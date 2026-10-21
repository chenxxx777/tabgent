"""Local PDF import and the library list in the vault: an imported PDF is named by the
SHA-256 of its bytes (urn:sha256:...), stored in its record folder with a visible copy
in Attachments/PDFs/ and its page text as a section per page in its full text file;
reading_vault reads those pages under exact-path checks, and vault/documents/list
lists every document. Uses generated, non-sensitive fixtures.
"""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent / "native"))
sys.path.insert(0, str(TESTS / "fixtures"))
import epub_fixture
import pdf_text
import text_pdf
import vault

# Page 2 has no text, like a scanned page.
PDF = text_pdf.build(
    [
        ["Chapter 1. Slow reading", "Careful readers return to difficult passages."],
        [],
        ["Chapter 3. Motivation", "Autonomy is the endorsement of one's own actions."],
    ],
    title="Reading Companion Paper",
)
# Page text comes from macOS PDFKit, as for the PDF fallback reader.
PDFKIT = sys.platform == "darwin" and Path("/usr/bin/osascript").exists()
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


def tool(settings, args):
    try:
        return vault.tool(settings, args)
    except vault.VaultError as error:
        return {"error": error.code}


def documents(settings):
    return call(settings, "vault/documents/list", {})["documents"]


def set_updated(root, ident, value):
    path = root / ".tabgent/documents" / ident / "anchors.json"
    data = json.loads(path.read_text())
    data["document"]["updatedAt"] = value
    path.write_text(json.dumps(data))


