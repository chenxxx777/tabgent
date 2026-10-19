"""EPUB import into the ReadingVault: chunked originals, chapter Markdown, books list,
EPUB anchors, and the host route for large source reads. Uses a generated fixture."""

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import sys
import tempfile
from unittest.mock import patch
import zipfile

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent / "native"))
sys.path.insert(0, str(TESTS / "fixtures"))
import epub_fixture
import epub_text
import host
import vault

BOOK = epub_fixture.build()
DIGEST = hashlib.sha256(BOOK).hexdigest()
URL = "urn:sha256:" + DIGEST


def call(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"result"}, (method, reply)
    return reply["result"]


def code(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"error"}, (method, reply)
    return reply["error"]["code"]


def b64(data):
    return base64.b64encode(data).decode("ascii")


def save(settings, offset, data, **extra):
    params = {
        "url": URL,
        "title": epub_fixture.TITLE,
        "kind": "epub",
        "meta": {"author": epub_fixture.AUTHOR},
        "sha256": DIGEST,
        "size": len(BOOK),
        "offset": offset,
        "data": b64(data),
        "name": "small-book.epub",
        **extra,
    }
    return call(settings, "vault/source/save", params)


def epub_anchor(exact, chapter="OEBPS/ch1.xhtml"):
    return {
        "kind": "epub",
        "cfi": "epubcfi(/6/4!/4/4,/1:0,/1:8)",
        "quote": {"exact": exact, "prefix": "", "suffix": " does not"},
        "chapter": {"href": chapter, "title": "Chapter One: Beginnings"},
        "position": {"start": 26, "end": 34},
    }


# Chapter extraction
with tempfile.TemporaryDirectory(prefix="tabgent-epub-") as directory:
    path = Path(directory) / "book.epub"
    path.write_bytes(BOOK)
    book = epub_text.extract(path)
    assert book["metadata"] == {
        "title": epub_fixture.TITLE,
        "author": epub_fixture.AUTHOR,
        "language": "en",
        "date": "2026-01-01",
    }
    chapters = book["chapters"]
    # The cover has no text and is skipped; spine indexes are kept.
    assert [(c["index"], c["href"], c["title"]) for c in chapters] == [
        (1, "OEBPS/ch1.xhtml", "Chapter One: Beginnings"),
        (2, "OEBPS/ch2.xhtml", "Chapter Two: Repetition"),
        (3, "OEBPS/ch3.xhtml", "Chapter Three: Endings"),
    ]
    first, second, third = (c["markdown"] for c in chapters)
    assert first.startswith("# Chapter One: Beginnings\n\nAutonomy does not mean")
    assert "one’s own actions." in first
    assert "- First idea\n- Second idea\n  - Nested idea" in first
    assert "> A quoted passage from another book." in first
    assert "SCRIPT-RAN" not in first and "tabgentScriptRan" not in first
    assert "A javascript link and an external link." in first
    assert "[image: remote pixel]" in first
    assert "## 2.1 A subsection" in second
    assert "自主性并不意味着独立于他人" in second
    assert "```\ncode  keeps   spacing\nsecond line\n```" in second
    assert "CFI | Canonical Fragment Identifier" in second
    assert "Line one of a poem\nline two of a poem" in third

    # EPUB 2: titles from the NCX when there is no navigation document.
    ncx_book = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(BOOK)) as source, zipfile.ZipFile(
        ncx_book, "w"
    ) as target:
        for info in source.infolist():
            data = source.read(info)
            if info.filename == "OEBPS/content.opf":
                text = data.decode()
                text = text.replace(' properties="nav"', "").replace(
                    "<spine>", '<spine toc="ncx">'
                )
                text = text.replace(
                    "</manifest>",
                    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
                    "</manifest>",
                )
                data = text.encode()
            target.writestr(info, data)
        target.writestr(
            "OEBPS/toc.ncx",
            '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"'
            ' version="2005-1"><navMap><navPoint id="n1"><navLabel><text>From NCX'
            '</text></navLabel><content src="ch3.xhtml"/></navPoint></navMap></ncx>',
        )
    path.write_bytes(ncx_book.getvalue())
    titles = [c["title"] for c in epub_text.extract(path)["chapters"]]
    # The nav document still exists as a plain manifest item, but has no nav role now.
    assert titles == ["Chapter One: Beginnings", "Chapter Two: Repetition", "From NCX"]

    # Hostile or broken archives fail cleanly instead of being expanded.
    path.write_bytes(b"not a zip")
    try:
        epub_text.extract(path)
        raise AssertionError("expected EpubError")
    except epub_text.EpubError:
        pass
    bomb = io.BytesIO()
    with zipfile.ZipFile(bomb, "w") as archive:
        archive.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><container/>',
        )
    path.write_bytes(bomb.getvalue())
    try:
        epub_text.extract(path)
        raise AssertionError("expected EpubError")
    except epub_text.EpubError as error:
        assert "entities" in str(error)
    with patch.object(epub_text, "ENTRY_LIMIT", 100):
        path.write_bytes(BOOK)
        try:
            epub_text.extract(path)
            raise AssertionError("expected EpubError")
        except epub_text.EpubError as error:
            assert "too large" in str(error)
