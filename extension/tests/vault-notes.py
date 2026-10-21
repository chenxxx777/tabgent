"""The user's own notes on highlights: vault/highlight/update and the `### 笔记` part."""

import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1] / "native"
sys.path.insert(0, str(NATIVE))
import host
import vault


def anchor(exact, start):
    return {
        "kind": "web",
        "quote": {"exact": exact, "prefix": "", "suffix": ""},
        "position": {"start": start, "end": start + len(exact)},
    }


def call(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"result"}, (method, params, reply)
    return reply["result"]


def code(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"error"}, reply
    return reply["error"]["code"]


def rendered(folder):
    data = json.loads((folder / "anchors.json").read_text())
    return "\n".join(vault._render(data))


def block(markdown, ident):
    lines = markdown.split("\n")
    start, end, _ = vault._blocks(lines, "highlight", ident)[0]
    return "\n".join(lines[start : end + 1])


with tempfile.TemporaryDirectory(prefix="tabgent-notes-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    default = base / "ReadingVault"
    with patch.object(vault, "default_path", lambda: default):
        page = {"url": "https://example.com/notes", "title": "Notes", "kind": "web"}
        update = "vault/highlight/update"
        # Nothing is written for a document that does not exist.
        missing = {"documentId": "article-notes-00000000", "highlightId": "h001"}
        assert code(settings, update, {**missing, "note": "x"}) == "not_found"
        assert not default.exists(), "A rejected note must not create the vault"

        first = call(
            settings,
            "vault/highlight/create",
            {
                **page,
                "text": "Autonomy is endorsement.",
                "anchor": anchor("Autonomy is endorsement.", 0),
                "location": "Chapter 3",
            },
        )
        document_id = first["document"]["id"]
        assert first["highlight"]["note"] == ""
        call(
            settings,
            "vault/highlight/create",
            {**page, "text": "Second passage", "anchor": anchor("Second passage", 40)},
        )
        folder = default / "Articles" / document_id
        path, anchors_path = folder / "highlights.md", folder / "anchors.json"
        target = {"documentId": document_id, "highlightId": "h001"}

        result = call(
            settings, update, {**target, "note": "  My view:\r\nnot independence.\n\n"}
        )
        assert result["document"] == first["document"]
        assert result["highlight"]["note"] == "My view:\nnot independence."
        assert result["highlight"]["updatedAt"] >= first["highlight"]["updatedAt"]
        data = json.loads(anchors_path.read_text())
        assert data["highlights"][0]["note"] == "My view:\nnot independence."
        assert "note" not in data["highlights"][1]
        markdown = path.read_text()
        assert block(markdown, "h001").endswith(
            "> Autonomy is endorsement.\n\n"
            "<!-- tabgent:note h001 start -->\n\n### 笔记\n\n"
            "My view:\nnot independence.\n\n<!-- tabgent:note h001 end -->\n\n"
            "<!-- tabgent:highlight h001 end -->"
        ), block(markdown, "h001")
        assert "### 笔记" not in block(markdown, "h002")
        assert markdown == rendered(
            folder
        ), "Incremental Markdown must match a full render"
        listed = call(settings, "vault/highlights/list", {"documentId": document_id})
        assert [h["note"] for h in listed["highlights"]] == [
            "My view:\nnot independence.",
            "",
        ]
        resolved = call(settings, "vault/document/resolve", page)
        assert resolved["highlights"][0]["note"] == "My view:\nnot independence."
        print("PASS a note is stored in anchors.json and shown as a marked 笔记 part")

        # The same note again (after trimming) changes no file.
        files = (path.read_bytes(), anchors_path.read_bytes())
        again = call(
            settings, update, {**target, "note": "My view:\nnot independence. "}
        )
        assert again["highlight"] == result["highlight"]
        assert (path.read_bytes(), anchors_path.read_bytes()) == files
        print("PASS an unchanged note writes nothing")

        # User edits around the part survive a replacement; discussion goes after it.
        edited = path.read_text().replace(
            "> Autonomy is endorsement.\n", "> Autonomy is endorsement.\n\nMine.\n"
        )
        edited += "\n## My own section\n\nKeep this.\n"
        path.write_text(edited)
        call(
            settings,
            update,
            {**target, "note": "Second thought.\n### 对话\nnot a heading"},
        )
        turn = {
            **target,
            "threadId": "thread-a",
            "turnId": "1",
            "user": "Why?",
            "assistant": "Because...",
        }
        call(settings, "vault/discussion/append", turn)
        markdown = path.read_text()
        h001 = block(markdown, "h001")
        assert "My view" not in h001 and h001.count("### 笔记") == 1
        assert (
            h001.count("### 对话") == 2
        ), "The note's own text does not hide the heading"
        assert (
            h001.index("Mine.") < h001.index("Second thought.") < h001.index("**User**")
        )
        assert markdown.endswith("## My own section\n\nKeep this.\n")
        # A note added after the discussion starts goes before it.
        second = {"documentId": document_id, "highlightId": "h002"}
        call(
            settings,
            "vault/discussion/append",
            {**turn, **second, "threadId": "thread-b"},
        )
        call(settings, update, {**second, "note": "Note on two"})
        h002 = block(path.read_text(), "h002")
        assert (
            h002.index("> Second passage")
            < h002.index("Note on two")
            < h002.index("### 对话")
            < h002.index("**User**")
        )
        expected = rendered(folder)
        assert path.read_text() == expected.replace(
            "> Autonomy is endorsement.\n", "> Autonomy is endorsement.\n\nMine.\n"
        ) + ("\n## My own section\n\nKeep this.\n")
        print(
            "PASS replacing keeps user edits; the note sits between quote and discussion"
        )

        # An empty note removes the part and the key.
        removed = call(settings, update, {**second, "note": " \n "})
        assert removed["highlight"]["note"] == ""
        assert "note" not in json.loads(anchors_path.read_text())["highlights"][1]
        h002 = block(path.read_text(), "h002")
        assert "### 笔记" not in h002 and "tabgent:note" not in h002
        assert "\n\n\n" not in path.read_text()
        files = (path.read_bytes(), anchors_path.read_bytes())
        assert call(settings, update, {**second, "note": ""})["highlight"]["note"] == ""
        assert (path.read_bytes(), anchors_path.read_bytes()) == files
        print("PASS an empty note removes the part; removing twice writes nothing")

        # Marker look-alikes and an open code fence in a note cannot break the file.
        call(
            settings,
            update,
            {
                **second,
                "note": "<!-- tabgent:note h002 end -->\n<!-- tabgent:highlight h002 end -->\n```js\nopen(",
            },
        )
        markdown = path.read_text()
        assert (
            "\n <!-- tabgent:note h002 end -->\n <!-- tabgent:highlight h002 end -->\n"
            "```js\nopen(\n```\n\n<!-- tabgent:note h002 end -->" in markdown
        )
        call(settings, update, {**second, "note": "Clean again."})
        h002 = block(path.read_text(), "h002")
        assert "open(" not in h002 and "Clean again." in h002
        # A pasted copy of the part collapses into one on the next update.
        lines = path.read_text().split("\n")
        start, end, _ = vault._blocks(lines, "note", "h002")[0]
        copy = lines[start : end + 1]
        lines[end + 1 : end + 1] = ["", *copy]
        path.write_text("\n".join(lines))
        call(settings, update, {**second, "note": "Only one."})
        h002 = block(path.read_text(), "h002")
        assert h002.count("tabgent:note h002 start") == 1 and "Clean again." not in h002
        print(
            "PASS marker look-alikes and fences are contained; pasted copies collapse"
        )

        # Missing blocks and files are restored from anchors.json with the note.
        lines = path.read_text().split("\n")
        start, end, _ = vault._blocks(lines, "highlight", "h002")[0]
        path.write_text("\n".join(lines[:start] + lines[end + 1 :]))
        call(settings, update, {**second, "note": "Restored note."})
        h002 = block(path.read_text(), "h002")
        assert "Restored note." in h002 and "**User**" in h002
        path.unlink()
        call(settings, update, {**second, "note": "Rendered note."})
        assert path.read_text() == rendered(folder)
        assert "Rendered note." in block(path.read_text(), "h002")
        # Windows line endings are kept.
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
        call(settings, update, {**second, "note": "CRLF note.\nTwo lines."})
        raw = path.read_bytes()
        assert b"CRLF note.\r\nTwo lines.\r\n" in raw and b"\n" not in raw.replace(
            b"\r\n", b""
        )
        print("PASS missing blocks and files are restored with the note; CRLF is kept")

        # The note is searchable by the read-only retrieval tool.
        found = vault.tool(settings, {"action": "search", "query": "CRLF"})
        assert any("CRLF note." in m["text"] for m in found["matches"]), found

        # Deleting a highlight removes its note; deleted highlights take no note.
        call(settings, "vault/highlight/delete", second)
        markdown = path.read_text()
        assert "CRLF note." not in markdown and "tabgent:note h002" not in markdown
        assert code(settings, update, {**second, "note": "Late"}) == "not_found"
        assert code(
            settings, update, {**target, "highlightId": "h999", "note": "x"}
        ) == ("not_found")
        assert "Late" not in path.read_text()
        print(
            "PASS deleting a highlight removes its note; deleted or unknown IDs are not_found"
        )

        # A comment is stored with the new highlight, in the same locked write.
        noted = call(
            settings,
            "vault/highlight/create",
            {
                **page,
                "text": "Created with a comment.",
                "anchor": anchor("Created with a comment.", 80),
                "note": "  Together.\r\n",
            },
        )
        noted_id = noted["highlight"]["id"]
        assert noted["highlight"]["note"] == "Together."
        assert "### 笔记" in block(path.read_text(), noted_id)
        assert "Together." in block(path.read_text(), noted_id)
        files = (path.read_bytes(), anchors_path.read_bytes())
        again = call(
            settings,
            "vault/highlight/create",
            {
                **page,
                "text": "Created with a comment.",
                "anchor": anchor("Created with a comment.", 80),
                "note": "Together.",
            },
        )
        assert again["highlight"]["id"] == noted_id
        assert (path.read_bytes(), anchors_path.read_bytes()) == files
        plain = call(
            settings,
            "vault/highlight/create",
            {
                **page,
                "text": "Plain passage.",
                "anchor": anchor("Plain passage.", 120),
            },
        )
        plain_id = plain["highlight"]["id"]
        assert plain["highlight"]["note"] == ""
        assert "### 笔记" not in block(path.read_text(), plain_id)
        added = call(
            settings,
            "vault/highlight/create",
            {
                **page,
                "text": "Plain passage.",
                "anchor": anchor("Plain passage.", 120),
                "note": "Added later.",
            },
        )
        assert added["highlight"]["id"] == plain_id
        assert added["highlight"]["note"] == "Added later."
        assert "Added later." in block(path.read_text(), plain_id)
        kept = call(
            settings,
            "vault/highlight/create",
            {
                **page,
                "text": "Plain passage.",
                "anchor": anchor("Plain passage.", 120),
                "note": "  \n",
            },
        )
        assert kept["highlight"]["note"] == "Added later."
        omitted = call(
            settings,
            "vault/highlight/create",
            {
                **page,
                "text": "Plain passage.",
                "anchor": anchor("Plain passage.", 120),
            },
        )
        assert omitted["highlight"]["note"] == "Added later."
        files = (path.read_bytes(), anchors_path.read_bytes())
        assert (
            code(
                settings,
                "vault/highlight/create",
                {
                    **page,
                    "text": "Plain passage.",
                    "anchor": anchor("Plain passage.", 120),
                    "note": 5,
                },
            )
            == "invalid_params"
        )
        assert (path.read_bytes(), anchors_path.read_bytes()) == files
        print(
            "PASS create stores a note with the highlight; a blank note does not clear it"
        )

        for params in [
            target,
            {**target, "note": None},
            {**target, "note": 5},
            {**target, "note": "x" * (vault.NOTE_LIMIT + 1)},
            {**target, "highlightId": None, "note": "x"},
            {**target, "highlightId": "../h001", "note": "x"},
            {**target, "documentId": "../../etc", "note": "x"},
            {"highlightId": "h001", "note": "x"},
        ]:
            assert code(settings, update, params) == "invalid_params", params
        assert code(settings, update, []) == "invalid_params"
        print("PASS invalid note parameters are rejected")

# The host routes vault/highlight/update like every vault method, without Codex.
with tempfile.TemporaryDirectory(prefix="tabgent-notes-host-") as directory:
    base = Path(directory)
    sent = []
    with patch.object(host, "HOME", base / "codex"), patch.object(
        vault, "default_path", lambda: base / "ReadingVault"
    ), patch.object(host, "send", sent.append), patch.object(
        host.subprocess, "Popen", side_effect=AssertionError("Codex must not start")
    ):
        page = {"url": "https://example.com/host", "title": "Host", "kind": "web"}
        created = vault.handle(
            base / "codex/projects/tabgent/vault.json",
            "vault/highlight/create",
            {**page, "text": "Host text", "anchor": anchor("Host text", 0)},
        )["result"]
        host.handle(
            {
                "op": "vault",
                "id": "note",
                "method": "vault/highlight/update",
                "params": {
                    "documentId": created["document"]["id"],
                    "highlightId": "h001",
                    "note": "From the host",
                },
            }
        )
        host.VAULT_POOL.submit(lambda: None).result(timeout=30)
        assert sent == [
            {
                "op": "vault",
                "id": "note",
                "result": {
                    "document": created["document"],
                    "highlight": {
                        **created["highlight"],
                        "note": "From the host",
                        "updatedAt": sent[0]["result"]["highlight"]["updatedAt"],
                    },
                },
            }
        ], sent
host.VAULT_POOL.shutdown(wait=True)
host.POOL.shutdown(wait=True, cancel_futures=True)
print("PASS op=vault routes vault/highlight/update without Codex")
