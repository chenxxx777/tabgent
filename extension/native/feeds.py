"""RSS, Atom and JSON Feed subscriptions for the ReadingVault.

Feeds are fetched by the browser and parsed here. Feeds are untrusted, and the system
Python on macOS (3.9.6) links expat 2.2.8, which predates expat's entity amplification
limits, so the parser refuses a DTD internal subset and every entity declaration: no
entity is ever expanded and no external entity is loaded. Input size, element count, depth
and text are bounded too. Subscriptions and items live in one SQLite file in the vault,
.tabgent/feeds.db, which Obsidian does not show; an item gets a document folder only when
the user saves, highlights or discusses it. Standard library only.
"""

import codecs
import contextlib
import datetime
import email.utils
import hashlib
import html.entities
import json
import random
import re
import sqlite3
import time
import uuid
from urllib.parse import unquote_plus, urljoin, urlsplit, urlunsplit
import xml.parsers.expat as expat

import epub_text
import vault
from vault import VaultError

FEED_LIMIT = 5 * 1024 * 1024
OPML_LIMIT = 2 * 1024 * 1024
ELEMENT_LIMIT = 100_000
DEPTH_LIMIT = 100
TEXT_LIMIT = 1024 * 1024  # characters of one element's text
ITEM_LIMIT = 200  # newest entries read from one fetch
CONTENT_LIMIT = 512 * 1024  # characters of an item's HTML
SUMMARY_LIMIT = 1000
TITLE_LIMIT = 500
FIRST_UNREAD = 20  # a new subscription's newest entries that are unread
KEEP_ITEMS = 500  # item records per subscription
UNREAD_LIMIT = 200  # unread items per subscription; older ones are archived
SEEN_LIMIT = 2000  # keys remembered per subscription, so old entries never come back
SOURCE_LIMIT = 500
INTERVAL = (30, 60, 24 * 60)  # minutes: shortest, default and longest refresh interval
QUIET_DAYS = 14  # a feed without new items for this long is checked half as often
SCHEMA = 1

ATOM = "http://www.w3.org/2005/Atom"
RSS1 = "http://purl.org/rss/1.0/"
RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
CONTENT = "http://purl.org/rss/1.0/modules/content/"
DC = "http://purl.org/dc/elements/1.1/"
MEDIA = "http://search.yahoo.com/mrss/"
SY = "http://purl.org/rss/1.0/modules/syndication/"
XML = "http://www.w3.org/XML/1998/namespace"
TRACKING = re.compile(r"utm_\w+|fbclid|gclid|mc_cid|mc_eid", re.IGNORECASE)


class FeedError(Exception):
    pass


# Parsing


class _Element:
    __slots__ = ("tag", "attrs", "children", "text", "size")

    def __init__(self, tag, attrs):
        self.tag = (
            tag  # "<namespace> <local name>", or the local name without a namespace
        )
        self.attrs = attrs
        self.children = []
        self.text = []  # text, with each child element at its place (for xhtml content)
        self.size = 0  # characters of text kept, counted as they are added

    def find(self, *tags):
        return next((c for c in self.children if c.tag in tags), None)

    def findall(self, *tags):
        return [c for c in self.children if c.tag in tags]

    def value(self):
        return "".join(part for part in self.text if isinstance(part, str)).strip()


class _Refused(Exception):
    pass


def _transcode(data, charset):
    """UTF-8 bytes for expat, which reads only UTF-8, UTF-16, ISO-8859-1 and ASCII itself:
    other encodings (GBK, Big5, ...) are decoded here and the declaration rewritten."""
    boms = (
        (b"\xef\xbb\xbf", "utf-8"),
        (b"\xff\xfe", "utf-16"),
        (b"\xfe\xff", "utf-16"),
    )
    encoding = next((codec for bom, codec in boms if data.startswith(bom)), None)
    if encoding is None:
        declared = re.match(
            rb"\s*<\?xml[^>]*?encoding=[\"']([A-Za-z0-9._-]+)", data[:300]
        )
        encoding = (
            charset or (declared and declared.group(1).decode("ascii")) or "utf-8"
        )
    try:
        name = codecs.lookup(encoding).name
    except LookupError:
        name = "utf-8"
    if name in ("gbk", "gb2312"):
        name = "gb18030"
    text = data.decode(name, errors="replace").lstrip("﻿")
    text = re.sub(
        r"^(\s*<\?xml[^>]*?encoding=)([\"'])[^\"']*\2", r"\1\2UTF-8\2", text, count=1
    )
    return text.encode("utf-8")


# &nbsp; and other HTML entities without a DTD: replaced by character references.
_NAMED = re.compile(r"&([A-Za-z][A-Za-z0-9]{1,31});")


def _numeric_entities(data):
    keep = {"amp", "lt", "gt", "quot", "apos"}

    def replace(match):
        name = match.group(1)
        code = html.entities.name2codepoint.get(name)
        return match.group(0) if name in keep or code is None else f"&#{code};"

    return _NAMED.sub(replace, data.decode("utf-8")).encode("utf-8")


def _xml(data, charset=""):
    data = _transcode(data, charset)
    try:
        return _expat(data)
    except expat.ExpatError as error:
        if "undefined entity" not in str(error):
            raise FeedError(f"Not a valid feed: {error}")
    try:
        return _expat(_numeric_entities(data))
    except expat.ExpatError as error:
        raise FeedError(f"Not a valid feed: {error}")


def _expat(data):
    parser = expat.ParserCreate(namespace_separator=" ")
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    parser.buffer_text = True
    root = _Element("#document", {})
    stack = [root]
    count = [0]
    size = [0]

    def doctype(name, system, public, internal):
        # An external DOCTYPE (RSS 0.91's) is never loaded; an internal subset is refused.
        if internal:
            raise _Refused("Feeds with a DTD internal subset are not read")

    def entity(*args):
        raise _Refused("Feeds that declare entities are not read")

    def skipped(name, parameter):
        if not parameter:
            text(chr(html.entities.name2codepoint.get(name, 0xFFFD)))

    def start(tag, attrs):
        count[0] += 1
        if count[0] > ELEMENT_LIMIT:
            raise _Refused("The feed has too many elements")
        if len(stack) > DEPTH_LIMIT:
            raise _Refused("The feed is nested too deeply")
        element = _Element(tag, attrs)
        stack[-1].children.append(element)
        stack[-1].text.append(element)
        stack.append(element)

    def end(tag):
        stack.pop()

    def text(value):
        size[0] += len(value)
        if size[0] > FEED_LIMIT * 2:
            raise _Refused("The feed text is too long")
        # A running count per element keeps this linear in the feed's size.
        element = stack[-1]
        if element.size < TEXT_LIMIT:
            element.text.append(value)
            element.size += len(value)

    parser.StartDoctypeDeclHandler = doctype
    parser.EntityDeclHandler = entity
    parser.SkippedEntityHandler = skipped
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    try:
        parser.Parse(data, True)
    except _Refused as error:
        raise FeedError(str(error))
    except RecursionError:
        raise FeedError("The feed is nested too deeply")
    return root


VOID = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "source",
    "track",
    "wbr",
}