with tempfile.TemporaryDirectory(prefix="tabgent-library-vault-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    root = base / "Tabgent"
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

        # Chunked import into the record folder, with a visible copy in Attachments/PDFs.
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
        folder = root / ".tabgent/documents" / document["id"]
        assert Path(document["folder"]) == folder and document["category"] == "pdfs"
        notes = root / "PDFs" / f"{TITLE}.md"
        full = root / "Full Document Contents/PDFs" / f"{TITLE}.md"
        assert (root / "Attachments/PDFs" / f"{TITLE}.pdf").read_bytes() == PDF
        assert (folder / "original.pdf").read_bytes() == PDF
        record = json.loads((folder / "source.json").read_text())
        assert record["file"] == "original.pdf" and record["kind"] == "pdf"
        assert record["sha256"] == DIGEST and record["size"] == len(PDF)
        assert record["name"] == "companion-paper.pdf" and record["chapters"] == []
        assert done["source"]["path"] == str(folder / "original.pdf")
        assert not list((root / ".tabgent/uploads").iterdir())
        assert "Full Document Contents" in (root / "AGENTS.md").read_text()
        print("PASS a local PDF is imported in chunks into its record and Attachments")

        # Each page with text is a section of the full text; the empty page is not.
        if PDFKIT:
            assert sorted(p.name for p in folder.iterdir()) == [
                "anchors.json",
                "original.pdf",
                "source.json",
            ]
            text = full.read_text()
            assert text.startswith(
                f"---\ntabgent_id: {document['id']}\ntabgent_part: full\n"
                f'title: "{TITLE}"\ncategory: pdfs\n'
            ), text
            assert "\n<!-- tabgent:page 3 -->\n## 第 3 页\n\n" in text
            assert "Autonomy is the endorsement of one's own actions." in text
            assert "tabgent:page 2 " not in text
            assert record["pageCount"] == 3 and "pageError" not in record
            assert [(p["page"], p["part"]) for p in record["pages"]] == [(1, 1), (3, 1)]
            assert done["source"]["pages"] == record["pages"]
            assert done["source"]["fullTextPath"] == str(full)
            print("PASS page text is a section per page with text in the full text")
        else:
            assert record["pageError"] and record["pages"] == []
            print("SKIP page text needs macOS PDFKit; the import records pageError")

        # Importing the same file again is the same document; nothing is uploaded.
        again = save(settings, 0, b"", name="renamed.pdf")
        assert again["complete"] is True and again["document"]["id"] == document["id"]
        assert [p.name for p in (root / ".tabgent/documents").iterdir()] == [
            document["id"]
        ]
        assert json.loads((folder / "source.json").read_text())["name"] == (
            "companion-paper.pdf"
        )
        if PDFKIT:
            # A deleted full text is written again when the file is imported again.
            full.unlink()
            assert save(settings, 0, b"")["complete"] is True
            assert full.read_text() == text
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
                {"documentId": document["id"], "offset": offset, "length": 256},
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
        markdown = notes.read_text()
        assert f'source: "{URL}"' in markdown and "kind: pdf" in markdown
        assert 'author: "[[Fixture Author]]"' in markdown
        # Its page link opens the visible copy at the page, in Obsidian's PDF viewer.
        assert f"[[../Attachments/PDFs/{TITLE}.pdf#page=1|原文位置]]" in markdown
        books = call(settings, "vault/books/list", {"kind": "pdf"})["books"]
        assert [b["id"] for b in books] == [document["id"]]
        assert call(settings, "vault/books/list", {})["books"] == []
        print("PASS highlights on an imported PDF save to its document")

        if PDFKIT:
            # reading_vault: an imported PDF's pages are listed, searched within the
            # paper (the user's notes first) and read by page number.
            ident = document["id"]
            listed = tool(settings, {"action": "list", "document": ident})["documents"]
            assert [c["section"] for c in listed[0].pop("contents")] == [1, 3]
            assert listed == [
                {
                    "id": ident,
                    "title": TITLE,
                    "kind": "pdf",
                    "category": "pdfs",
                    "notes": f"PDFs/{TITLE}.md",
                    "path": f"PDFs/{TITLE}.md",
                    "fullText": f"Full Document Contents/PDFs/{TITLE}.md",
                    "sections": 2,
                }
            ]
            found = tool(
                settings,
                {"action": "search", "query": "endorsement", "document": ident},
            )["matches"]
            assert [m["path"] for m in found] == [
                f"PDFs/{TITLE}.md",
                f"Full Document Contents/PDFs/{TITLE}.md",
            ]
            assert found[1]["section"] == 3 and found[1]["sectionTitle"] == "第 3 页"
            everywhere = tool(settings, {"action": "search", "query": "endorsement"})
            assert all("Full Document" not in m["path"] for m in everywhere["matches"])
            read = tool(
                settings,
                {"action": "read", "document": ident, "part": "full", "section": 3},
            )
            assert "Autonomy is the endorsement" in read["text"]
            assert "Careful readers" not in read["text"]
            first = tool(settings, {"action": "read", "path": str(full), "section": 1})
            assert "Careful readers" in first["text"]
            assert tool(
                settings,
                {"action": "read", "document": ident, "part": "full", "section": 2},
            ) == {"error": "not_found"}, "A page without text has no section"

            # Only the full text at its exact place is readable.
            texts = full.parent
            outside = base / "private.md"
            outside.write_text("private text")
            (texts / "notes.md").write_text("not a page")
            (texts / "linked.md").symlink_to(outside)
            for path in (
                "Full Document Contents/PDFs/notes.md",
                "Full Document Contents/PDFs/linked.md",
                f"Full Document Contents/pdfs/{TITLE}.md",
                "Full Document Contents/PDFs/../../../private.md",
            ):
                assert tool(settings, {"action": "read", "path": path}) == {
                    "error": "invalid_params"
                }, path
            # A full text replaced by a link to another place is not read either.
            saved = full.read_bytes()
            elsewhere = base / "elsewhere.md"
            elsewhere.write_bytes(saved)
            full.unlink()
            full.symlink_to(elsewhere)
            assert tool(
                settings, {"action": "read", "document": ident, "part": "full"}
            ) == {"error": "not_found"}
            assert (
                "fullText"
                not in tool(settings, {"action": "list", "document": ident})[
                    "documents"
                ][0]
            )
            full.unlink()
            full.write_bytes(saved)
            for extra in ("notes.md", "linked.md"):
                (texts / extra).unlink()
            print(
                "PASS reading_vault lists, searches and reads a PDF's pages by number"
            )

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
        assert local["notesPath"] == str(notes) and local["category"] == "pdfs"
        assert by_id[web["id"]]["category"] == "articles"
        assert by_id[epub["id"]]["category"] == "books"
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
            "category",
            "notesPath",
            "discussionsPath",
            "fullTextPath",
            "folder",
            "createdAt",
            "updatedAt",
            "author",
            "highlightCount",
            "clip",
            "comment",
            "tags",
            "source",
        }
        assert local["comment"] == "" and local["tags"] == []
        # Only a clipped webpage has a clip.
        assert all(entry["clip"] is None for entry in listed)
        print(
            "PASS the library lists web pages, online and imported PDFs, and EPUB books"
        )

        # Unreadable or misplaced records are left out; the other documents still list.
        records = root / ".tabgent/documents"
        (records / web["id"] / "anchors.json").write_text("{not json")
        (records / "notes").mkdir()
        (records / "paper-no-anchors-00000000").mkdir()
        (root / "Articles" / "README.md").write_text("mine")
        # A document whose original was removed is listed without a source.
        (records / epub["id"] / "original.epub").unlink()
        (root / "Attachments/Books" / f"{epub_fixture.TITLE}.epub").unlink()
        listed = documents(settings)
        assert [d["id"] for d in listed] == [
            online["id"],
            document["id"],
            epub["id"],
            discussed["id"],
        ]
        assert {d["id"]: d for d in listed}[epub["id"]]["source"] is None
        print("PASS unreadable, misplaced and incomplete records do not hide documents")

        # The library lists the records: notes moved or deleted by the user do not hide
        # their documents.
        shutil.rmtree(root / "Articles")
        assert len(documents(settings)) == 4
        print("PASS a vault without its notes folders still lists its documents")


