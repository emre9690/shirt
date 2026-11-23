"""Server-side URL retrieval that cannot be used to reach the local network."""
from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

MAX_BYTES = 8 * 1024 * 1024
MAX_REDIRECTS = 4
TIMEOUT_SECONDS = 15.0
ALLOWED_PORTS = {None, 443}
USER_AGENT = "shirt-preprocess/0.1"

Resolver = Callable[[str], list[str]]


class UnsafeUrl(ValueError):
    """The URL or one of its redirects points somewhere this service must not fetch."""


class FetchFailed(RuntimeError):
    """The remote request failed or exceeded a limit."""


@dataclass
class Fetched:
    url: str
    status: int
    content_type: str
    body: bytes


def system_resolver(host: str) -> list[str]:
    try:
        return sorted({info[4][0] for info in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)})
    except socket.gaierror as exc:
        raise FetchFailed(f"Could not resolve {host}") from exc


def is_public_ip(value: str) -> bool:
    ip = ipaddress.ip_address(value.split("%")[0])
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped or ip.sixtofour or (ip.teredo[1] if ip.teredo else None)
        if mapped is not None:
            ip = mapped
    return ip.is_global and not ip.is_multicast


def validate_url(url: str, resolver: Resolver = system_resolver) -> tuple[str, str]:
    """Return (hostname, vetted IP). Every resolved address must be public."""
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise UnsafeUrl("Only https URLs are allowed")
    if parts.username or parts.password:
        raise UnsafeUrl("URLs with credentials are not allowed")
    host = parts.hostname
    if not host:
        raise UnsafeUrl("URL has no host")
    try:
        port = parts.port
    except ValueError as exc:
        raise UnsafeUrl("Invalid port") from exc
    if port not in ALLOWED_PORTS:
        raise UnsafeUrl("Only the default https port is allowed")
    addresses = resolver(host)
    if not addresses:
        raise UnsafeUrl("Host did not resolve")
    for address in addresses:
        if not is_public_ip(address):
            raise UnsafeUrl("Host resolves to a non-public address")
    return host, addresses[0]


def _pinned_url(url: str, ip: str) -> str:
    parts = urlsplit(url)
    netloc = f"[{ip}]" if ":" in ip else ip
    return urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))


def safe_get(
    url: str,
    resolver: Resolver = system_resolver,
    transport: httpx.BaseTransport | None = None,
    max_bytes: int = MAX_BYTES,
) -> Fetched:
    """GET a public URL, connecting to the vetted IP so DNS cannot change after validation."""
    current = url
    with httpx.Client(transport=transport, timeout=TIMEOUT_SECONDS, follow_redirects=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            host, ip = validate_url(current, resolver)
            headers = {"Host": host, "User-Agent": USER_AGENT, "Accept": "text/html,image/*;q=0.9,*/*;q=0.1"}
            try:
                with client.stream("GET", _pinned_url(current, ip), headers=headers, extensions={"sni_hostname": host}) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise FetchFailed("Redirect without a location")
                        current = urljoin(current, location)
                        continue
                    declared = response.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > max_bytes:
                        raise FetchFailed("Response is too large")
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > max_bytes:
                            raise FetchFailed("Response is too large")
                    return Fetched(current, response.status_code, response.headers.get("content-type", ""), bytes(body))
            except httpx.HTTPError as exc:
                raise FetchFailed(f"Request failed: {type(exc).__name__}") from exc
    raise FetchFailed("Too many redirects")