def _serialize(element):
    """The HTML of an element's children (Atom xhtml content)."""
    parts = []

    def write(node):
        local = node.tag.rsplit(" ", 1)[-1]
        attrs = "".join(
            f' {name.rsplit(" ", 1)[-1]}="{_escape(value, True)}"'
            for name, value in node.attrs.items()
        )
        parts.append(f"<{local}{attrs}>")
        if local not in VOID:
            content(node)
            parts.append(f"</{local}>")

    def content(node):
        for part in node.text:
            if isinstance(part, str):
                parts.append(_escape(part))
            else:
                write(part)

    content(element)
    return "".join(parts)


def _escape(value, quote=False):
    value = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return value.replace('"', "&quot;") if quote else value


def _text(markup, limit):
    """Plain text of HTML (titles, summaries), with whitespace collapsed."""
    if "<" not in markup and "&" not in markup:
        return " ".join(markup.split())[:limit]
    tree = epub_text._parse(markup[: limit * 20])
    return " ".join(epub_text._text(tree).split())[:limit]


def _date(value):
    """An ISO 8601 UTC time from RFC 822 or RFC 3339 text, or None."""
    value = (value or "").strip()
    if not value:
        return None
    moment = None
    try:
        moment = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        match = re.match(
            r"(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$",
            value,
            re.IGNORECASE,
        )
        if match:
            day, clock, fraction, zone = match.groups()
            clock = clock or "00:00:00"
            clock += ":00" if len(clock) == 5 else ""
            fraction = (fraction or ".0")[1:7].ljust(6, "0")
            zone = "+00:00" if not zone or zone.upper() == "Z" else zone
            zone = zone if ":" in zone else f"{zone[:3]}:{zone[3:]}"
            try:
                moment = datetime.datetime.fromisoformat(
                    f"{day}T{clock}.{fraction}{zone}"
                )
            except ValueError:
                moment = None
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return moment.astimezone(datetime.timezone.utc).isoformat(timespec="seconds")


def identity(url):
    """The vault identity of an item's link: no fragment and no tracking parameters (feed
    links often carry utm_source=rss), so the item and the page are one document. Other
    parameters stay exactly as written: servers may treat ?a and ?a= differently."""
    parts = urlsplit(url)
    query = [
        pair
        for pair in parts.query.split("&")
        if pair and not TRACKING.fullmatch(unquote_plus(pair.split("=", 1)[0]))
    ]
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path or "/", "&".join(query), "")
    )


def item_urn(source_url, key):
    """The vault identity of an entry without a link: urn:tabgent:feed:<sha256>."""
    digest = hashlib.sha256(f"{source_url}\n{key}".encode("utf-8")).hexdigest()
    return "urn:tabgent:feed:" + digest


def _link(value, base):
    """An absolute http(s) address, or "" (an empty value is not the base address)."""
    value = (value or "").strip()
    if not value:
        return ""
    try:
        url = urljoin(base or "", value)
    except ValueError:
        return ""
    return (
        url if re.match(r"https?://", url, re.IGNORECASE) and len(url) <= 4096 else ""
    )


def _base(element, inherited):
    value = element.attrs.get(f"{XML} base")
    return urljoin(inherited, value) if value else inherited


def _minutes(value):
    try:
        return max(0, int(float(str(value).strip())))
    except (TypeError, ValueError):
        return None


def parse(data, content_type="", url=""):
    """{title, siteUrl, kind, ttl (minutes or None), items: [...]}; raises FeedError."""
    if len(data) > FEED_LIMIT:
        raise FeedError("The feed is larger than 5 MB")
    charset = ""
    match = re.search(r"charset=\"?([\w.-]+)", content_type or "", re.IGNORECASE)
    if match:
        charset = match.group(1)
    head = data.lstrip(b"\xef\xbb\xbf \t\r\n")[:1]
    if head in (b"{", b"["):
        return _json_feed(data, url)
    root = _xml(data, charset)
    top = next(iter(root.children), None)
    if top is None:
        raise FeedError("The feed is empty")
    if top.tag == "rss" or top.tag.endswith(" rss"):
        return _rss(top, url)
    if top.tag == f"{RDF} RDF":
        return _rdf(top, url)
    if top.tag == f"{ATOM} feed":
        return _atom(top, url)
    raise FeedError("Not an RSS, Atom or JSON feed")


def _item(key, link, title, author, published, updated, content, summary, image, full):
    link = link or ""
    content = (content or "")[:CONTENT_LIMIT]
    text = _text(summary or content, SUMMARY_LIMIT)
    key = (key or "").strip()[:1024] or (identity(link) if link else "")
    if not key:
        raw = f"{title}\0{published}\0{text[:200]}".encode("utf-8")
        key = "sha256:" + hashlib.sha256(raw).hexdigest()
    body = _text(content, 2000) if content else ""
    return {
        "key": key,
        "link": link,
        "url": identity(link) if link else "",
        "title": _text(title or "", TITLE_LIMIT),
        "author": _text(author or "", 200),
        "publishedAt": published,
        "updatedAt": updated,
        "summary": text,
        "contentHtml": content or (summary or "")[:CONTENT_LIMIT],
        # A feed that sends only a summary (or a short text) asks for the original page.
        "contentKind": "full" if full and len(body) >= 1000 else "summary",
        "image": image,
    }


def _media_image(element, base):
    for child in element.children:
        if child.tag == f"{MEDIA} thumbnail" or (
            child.tag == f"{MEDIA} content" and child.attrs.get("medium") == "image"
        ):
            return _link(child.attrs.get("url"), base)
        if child.tag == "enclosure" and child.attrs.get("type", "").startswith(
            "image/"
        ):
            return _link(child.attrs.get("url"), base)
    return ""


def _rss(top, url):
    channel = top.find("channel")
    if channel is None:
        raise FeedError("The RSS feed has no channel")
    site = _link(_value(channel, "link"), url)
    period = channel.find(f"{SY} updatePeriod")
    frequency = channel.find(f"{SY} updateFrequency")
    items = []
    for entry in channel.findall("item")[:ITEM_LIMIT]:
        guid = entry.find("guid")
        link = _link(_value(entry, "link"), site or url)
        if (
            not link
            and guid is not None
            and guid.attrs.get("isPermaLink", "true") != "false"
        ):
            link = _link(guid.value(), site or url)
        encoded = _value(entry, f"{CONTENT} encoded")
        description = _value(entry, "description")
        published = _date(_value(entry, "pubDate") or _value(entry, f"{DC} date"))
        items.append(
            _item(
                guid.value() if guid is not None else "",
                link,
                _value(entry, "title"),
                _value(entry, f"{DC} creator") or _value(entry, "author"),
                published,
                published,
                encoded or description,
                description if encoded else "",
                _media_image(entry, site or url),
                bool(encoded) or len(_text(description, 3000)) >= 1000,
            )
        )
    return {
        "kind": "rss",
        "title": _text(_value(channel, "title"), TITLE_LIMIT),
        "siteUrl": site,
        "ttl": _minutes(_value(channel, "ttl")) or _period(period, frequency),
        "items": items,
    }


def _period(period, frequency):
    if period is None:
        return None
    minutes = {
        "hourly": 60,
        "daily": 1440,
        "weekly": 10080,
        "monthly": 43200,
        "yearly": 525600,
    }
    base = minutes.get(period.value().lower())
    count = _minutes(frequency.value()) if frequency is not None else 1
    return base // max(1, count or 1) if base else None