# Failures leave the original readable, without page files.
with tempfile.TemporaryDirectory(prefix="tabgent-library-pages-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    root = base / "Tabgent"

    def import_pdf(data, title):
        digest = hashlib.sha256(data).hexdigest()
        params = {
            "url": "urn:sha256:" + digest,
            "title": title,
            "kind": "pdf",
            "sha256": digest,
            "size": len(data),
            "offset": 0,
            "data": b64(data),
            "name": title + ".pdf",
        }
        return call(settings, "vault/source/save", params), params

    with patch.object(vault, "default_path", lambda: root):
        # Text that cannot be read (here: an encrypted PDF) is recorded and not retried.
        calls = []

        def unreadable(path):
            calls.append(path)
            raise pdf_text.PdfError("The PDF is encrypted")

        with patch.object(pdf_text, "extract", unreadable):
            locked, params = import_pdf(text_pdf.build([["Locked."]]), "Locked")
            assert locked["complete"] is True
            assert locked["source"]["pageError"] == "The PDF is encrypted"
            assert locked["source"]["pages"] == []
            assert locked["source"]["fullTextPath"] is None
            assert call(settings, "vault/source/save", {**params, "data": ""})
        assert len(calls) == 1, "An unreadable PDF is not read again on every import"

        # A PDF without any text (scanned pages) gets no page files.
        scanned, _ = import_pdf(text_pdf.build([[], []]), "Scanned")
        if PDFKIT:
            assert scanned["source"]["pageError"] == "The PDF has no text layer"
            assert scanned["source"]["pageCount"] == 2
        assert scanned["source"]["fullTextPath"] is None

        # A full text that cannot be written is retried at the next import check.
        if PDFKIT:
            real_write = vault._write

            def full_disk(path, data, mode=None):
                if "Full Document Contents" in str(path):
                    raise OSError(28, "No space left")
                return real_write(path, data, mode)

            with patch.object(vault, "_write", full_disk):
                written, params = import_pdf(
                    text_pdf.build([["First page."], ["Second page."]]), "Written"
                )
            assert "pageWriteError" in written["source"], written["source"]
            restored = call(settings, "vault/source/save", {**params, "data": ""})
            assert "pageWriteError" not in restored["source"]
            assert [p["page"] for p in restored["source"]["pages"]] == [1, 2]
            assert Path(restored["source"]["fullTextPath"]).is_file()
        # An EPUB's source record has no page fields.
        book = epub_fixture.build()
        book_digest = hashlib.sha256(book).hexdigest()
        epub = call(
            settings,
            "vault/source/save",
            {
                "url": "urn:sha256:" + book_digest,
                "title": "Book",
                "kind": "epub",
                "sha256": book_digest,
                "size": len(book),
                "offset": 0,
                "data": b64(book),
            },
        )
        assert not {"pages", "pageCount", "pageError"} & set(epub["source"])
print("PASS unreadable, scanned and unwritable page text leaves the PDF readable")


# pdf_text bounds and reports what PDFKit returns, without running it here.
def finished(stdout="", stderr="", returncode=0):
    return lambda *args, **kwargs: SimpleNamespace(
        returncode=returncode, stdout=stdout, stderr=stderr
    )


texts = ["a\r\nb  \r\x07c\x00", "x" * (pdf_text.PAGE_CHARS + 5), "", 5]
with patch.object(
    pdf_text.subprocess, "run", finished(json.dumps({"count": 4, "text": texts}))
):
    assert pdf_text.extract("paper.pdf") == {
        "count": 4,
        "pages": [
            {"page": 1, "text": "a\nb\nc"},
            {"page": 2, "text": "x" * pdf_text.PAGE_CHARS},
            {"page": 3, "text": ""},
            {"page": 4, "text": ""},
        ],
        "truncated": True,
    }
with patch.object(
    pdf_text.subprocess, "run", finished(json.dumps({"count": 9, "text": ["one"]}))
):
    assert pdf_text.extract("paper.pdf")["truncated"] is True
with patch.object(pdf_text, "TOTAL_CHARS", 5), patch.object(
    pdf_text.subprocess,
    "run",
    finished(json.dumps({"count": 2, "text": ["abc", "def"]})),
):
    assert pdf_text.extract("paper.pdf") == {
        "count": 2,
        "pages": [{"page": 1, "text": "abc"}],
        "truncated": True,
    }
failures = [
    (
        finished(
            stderr="script: execution error: Error: Error: The PDF is encrypted (-2700)",
            returncode=1,
        ),
        "The PDF is encrypted",
    ),
    (
        finished(stderr="osascript crashed", returncode=1),
        "PDFKit could not read the PDF",
    ),
    (finished(stdout="not json"), "PDFKit returned no page text"),
]


def missing(*args, **kwargs):
    raise FileNotFoundError("osascript")


def slow(*args, **kwargs):
    raise subprocess.TimeoutExpired("osascript", pdf_text.TIMEOUT)


failures += [
    (missing, "Reading PDF text needs macOS PDFKit"),
    (slow, "Reading the PDF text took too long"),
]
for run, reason in failures:
    with patch.object(pdf_text.subprocess, "run", run):
        try:
            pdf_text.extract("paper.pdf")
        except pdf_text.PdfError as error:
            assert str(error) == reason, (str(error), reason)
        else:
            raise AssertionError(reason)
if PDFKIT:
    with tempfile.TemporaryDirectory(prefix="tabgent-pdf-text-") as directory:
        broken = Path(directory) / "broken.pdf"
        broken.write_bytes(b"%PDF-1.4\nnot really a PDF\n")
        try:
            pdf_text.extract(broken)
        except pdf_text.PdfError as error:
            assert str(error) == "Not a readable PDF", str(error)
        else:
            raise AssertionError("A damaged PDF has no page text")
print("PASS pdf_text bounds page text and reports PDFKit failures")
