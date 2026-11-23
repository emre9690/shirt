"""Extract product facts from public structured data. Page text is data, never instructions."""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlsplit


class _JsonLd(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self._buffer: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "script" and dict(attrs).get("type", "").lower() == "application/ld+json":
            self._buffer = []

    def handle_data(self, data: str) -> None:
        if self._buffer is not None:
            self._buffer.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._buffer is not None:
            self.blocks.append("".join(self._buffer))
            self._buffer = None


def _walk(node: Any):
    if isinstance(node, list):
        for item in node:
            yield from _walk(item)
    elif isinstance(node, dict):
        yield node
        yield from _walk(node.get("@graph", []))


def _is_product(node: dict) -> bool:
    kind = node.get("@type")
    return "Product" in kind if isinstance(kind, list) else kind == "Product"


def _text(value: Any) -> str | None:
    if isinstance(value, str):
        return value.strip()[:300] or None
    if isinstance(value, dict):
        return _text(value.get("name"))
    return None


def _images(value: Any, base: str) -> list[str]:
    raw = value if isinstance(value, list) else [value]
    urls: list[str] = []
    for item in raw:
        candidate = item.get("url") or item.get("contentUrl") if isinstance(item, dict) else item
        if not isinstance(candidate, str):
            continue
        absolute = urljoin(base, candidate)
        if urlsplit(absolute).scheme == "https" and absolute not in urls:
            urls.append(absolute)
    return urls[:24]


def article_from_url(url: str) -> str | None:
    match = re.search(r"productpage\.(\d{7,12})", url)
    return match.group(1) if match else None


def extract_product(html: str, page_url: str) -> dict | None:
    """Return observed facts from the page's Product JSON-LD, or None if it has none."""
    parser = _JsonLd()
    parser.feed(html)
    for block in parser.blocks:
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        for node in _walk(data):
            if not _is_product(node):
                continue
            return {
                "name": _text(node.get("name")),
                "article": _text(node.get("sku")) or _text(node.get("productID")) or article_from_url(page_url),
                "color": _text(node.get("color")),
                "composition": _text(node.get("material")),
                "sizes": [s for s in (_text(v) for v in (node.get("size") if isinstance(node.get("size"), list) else [node.get("size")])) if s],
                "images": _images(node.get("image", []), page_url),
                "source": page_url,
            }
    return None