def _rdf(top, url):
    channel = top.find(f"{RSS1} channel")
    site = _link(_value(channel, f"{RSS1} link"), url) if channel is not None else ""
    items = []
    for entry in top.findall(f"{RSS1} item")[:ITEM_LIMIT]:
        encoded = _value(entry, f"{CONTENT} encoded")
        description = _value(entry, f"{RSS1} description")
        published = _date(_value(entry, f"{DC} date"))
        items.append(
            _item(
                entry.attrs.get(f"{RDF} about", ""),
                _link(_value(entry, f"{RSS1} link"), site or url),
                _value(entry, f"{RSS1} title"),
                _value(entry, f"{DC} creator"),
                published,
                published,
                encoded or description,
                description if encoded else "",
                "",
                bool(encoded) or len(_text(description, 3000)) >= 1000,
            )
        )
    return {
        "kind": "rdf",
        "title": _text(
            _value(channel, f"{RSS1} title") if channel is not None else "", TITLE_LIMIT
        ),
        "siteUrl": site,
        "ttl": None,
        "items": items,
    }


def _atom_text(element):
    """Text of an Atom text construct; type html is HTML text, xhtml is markup."""
    if element is None:
        return ""
    kind = element.attrs.get("type", "text")
    if kind == "xhtml":
        division = element.find("http://www.w3.org/1999/xhtml div")
        return _serialize(division if division is not None else element)
    if kind == "html":
        return element.value()
    return _escape(element.value())


def _atom_link(entry, base):
    for link in entry.findall(f"{ATOM} link"):
        if link.attrs.get("rel", "alternate") == "alternate":
            return _link(link.attrs.get("href"), _base(link, base))
    return ""


def _atom(top, url):
    base = _base(top, url)
    site = _atom_link(top, base)
    items = []
    for entry in top.findall(f"{ATOM} entry")[:ITEM_LIMIT]:
        where = _base(entry, base)
        content = entry.find(f"{ATOM} content")
        summary = _atom_text(entry.find(f"{ATOM} summary"))
        body = (
            _atom_text(content)
            if content is not None and "src" not in content.attrs
            else ""
        )
        author = entry.find(f"{ATOM} author") or top.find(f"{ATOM} author")
        updated = _date(_value(entry, f"{ATOM} updated"))
        items.append(
            _item(
                _value(entry, f"{ATOM} id"),
                _atom_link(entry, where),
                _text(_atom_text(entry.find(f"{ATOM} title")), TITLE_LIMIT),
                _value(author, f"{ATOM} name") if author is not None else "",
                _date(_value(entry, f"{ATOM} published")) or updated,
                updated,
                body or summary,
                summary if body else "",
                _media_image(entry, where),
                bool(body),
            )
        )
    return {
        "kind": "atom",
        "title": _text(_atom_text(top.find(f"{ATOM} title")), TITLE_LIMIT),
        "siteUrl": site,
        "ttl": None,
        "items": items,
    }


def _value(element, tag):
    if element is None:
        return ""
    found = element.find(tag)
    return found.value() if found is not None else ""


def _json_feed(data, url):
    try:
        feed = json.loads(data.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError) as error:
        raise FeedError(f"Not a valid JSON feed: {error}")
    _depth(feed)
    if not (
        isinstance(feed, dict)
        and str(feed.get("version", "")).startswith("https://jsonfeed.org/version/")
        and isinstance(feed.get("items", []), list)
    ):
        raise FeedError("Not a JSON Feed")
    site = _link(_string(feed.get("home_page_url")), url)
    items = []
    for entry in feed.get("items", [])[:ITEM_LIMIT]:
        if not isinstance(entry, dict):
            continue
        authors = entry.get("authors") or (
            [entry["author"]] if isinstance(entry.get("author"), dict) else []
        )
        author = ", ".join(
            _string(a.get("name")) for a in authors if isinstance(a, dict)
        )
        content = _string(entry.get("content_html")) or _escape(
            _string(entry.get("content_text"))
        )
        summary = _string(entry.get("summary"))
        items.append(
            _item(
                _string(entry.get("id")),
                _link(
                    _string(entry.get("url")) or _string(entry.get("external_url")),
                    site or url,
                ),
                _string(entry.get("title")),
                author,
                _date(_string(entry.get("date_published"))),
                _date(_string(entry.get("date_modified"))),
                content or summary,
                summary if content else "",
                _link(_string(entry.get("image")), site or url),
                bool(content),
            )
        )
    return {
        "kind": "json",
        "title": _text(_string(feed.get("title")), TITLE_LIMIT),
        "siteUrl": site,
        "ttl": None,
        "items": items,
    }


def _string(value):
    return value if isinstance(value, str) else ""


def _depth(value, level=0):
    if level > DEPTH_LIMIT:
        raise FeedError("The feed is nested too deeply")
    if isinstance(value, dict):
        for child in value.values():
            _depth(child, level + 1)
    elif isinstance(value, list):
        for child in value:
            _depth(child, level + 1)


def parse_opml(text):
    """Subscriptions in an OPML file: [{url, title, siteUrl, category}]."""
    if not isinstance(text, str) or len(text) > OPML_LIMIT:
        raise FeedError("The OPML file is too large")
    root = _xml(text.encode("utf-8"))
    found = []

    def walk(node, category):
        for child in node.children:
            if child.tag != "outline":
                walk(child, category)
                continue
            url = _link(child.attrs.get("xmlUrl"), "")
            title = _text(
                child.attrs.get("title") or child.attrs.get("text") or "", TITLE_LIMIT
            )
            if url:
                found.append(
                    {
                        "url": url,
                        "title": title,
                        "siteUrl": _link(child.attrs.get("htmlUrl"), ""),
                        "category": category,
                    }
                )
            walk(child, category if url else (title or category))

    walk(root, "")
    return found[:SOURCE_LIMIT]


# The index: .tabgent/feeds.db in the vault


