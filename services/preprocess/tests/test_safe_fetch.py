import httpx
import pytest

from app.safe_fetch import FetchFailed, UnsafeUrl, is_public_ip, safe_get, validate_url

PUBLIC = "93.184.216.34"


def public(_host):
    return [PUBLIC]


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.0.0.5", "172.16.1.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
     "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "2002:7f00:1::", "224.0.0.1"],
)
def test_blocks_non_public_addresses(address):
    assert not is_public_ip(address)
    with pytest.raises(UnsafeUrl):
        validate_url("https://example.test/", lambda _: [address])


def test_blocks_if_any_address_is_private():
    with pytest.raises(UnsafeUrl):
        validate_url("https://example.test/", lambda _: [PUBLIC, "10.0.0.1"])


@pytest.mark.parametrize(
    "url",
    ["http://example.test/", "file:///etc/passwd", "ftp://example.test/", "https://user:pw@example.test/",
     "https://example.test:8443/", "https:///nohost"],
)
def test_blocks_bad_urls(url):
    with pytest.raises(UnsafeUrl):
        validate_url(url, public)


def test_revalidates_redirect_target():
    def handler(_request):
        return httpx.Response(302, headers={"location": "https://internal.test/admin"})

    resolver = lambda host: ["10.0.0.9"] if host == "internal.test" else [PUBLIC]
    with pytest.raises(UnsafeUrl):
        safe_get("https://example.test/", resolver, httpx.MockTransport(handler))


def test_connects_to_vetted_ip_with_original_host():
    seen = {}

    def handler(request):
        seen.update(host=request.url.host, header=request.headers["host"], sni=request.extensions.get("sni_hostname"))
        return httpx.Response(200, text="ok", headers={"content-type": "text/html"})

    result = safe_get("https://example.test/page?a=1", public, httpx.MockTransport(handler))
    assert result.body == b"ok"
    assert seen == {"host": PUBLIC, "header": "example.test", "sni": "example.test"}


def test_caps_response_size():
    transport = httpx.MockTransport(lambda _: httpx.Response(200, content=b"x" * 2048))
    with pytest.raises(FetchFailed):
        safe_get("https://example.test/", public, transport, max_bytes=1024)


def test_stops_redirect_loops():
    transport = httpx.MockTransport(lambda _: httpx.Response(302, headers={"location": "https://example.test/again"}))
    with pytest.raises(FetchFailed):
        safe_get("https://example.test/", public, transport)
