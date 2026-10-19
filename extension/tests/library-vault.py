"""Local PDF import and the library list in the ReadingVault: an imported PDF is named by
the SHA-256 of its bytes (urn:sha256:...) and stored as Books/paper-*/original.pdf, and
vault/documents/list lists every document. Uses generated, non-sensitive fixture bytes.
"""

import base64
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
from unittest.mock import patch

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent / "native"))
sys.path.insert(0, str(TESTS / "fixtures"))
import epub_fixture
import vault


def fixture_pdf(text):
    """A small one-page PDF; the vault never parses it, only stores and returns it."""
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("latin-1")
    return (
        b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R >>\nendobj\n"
        + f"4 0 obj\n<< /Length {len(stream)} >>\nstream\n".encode()
        + stream
        + b"\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"
        # Padding makes the file span several read chunks in the tests below.
        + b"%" + b"0" * 5000 + b"\n"
    )


PDF = fixture_pdf("Autonomy is the endorsement of one's own actions.")
DIGEST = hashlib.sha256(PDF).hexdigest()
URL = "urn:sha256:" + DIGEST
TITLE = "Reading Companion Paper"


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
        "title": TITLE,
        "kind": "pdf",
        "meta": {"author": "Fixture Author"},
        "sha256": DIGEST,
        "size": len(PDF),
        "offset": offset,
        "data": b64(data),
        "name": "companion-paper.pdf",
        **extra,
    }
    return call(settings, "vault/source/save", params)


def pdf_anchor(exact, page=1):
    return {"kind": "pdf", "page": page, "quote": {"exact": exact}}


def documents(settings):
    return call(settings, "vault/documents/list", {})["documents"]


def set_updated(root, ident, value):
    folder = "Articles" if ident.startswith("article-") else "Books"
    path = root / folder / ident / "anchors.json"
    data = json.loads(path.read_text())
    data["document"]["updatedAt"] = value
    path.write_text(json.dumps(data))