TABLES = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'feed', url TEXT NOT NULL UNIQUE,
  site_url TEXT, title TEXT, category TEXT, added_at TEXT, settings TEXT,
  etag TEXT, last_modified TEXT, last_fetch_at TEXT, next_fetch_at REAL,
  failures INTEGER NOT NULL DEFAULT 0, failing_since TEXT, last_error TEXT,
  status TEXT NOT NULL DEFAULT 'active', paused INTEGER NOT NULL DEFAULT 0,
  ttl INTEGER, last_new_at TEXT,
  redirect_url TEXT, redirect_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  key TEXT NOT NULL, url TEXT, link TEXT, title TEXT, author TEXT,
  published_at TEXT, updated_at TEXT, first_seen_at TEXT NOT NULL,
  sort_at REAL NOT NULL, summary TEXT, content_kind TEXT, image TEXT, content_hash TEXT,
  state TEXT, read_at TEXT, document_id TEXT,
  UNIQUE (source_id, key)
);
CREATE INDEX IF NOT EXISTS items_state ON items (state, read_at, sort_at);
CREATE INDEX IF NOT EXISTS items_source ON items (source_id, first_seen_at);
CREATE INDEX IF NOT EXISTS items_url ON items (url);
CREATE TABLE IF NOT EXISTS item_content (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  kind TEXT, html TEXT, bytes INTEGER, fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS seen (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  key TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (source_id, key)
);
"""


def _index(root):
    """The index's path. A symbolic link at its place (or at .tabgent) is refused: the
    index stays in this vault."""
    folder = root / ".tabgent"
    path = folder / "feeds.db"
    if folder.is_symlink() or path.is_symlink():
        raise VaultError("io_error", f"{path} is a link; Tabgent does not follow it")
    return path


def _connect(root, create=False):
    """The index, or None when nothing was subscribed yet and create is false. Reads never
    create it; only writes (under the vault lock) set up its tables."""
    path = _index(root)
    if not create and not path.is_file():
        return None
    if create:
        vault._ensure_dir(path.parent)
    db = sqlite3.connect(str(path), timeout=10, isolation_level=None)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        if create:
            db.execute("PRAGMA journal_mode=DELETE")
            db.executescript(TABLES)
            db.execute(
                "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', ?)",
                (str(SCHEMA),),
            )
        elif not db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
        ).fetchone():
            db.close()
            return None
        version = db.execute("SELECT value FROM meta WHERE key = 'schema'").fetchone()
        if version is None or not str(version[0]).isdigit() or int(version[0]) > SCHEMA:
            raise VaultError("io_error", f"{path} was written by a newer Tabgent")
    except BaseException:
        db.close()
        raise
    return db


@contextlib.contextmanager
def _writing(root):
    """The vault lock and one immediate transaction on the index."""
    with vault._locked(root):
        db = _connect(root, True)
        try:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
            except BaseException:
                db.execute("ROLLBACK")
                raise
            db.execute("COMMIT")
        finally:
            db.close()


@contextlib.contextmanager
def _reading(root):
    db = _connect(root)
    try:
        yield db
    finally:
        if db is not None:
            db.close()


def _iso(moment):
    """UTC, like the feeds' own dates, so stored times sort as text."""
    return datetime.datetime.fromtimestamp(moment, datetime.timezone.utc).isoformat(
        timespec="seconds"
    )


def _source_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"feed-[0-9a-f]{12}", value):
        raise VaultError("invalid_params", "sourceId is not a subscription")
    return value


def _feed_url(value):
    if not isinstance(value, str) or len(value) > 4096:
        raise VaultError("invalid_params", "url must be a web address")
    url = value.strip().split("#", 1)[0]
    if not re.match(r"https?://[^/\s]+", url, re.IGNORECASE):
        raise VaultError("invalid_params", "url must be a web address")
    return url


def _settings(row):
    try:
        value = json.loads(row["settings"] or "{}")
    except ValueError:
        value = {}
    return value if isinstance(value, dict) else {}


def _public_source(db, row, counts=None):
    """A subscription for the library; counts: (items, unread), read here when not given
    (the list reads them for every subscription in one query)."""
    if counts is None:
        counts = db.execute(
            "SELECT COUNT(*), SUM(state = 'inbox' AND read_at IS NULL) FROM items "
            "WHERE source_id = ?",
            (row["id"],),
        ).fetchone()
    return {
        "id": row["id"],
        "type": row["type"],
        "url": row["url"],
        "siteUrl": row["site_url"] or "",
        "title": row["title"] or "",
        "category": row["category"] or "",
        "addedAt": row["added_at"],
        "status": row["status"],
        "lastFetchAt": row["last_fetch_at"],
        "nextFetchAt": _iso(row["next_fetch_at"]) if row["next_fetch_at"] else None,
        "failures": row["failures"],
        "lastError": row["last_error"] or "",
        "settings": {**_settings(row), "paused": bool(row["paused"])},
        "items": counts[0] or 0,
        "unread": counts[1] or 0,
    }


def _public_item(row):
    return {
        "id": row["id"],
        "sourceId": row["source_id"],
        "sourceTitle": row["source_title"] if "source_title" in row.keys() else "",
        "url": row["url"] or "",
        "link": row["link"] or "",
        "title": row["title"] or "",
        "author": row["author"] or "",
        "publishedAt": row["published_at"],
        "firstSeenAt": row["first_seen_at"],
        "summary": row["summary"] or "",
        "contentKind": row["content_kind"],
        "image": row["image"] or "",
        "state": row["state"],
        "readAt": row["read_at"],
        "documentId": row["document_id"],
    }


def _interval(row, feed_ttl, max_age, now):
    """Minutes to the next check: the user's interval, else what the feed or its server
    asks for (at least the default), checked half as often when it has been quiet."""
    chosen = _settings(row).get("interval")
    if isinstance(chosen, int):
        return min(max(chosen, INTERVAL[0]), INTERVAL[2])
    minutes = max(INTERVAL[1], feed_ttl or 0, max_age or 0)
    quiet = (
        row["last_new_at"]
        and vault._instant(row["last_new_at"]) < now - QUIET_DAYS * 86400
    )
    if quiet:
        minutes = min(minutes * 2, 12 * 60)
    return min(max(minutes, INTERVAL[0]), INTERVAL[2])


def _jitter(minutes):
    return minutes * 60 * random.uniform(0.9, 1.1)


def _max_age(value):
    match = re.search(r"max-age=(\d+)", value or "")
    return int(match.group(1)) // 60 if match else None


def _store_items(db, row, feed, now):
    """Adds the feed's new entries and updates changed ones; returns how many are new."""
    first = (
        row["last_fetch_at"] is None
        and not db.execute(
            "SELECT 1 FROM items WHERE source_id = ? LIMIT 1", (row["id"],)
        ).fetchone()
    )
    # Newest first by date; entries without a date keep the feed's order after them.
    entries = sorted(
        enumerate(feed["items"]),
        key=lambda pair: (vault._instant(pair[1]["publishedAt"]), -pair[0]),
        reverse=True,
    )
    seen_at = _iso(now)
    new = 0
    for position, (_, entry) in enumerate(entries):
        content = entry["contentHtml"]
        digest = hashlib.sha256(
            f"{entry['title']}\0{entry['summary']}\0{content}".encode("utf-8")
        ).hexdigest()
        known = db.execute(
            "SELECT id, content_hash FROM items WHERE source_id = ? AND key = ?",
            (row["id"], entry["key"]),
        ).fetchone()
        if known is None and entry["url"]:
            # Some feeds give an entry a new guid on every fetch; its link stays the same.
            known = db.execute(
                "SELECT id, content_hash FROM items WHERE source_id = ? AND url = ?",
                (row["id"], entry["url"]),
            ).fetchone()
        if known is not None:
            if known["content_hash"] != digest:
                db.execute(
                    "UPDATE items SET title = ?, summary = ?, updated_at = ?, image = ?, "
                    "content_kind = ?, content_hash = ? WHERE id = ?",
                    (
                        entry["title"],
                        entry["summary"],
                        entry["updatedAt"],
                        entry["image"],
                        entry["contentKind"],
                        digest,
                        known["id"],
                    ),
                )
                _store_content(db, known["id"], content, seen_at)
            continue
        fresh = db.execute(
            "INSERT OR IGNORE INTO seen (source_id, key, seen_at) VALUES (?, ?, ?)",
            (row["id"], entry["key"], seen_at),
        ).rowcount
        # A key seen before (an old entry the feed shows again) never comes back as new;
        # a new subscription starts with its newest entries only.
        if not fresh or (first and position >= FIRST_UNREAD):
            continue
        published = vault._instant(entry["publishedAt"])
        # A date in the future does not keep an item at the top; undated keep feed order.
        order = min(published, now) if published else now - position / 1000
        ident = "item-" + uuid.uuid4().hex[:16]
        # An entry without a link is named by its subscription and key.
        address = entry["url"] or item_urn(row["url"], entry["key"])
        db.execute(
            "INSERT INTO items (id, source_id, key, url, link, title, author, published_at, "
            "updated_at, first_seen_at, sort_at, summary, content_kind, image, "
            "content_hash, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox')",
            (
                ident,
                row["id"],
                entry["key"],
                address,
                entry["link"],
                entry["title"],
                entry["author"],
                entry["publishedAt"],
                entry["updatedAt"],
                seen_at,
                order,
                entry["summary"],
                entry["contentKind"],
                entry["image"],
                digest,
            ),
        )
        _store_content(db, ident, content, seen_at)
        new += 1
    _trim(db, row["id"])
    return new


