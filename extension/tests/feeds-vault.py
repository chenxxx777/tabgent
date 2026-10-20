"""Subscriptions in the ReadingVault (.tabgent/feeds.db): subscribing, the first fetch's
20 unread items, deduplication, retention, scheduling and backoff, moved feeds, OPML,
and host routing that parses feeds before the vault queue. Generated fixtures only.
"""

import base64
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
from unittest.mock import patch

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent / "native"))
import feeds
import vault


def call(settings, method, params, prepared=None):
    reply = feeds.handle(settings, method, params, prepared)
    assert set(reply) == {"result"}, (method, reply)
    return reply["result"]


def code(settings, method, params):
    reply = feeds.handle(settings, method, params)
    assert set(reply) == {"error"}, (method, reply)
    return reply["error"]["code"]


def rss(entries, title="Fixture feed"):
    items = "".join(
        f"<item><title>{name}</title><guid>{key}</guid><link>https://site.example/{key}</link>"
        f"<pubDate>{date}</pubDate><description>About {name}</description></item>"
        for key, name, date in entries
    )
    xml = f'<?xml version="1.0"?><rss><channel><title>{title}</title>'
    xml += f"<link>https://site.example/</link>{items}</channel></rss>"
    return base64.b64encode(xml.encode()).decode()


def day(n):
    return time.strftime(
        "%a, %d %b %Y %H:%M:%S +0000", time.gmtime(1_700_000_000 + n * 3600)
    )


def entries(numbers):
    return [(f"post-{n}", f"Post {n}", day(n)) for n in numbers]


def fetch(settings, source, numbers, status=200, **extra):
    params = {"sourceId": source, "status": status, **extra}
    if numbers is not None:
        params["data"] = rss(entries(numbers))
    return call(settings, "vault/feeds/ingest", params)


def unread(settings, source=None):
    params = {"view": "unread", "limit": 200}
    if source:
        params["sourceId"] = source
    return call(settings, "vault/feeds/items", params)


