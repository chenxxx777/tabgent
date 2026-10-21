"""reading_vault: read-only search and reads confined to the vault, and its host route."""

import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1] / "native"
sys.path.insert(0, str(NATIVE))
import host
import vault


def call(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"result"}, reply
    return reply["result"]


def anchor(exact):
    return {
        "kind": "web",
        "quote": {"exact": exact, "prefix": "", "suffix": ""},
        "position": {"start": 0, "end": len(exact)},
    }


def failure(settings, args):
    try:
        vault.tool(settings, args)
    except vault.VaultError as error:
        return error.code
    raise AssertionError(f"{args} should fail")


with tempfile.TemporaryDirectory() as temp:
    temp = Path(temp)
    settings = temp / "codex/projects/tabgent/vault.json"
    root = temp / "Reading Vault"
    # A vault that does not exist yet is simply empty.
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({"version": 1, "path": str(root)}))
    assert vault.tool(settings, {"action": "list"})["documents"] == []
    call(settings, "vault/configure", {"path": str(root)})
    for url, title, text, question in [
        (
            "https://example.test/sdt",
            "Self-Determination Theory",
            "Competence, autonomy and relatedness are basic needs.",
            "Which need matters most?",
        ),
        (
            "https://example.test/rewards",
            "Rewards and interest",
            "Contingent rewards can undermine interest.",
            "Why do rewards backfire?",
        ),
    ]:
        made = call(
            settings,
            "vault/highlight/create",
            {
                "url": url,
                "title": title,
                "kind": "web",
                "text": text,
                "anchor": anchor(text),
            },
        )
        call(
            settings,
            "vault/discussion/append",
            {
                "documentId": made["document"]["id"],
                "highlightId": made["highlight"]["id"],
                "threadId": "t",
                "turnId": url,
                "user": question,
                "assistant": "Autonomy support keeps interest alive.",
            },
        )
    listed = vault.tool(settings, {"action": "list"})
    assert listed["vault"] == str(root)
    assert sorted(d["title"] for d in listed["documents"]) == [
        "Rewards and interest",
        "Self-Determination Theory",
    ]
    found = vault.tool(settings, {"action": "search", "query": "autonomy relatedness"})
    best = found["matches"][0]
    assert best["title"] == "Self-Determination Theory", found
    assert "relatedness" in best["text"]
    assert best["path"] == "Articles/Self-Determination Theory.md", best
    assert found["total"] >= 3, "Any keyword matches; both answers mention autonomy"
    assert all(
        "tabgent:" not in m["text"] for m in found["matches"]
    ), "Markers are skipped"
    read = vault.tool(
        settings, {"action": "read", "path": best["path"], "offset": 0, "limit": 5}
    )
    assert read["text"].startswith("1: ---") and read["lines"] > 5
    assert len(read["text"].split("\n")) == 5
    absolute = vault.tool(
        settings, {"action": "read", "path": str(root / best["path"])}
    )
    assert absolute["path"] == best["path"]
    paths = [m["path"] for m in found["matches"]]
    first_discussion = next(
        i for i, p in enumerate(paths) if p.startswith("Discussions/")
    )
    assert all(p.startswith("Articles/") for p in paths[:first_discussion])
    assert all(p.startswith("Discussions/") for p in paths[first_discussion:])
    print("PASS reading_vault lists documents, ranks keyword matches and reads notes")

    # read is limited to Tabgent's own files: the folder may be shared with other tools.
    outside = temp / "secret.md"
    outside.write_text("private")
    (root / "Articles/escape.md").symlink_to(outside)
    (root / "settings.json").write_text('{"token": "root secret"}')
    plugin = root / ".obsidian/plugins/sync"
    plugin.mkdir(parents=True)
    (plugin / "data.json").write_text('{"apiKey": "plugin secret"}')
    (root / "Personal.md").write_text("A private note")
    note = root / best["path"]
    ident = vault.tool(settings, {"action": "list"})["documents"][1]["id"]
    # A private note that copies a document's tabgent_id is not that document's note.
    (root / "Copied.md").write_text(f"---\ntabgent_id: {ident}\n---\nA secret copy\n")
    for args, code in [
        ({"action": "read", "path": "../secret.md"}, "invalid_params"),
        ({"action": "read", "path": str(outside)}, "invalid_params"),
        ({"action": "read", "path": "Articles/escape.md"}, "invalid_params"),
        ({"action": "read", "path": ".tabgent/catalog.json"}, "invalid_params"),
        ({"action": "read", "path": ".TABGENT/catalog.json"}, "invalid_params"),
        ({"action": "read", "path": "settings.json"}, "invalid_params"),
        ({"action": "read", "path": str(root / "settings.json")}, "invalid_params"),
        (
            {"action": "read", "path": ".obsidian/plugins/sync/data.json"},
            "invalid_params",
        ),
        ({"action": "read", "path": "Personal.md"}, "invalid_params"),
        ({"action": "read", "path": "Copied.md"}, "invalid_params"),
        ({"action": "read", "path": "AGENTS.txt"}, "invalid_params"),
        ({"action": "read", "path": "Articles/../settings.json"}, "invalid_params"),
        ({"action": "read", "path": best["path"].lower()}, "invalid_params"),
        ({"action": "read", "path": "Articles/missing.md"}, "invalid_params"),
        ({"action": "read", "part": "notes"}, "invalid_params"),
        (
            {"action": "read", "document": "article-missing-0000", "part": "notes"},
            "not_found",
        ),
        ({"action": "read", "document": ident, "part": "full"}, "not_found"),
        ({"action": "read", "document": ident, "part": "x"}, "invalid_params"),
        ({"action": "search", "query": " "}, "invalid_params"),
        ({"action": "write"}, "invalid_params"),
    ]:
        assert failure(settings, args) == code, args
    anchors = vault.tool(
        settings, {"action": "read", "document": ident, "part": "anchors"}
    )
    assert anchors["path"] == f".tabgent/documents/{ident}/anchors.json"
    assert '"turns"' in anchors["text"]
    assert vault.tool(settings, {"action": "read", "path": anchors["path"]})["lines"]
    by_part = vault.tool(
        settings, {"action": "read", "document": ident, "part": "notes"}
    )
    assert by_part["path"].startswith("Articles/") and by_part["text"].startswith(
        "1: ---"
    )
    # A note replaced by a link is no longer readable.
    saved = note.read_bytes()
    note.unlink()
    note.symlink_to(outside)
    assert (
        failure(settings, {"action": "read", "path": best["path"]}) == "invalid_params"
    )
    assert (
        failure(settings, {"action": "read", "path": "Copied.md"}) == "invalid_params"
    )
    assert (
        "notes"
        not in vault.tool(settings, {"action": "list", "document": ident})["documents"][
            0
        ]
    ), "The copy is not taken for the missing note"
    note.unlink()
    note.write_bytes(saved)
    assert vault.tool(settings, {"action": "read", "path": "AGENTS.md"})["lines"] > 10
    listed = [d["path"] for d in vault.tool(settings, {"action": "list"})["documents"]]
    assert all("Copied" not in p and "escape" not in p for p in listed), listed
    assert not any(
        "secret" in m["text"]
        for m in vault.tool(settings, {"action": "search", "query": "secret private"})[
            "matches"
        ]
    )
    print(
        "PASS reading_vault reads only Tabgent's notes, never other files in the folder"
    )

    # A vault set to the home folder must not expose the Codex login.
    home = temp / "home"
    (home / ".codex").mkdir(parents=True)
    (home / ".codex/auth.json").write_text('{"tokens": "login"}')
    home_settings = temp / "home-settings.json"
    home_settings.write_text(json.dumps({"version": 1, "path": str(home)}))
    for path in (".codex/auth.json", str(home / ".codex/auth.json")):
        assert (
            failure(home_settings, {"action": "read", "path": path}) == "invalid_params"
        )
    print("PASS a vault in the home folder cannot read ~/.codex/auth.json")

    # Codex's dynamic tool call is answered by the host without reaching the extension.
    session = host.Session("s", {})
    written, emitted = [], []
    session.write = written.append
    session.emit = emitted.append
    with patch.object(host, "HOME", temp / "codex"):
        session.reply_vault_tool(
            {
                "id": 7,
                "method": "item/tool/call",
                "params": {
                    "tool": "reading_vault",
                    "arguments": json.dumps({"action": "search", "query": "rewards"}),
                },
            }
        )
        session.reply_vault_tool(
            {
                "id": 8,
                "params": {"tool": "reading_vault", "arguments": {"action": "read"}},
            }
        )
    assert written[0]["id"] == 7 and written[0]["result"]["success"] is True
    payload = json.loads(written[0]["result"]["contentItems"][0]["text"])
    assert payload["matches"][0]["title"] == "Rewards and interest"
    assert written[1]["result"] == {
        "success": False,
        "contentItems": [{"type": "inputText", "text": "path is required"}],
    }
    assert emitted == []
    params = host.Session("t", {"dynamicTools": [{"name": "browser"}]})
    params.project_id = "p"
    names = [t["name"] for t in params.thread_params({})["dynamicTools"]]
    assert names == ["browser", "read_attachment", "reading_vault"], names
    print(
        "PASS host answers reading_vault calls locally and offers the tool to threads"
    )