def _store_content(db, ident, content, at):
    """The feed's own HTML of an item. Full text fetched from the page is kept."""
    if not content:
        return
    db.execute(
        "INSERT INTO item_content (item_id, kind, html, bytes, fetched_at) "
        "VALUES (?, 'feed', ?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET "
        "html = excluded.html, bytes = excluded.bytes, fetched_at = excluded.fetched_at "
        "WHERE item_content.kind = 'feed'",
        (ident, content, len(content.encode("utf-8")), at),
    )


def _trim(db, source):
    # Unread items beyond the limit are archived, oldest first.
    db.execute(
        "UPDATE items SET state = 'archive' WHERE id IN (SELECT id FROM items "
        "WHERE source_id = ? AND state = 'inbox' AND read_at IS NULL "
        "ORDER BY sort_at DESC LIMIT -1 OFFSET ?)",
        (source, UNREAD_LIMIT),
    )
    # Records beyond the limit go, oldest first; items kept for later or saved as a
    # document stay. Their keys stay in seen, so they do not come back.
    db.execute(
        "DELETE FROM items WHERE id IN (SELECT id FROM items WHERE source_id = ? "
        "AND document_id IS NULL AND state IN ('inbox', 'archive') "
        "ORDER BY first_seen_at DESC, sort_at DESC LIMIT -1 OFFSET ?)",
        (source, KEEP_ITEMS),
    )
    db.execute(
        "DELETE FROM seen WHERE rowid IN (SELECT rowid FROM seen WHERE source_id = ? "
        "ORDER BY seen_at DESC LIMIT -1 OFFSET ?)",
        (source, SEEN_LIMIT),
    )


# Methods


def prepare(method, params):
    """Parses a fetched feed before the vault queue: {"feed": ...}, {"error": ...} or None
    when the request carries no feed."""
    if method not in PARSING or not isinstance(params, dict) or not params.get("data"):
        return None
    if method == "vault/feeds/ingest" and params.get("status") != 200:
        return None
    try:
        raw = vault._base64(params["data"], FEED_LIMIT)
        kind = params.get("contentType")
        url = params.get("finalUrl") or params.get("url")
        feed = parse(
            raw,
            kind if isinstance(kind, str) else "",
            url if isinstance(url, str) else "",
        )
        return {"feed": feed}
    except (FeedError, VaultError) as error:
        return {"error": str(error)[:300]}


def preview(settings, params, prepared=None):
    """What a fetched address holds, without saving anything."""
    prepared = prepared or prepare("vault/feeds/preview", params)
    if not prepared:
        raise VaultError("invalid_params", "data is required")
    if "error" in prepared:
        raise VaultError("invalid_feed", prepared["error"])
    feed = prepared["feed"]
    return {
        "title": feed["title"],
        "siteUrl": feed["siteUrl"],
        "kind": feed["kind"],
        "count": len(feed["items"]),
        "items": [
            {"title": entry["title"], "publishedAt": entry["publishedAt"]}
            for entry in feed["items"][:3]
        ],
    }


def subscribe(settings, params, prepared=None):
    """Adds a subscription (once per address). With the feed already fetched (data), its
    newest entries are added at once; otherwise it is checked after delay seconds."""
    url = _feed_url(params.get("url"))
    title = vault._label(params.get("title"), "title")
    category = vault._label(params.get("category"), "category")[:200]
    site = _link(vault._label(params.get("siteUrl"), "siteUrl"), "")
    delay = vault._integer(params, "delay", 0, 86400, 0)
    if prepared is None:
        prepared = prepare("vault/feeds/subscribe", params)
    if prepared and "error" in prepared:
        raise VaultError("invalid_feed", prepared["error"])
    feed = prepared["feed"] if prepared else None
    root = vault._root(settings)
    with _writing(root) as db:
        existing = db.execute("SELECT * FROM sources WHERE url = ?", (url,)).fetchone()
        if existing is not None:
            return {"source": _public_source(db, existing), "created": False, "new": 0}
        if db.execute("SELECT COUNT(*) FROM sources").fetchone()[0] >= SOURCE_LIMIT:
            raise VaultError("invalid_params", f"At most {SOURCE_LIMIT} subscriptions")
        ident = "feed-" + uuid.uuid4().hex[:12]
        now = time.time()
        db.execute(
            "INSERT INTO sources (id, url, site_url, title, category, added_at, settings, "
            "next_fetch_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)",
            (
                ident,
                url,
                site or (feed["siteUrl"] if feed else ""),
                title or (feed["title"] if feed else ""),
                category,
                _iso(now),
                now + delay,
            ),
        )
        new = 0
        if feed is not None:
            row = _source(db, ident)
            new = _fetched(db, row, 200, params, prepared, now)
        return {
            "source": _public_source(db, _source(db, ident)),
            "created": True,
            "new": new,
        }


def _source(db, ident):
    row = db.execute("SELECT * FROM sources WHERE id = ?", (ident,)).fetchone()
    if row is None:
        raise VaultError("not_found", f"Subscription {ident} does not exist")
    return row


def _retry_after(headers):
    value = headers.get("retryAfter")
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return 0
    return min(value, INTERVAL[2] * 60)


