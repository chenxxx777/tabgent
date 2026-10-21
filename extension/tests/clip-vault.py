"""Clipped webpages in the vault: vault/clip/save writes the page's full text under Full
Document Contents/, its HTML and then its record into the document's record folder,
replaces a clip only when asked (keeping a full text the user edited), reports clips in
resolve and the library list, and reading_vault lists, searches and reads the full text
under exact-path checks. Uses generated, non-sensitive fixtures.
"""

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent / "native"))
import vault

URL = "https://example.test/essays/autonomy"
TITLE = "On Autonomy"
BODY = (
    "Autonomy is the endorsement of one's own actions.\n\n"
    "## Evidence\n\nReaders who endorse a goal persist for longer.\n"
)
HTML = "<p>Autonomy is the endorsement of one's own actions.</p><h2>Evidence</h2>"


def call(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"result"}, (method, reply)
    return reply["result"]


def code(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"error"}, (method, reply)
    return reply["error"]["code"]


def clip(settings, **extra):
    params = {
        "url": URL,
        "title": TITLE,
        "kind": "web",
        "meta": {"author": "Fixture Author", "siteName": "Fixture Essays"},
        "markdown": BODY,
        "html": HTML,
        "origin": {
            "method": "article",
            "extractor": "defuddle",
            "pageUrl": URL + "#evidence",
        },
        "language": "en",
        "direction": "ltr",
        "excerpt": "An essay about autonomy.",
        "words": 18,
        "chars": 90,
        "images": {"found": 2, "saved": 0, "remote": 2},
        **extra,
    }
    return call(settings, "vault/clip/save", params)


def tool(settings, args):
    try:
        return vault.tool(settings, args)
    except vault.VaultError as error:
        return {"error": error.code}


def snapshot(*paths):
    found = {}
    for path in paths:
        files = path.iterdir() if path.is_dir() else [path]
        for file in files:
            if file.is_file():
                found[str(file)] = (file.stat().st_mtime_ns, file.read_bytes())
    return found


