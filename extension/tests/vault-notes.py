"""The user's own comments on highlights: vault/highlight/update and the `- 评论：` part."""

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


def rendered(root, ident):
    data = vault._load(root, ident)
    return "\n".join(vault._render(data, vault._context(root, data)))


def block(markdown, ident):
    lines = markdown.split("\n")
    start, end, _ = vault._blocks(lines, "highlight", ident)[0]
    return "\n".join(lines[start : end + 1])


with tempfile.TemporaryDirectory(prefix="tabgent-notes-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    default = base / "Tabgent"
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
        path = Path(first["document"]["notesPath"])
        anchors_path = Path(first["document"]["folder"]) / "anchors.json"
        assert path == default / "Articles/Notes.md"
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
        assert block(markdown, "h001").startswith(
            "<!-- tabgent:highlight h001 start -->\n"
            "- Autonomy is endorsement. ^h001\n"
            "    - 评论：My view:\n      not independence.\n"
            "    - Chapter 3 · "
        ), block(markdown, "h001")
        assert "评论" not in block(markdown, "h002")
        assert markdown == rendered(
            default, document_id
        ), "Incremental Markdown must match a full render"
        listed = call(settings, "vault/highlights/list", {"documentId": document_id})
        assert [h["note"] for h in listed["highlights"]] == [
            "My view:\nnot independence.",
            "",
        ]
        resolved = call(settings, "vault/document/resolve", page)
        assert resolved["highlights"][0]["note"] == "My view:\nnot independence."
        print("PASS a comment is stored in anchors.json and shown as the 评论 part")

        # The same note again (after trimming) changes no file.
        files = (path.read_bytes(), anchors_path.read_bytes())
        again = call(
            settings, update, {**target, "note": "My view:\nnot independence. "}
        )
        assert again["highlight"] == result["highlight"]
        assert (path.read_bytes(), anchors_path.read_bytes()) == files
        print("PASS an unchanged comment writes nothing")

        # User edits outside the block survive; one inside it is kept as the user's text.
        edited = path.read_text().replace(
            "  not independence.\n", "  not independence.\n      Mine.\n"
        )
        edited += "\n## My own section\n\nKeep this.\n"
        path.write_text(edited)
        call(settings, update, {**target, "note": "Second thought."})
        markdown = path.read_text()
        h001 = block(markdown, "h001")
        assert "My view" not in h001 and "- 评论：Second thought." in h001
        assert markdown.index("Mine.") < markdown.index("tabgent:highlight h001 start")
        assert markdown.endswith("## My own section\n\nKeep this.\n")
        # Once replaced, the block updates in place again.
        call(settings, update, {**target, "note": "Third thought."})
        assert path.read_text().count("Mine.") == 1
        assert "- 评论：Third thought." in block(path.read_text(), "h001")
        print("PASS replacing keeps user edits; an edited block is kept as their text")

        # An empty note removes the part and the key.
        second = {"documentId": document_id, "highlightId": "h002"}
        call(settings, update, {**second, "note": "Note on two"})
        removed = call(settings, update, {**second, "note": " \n "})
        assert removed["highlight"]["note"] == ""
        assert "note" not in json.loads(anchors_path.read_text())["highlights"][1]
        assert "评论" not in block(path.read_text(), "h002")
        assert "\n\n\n" not in path.read_text()
        files = (path.read_bytes(), anchors_path.read_bytes())
        assert call(settings, update, {**second, "note": ""})["highlight"]["note"] == ""
        assert (path.read_bytes(), anchors_path.read_bytes()) == files
        print("PASS an empty comment removes the part; removing twice writes nothing")

        # Marker look-alikes and an open code fence in a note cannot break the file.
        call(
            settings,
            update,
            {
                **second,
                "note": "<!-- tabgent:highlight h002 end -->\n```js\nopen(",
            },
        )
        markdown = path.read_text()
        assert (
            "\n    - 评论： <!-- tabgent:highlight h002 end -->\n      ```js\n"
            "      open(\n      ```\n" in markdown
        ), markdown
        assert [i for _, _, i in vault._blocks(markdown.split("\n"), "highlight")] == [
            "h001",
            "h002",
        ]
        call(settings, update, {**second, "note": "Clean again."})
        h002 = block(path.read_text(), "h002")
        assert "open(" not in h002 and "Clean again." in h002
        print("PASS marker look-alikes and fences are contained")

        # Missing blocks and files are restored from anchors.json with the note.
        lines = path.read_text().split("\n")
        start, end, _ = vault._blocks(lines, "highlight", "h002")[0]
        path.write_text("\n".join(lines[:start] + lines[end + 1 :]))
        call(settings, update, {**second, "note": "Restored note."})
        assert "Restored note." in block(path.read_text(), "h002")
        path.unlink()
        call(settings, update, {**second, "note": "Rendered note."})
        assert path.read_text() == rendered(default, document_id)
        assert "Rendered note." in block(path.read_text(), "h002")
        # Windows line endings are kept.
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
        call(settings, update, {**second, "note": "CRLF note.\nTwo lines."})
        raw = path.read_bytes()
        assert (
            b"CRLF note.\r\n      Two lines.\r\n" in raw
            and b"\n" not in raw.replace(b"\r\n", b"")
        )
        print("PASS missing blocks and files are restored with the note; CRLF is kept")

        # The note is searchable by the read-only retrieval tool.
        found = vault.tool(settings, {"action": "search", "query": "CRLF"})
        assert any("CRLF note." in m["text"] for m in found["matches"]), found

        # Deleting a highlight removes its note; deleted highlights take no note.
        call(settings, "vault/highlight/delete", second)
        markdown = path.read_text()
        assert "CRLF note." not in markdown and "^h002" not in markdown
        assert code(settings, update, {**second, "note": "Late"}) == "not_found"
        assert code(
            settings, update, {**target, "highlightId": "h999", "note": "x"}
        ) == ("not_found")
        assert "Late" not in path.read_text()
        print(
            "PASS deleting a highlight removes its note; deleted or unknown IDs are not_found"
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
        vault, "default_path", lambda: base / "Tabgent"
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