def _fetched(db, row, status, params, prepared, now):
    """Records one fetch of a subscription and schedules the next; returns new items."""
    headers = params.get("headers") if isinstance(params.get("headers"), dict) else {}

    def header(name, limit):
        value = headers.get(name)
        return value[:limit] if isinstance(value, str) else ""

    updates = {"last_fetch_at": _iso(now)}
    new = 0
    feed = (prepared or {}).get("feed")
    if status == 304 or (status == 200 and feed is not None):
        if feed is not None:
            new = _store_items(db, row, feed, now)
            updates.update(
                etag=header("etag", 1000) or None,
                last_modified=header("lastModified", 200) or None,
                title=row["title"] or feed["title"],
                site_url=row["site_url"] or feed["siteUrl"],
                ttl=feed["ttl"],
            )
            if new:
                updates["last_new_at"] = _iso(now)
        updates.update(failures=0, failing_since=None, last_error=None, status="active")
        merged = {**dict(row), **updates}
        minutes = _interval(
            merged, merged["ttl"], _max_age(header("cacheControl", 500)), now
        )
        updates["next_fetch_at"] = now + _jitter(minutes)
        updates.update(_moved(db, row, params.get("finalUrl")))
    else:
        failures = row["failures"] + 1
        since = row["failing_since"] or _iso(now)
        reason = (prepared or {}).get("error") or vault._label(
            params.get("error"), "error"
        )[:300]
        if not reason:
            reason = "The feed is empty" if status == 200 else f"HTTP {status}"
        updates.update(failures=failures, failing_since=since, last_error=reason)
        # Backing off: 30 minutes, then twice as long after each failure, up to a day.
        delay = min(INTERVAL[0] * 2 ** min(failures - 1, 10), INTERVAL[2]) * 60
        if status in (429, 503) and _retry_after(headers):
            delay = _retry_after(headers)
        updates["next_fetch_at"] = now + delay * random.uniform(0.9, 1.1)
        if status == 410:
            updates.update(status="gone", next_fetch_at=None)
        elif status in (401, 403) and failures >= 3:
            updates.update(status="refused", next_fetch_at=None)
        elif status == 404 and vault._instant(since) < now - 7 * 86400:
            updates.update(status="gone", next_fetch_at=None)
    columns = ", ".join(f"{name} = ?" for name in updates)
    db.execute(
        f"UPDATE sources SET {columns} WHERE id = ?", (*updates.values(), row["id"])
    )
    return new


def _moved(db, row, final):
    """A feed that answered from another address three fetches in a row has moved there
    (unless another subscription already uses that address)."""
    try:
        final = _feed_url(final) if final else ""
    except VaultError:
        final = ""
    if not final or final == row["url"]:
        return {"redirect_url": None, "redirect_count": 0}
    count = row["redirect_count"] + 1 if row["redirect_url"] == final else 1
    taken = db.execute("SELECT 1 FROM sources WHERE url = ?", (final,)).fetchone()
    if count >= 3 and not taken:
        return {"url": final, "redirect_url": None, "redirect_count": 0}
    return {"redirect_url": final, "redirect_count": count}


def ingest(settings, params, prepared=None):
    """One fetch of a subscription: {sourceId, status (0 when the request failed), finalUrl,
    headers: {etag, lastModified, cacheControl, retryAfter (seconds)}, data, error}."""
    ident = _source_id(params.get("sourceId"))
    status = vault._integer(params, "status", 0, 999)
    if prepared is None:
        prepared = prepare("vault/feeds/ingest", params)
    root = vault._root(settings)
    if not _index(root).is_file():
        raise VaultError("not_found", f"Subscription {ident} does not exist")
    with _writing(root) as db:
        new = _fetched(db, _source(db, ident), status, params, prepared, time.time())
        return {"source": _public_source(db, _source(db, ident)), "new": new}


def sources(settings, params):
    with _reading(vault._root(settings)) as db:
        if db is None:
            return {"sources": []}
        rows = db.execute(
            "SELECT * FROM sources ORDER BY COALESCE(category, ''), "
            "LOWER(COALESCE(NULLIF(title, ''), url))"
        ).fetchall()
        counts = {
            source: (total, unread)
            for source, total, unread in db.execute(
                "SELECT source_id, COUNT(*), SUM(state = 'inbox' AND read_at IS NULL) "
                "FROM items GROUP BY source_id"
            )
        }
        return {
            "sources": [
                _public_source(db, row, counts.get(row["id"], (0, 0))) for row in rows
            ]
        }


def due(settings, params):
    """Subscriptions to check now, earliest first; with a sourceId, that one whatever its
    state (the user asked to check it)."""
    limit = vault._integer(params, "limit", 1, 100, 20)
    only = params.get("sourceId")
    with _reading(vault._root(settings)) as db:
        if db is None:
            return {"sources": [], "nextAt": None}
        active = "status = 'active' AND paused = 0"
        if only is not None:
            rows = db.execute(
                "SELECT * FROM sources WHERE id = ?", (_source_id(only),)
            ).fetchall()
        else:
            rows = db.execute(
                f"SELECT * FROM sources WHERE {active} AND next_fetch_at <= ? "
                "ORDER BY next_fetch_at LIMIT ?",
                (time.time(), limit),
            ).fetchall()
        upcoming = db.execute(
            f"SELECT MIN(next_fetch_at) FROM sources WHERE {active}"
        ).fetchone()[0]
        return {
            "sources": [
                {
                    "id": row["id"],
                    "url": row["url"],
                    "etag": row["etag"] or "",
                    "lastModified": row["last_modified"] or "",
                }
                for row in rows
            ],
            # When the next subscription is due (milliseconds since the epoch), or None.
            "nextAt": int(upcoming * 1000) if upcoming is not None else None,
        }


def refresh(settings, params):
    """Makes every active subscription due now (the user asked to refresh them all)."""
    root = vault._root(settings)
    if not _index(root).is_file():
        return {"due": 0}
    with _writing(root) as db:
        count = db.execute(
            "UPDATE sources SET next_fetch_at = ? WHERE status = 'active' AND paused = 0",
            (time.time(),),
        ).rowcount
    return {"due": count}


def update(settings, params):
    """Renames, files or sets a subscription; retry makes a stopped one active again."""
    ident = _source_id(params.get("sourceId"))
    changes = {}
    if "title" in params:
        changes["title"] = vault._label(params["title"], "title")
    if "category" in params:
        changes["category"] = vault._label(params["category"], "category")[:200]
    value = params.get("settings")
    if value is not None and not isinstance(value, dict):
        raise VaultError("invalid_params", "settings must be an object")
    value = value or {}
    if "interval" in value:
        interval = value["interval"]
        if interval is not None and (
            isinstance(interval, bool)
            or not isinstance(interval, int)
            or not INTERVAL[0] <= interval <= INTERVAL[2]
        ):
            raise VaultError("invalid_params", "interval must be 30 to 1440 minutes")
    if value.get("fullText", "auto") not in ("auto", "always", "never"):
        raise VaultError("invalid_params", "fullText must be auto, always or never")
    root = vault._root(settings)
    if not _index(root).is_file():
        raise VaultError("not_found", f"Subscription {ident} does not exist")
    with _writing(root) as db:
        row = _source(db, ident)
        if value:
            current = _settings(row)
            for name in ("interval", "fullText"):
                if name in value:
                    current[name] = value[name]
            if "images" in value:
                current["images"] = value["images"] is True
            changes["settings"] = json.dumps(current)
            if "paused" in value:
                changes["paused"] = 1 if value["paused"] is True else 0
        if params.get("retry") is True:
            changes.update(
                status="active",
                failures=0,
                failing_since=None,
                next_fetch_at=time.time(),
            )
        if changes:
            columns = ", ".join(f"{name} = ?" for name in changes)
            db.execute(
                f"UPDATE sources SET {columns} WHERE id = ?", (*changes.values(), ident)
            )
        return {"source": _public_source(db, _source(db, ident))}