with tempfile.TemporaryDirectory(prefix="tabgent-clip-vault-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    root = base / "Tabgent"
    with patch.object(vault, "default_path", lambda: root):
        # A first clip creates the page's document: its note, its full text and, in its
        # record folder, the HTML and the record naming the files.
        result = clip(settings)
        assert result["saved"] is True and result["conflict"] is False
        assert result["backup"] is None
        document = result["document"]
        folder = Path(document["folder"])
        assert folder.parent == root / ".tabgent/documents" and document[
            "id"
        ].startswith("article-on-autonomy-")
        full = root / "Full Document Contents/Articles/On Autonomy.md"
        notes = root / "Articles/On Autonomy.md"
        summary = result["clip"]
        assert summary["complete"] is True and summary["method"] == "article"
        assert summary["words"] == 18 and summary["images"] == 2
        assert summary["fullTextPath"] == str(full) == summary["articlePath"]
        assert document["fullTextPath"] == str(full)
        markdown = full.read_text()
        assert markdown.startswith(
            "---\n"
            f"tabgent_id: {document['id']}\n"
            "tabgent_part: full\n"
            'title: "On Autonomy"\n'
            "category: articles\n"
            f'source: "{URL}"\n'
            'author: "[[Fixture Author]]"\n'
            'site: "Fixture Essays"\n'
        ), markdown
        assert "\nclipped: " in markdown and '\nlanguage: "en"\n' in markdown
        assert "\n---\n\n<!-- 由 Tabgent 剪藏生成" in markdown
        assert (
            "\n# On Autonomy\n\n[[../../Articles/On Autonomy|← 阅读笔记]] · "
            f"[原网页]({URL})\n\nAutonomy is the endorsement" in markdown
        ), markdown
        assert markdown.endswith("persist for longer.\n")
        page = (folder / "article.html").read_text()
        assert page.startswith('<!doctype html>\n<html lang="en" dir="ltr">')
        assert "default-src 'none'" in page and "<title>On Autonomy</title>" in page
        assert f"<article>\n{HTML}\n</article>" in page
        record = json.loads((folder / "article.json").read_text())
        assert record["origin"]["type"] == "clip"
        assert record["origin"]["pageUrl"] == URL + "#evidence"
        assert record["origin"]["clippedAt"] == summary["clippedAt"]
        assert record["files"]["markdown"] == {
            "file": "article.md",
            "sha256": hashlib.sha256(markdown.encode()).hexdigest(),
            "bytes": len(markdown.encode()),
        }
        assert record["author"] == "Fixture Author" and record["images"] == {
            "found": 2,
            "saved": 0,
            "remote": 2,
            "failed": [],
        }
        assert record["assets"] == [] and record["truncated"] is False
        assert "coverage" not in record, "a clip without a coverage check records none"
        assert sorted(p.name for p in folder.iterdir()) == [
            "anchors.json",
            "article.html",
            "article.json",
        ]
        # The note: its metadata links the full text; there are no highlights yet.
        text = notes.read_text()
        assert (
            "- 全文：[[../Full Document Contents/Articles/On Autonomy|查看全文 →]]"
            in (text)
        )
        assert "- 来源：剪藏" in text and "- 摘要：An essay about autonomy." in text
        assert "^h" not in text
        anchors = json.loads((folder / "anchors.json").read_text())
        assert anchors["document"]["url"] == URL and anchors["highlights"] == []
        assert anchors["document"]["meta"]["siteName"] == "Fixture Essays"

        # resolve and the library list report the clip; the fragment is not identity.
        resolved = call(
            settings,
            "vault/document/resolve",
            {"url": URL + "#top", "title": "", "kind": "web"},
        )
        assert resolved["document"]["id"] == document["id"]
        assert resolved["clip"]["clippedAt"] == summary["clippedAt"]
        listed = call(settings, "vault/documents/list", {})["documents"]
        assert listed[0]["clip"]["complete"] is True
        fresh = call(
            settings,
            "vault/document/resolve",
            {"url": "https://example.test/other", "title": "", "kind": "web"},
        )
        assert fresh["clip"] is None

        # A highlight on the live page belongs to the same document and survives clips.
        highlight = call(
            settings,
            "vault/highlight/create",
            {
                "url": URL,
                "title": TITLE,
                "kind": "web",
                "text": "endorsement",
                "anchor": {
                    "kind": "web",
                    "quote": {
                        "exact": "endorsement",
                        "prefix": "is the ",
                        "suffix": " of",
                    },
                },
            },
        )
        assert highlight["document"]["id"] == document["id"]

        # Clipping again without replace is a conflict that writes nothing.
        before = snapshot(folder, full, notes)
        again = clip(settings, markdown="Different text.")
        assert again["saved"] is False and again["conflict"] is True
        assert again["clip"]["clippedAt"] == summary["clippedAt"]
        assert snapshot(folder, full, notes) == before
        # So is replacing a clip other than the one the user saw.
        stale = clip(settings, replace=True, expected="2001-01-01T00:00:00+00:00")
        assert stale["conflict"] is True and snapshot(folder, full, notes) == before

        # Replacing the expected clip rewrites its files and keeps the highlights.
        replaced = clip(
            settings,
            replace=True,
            expected=summary["clippedAt"],
            markdown="Second version of the text.",
            origin={"method": "page", "pageUrl": URL},
        )
        assert replaced["saved"] is True and replaced["backup"] is None
        assert "Second version of the text." in full.read_text()
        assert replaced["clip"]["method"] == "page"
        assert "- endorsement ^h001" in notes.read_text()
        assert call(
            settings,
            "vault/highlights/list",
            {"documentId": document["id"]},
        )[
            "highlights"
        ][0]["text"] == ("endorsement")

        # A full text the user edited is kept before it is replaced.
        edited = full.read_text() + "\nMy own addition.\n"
        full.write_text(edited)
        third = clip(settings, replace=True, markdown="Third version.")
        assert third["backup"].startswith("On Autonomy（编辑版 ") and third[
            "backup"
        ].endswith("）.md"), third["backup"]
        kept = full.parent / third["backup"]
        # The kept copy is no longer taken for the full text.
        assert kept.read_text() == edited.replace(
            "tabgent_part: full", "tabgent_part: edited"
        )
        assert "Third version." in full.read_text()

        # A missing file makes the clip incomplete; an unreadable record does not break
        # resolve, conflicts without replace, and is replaced (keeping the text) with it.
        (folder / "article.html").unlink()
        assert (
            call(
                settings,
                "vault/document/resolve",
                {"url": URL, "title": "", "kind": "web"},
            )["clip"]["complete"]
            is False
        )
        (folder / "article.json").write_text("{broken")
        broken = call(
            settings, "vault/document/resolve", {"url": URL, "title": "", "kind": "web"}
        )
        assert broken["clip"] == {"complete": False, "invalid": True}
        assert broken["highlights"][0]["text"] == "endorsement"
        assert clip(settings)["conflict"] is True
        fixed = clip(settings, replace=True, markdown="Fourth version.")
        assert fixed["saved"] is True and fixed["backup"].startswith(
            "On Autonomy（编辑版"
        )
        assert fixed["clip"]["complete"] is True
        # The coverage check's figures go into the record.
        coverage = {
            "visibleChars": 900,
            "keptChars": 810,
            "ratio": 0.9,
            "restoredPassages": 2,
            "restoredChars": 90,
            "incomplete": False,
        }
        saved = clip(
            settings, replace=True, markdown="Fourth version.", coverage=coverage
        )
        assert saved["saved"] is True
        record = json.loads((folder / "article.json").read_text())
        assert record["coverage"] == coverage

        # Invalid requests are refused before anything is written.
        for change in (
            {"kind": "pdf"},
            {"url": "urn:sha256:" + "0" * 64},
            {"url": "ftp://example.test/file"},
            {"markdown": ""},
            {"markdown": 7},
            {"html": "x" * (vault.CLIP_HTML_LIMIT + 1)},
            {"html": "中" * (vault.CLIP_HTML_LIMIT // 3 + 1)},
            {"origin": {"method": "everything"}},
            {"origin": {"method": "article", "pageUrl": "javascript:alert(1)"}},
            {"images": {"found": -1}},
            {"words": "many"},
            {"expected": 12},
            {"coverage": "all"},
            {"coverage": {"ratio": 2}},
            {"coverage": {"ratio": True}},
            {"coverage": {"visibleChars": -1}},
        ):
            params = {
                "url": "https://example.test/invalid",
                "title": "Invalid",
                "kind": "web",
                "markdown": "Text.",
                "html": "<p>Text.</p>",
                "origin": {"method": "article"},
                **change,
            }
            assert code(settings, "vault/clip/save", params) == "invalid_params", change
        assert not any(
            "invalid" in path.name for path in (root / ".tabgent/documents").iterdir()
        ), "invalid clips create no document"

        # A clip is refused for an address whose document is a PDF (Chrome's own viewer).
        pdf = "https://example.test/papers/fallback.pdf"
        paper = call(
            settings,
            "vault/highlight/create",
            {
                "url": pdf,
                "title": "Paper",
                "kind": "pdf",
                "text": "words",
                "anchor": {"kind": "pdf", "page": 1, "quote": {"exact": "words"}},
            },
        )["document"]
        assert paper["category"] == "pdfs"
        records = sorted(path.name for path in (root / ".tabgent/documents").iterdir())
        assert (
            code(
                settings,
                "vault/clip/save",
                {
                    "url": pdf,
                    "title": "Paper",
                    "kind": "web",
                    "markdown": "Text.",
                    "html": "<p>Text.</p>",
                    "origin": {"method": "article"},
                },
            )
            == "invalid_params"
        )
        assert (
            sorted(p.name for p in (root / ".tabgent/documents").iterdir()) == records
        )
        assert not (Path(paper["folder"]) / "article.json").exists()
        assert not (root / "Full Document Contents/PDFs").exists()

        # AGENTS.md tells Codex about full texts.
        assert "`Full Document Contents/<category>/<same name>.md`" in (
            (root / "AGENTS.md").read_text()
        )

        # reading_vault lists the clip, searches its text after the user's notes, and reads
        # it, but not Tabgent's HTML copy, its record or a kept edited copy.
        entry = next(
            d
            for d in tool(settings, {"action": "list"})["documents"]
            if d.get("fullText")
        )
        assert entry["fullText"] == "Full Document Contents/Articles/On Autonomy.md"
        assert entry["title"] == TITLE and entry["notes"] == "Articles/On Autonomy.md"
        found = tool(settings, {"action": "search", "query": "fourth endorsement"})
        paths = [match["path"] for match in found["matches"]]
        assert "Articles/On Autonomy.md" in paths and entry["fullText"] in paths
        assert paths.index("Articles/On Autonomy.md") < paths.index(
            entry["fullText"]
        ), paths
        read = tool(settings, {"action": "read", "path": entry["fullText"]})
        assert "Fourth version." in read["text"]
        relative = folder.relative_to(root).as_posix()
        for path in (
            f"{relative}/article.html",
            f"{relative}/article.json",
            f"Full Document Contents/Articles/{fixed['backup']}",
            "Full Document Contents/Articles/ON AUTONOMY.md",
        ):
            assert tool(settings, {"action": "read", "path": path})["error"] in (
                "invalid_params",
                "not_found",
            ), path
        # The full text counts only at its place, without symlinks.
        outside = base / "outside.md"
        outside.write_text("Private text outside the vault.")
        saved_text = full.read_bytes()
        full.unlink()
        full.symlink_to(outside)
        assert tool(settings, {"action": "read", "path": entry["fullText"]})[
            "error"
        ] in (
            "invalid_params",
            "not_found",
        )
        assert not any(
            "Private text" in m["text"]
            for m in tool(settings, {"action": "search", "query": "private outside"})[
                "matches"
            ]
        )
        full.unlink()
        full.write_bytes(saved_text)

        # Deleting the clip keeps the note and its highlights; an edited text stays.
        deleted = call(settings, "vault/clip/delete", {"documentId": document["id"]})
        assert deleted == {"ok": True, "backup": None}
        assert not full.exists() and not (folder / "article.json").exists()
        assert "- endorsement ^h001" in notes.read_text()
        assert "- 全文：" not in notes.read_text()
        assert kept.exists(), "Kept edited copies are the user's"
print(
    "PASS clipped webpages: save, replace, edited copies, summaries and reading_vault"
)
