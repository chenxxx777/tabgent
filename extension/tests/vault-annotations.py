"""The user's comment on a whole document and its tags: vault/document/comment,
vault/document/tags and vault/tags/*, kept in the note (the ## 全文评论 block and the front
matter's tags), which stays their source when the user edits it in Obsidian."""

import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1] / "native"
sys.path.insert(0, str(NATIVE))
import vault


def call(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"result"}, (method, params, reply)
    return reply["result"]


def code(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"error"}, reply
    return reply["error"]["code"]


def anchor(exact):
    return {"kind": "web", "quote": {"exact": exact, "prefix": "", "suffix": ""}}


def edit(path, old, new):
    text = path.read_text("utf-8")
    assert old in text, (old, text)
    path.write_text(text.replace(old, new, 1), "utf-8")


# Front matter as users write it by hand in Obsidian.
assert vault.note_tags(["---", "tags: [AI学习, 'b c', \"#重要\"]", "---"]) == [
    "AI学习",
    "b c",
    "重要",
]
assert vault.note_tags(["---", "tags: a, b ai学习", "---"]) == ["a", "b", "ai学习"]
assert vault.note_tags(
    ["---", "tags:", "- One", "- one", "  - two # note", "x: 1", "---"]
) == [
    "One",
    "two",
]
assert vault.note_tags(["---", "title: x", "---", "tags: [not front matter]"]) == []
assert vault.tag_key(" #AI学习 ") == vault.tag_key("ai学习")
assert vault.note_comment(["x"]) is None