print("PASS EPUB chapter extraction: titles, Markdown blocks, scripts skipped, limits")


with tempfile.TemporaryDirectory(prefix="tabgent-epub-vault-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    root = base / "ReadingVault"
    with patch.object(vault, "default_path", lambda: root):
        # A progress check for an unknown book writes nothing, not even the vault.
        probe = save(settings, 0, b"")
        assert probe == {
            "document": None,
            "complete": False,
            "received": 0,
            "source": None,
        }
        assert not root.exists()
        assert call(settings, "vault/books/list", {}) == {"books": []}

        # Chunks append in order; a wrong offset is ignored and reports progress.
        half = len(BOOK) // 2
        assert save(settings, 0, BOOK[:1000])["received"] == 1000
        assert save(settings, 5, BOOK[5:1000])["received"] == 1000
        assert save(settings, 0, b"")["received"] == 1000  # Resume point.
        upload = root / ".tabgent/uploads" / f"{DIGEST}.part"
        assert upload.stat().st_size == 1000
        assert save(settings, 1000, BOOK[1000:half])["complete"] is False
        assert not (root / "Books").exists() or not any((root / "Books").iterdir())

        # A highlight before the import finishes creates the same document.
        created = call(
            settings,
            "vault/highlight/create",
            {
                "url": URL,
                "title": epub_fixture.TITLE,
                "kind": "epub",
                "meta": {"author": epub_fixture.AUTHOR},
                "text": "Autonomy",
                "anchor": epub_anchor("Autonomy"),
                "location": "Chapter One: Beginnings",
            },
        )
        document = created["document"]
        assert re.fullmatch(r"book-a-small-book-of-reading-[0-9a-f]{8}", document["id"])
        assert document["url"] == URL and document["kind"] == "epub"
        assert created["highlight"]["anchor"] == epub_anchor("Autonomy")
        assert created["highlight"]["location"] == "Chapter One: Beginnings"
        assert save(settings, half, b"")["document"]["id"] == document["id"]

        done = save(settings, half, BOOK[half:])
        assert done["complete"] is True and done["received"] == len(BOOK)
        assert done["document"]["id"] == document["id"]
        folder = Path(done["document"]["folder"])
        assert folder == root / "Books" / document["id"]
        assert (folder / "original.epub").read_bytes() == BOOK
        assert not upload.exists()
        source = done["source"]
        assert source["path"] == str(folder / "original.epub")
        assert source["sha256"] == DIGEST and source["size"] == len(BOOK)
        assert source["name"] == "small-book.epub"
        assert source["chaptersPath"] == str(folder / "chapters")
        assert [c["file"] for c in source["chapters"]] == [
            "chapters/01-chapter-one-beginnings.md",
            "chapters/02-chapter-two-repetition.md",
            "chapters/03-chapter-three-endings.md",
        ]
        assert source["chapters"][1] == {
            "number": 2,
            "index": 2,
            "href": "OEBPS/ch2.xhtml",
            "title": "Chapter Two: Repetition",
            "file": "chapters/02-chapter-two-repetition.md",
            "chars": source["chapters"][1]["chars"],
        }
        chapter = (folder / "chapters/02-chapter-two-repetition.md").read_text()
        assert chapter.startswith(
            "---\n"
            'title: "Chapter Two: Repetition"\n'
            'book: "A Small Book of Reading"\n'
            f"document_id: {document['id']}\n"
            "chapter: 2\n"
            'href: "OEBPS/ch2.xhtml"\n'
            "---\n\n# Chapter Two: Repetition\n"
        )
        record = json.loads((folder / "source.json").read_text())
        assert record["metadata"]["author"] == epub_fixture.AUTHOR
        assert sorted(p.name for p in folder.iterdir()) == [
            "anchors.json",
            "chapters",
            "highlights.md",
            "original.epub",
            "source.json",
        ]
        agents = (root / "AGENTS.md").read_text()
        assert "original.epub" in agents and "/chapters" in agents
        # W1's highlight record is untouched by the import.
        markdown = (folder / "highlights.md").read_text()
        assert "type: book" in markdown and "> Autonomy" in markdown
        assert "位置：Chapter One: Beginnings" in markdown

        # Re-importing the same file is a no-op that reports the stored original.
        again = save(settings, 0, b"")
        assert again["complete"] is True and again["source"]["sha256"] == DIGEST
        assert save(settings, 0, BOOK[:10]) == again
        assert not upload.exists()
        # Deleted chapter files are regenerated from the stored EPUB.
        (folder / "chapters/01-chapter-one-beginnings.md").unlink()
        save(settings, 0, b"")
        assert (folder / "chapters/01-chapter-one-beginnings.md").is_file()
        assert not [p for p in folder.iterdir() if p.name.startswith(".chapters")]

        # Reading the original back in bounded chunks.
        read = call(
            settings,
            "vault/source/read",
            {"documentId": document["id"], "offset": 0, "length": 1000},
        )
        assert base64.b64decode(read["data"]) == BOOK[:1000]
        assert read["eof"] is False and read["offset"] == 0
        assert read["source"]["sha256"] == DIGEST
        assert read["document"]["id"] == document["id"]
        rest = call(
            settings,
            "vault/source/read",
            {"documentId": document["id"], "offset": 1000},
        )
        assert base64.b64decode(rest["data"]) == BOOK[1000:] and rest["eof"] is True
        end = call(
            settings,
            "vault/source/read",
            {"documentId": document["id"], "offset": len(BOOK)},
        )
        assert end["data"] == "" and end["eof"] is True

        books = call(settings, "vault/books/list", {})["books"]
        assert len(books) == 1
        listed = books[0]
        assert listed["id"] == document["id"] and listed["title"] == epub_fixture.TITLE
        assert listed["author"] == epub_fixture.AUTHOR
        assert listed["highlightCount"] == 1 and listed["updatedAt"]
        assert listed["source"]["chapters"] == source["chapters"]
        assert call(settings, "vault/books/list", {"kind": "pdf"}) == {"books": []}

        # A web page and a book without an original are not books to reopen.
        call(
            settings,
            "vault/highlight/create",
            {
                "url": "urn:sha256:" + "0" * 64,
                "title": "Never imported",
                "kind": "epub",
                "text": "x",
                "anchor": epub_anchor("x"),
            },
        )
        assert len(call(settings, "vault/books/list", {})["books"]) == 1

        # A corrupt source record is skipped in the list but reported on read.
        (folder / "source.json").write_text("{}")
        assert call(settings, "vault/books/list", {}) == {"books": []}
        assert (
            code(settings, "vault/source/read", {"documentId": document["id"]})
            == "io_error"
        )
        (folder / "source.json").write_text(json.dumps(record))

        # Validation.
        bad = {
            "url": URL,
            "title": "x",
            "kind": "epub",
            "sha256": DIGEST,
            "size": 10,
            "offset": 0,
        }
        for params in [
            {**bad, "kind": "web"},
            {**bad, "sha256": DIGEST.upper()},
            {**bad, "sha256": "abc"},
            {**bad, "size": 0},
            {**bad, "size": vault.SOURCE_LIMIT + 1},
            {**bad, "size": True},
            {**bad, "offset": 11},
            {**bad, "offset": -1},
            {**bad, "data": "not base64!"},
            {**bad, "data": b64(b"x" * 11)},
            {**bad, "data": "A" * (vault.CHUNK_LIMIT // 3 * 4 + 8)},
            {**bad, "url": ""},
        ]:
            assert (
                code(settings, "vault/source/save", params) == "invalid_params"
            ), params
        for params in [
            {},
            {"documentId": "nope"},
            {"documentId": document["id"], "offset": -1},
            {"documentId": document["id"], "length": vault.CHUNK_LIMIT + 1},
            {"documentId": document["id"], "offset": len(BOOK) + 1},
        ]:
            assert (
                code(settings, "vault/source/read", params) == "invalid_params"
            ), params
        assert (
            code(settings, "vault/source/read", {"documentId": "book-missing-00000000"})
            == "not_found"
        )
        assert code(settings, "vault/books/list", {"kind": "web"}) == "invalid_params"

        # A file that does not match its hash is discarded, never stored.
        tampered = b"PK" + BOOK[2:]
        digest = hashlib.sha256(b"different").hexdigest()
        wrong = {
            "url": "urn:sha256:" + digest,
            "title": "Wrong",
            "kind": "epub",
            "sha256": digest,
            "size": len(tampered),
            "offset": 0,
            "data": b64(tampered),
        }
        assert code(settings, "vault/source/save", wrong) == "invalid_params"
        assert not (root / ".tabgent/uploads" / f"{digest}.part").exists()
        # The stored original is immutable: another hash for the same document fails.
        assert (
            code(
                settings,
                "vault/source/save",
                {**wrong, "url": URL, "data": b64(b"x"), "size": 1},
            )
            == "invalid_params"
        )

        # EPUB anchors need a CFI and a quote; other kinds are unchanged.
        page = {"url": URL, "title": "x", "kind": "epub", "text": "Autonomy"}
        for broken in [
            {**epub_anchor("Autonomy"), "cfi": None},
            {**epub_anchor("Autonomy"), "cfi": "/6/4!/4"},
            {**epub_anchor("Autonomy"), "quote": {"exact": ""}},
        ]:
            assert (
                code(settings, "vault/highlight/create", {**page, "anchor": broken})
                == "invalid_params"
            )
        retried = call(
            settings,
            "vault/highlight/create",
            {**page, "anchor": epub_anchor("Autonomy")},
        )
        assert retried["highlight"]["id"] == created["highlight"]["id"]

        # Abandoned partial uploads are pruned when a new upload starts.
        stale = root / ".tabgent/uploads" / ("f" * 64 + ".part")
        stale.write_bytes(b"x")
        os.utime(stale, (1, 1))
        fresh_book = epub_fixture.build(title="Second Book")
        fresh = hashlib.sha256(fresh_book).hexdigest()
        result = call(
            settings,
            "vault/source/save",
            {
                "url": "urn:sha256:" + fresh,
                "title": "Second Book",
                "kind": "epub",
                "sha256": fresh,
                "size": len(fresh_book),
                "offset": 0,
                "data": b64(fresh_book),
            },
        )
        assert result["complete"] and not stale.exists()
        titles = {b["title"] for b in call(settings, "vault/books/list", {})["books"]}
        assert titles == {"A Small Book of Reading", "Second Book"}

        # A book whose archive cannot be read is still stored, without chapters.
        broken_book = b"PK\x03\x04 not really a zip"
        broken = hashlib.sha256(broken_book).hexdigest()
        result = call(
            settings,
            "vault/source/save",
            {
                "url": "urn:sha256:" + broken,
                "title": "Broken",
                "kind": "epub",
                "sha256": broken,
                "size": len(broken_book),
                "offset": 0,
                "data": b64(broken_book),
            },
        )
        assert result["complete"] and result["source"]["chapters"] == []
        assert "chapterError" in result["source"]
print("PASS vault/source/save, vault/source/read and vault/books/list for EPUB books")


# The host returns large source reads in chunk frames, without Codex.
with tempfile.TemporaryDirectory(prefix="tabgent-epub-host-") as directory:
    base = Path(directory)
    frames = io.BytesIO()
    big = epub_fixture.build(
        chapters=epub_fixture.CHAPTERS
        + [("ch4.xhtml", "Noise", "<p>" + os.urandom(600_000).hex() + "</p>")]
    )
    digest = hashlib.sha256(big).hexdigest()

    class Stdout:
        buffer = frames

    with patch.object(host, "HOME", base / "codex"), patch.object(
        vault, "default_path", lambda: base / "ReadingVault"
    ), patch.object(host.sys, "stdout", Stdout), patch.object(
        host, "executable", side_effect=AssertionError("Codex must not be discovered")
    ):
        params = {
            "url": "urn:sha256:" + digest,
            "title": "Big",
            "kind": "epub",
            "sha256": digest,
            "size": len(big),
        }
        position = 0
        while position < len(big):
            piece = big[position : position + 400_000]
            host.handle(
                {
                    "op": "vault",
                    "id": f"save-{position}",
                    "method": "vault/source/save",
                    "params": {**params, "offset": position, "data": b64(piece)},
                }
            )
            position += len(piece)
        host.VAULT_POOL.submit(lambda: None).result(timeout=60)
        replies = []
        raw = frames.getvalue()
        while raw:
            (size,) = struct.unpack("<I", raw[:4])
            replies.append(json.loads(raw[4 : 4 + size]))
            raw = raw[4 + size :]
        assert replies[-1]["result"]["complete"] is True
        ident = replies[-1]["result"]["document"]["id"]
        frames.seek(0)
        frames.truncate()
        host.handle(
            {
                "op": "vault",
                "id": "read",
                "method": "vault/source/read",
                "params": {"documentId": ident},
            }
        )
        host.VAULT_POOL.submit(lambda: None).result(timeout=60)
        raw, parts = frames.getvalue(), []
        while raw:
            (size,) = struct.unpack("<I", raw[:4])
            assert size <= 1024 * 1024, "Chrome accepts host messages up to 1 MB"
            parts.append(json.loads(raw[4 : 4 + size]))
            raw = raw[4 + size :]
        assert len(parts) > 1 and all(p["op"] == "chunk" for p in parts)
        message = json.loads("".join(p["data"] for p in parts))
        assert message["op"] == "vault" and message["id"] == "read"
        assert base64.b64decode(message["result"]["data"]) == big
host.VAULT_POOL.shutdown(wait=True)
host.POOL.shutdown(wait=True, cancel_futures=True)
print("PASS host saves and reads a large EPUB in chunks without Codex")
