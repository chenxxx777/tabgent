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
    assert "relatedness" in best["text"] and best["path"].endswith("highlights.md")
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
    print("PASS reading_vault lists documents, ranks keyword matches and reads notes")

    outside = temp / "secret.md"
    outside.write_text("private")
    (root / "Articles/escape.md").symlink_to(outside)
    for args, code in [
        ({"action": "read", "path": "../secret.md"}, "invalid_params"),
        ({"action": "read", "path": str(outside)}, "invalid_params"),
        ({"action": "read", "path": "Articles/escape.md"}, "invalid_params"),
        ({"action": "read", "path": ".tabgent/index.json"}, "invalid_params"),
        ({"action": "read", "path": "AGENTS.txt"}, "invalid_params"),
        ({"action": "read", "path": "Articles/missing/highlights.md"}, "not_found"),
        ({"action": "search", "query": " "}, "invalid_params"),
        ({"action": "write"}, "invalid_params"),
    ]:
        assert failure(settings, args) == code, args
    assert vault.tool(settings, {"action": "read", "path": "AGENTS.md"})["lines"] > 10
    print("PASS reading_vault stays inside the vault and never reads Tabgent's index")

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