with tempfile.TemporaryDirectory(prefix="tabgent-annotations-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    default = base / "Tabgent"
    with patch.object(vault, "default_path", lambda: default):
        page = {"url": "https://example.com/essay", "title": "示例文章", "kind": "web"}
        comment = "vault/document/comment"
        tags = "vault/document/tags"

        # Removing what a page that is not saved does not have writes nothing.
        result = call(settings, comment, {**page, "comment": ""})
        assert result["document"] is None and result["comment"] == ""
        assert call(settings, tags, {**page, "remove": ["x"]})["document"] is None
        assert not default.exists(), "Nothing to remove must not create the vault"
        assert code(settings, comment, {"comment": "x"}) == "invalid_params"
        unknown = {"documentId": "article-x-00000000", "comment": "x"}
        assert code(settings, comment, unknown) == "not_found"

        # A first comment on a page without highlights creates a minimal document.
        text = "我保存这篇文章是想比较两种方法。\n\n还需要验证第二种方法的适用条件。"
        first = call(settings, comment, {**page, "comment": "  " + text + "\n"})
        assert first["comment"] == text and first["tags"] == [] and not first["kept"]
        ident = first["document"]["id"]
        note = Path(first["document"]["notesPath"])
        anchors = Path(first["document"]["folder"]) / "anchors.json"
        markdown = note.read_text("utf-8")
        block = (
            "<!-- tabgent:comment document start -->\n## 全文评论\n\n"
            + text
            + "\n<!-- tabgent:comment document end -->"
        )
        assert block in markdown, markdown
        # Between the metadata and the highlights.
        assert (
            markdown.index("tabgent:metadata document end")
            < markdown.index(block)
            < markdown.index("## 高亮")
        )
        record = json.loads(anchors.read_text("utf-8"))
        assert (
            record["highlights"] == [] and record["document"]["comment"]["text"] == text
        )
        resolved = call(settings, "vault/document/resolve", page)
        assert resolved["comment"] == text and resolved["highlights"] == []
        listed = call(settings, "vault/documents/list", {})["documents"]
        assert [(d["id"], d["comment"], d["tags"]) for d in listed] == [
            (ident, text, [])
        ]
        # The same comment again writes nothing.
        before = note.stat().st_mtime_ns
        call(settings, comment, {"documentId": ident, "comment": text, "base": text})
        assert note.stat().st_mtime_ns == before

        # Edited in Tabgent from what it showed: replaced, with no copy kept.
        second = call(
            settings, comment, {"documentId": ident, "comment": "新看法", "base": text}
        )
        assert second["comment"] == "新看法" and not second["kept"]
        markdown = note.read_text("utf-8")
        assert "新看法" in markdown and text.split("\n")[0] not in markdown

        # Edited in Obsidian: read from the note, and kept by later writes.
        edit(note, "新看法", "在 Obsidian 里改过的看法")
        assert (
            call(settings, "vault/document/resolve", page)["comment"]
            == "在 Obsidian 里改过的看法"
        )
        call(
            settings,
            "vault/highlight/create",
            {**page, "text": "两种方法", "anchor": anchor("两种方法")},
        )
        markdown = note.read_text("utf-8")
        assert "在 Obsidian 里改过的看法" in markdown and "新看法" not in markdown
        assert markdown.count("tabgent:comment document start") == 1
        record = json.loads(anchors.read_text("utf-8"))
        assert record["document"]["comment"]["text"] == "在 Obsidian 里改过的看法"

        # An editor opened before that edit: the note's version is kept, not lost.
        stale = call(
            settings,
            comment,
            {"documentId": ident, "comment": "第三版", "base": "新看法"},
        )
        assert stale["kept"] and stale["comment"] == "第三版"
        markdown = note.read_text("utf-8")
        assert "在 Obsidian 里改过的看法" in markdown and "第三版" in markdown

        # Removed in Obsidian: no comment, and a later write does not bring it back.
        lines = note.read_text("utf-8").split("\n")
        start, end = vault._block_index(lines)[("comment", "document")]
        note.write_text("\n".join(lines[:start] + lines[end + 1 :]), "utf-8")
        assert call(settings, "vault/document/resolve", page)["comment"] == ""
        call(
            settings,
            "vault/highlight/create",
            {**page, "text": "验证", "anchor": anchor("验证")},
        )
        assert "第三版" not in note.read_text("utf-8")
        assert call(settings, "vault/document/resolve", page)["comment"] == ""

        # Written again, then removed in Tabgent: the block goes.
        call(
            settings,
            comment,
            {"documentId": ident, "comment": "最后的看法", "base": ""},
        )
        call(
            settings,
            comment,
            {"documentId": ident, "comment": "", "base": "最后的看法"},
        )
        markdown = note.read_text("utf-8")
        assert "tabgent:comment" not in markdown and "最后的看法" not in markdown

        # Tags: in the front matter, matched without case, the user's spelling kept.
        call(settings, comment, {"documentId": ident, "comment": text, "base": ""})
        result = call(
            settings, tags, {"documentId": ident, "add": ["AI学习", "#重要", "ai学习"]}
        )
        assert result["tags"] == ["AI学习", "重要"], result
        markdown = note.read_text("utf-8")
        assert "tags:\n  - AI学习\n  - 重要\n---" in markdown, markdown
        result = call(
            settings,
            tags,
            {"documentId": ident, "add": ["2026 计划"], "remove": ["ai学习"]},
        )
        assert result["tags"] == ["重要", "2026-计划"]
        assert '  - "2026-计划"' in note.read_text("utf-8")
        assert (
            code(settings, tags, {"documentId": ident, "add": ["  "]})
            == "invalid_params"
        )

        # The user's own front matter: tags edited by hand are read; other keys stay.
        edit(
            note,
            'tags:\n  - 重要\n  - "2026-计划"\n',
            "rating: 5\ntags: [重要, 阅读]\n",
        )
        resolved = call(settings, "vault/document/resolve", page)
        assert resolved["tags"] == ["重要", "阅读"]
        call(settings, tags, {"documentId": ident, "add": ["方法论"]})
        markdown = note.read_text("utf-8")
        assert (
            "rating: 5\ntags:\n  - 重要\n  - 阅读\n  - 方法论\n" in markdown
        ), markdown
        assert text in markdown, "Tags must not change the comment"

        # Another page, tagged without a comment; then the vault's tags with their counts.
        other = {"url": "https://example.com/other", "title": "Other", "kind": "web"}
        made = call(settings, tags, {**other, "add": ["阅读", "Ideas"]})
        assert made["document"]["createdAt"] and made["tags"] == ["阅读", "Ideas"]
        other_note = Path(made["document"]["notesPath"])
        listed = call(settings, "vault/tags/list", {})["tags"]
        assert [(t["name"], t["count"]) for t in listed] == [
            ("阅读", 2),
            ("Ideas", 1),
            ("方法论", 1),
            ("重要", 1),
        ], listed

        # Rename, then merge into an existing tag: notes change, documents stay.
        renamed = call(settings, "vault/tags/rename", {"from": "ideas", "to": "想法"})
        assert renamed == {"changed": 1, "failed": 0, "merged": False}
        assert "  - 想法" in other_note.read_text("utf-8")
        merged = call(settings, "vault/tags/rename", {"from": "方法论", "to": "阅读"})
        assert merged["merged"] and merged["changed"] == 1
        assert call(settings, "vault/document/resolve", page)["tags"] == [
            "重要",
            "阅读",
        ]
        removed = call(settings, "vault/tags/delete", {"tag": "阅读"})
        assert removed["changed"] == 2
        assert call(settings, "vault/document/resolve", page)["tags"] == ["重要"]
        assert call(settings, "vault/document/resolve", other)["tags"] == ["想法"]
        assert "tags:" in note.read_text("utf-8") and "阅读" not in note.read_text(
            "utf-8"
        )
        assert len(call(settings, "vault/documents/list", {})["documents"]) == 2
        call(settings, tags, {**other, "remove": ["想法"]})
        assert "tags:" not in other_note.read_text("utf-8")

        # Clipping the page again keeps the comment and tags.
        for replace in (False, True):
            call(
                settings,
                "vault/clip/save",
                {
                    **page,
                    "markdown": "The page's text.",
                    "html": "<p>The page's text.</p>",
                    "origin": {"method": "article", "pageUrl": page["url"]},
                    **({"replace": True} if replace else {}),
                },
            )
        resolved = call(settings, "vault/document/resolve", page)
        assert resolved["comment"] == text and resolved["tags"] == ["重要"]

        # A note the user deleted is written again with the comment and tags.
        note.unlink()
        assert call(settings, "vault/document/resolve", page)["comment"] == text
        call(
            settings,
            "vault/highlight/create",
            {**page, "text": "第二种", "anchor": anchor("第二种")},
        )
        markdown = note.read_text("utf-8")
        assert text in markdown and "tags:\n  - 重要\n" in markdown

        # reading_vault finds the comment and the tags.
        found = vault.tool(settings, {"action": "search", "query": "适用条件"})[
            "matches"
        ]
        assert any("适用条件" in m["text"] for m in found), found
        found = vault.tool(settings, {"action": "search", "query": "重要"})["matches"]
        assert any(m["text"] == "- 重要" for m in found), found

print("PASS document comments and tags")