def unsubscribe(settings, params):
    """Removes a subscription and its items. Documents saved from it stay in the vault."""
    ident = _source_id(params.get("sourceId"))
    root = vault._root(settings)
    if not _index(root).is_file():
        return {"removed": False}
    with _writing(root) as db:
        removed = db.execute("DELETE FROM sources WHERE id = ?", (ident,)).rowcount
    return {"removed": bool(removed)}


def items(settings, params):
    """Items, newest first: unread or all, optionally of one subscription."""
    view = params.get("view", "unread")
    if view not in ("unread", "all"):
        raise VaultError("invalid_params", "view must be unread or all")
    limit = vault._integer(params, "limit", 1, 200, 50)
    offset = vault._integer(params, "offset", 0, 100_000, 0)
    where, args = [], []
    if params.get("sourceId") is not None:
        where.append("items.source_id = ?")
        args.append(_source_id(params["sourceId"]))
    if view == "unread":
        where.append("items.state = 'inbox' AND items.read_at IS NULL")
    clause = " WHERE " + " AND ".join(where) if where else ""
    with _reading(vault._root(settings)) as db:
        if db is None:
            return {"items": [], "total": 0}
        total = db.execute(f"SELECT COUNT(*) FROM items{clause}", args).fetchone()[0]
        rows = db.execute(
            "SELECT items.*, sources.title AS source_title FROM items "
            f"JOIN sources ON sources.id = items.source_id{clause} "
            "ORDER BY items.sort_at DESC LIMIT ? OFFSET ?",
            (*args, limit, offset),
        ).fetchall()
        return {"items": [_public_item(row) for row in rows], "total": total}


FULLTEXT_LIMIT = 4 * 1024 * 1024  # UTF-8 bytes of a page's cleaned full text
ITEM_URL = re.compile(r"(?:https?://|urn:tabgent:feed:[0-9a-f]{64}$)", re.IGNORECASE)
VIEWS = ("unread", "later", "archive", "all")
STATES = ("inbox", "later", "archive")


def _item_url(params):
    value = params.get("url")
    if not isinstance(value, str) or len(value) > 16384 or not ITEM_URL.match(value):
        raise VaultError("invalid_params", "url must be an item's address")
    return value.split("#", 1)[0]


def _item_urls(params):
    urls = params.get("urls")
    if not isinstance(urls, list) or not urls or len(urls) > 500:
        raise VaultError("invalid_params", "urls must list 1 to 500 item addresses")
    return list(dict.fromkeys(_item_url({"url": url}) for url in urls))


def open_item(settings, params):
    """The newest item at an address, for the reader, marked read. Also the feeds that
    list it, the subscription's settings, and the content to show: the cached full text,
    else the feed's own HTML (untrusted)."""
    url = _item_url(params)
    root = vault._root(settings)
    if not _index(root).is_file():
        raise VaultError("not_found", "This item is not in your subscriptions")
    with _writing(root) as db:
        rows = db.execute(
            "SELECT items.*, sources.title AS source_title, sources.url AS source_url, "
            "sources.settings AS source_settings FROM items JOIN sources "
            "ON sources.id = items.source_id WHERE items.url = ? ORDER BY items.sort_at DESC",
            (url,),
        ).fetchall()
        if not rows:
            raise VaultError("not_found", "This item is not in your subscriptions")
        db.execute(
            "UPDATE items SET read_at = ? WHERE url = ? AND read_at IS NULL",
            (_iso(time.time()), url),
        )
        row = rows[0]
        content = db.execute(
            "SELECT item_content.kind, item_content.html FROM items JOIN item_content "
            "ON item_content.item_id = items.id WHERE items.url = ? "
            "ORDER BY item_content.kind = 'fulltext' DESC, items.sort_at DESC LIMIT 1",
            (url,),
        ).fetchone()
        try:
            settings_value = json.loads(row["source_settings"] or "{}")
        except ValueError:
            settings_value = {}
        return {
            "item": {
                **_public_item(row),
                "key": row["key"],
                "sources": list(
                    dict.fromkeys(r["source_title"] or r["source_url"] for r in rows)
                ),
                "documentId": next(
                    (r["document_id"] for r in rows if r["document_id"]), None
                ),
            },
            "source": {
                "id": row["source_id"],
                "title": row["source_title"] or "",
                "url": row["source_url"],
                "settings": settings_value if isinstance(settings_value, dict) else {},
            },
            "content": (
                {"kind": content["kind"], "html": content["html"]} if content else None
            ),
        }


def mark(settings, params):
    """Read or unread, and inbox, later or archive, for the items at some addresses (every
    feed's entry there). A saved item's state is its document's, so state skips them.
    allRead marks every unread item of the inbox, or of one subscription, as read, with
    the other feeds' entries at the same addresses."""
    read = params.get("read")
    state = params.get("state")
    if read is not None and not isinstance(read, bool):
        raise VaultError("invalid_params", "read must be true or false")
    if state is not None and state not in STATES:
        raise VaultError("invalid_params", "state must be inbox, later or archive")
    every = params.get("allRead") is True
    source = (
        _source_id(params["sourceId"]) if params.get("sourceId") is not None else None
    )
    urls = None if every else _item_urls(params)
    root = vault._root(settings)
    if not _index(root).is_file():
        return {"changed": 0}
    now = _iso(time.time())
    with _writing(root) as db:
        if every:
            # By address, as the inbox lists them: an entry also in another feed is read too.
            clause = "state = 'inbox' AND read_at IS NULL AND document_id IS NULL"
            args = [now]
            if source:
                clause += " AND source_id = ?"
                args.append(source)
            changed = db.execute(
                "UPDATE items SET read_at = ? WHERE read_at IS NULL AND url IN "
                f"(SELECT url FROM items WHERE {clause})",
                args,
            ).rowcount
            return {"changed": changed}
        marks = ",".join("?" * len(urls))
        changed = 0
        if read is not None:
            changed = db.execute(
                f"UPDATE items SET read_at = ? WHERE url IN ({marks})",
                (now if read else None, *urls),
            ).rowcount
        if state is not None:
            changed = db.execute(
                f"UPDATE items SET state = ? WHERE url IN ({marks}) AND document_id IS NULL",
                (state, *urls),
            ).rowcount
        return {"changed": changed}


def save_content(settings, params):
    """Keeps the cleaned full text the reader extracted from an item's page."""
    url = _item_url(params)
    html = params.get("html")
    if not isinstance(html, str) or not html.strip():
        raise VaultError("invalid_params", "html must be the item's cleaned text")
    size = len(html.encode("utf-8"))
    if size > FULLTEXT_LIMIT:
        raise VaultError("invalid_params", "html is too long")
    root = vault._root(settings)
    if not _index(root).is_file():
        raise VaultError("not_found", "This item is not in your subscriptions")
    now = _iso(time.time())
    with _writing(root) as db:
        ids = [
            row[0] for row in db.execute("SELECT id FROM items WHERE url = ?", (url,))
        ]
        if not ids:
            raise VaultError("not_found", "This item is not in your subscriptions")
        for ident in ids:
            db.execute(
                "INSERT OR REPLACE INTO item_content (item_id, kind, html, bytes, fetched_at) "
                "VALUES (?, 'fulltext', ?, ?, ?)",
                (ident, html, size, now),
            )
    return {"saved": len(ids)}