with tempfile.TemporaryDirectory(prefix="tabgent-feeds-vault-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    root = base / "ReadingVault"
    index = root / ".tabgent/feeds.db"
    with patch.object(vault, "default_path", lambda: root):
        # Reading creates nothing.
        assert call(settings, "vault/feeds/sources", {}) == {"sources": []}
        assert call(settings, "vault/feeds/items", {}) == {"items": [], "total": 0}
        assert call(settings, "vault/feeds/due", {}) == {"sources": [], "nextAt": None}
        assert call(settings, "vault/feeds/refresh", {}) == {"due": 0}
        assert call(
            settings, "vault/feeds/unsubscribe", {"sourceId": "feed-000000000000"}
        ) == {"removed": False}
        assert not root.exists()

        # Preview reads without saving; a page that is not a feed is refused.
        preview = call(
            settings, "vault/feeds/preview", {"data": rss(entries(range(5)))}
        )
        assert preview["title"] == "Fixture feed" and preview["count"] == 5
        assert [i["title"] for i in preview["items"]] == ["Post 0", "Post 1", "Post 2"]
        page = base64.b64encode(b"<html><body>hello</body></html>").decode()
        assert code(settings, "vault/feeds/preview", {"data": page}) == "invalid_feed"
        assert (
            code(settings, "vault/feeds/subscribe", {"url": "ftp://x"})
            == "invalid_params"
        )
        assert (
            code(
                settings,
                "vault/feeds/subscribe",
                {"url": "https://a.example/", "data": page},
            )
            == "invalid_feed"
        )
        assert not root.exists()

        # A new subscription imports its 20 newest entries as unread; older ones never come.
        result = call(
            settings,
            "vault/feeds/subscribe",
            {
                "url": "https://site.example/feed.xml#top",
                "data": rss(entries(range(30))),
                "headers": {
                    "etag": '"v1"',
                    "lastModified": "Tue, 01 Jul 2025 00:00:00 GMT",
                },
            },
        )
        source = result["source"]["id"]
        assert result["created"] and result["new"] == 20, result
        assert result["source"]["url"] == "https://site.example/feed.xml"
        assert (
            result["source"]["title"] == "Fixture feed"
            and result["source"]["unread"] == 20
        )
        listed = unread(settings)
        assert listed["total"] == 20
        assert [i["title"] for i in listed["items"][:2]] == ["Post 29", "Post 28"]
        assert listed["items"][0]["sourceTitle"] == "Fixture feed"
        assert listed["items"][0]["url"] == "https://site.example/post-29"
        assert index.is_file() and not (root / "Articles").exists()
        # Subscribing again to the same address changes nothing.
        again = call(
            settings, "vault/feeds/subscribe", {"url": "https://site.example/feed.xml"}
        )
        assert not again["created"] and again["source"]["id"] == source

        # Not due yet; the next check honours the feed's schedule.
        due = call(settings, "vault/feeds/due", {})
        assert (
            due["sources"] == [] and due["nextAt"] > time.time() * 1000 + 25 * 60 * 1000
        )
        assert call(settings, "vault/feeds/refresh", {}) == {"due": 1}
        forced = call(settings, "vault/feeds/due", {})["sources"]
        assert forced == [
            {
                "id": source,
                "url": "https://site.example/feed.xml",
                "etag": '"v1"',
                "lastModified": "Tue, 01 Jul 2025 00:00:00 GMT",
            }
        ], forced

        # Old entries the feed shows again are not new; changed entries are updated.
        assert fetch(settings, source, range(5, 31))["new"] == 1  # only post-30
        assert unread(settings)["total"] == 21
        changed = rss([("post-30", "Post 30 (edited)", day(30))])
        call(
            settings,
            "vault/feeds/ingest",
            {"sourceId": source, "status": 200, "data": changed},
        )
        assert unread(settings)["items"][0]["title"] == "Post 30 (edited)"
        # A new guid for the same link is the same item.
        moved = rss([("post-30-v2", "Post 30", day(30))])
        xml = (
            base64.b64decode(moved)
            .decode()
            .replace(
                "https://site.example/post-30-v2",
                "https://site.example/post-30?utm_source=rss",
            )
        )
        moved = base64.b64encode(xml.encode()).decode()
        assert fetch(settings, source, None, data=moved)["new"] == 0

        # 304 keeps everything and schedules the next check.
        before = time.time()
        result = fetch(settings, source, None, status=304)
        assert result["new"] == 0 and result["source"]["failures"] == 0
        with sqlite3.connect(index) as db:
            next_at = db.execute("SELECT next_fetch_at FROM sources").fetchone()[0]
        assert before + 30 * 60 * 0.9 <= next_at <= before + 24 * 3600 * 1.1

        # Failures back off; 429 honours Retry-After; 410 stops the subscription.
        result = fetch(settings, source, None, status=0, error="Network unreachable")
        assert result["source"]["failures"] == 1
        assert result["source"]["lastError"] == "Network unreachable"
        result = fetch(settings, source, None, status=429, headers={"retryAfter": 7200})
        with sqlite3.connect(index) as db:
            next_at = db.execute("SELECT next_fetch_at FROM sources").fetchone()[0]
        assert 7200 * 0.9 <= next_at - time.time() <= 7200 * 1.1
        bad = base64.b64encode(b"<rss><channel>").decode()
        result = fetch(settings, source, None, data=bad)
        assert (
            result["source"]["failures"] == 3
            and "valid" in result["source"]["lastError"]
        )
        result = fetch(settings, source, None, status=410)
        assert result["source"]["status"] == "gone"
        assert call(settings, "vault/feeds/refresh", {}) == {"due": 0}
        assert call(settings, "vault/feeds/due", {}) == {"sources": [], "nextAt": None}
        retried = call(
            settings, "vault/feeds/update", {"sourceId": source, "retry": True}
        )
        assert (
            retried["source"]["status"] == "active"
            and retried["source"]["failures"] == 0
        )
        assert call(settings, "vault/feeds/due", {})["sources"][0]["id"] == source
        for _ in range(3):
            result = fetch(settings, source, None, status=403)
        assert result["source"]["status"] == "refused"
        call(settings, "vault/feeds/update", {"sourceId": source, "retry": True})

        # A feed that answers from another address three times in a row has moved.
        for n in range(3):
            result = fetch(
                settings,
                source,
                None,
                status=304,
                finalUrl="https://new.example/feed.xml",
            )
            expected = (
                "https://new.example/feed.xml"
                if n == 2
                else "https://site.example/feed.xml"
            )
            assert result["source"]["url"] == expected, (n, result["source"]["url"])

        # Settings: paused subscriptions are not due; the interval is bounded.
        update = lambda values: call(
            settings, "vault/feeds/update", {"sourceId": source, **values}
        )
        assert update({"settings": {"interval": 90}})["source"]["settings"] == {
            "interval": 90,
            "paused": False,
        }
        assert (
            code(
                settings,
                "vault/feeds/update",
                {"sourceId": source, "settings": {"interval": 5}},
            )
            == "invalid_params"
        )
        assert (
            code(
                settings,
                "vault/feeds/update",
                {"sourceId": source, "settings": {"fullText": "x"}},
            )
            == "invalid_params"
        )
        update(
            {
                "settings": {"paused": True},
                "title": "  Renamed   feed ",
                "category": "Tech",
            }
        )
        call(settings, "vault/feeds/refresh", {})
        assert call(settings, "vault/feeds/due", {}) == {"sources": [], "nextAt": None}
        named = call(settings, "vault/feeds/due", {"sourceId": source})["sources"]
        assert [s["id"] for s in named] == [source]
        listed = call(settings, "vault/feeds/sources", {})["sources"]
        assert listed[0]["title"] == "Renamed feed" and listed[0]["category"] == "Tech"
        update({"settings": {"paused": False}})

        # Unread items are bounded; the oldest are archived, then the oldest records go.
        result = fetch(settings, source, range(100, 300))
        assert result["new"] == 200
        assert unread(settings)["total"] == feeds.UNREAD_LIMIT
        assert unread(settings)["items"][-1]["title"] == "Post 100"
        everything = call(settings, "vault/feeds/items", {"view": "all", "limit": 1})
        assert everything["total"] == 221, everything["total"]
        for start in range(300, 800, 200):
            fetch(settings, source, range(start, start + 200))
        everything = call(settings, "vault/feeds/items", {"view": "all", "limit": 1})
        assert everything["total"] == feeds.KEEP_ITEMS, everything["total"]
        # Keys stay in seen, so trimmed entries never come back as new.
        assert fetch(settings, source, range(100, 300))["new"] == 0
        assert (
            code(settings, "vault/feeds/items", {"view": "later"}) == "invalid_params"
        )

        # A subscription added from OPML without a fetch is due after its delay; its first
        # fetch imports 20 unread items too.
        second = call(
            settings,
            "vault/feeds/subscribe",
            {"url": "https://two.example/rss", "title": "Two", "category": "News"},
        )["source"]["id"]
        due = call(settings, "vault/feeds/due", {})["sources"]
        assert [s["id"] for s in due] == [second]
        assert fetch(settings, second, range(40))["new"] == 20
        assert unread(settings, second)["total"] == 20

        # OPML export and the round trip.
        exported = call(settings, "vault/feeds/opml/export", {})
        assert exported["count"] == 2
        outlines = call(settings, "vault/feeds/opml/parse", {"text": exported["text"]})[
            "outlines"
        ]
        assert {(o["url"], o["category"]) for o in outlines} == {
            ("https://new.example/feed.xml", "Tech"),
            ("https://two.example/rss", "News"),
        }, outlines
        assert outlines[0]["title"] in ("Renamed feed", "Two")
        assert (
            code(settings, "vault/feeds/opml/parse", {"text": "<opml"})
            == "invalid_feed"
        )

        # Unsubscribing removes its items; documents saved from it are not touched.
        assert call(settings, "vault/feeds/unsubscribe", {"sourceId": second}) == {
            "removed": True
        }
        assert unread(settings, None)["total"] == feeds.UNREAD_LIMIT
        assert code(
            settings, "vault/feeds/ingest", {"sourceId": second, "status": 304}
        ) == ("not_found")
        assert (
            code(settings, "vault/feeds/update", {"sourceId": "x"}) == "invalid_params"
        )
        assert code(settings, "vault/feeds/nope", {}) == "unknown_method"

    # A symbolic link at the index's place is refused.
    other = base / "Linked"
    (other / ".tabgent").mkdir(parents=True)
    (base / "elsewhere.db").write_bytes(b"")
    (other / ".tabgent/feeds.db").symlink_to(base / "elsewhere.db")
    with patch.object(vault, "default_path", lambda: other):
        assert code(settings, "vault/feeds/sources", {}) == "io_error"
        assert (
            code(settings, "vault/feeds/subscribe", {"url": "https://a.example/"})
            == "io_error"
        )

    # A newer index is not changed.
    newer = base / "Newer"
    (newer / ".tabgent").mkdir(parents=True)
    with sqlite3.connect(newer / ".tabgent/feeds.db") as db:
        db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
        db.execute("INSERT INTO meta VALUES ('schema', '99')")
    with patch.object(vault, "default_path", lambda: newer):
        assert code(settings, "vault/feeds/sources", {}) == "io_error"
        assert (
            code(settings, "vault/feeds/subscribe", {"url": "https://a.example/"})
            == "io_error"
        )

# The host parses feeds on its feed thread, then writes on the vault queue in order.
sys.path.insert(0, str(TESTS.parent / "native"))
import host

sent = []
with tempfile.TemporaryDirectory(prefix="tabgent-feeds-host-") as directory:
    root = Path(directory) / "ReadingVault"
    with patch.object(vault, "default_path", lambda: root), patch.object(
        host, "send", sent.append
    ), patch.object(host, "HOME", Path(directory) / "codex"):
        parsed = []
        original = feeds.prepare

        def prepare(method, params):
            parsed.append(method)
            return original(method, params)

        with patch.object(feeds, "prepare", prepare):
            host.handle(
                {
                    "op": "vault",
                    "id": "a",
                    "method": "vault/feeds/subscribe",
                    "params": {
                        "url": "https://h.example/rss",
                        "data": rss(entries(range(3))),
                    },
                }
            )
            host.handle(
                {
                    "op": "vault",
                    "id": "b",
                    "method": "vault/feeds/opml/parse",
                    "params": {"text": "<opml><body/></opml>"},
                }
            )
            host.FEED_POOL.submit(lambda: None).result()
            host.VAULT_POOL.submit(lambda: None).result()
            host.handle(
                {
                    "op": "vault",
                    "id": "c",
                    "method": "vault/feeds/sources",
                    "params": {},
                }
            )
            host.VAULT_POOL.submit(lambda: None).result()
        replies = {reply["id"]: reply for reply in sent}
        assert parsed == ["vault/feeds/subscribe"], parsed
        # A method that is not a string is refused, and the connector keeps reading.
        host.handle({"op": "vault", "id": "odd", "method": ["vault/feeds/preview"]})
        host.VAULT_POOL.submit(lambda: None).result(timeout=10)
        odd = next(reply for reply in sent if reply["id"] == "odd")
        assert odd["error"]["code"] == "unknown_method", odd

        # Parsing a feed never holds the vault queue: a request sent while a feed is being
        # parsed is answered first.
        parsing, release = threading.Event(), threading.Event()
        real_parse = feeds.parse

        def slow_parse(*args):
            parsing.set()
            assert release.wait(10)
            return real_parse(*args)

        with patch.object(feeds, "parse", slow_parse):
            host.handle(
                {
                    "op": "vault",
                    "id": "slow",
                    "method": "vault/feeds/subscribe",
                    "params": {
                        "url": "https://slow.example/rss",
                        "data": rss(entries([1])),
                    },
                }
            )
            assert parsing.wait(10)
            host.handle(
                {
                    "op": "vault",
                    "id": "quick",
                    "method": "vault/feeds/sources",
                    "params": {},
                }
            )
            host.VAULT_POOL.submit(lambda: None).result(timeout=10)
            done = {reply["id"] for reply in sent}
            assert "quick" in done and "slow" not in done, done
            release.set()
            host.FEED_POOL.submit(lambda: None).result(timeout=10)
            host.VAULT_POOL.submit(lambda: None).result(timeout=10)
        replies = {reply["id"]: reply for reply in sent}
        assert replies["slow"]["result"]["new"] == 1, replies["slow"]
        assert replies["a"]["result"]["new"] == 3, replies["a"]
        assert replies["b"]["result"] == {"outlines": []}
        assert [s["url"] for s in replies["c"]["result"]["sources"]] == [
            "https://h.example/rss"
        ]
print("feeds-vault: ok")