with tempfile.TemporaryDirectory(prefix="tabgent-library-vault-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    root = base / "ReadingVault"
    with patch.object(vault, "default_path", lambda: root):
        # Listing an empty vault writes nothing, not even the vault folder.
        assert documents(settings) == []
        assert not root.exists()

        # The URL of a file named by its hash must be that hash: nothing is written.
        other = "urn:sha256:" + "0" * 64
        assert (
            code(
                settings,
                "vault/source/save",
                {
                    "url": other,
                    "title": TITLE,
                    "kind": "pdf",
                    "sha256": DIGEST,
                    "size": len(PDF),
                    "offset": 0,
                    "data": b64(PDF),
                },
            )
            == "invalid_params"
        )
        assert not root.exists()
        # The size and chunk limits are those of EPUB imports.
        for patches in (
            {"size": vault.SOURCE_LIMIT + 1},
            {"data": b64(b"x" * (vault.CHUNK_LIMIT + 1))},
        ):
            params = {
                "url": URL,
                "title": TITLE,
                "kind": "pdf",
                "sha256": DIGEST,
                "size": len(PDF),
                "offset": 0,
                "data": "",
                **patches,
            }
            assert code(settings, "vault/source/save", params) == "invalid_params"
        assert not root.exists()
        print("PASS a PDF import must match its hash identity and the EPUB size limits")

        # Chunked import into Books/paper-<title>-<hash>/original.pdf.
        half = len(PDF) // 2
        assert save(settings, 0, b"")["received"] == 0
        assert not root.exists(), "A progress check for an unknown file writes nothing"
        first = save(settings, 0, PDF[:half])
        assert first["complete"] is False and first["received"] == half
        assert save(settings, 0, b"")["received"] == half  # Resume point.
        done = save(settings, half, PDF[half:])
        assert done["complete"] is True and done["received"] == len(PDF)
        document = done["document"]
        assert re.fullmatch(
            r"paper-reading-companion-paper-[0-9a-f]{8}", document["id"]
        )
        assert document["kind"] == "pdf" and document["url"] == URL
        folder = root / "Books" / document["id"]
        assert Path(document["folder"]) == folder
        assert (folder / "original.pdf").read_bytes() == PDF
        assert sorted(p.name for p in folder.iterdir()) == [
            "anchors.json",
            "original.pdf",
            "source.json",
        ]
        record = json.loads((folder / "source.json").read_text())
        assert record["file"] == "original.pdf" and record["kind"] == "pdf"
        assert record["sha256"] == DIGEST and record["size"] == len(PDF)
        assert record["name"] == "companion-paper.pdf" and record["chapters"] == []
        assert done["source"]["path"] == str(folder / "original.pdf")
        assert not list((root / ".tabgent/uploads").iterdir())
        assert "original.pdf" in (root / "AGENTS.md").read_text()
        print("PASS a local PDF is imported in chunks as Books/paper-*/original.pdf")

        # Importing the same file again is the same document; nothing is uploaded.
        again = save(settings, 0, b"", name="renamed.pdf")
        assert again["complete"] is True and again["document"]["id"] == document["id"]
        assert [p.name for p in (root / "Books").iterdir()] == [document["id"]]
        assert json.loads((folder / "source.json").read_text())["name"] == (
            "companion-paper.pdf"
        )
        # Another file under this identity is refused; the original never changes.
        assert (
            code(
                settings,
                "vault/source/save",
                {
                    "url": URL,
                    "title": TITLE,
                    "kind": "pdf",
                    "sha256": "1" * 64,
                    "size": 1,
                    "offset": 0,
                    "data": b64(b"x"),
                },
            )
            == "invalid_params"
        )
        assert (folder / "original.pdf").read_bytes() == PDF

        # Read back in chunks, for the viewer that reopens it.
        parts, offset = [], 0
        while True:
            read = call(
                settings,
                "vault/source/read",
                {"documentId": document["id"], "offset": offset, "length": 2048},
            )
            chunk = base64.b64decode(read["data"])
            parts.append(chunk)
            offset += len(chunk)
            if read["eof"]:
                break
        assert len(parts) > 1 and b"".join(parts) == PDF
        assert read["source"]["sha256"] == DIGEST
        assert read["document"]["url"] == URL
        print("PASS the same file is the same document; reads return the stored bytes")

        # Highlights on the imported PDF belong to that document (resolved by its URL).
        resolved = call(
            settings,
            "vault/document/resolve",
            {"url": URL + "#page=1", "title": "", "kind": "pdf"},
        )
        assert resolved["document"]["id"] == document["id"]
        assert resolved["document"]["createdAt"]
        created = call(
            settings,
            "vault/highlight/create",
            {
                "url": URL,
                "title": TITLE,
                "kind": "pdf",
                "text": "endorsement",
                "anchor": pdf_anchor("endorsement"),
                "location": "p. 1",
            },
        )
        assert created["document"]["id"] == document["id"]
        markdown = (folder / "highlights.md").read_text()
        assert f'source: "{URL}"' in markdown and "type: paper" in markdown
        assert 'author: "Fixture Author"' in markdown
        books = call(settings, "vault/books/list", {"kind": "pdf"})["books"]
        assert [b["id"] for b in books] == [document["id"]]
        assert call(settings, "vault/books/list", {})["books"] == []
        print("PASS highlights on an imported PDF save to its document")

        # Other kinds of documents, as the extension creates them.
        web = call(
            settings,
            "vault/highlight/create",
            {
                "url": "https://example.test/articles/autonomy?id=3#intro",
                "title": "On Autonomy",
                "kind": "web",
                "meta": {"author": "A. Writer", "siteName": "Example"},
                "text": "Autonomy",
                "anchor": {"kind": "web", "quote": {"exact": "Autonomy"}},
            },
        )["document"]
        online = call(
            settings,
            "vault/highlight/create",
            {
                "url": "https://papers.example.test/motivation.pdf",
                "title": "Motivation Paper",
                "kind": "pdf",
                "text": "goal",
                "anchor": pdf_anchor("goal", 2),
            },
        )["document"]
        call(
            settings,
            "vault/highlight/create",
            {
                "url": "https://papers.example.test/motivation.pdf",
                "title": "Motivation Paper",
                "kind": "pdf",
                "text": "persist",
                "anchor": pdf_anchor("persist", 2),
            },
        )
        book = epub_fixture.build()
        book_digest = hashlib.sha256(book).hexdigest()
        epub = call(
            settings,
            "vault/source/save",
            {
                "url": "urn:sha256:" + book_digest,
                "title": epub_fixture.TITLE,
                "kind": "epub",
                "meta": {"author": epub_fixture.AUTHOR},
                "sha256": book_digest,
                "size": len(book),
                "offset": 0,
                "data": b64(book),
                "name": "small-book.epub",
            },
        )["document"]
        # A document discussed but not highlighted is listed too.
        discussed = call(
            settings,
            "vault/discussion/append",
            {
                "highlightId": None,
                "url": "https://example.test/notes",
                "title": "Notes Page",
                "kind": "web",
                "threadId": "thread-1",
                "turnId": "turn-1",
                "user": "What is this about?",
                "assistant": "Fixture answer.",
            },
        )["document"]

        # Most recently updated first, comparing times across UTC offsets.
        set_updated(root, web["id"], "2026-10-20T09:00:00+08:00")  # 01:00Z
        set_updated(root, online["id"], "2026-10-20T03:00:00+00:00")  # 03:00Z
        set_updated(root, document["id"], "2026-10-19T23:30:00-03:00")  # 02:30Z
        set_updated(root, epub["id"], "2026-10-20T00:30:00+00:00")  # 00:30Z
        set_updated(root, discussed["id"], "2026-10-19T12:00:00+00:00")
        listed = documents(settings)
        assert [d["id"] for d in listed] == [
            online["id"],
            document["id"],
            web["id"],
            epub["id"],
            discussed["id"],
        ]
        by_id = {d["id"]: d for d in listed}
        assert by_id[web["id"]]["kind"] == "web"
        assert by_id[web["id"]]["url"] == "https://example.test/articles/autonomy?id=3"
        assert by_id[web["id"]]["title"] == "On Autonomy"
        assert by_id[web["id"]]["author"] == "A. Writer"
        assert by_id[web["id"]]["highlightCount"] == 1
        assert by_id[web["id"]]["source"] is None
        assert by_id[online["id"]]["kind"] == "pdf"
        assert by_id[online["id"]]["highlightCount"] == 2
        assert by_id[online["id"]]["source"] is None
        local = by_id[document["id"]]
        assert local["kind"] == "pdf" and local["url"] == URL
        assert local["title"] == TITLE and local["highlightCount"] == 1
        assert local["source"] == {
            "name": "companion-paper.pdf",
            "size": len(PDF),
            "sha256": DIGEST,
            "importedAt": record["importedAt"],
        }
        assert local["folder"] == str(folder)
        assert local["highlightsPath"] == str(folder / "highlights.md")
        assert local["updatedAt"] == "2026-10-19T23:30:00-03:00"
        assert by_id[epub["id"]]["kind"] == "epub"
        assert by_id[epub["id"]]["author"] == epub_fixture.AUTHOR
        assert by_id[epub["id"]]["source"]["sha256"] == book_digest
        assert by_id[epub["id"]]["highlightCount"] == 0
        assert by_id[discussed["id"]]["highlightCount"] == 0
        assert set(local) == {
            "id",
            "kind",
            "title",
            "url",
            "folder",
            "highlightsPath",
            "createdAt",
            "updatedAt",
            "author",
            "highlightCount",
            "source",
        }
        print(
            "PASS the library lists web pages, online and imported PDFs, and EPUB books"
        )

        # Unreadable or misplaced folders are left out; the other documents still list.
        (root / "Articles" / web["id"] / "anchors.json").write_text("{not json")
        (root / "Books" / "article-misplaced-00000000").mkdir()
        (root / "Books" / "notes").mkdir()
        (root / "Books" / "paper-no-anchors-00000000").mkdir()
        (root / "Articles" / "README.md").write_text("mine")
        # A document whose original was removed is listed without a source.
        (root / "Books" / epub["id"] / "original.epub").unlink()
        listed = documents(settings)
        assert [d["id"] for d in listed] == [
            online["id"],
            document["id"],
            epub["id"],
            discussed["id"],
        ]
        assert {d["id"]: d for d in listed}[epub["id"]]["source"] is None
        print("PASS unreadable, misplaced and incomplete folders do not hide documents")

        # A missing Articles folder (or one that is a file) lists the books.
        shutil.rmtree(root / "Articles")
        (root / "Articles").write_text("not a folder")
        assert [d["kind"] for d in documents(settings)] == ["pdf", "pdf", "epub"]
        print("PASS a vault without an Articles folder still lists its books")