def saved(settings, params):
    """Links the items at an address to the vault document saved from them. Their later or
    archive state moves to the document (document.library), which keeps it from then on.
    """
    url = _item_url(params)
    root = vault._root(settings)
    if not _index(root).is_file():
        return {"linked": 0}
    with _writing(root) as db:
        rows = db.execute(
            "SELECT id, state FROM items WHERE url = ? ORDER BY sort_at DESC", (url,)
        ).fetchall()
        if not rows:
            return {"linked": 0}
        data = vault._find(root, None, (url, "", "web", {}))
        if data is None:
            raise VaultError("not_found", "The document is not saved")
        state = next(
            (r["state"] for r in rows if r["state"] in ("later", "archive")), None
        )
        if state and not data["document"].get("library"):
            vault._set_library(data, state)
            vault._save(root, data)
        db.execute(
            "UPDATE items SET document_id = ?, state = NULL, read_at = COALESCE(read_at, ?) "
            "WHERE url = ?",
            (data["document"]["id"], _iso(time.time()), url),
        )
        return {"linked": len(rows), "documentId": data["document"]["id"]}


def library(settings, params):
    """The inbox list: items not saved yet in a view (unread, later, archive or all), and,
    for later and archive, saved documents marked so, newest first. One entry per address;
    a saved document wins over the items at its address."""
    view = params.get("view", "unread")
    if view not in VIEWS:
        raise VaultError("invalid_params", "view must be unread, later, archive or all")
    limit = vault._integer(params, "limit", 1, 200, 50)
    offset = vault._integer(params, "offset", 0, 100_000, 0)
    source = (
        _source_id(params["sourceId"]) if params.get("sourceId") is not None else None
    )
    root = vault._root(settings)
    entries, total = [], 0
    with _reading(root) as db:
        if db is not None:
            clause = {
                "unread": "items.state = 'inbox' AND items.read_at IS NULL "
                "AND items.document_id IS NULL",
                "later": "items.state = 'later' AND items.document_id IS NULL",
                "archive": "items.state = 'archive' AND items.document_id IS NULL",
                "all": "1",
            }[view]
            args = []
            if source:
                clause += " AND items.source_id = ?"
                args.append(source)
            total = db.execute(
                f"SELECT COUNT(DISTINCT items.url) FROM items WHERE {clause}", args
            ).fetchone()[0]
            rows = db.execute(
                "SELECT items.*, sources.title AS source_title FROM items JOIN sources "
                f"ON sources.id = items.source_id WHERE {clause} "
                "ORDER BY items.sort_at DESC LIMIT ?",
                (*args, (offset + limit) * 2 + 20),
            ).fetchall()
            by_url = {}
            for row in rows:
                entry = by_url.get(row["url"])
                if entry is not None:
                    if row["source_title"] not in entry["sources"]:
                        entry["sources"].append(row["source_title"] or "")
                    continue
                by_url[row["url"]] = entry = {
                    "kind": "item",
                    **_public_item(row),
                    "sources": [row["source_title"] or ""],
                    "read": row["read_at"] is not None,
                    "saved": row["document_id"] is not None,
                    "sortAt": row["sort_at"],
                }
                entries.append(entry)
    if view in ("later", "archive") and not source:
        documents = vault.library_documents(root, (view,))
        addresses = {entry["document"]["url"] for entry in documents}
        entries = [entry for entry in entries if entry["url"] not in addresses]
        total += len(documents)
        for found in documents:
            document = found["document"]
            entries.append(
                {
                    "kind": "document",
                    "id": document["id"],
                    "documentId": document["id"],
                    "url": document["url"],
                    "link": (
                        document["url"]
                        if re.match(r"https?://", document["url"])
                        else ""
                    ),
                    "title": document["title"],
                    "author": document.get("author", ""),
                    "documentKind": document["kind"],
                    "publishedAt": None,
                    "summary": "",
                    "sources": [],
                    "state": document["library"]["state"],
                    "read": True,
                    "saved": True,
                    "clip": bool(found["clip"] and found["clip"].get("complete")),
                    "sortAt": vault._instant(document["library"]["updatedAt"]),
                }
            )
    entries.sort(key=lambda entry: entry["sortAt"], reverse=True)
    page = entries[offset : offset + limit]
    for entry in page:
        entry.pop("sortAt", None)
    return {"items": page, "total": total}


def opml_parse(settings, params, prepared=None):
    try:
        return {"outlines": parse_opml(params.get("text"))}
    except FeedError as error:
        raise VaultError("invalid_feed", str(error))


def opml_export(settings, params):
    """The subscriptions as OPML 2.0, grouped by category."""
    groups = {}
    for source in sources(settings, {})["sources"]:
        groups.setdefault(source["category"], []).append(source)

    def outline(source):
        name = _escape(source["title"] or source["url"], True)
        site = source["siteUrl"]
        return (
            f'<outline type="rss" text="{name}" title="{name}" '
            f'xmlUrl="{_escape(source["url"], True)}"'
            + (f' htmlUrl="{_escape(site, True)}"' if site else "")
            + "/>"
        )

    body = []
    for category, members in groups.items():
        if category:
            body.append(f'    <outline text="{_escape(category, True)}">')
            body += [f"      {outline(source)}" for source in members]
            body.append("    </outline>")
        else:
            body += [f"    {outline(source)}" for source in members]
    text = "\n".join(
        [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<opml version="2.0">',
            "  <head><title>Tabgent subscriptions</title></head>",
            "  <body>",
            *body,
            "  </body>",
            "</opml>",
            "",
        ]
    )
    return {"text": text, "count": sum(len(members) for members in groups.values())}


METHODS = {
    "vault/feeds/preview": preview,
    "vault/feeds/subscribe": subscribe,
    "vault/feeds/unsubscribe": unsubscribe,
    "vault/feeds/update": update,
    "vault/feeds/sources": sources,
    "vault/feeds/due": due,
    "vault/feeds/refresh": refresh,
    "vault/feeds/ingest": ingest,
    "vault/feeds/items": items,
    "vault/feeds/open": open_item,
    "vault/feeds/mark": mark,
    "vault/feeds/content": save_content,
    "vault/feeds/saved": saved,
    "vault/feeds/library": library,
    "vault/feeds/opml/parse": opml_parse,
    "vault/feeds/opml/export": opml_export,
}
# The host parses these on its feed thread, outside the vault queue and lock. Preview and
# OPML parsing need no vault at all; ingest and subscribe then write on the vault queue.
PARSE_ONLY = {"vault/feeds/preview", "vault/feeds/opml/parse"}
PARSING = {"vault/feeds/preview", "vault/feeds/subscribe", "vault/feeds/ingest"}


def handle(settings, method, params, prepared=None):
    """One feed request, answered as vault.handle answers vault requests."""
    action = METHODS.get(method) if isinstance(method, str) else None

    def run(settings, params):
        try:
            if method in PARSE_ONLY or method in PARSING:
                return action(settings, params, prepared)
            return action(settings, params)
        except sqlite3.DatabaseError as error:
            raise VaultError("io_error", f"The subscriptions index failed: {error}")

    return vault.handle_with({method: run} if action else {}, settings, method, params)
