"""ReadingVault files, Markdown blocks, concurrency and the op=vault host route."""

import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1] / "native"
sys.path.insert(0, str(NATIVE))
import host
import vault


def anchor(exact, start):
    return {
        "kind": "web",
        "quote": {"exact": exact, "prefix": "before ", "suffix": " after"},
        "position": {"start": start, "end": start + len(exact)},
    }


def call(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"result"}, (method, params, reply)
    return reply["result"]


def code(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"error"} and set(reply["error"]) == {"code", "message"}, reply
    return reply["error"]["code"]


def markdown_ids(text):
    return [ident for _, _, ident in vault._blocks(text.split("\n"), "highlight")]


def rendered(folder):
    data = json.loads((folder / "anchors.json").read_text())
    return "\n".join(vault._render(data))


def local(iso):
    moment = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return moment.astimezone().isoformat(timespec="seconds")


with tempfile.TemporaryDirectory(prefix="tabgent-vault-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    default = base / "ReadingVault"
    with patch.object(vault, "default_path", lambda: default):
        # Defaults: nothing exists until the first write.
        assert call(settings, "vault/status", {}) == {
            "configured": False,
            "path": str(default),
            "defaultPath": str(default),
            "writable": True,
        }
        page = {
            "url": "https://example.com/essay?id=7#intro",
            "title": "On Reading:  Notes",
            "kind": "web",
            "meta": {"author": "A. Writer", "siteName": "Example"},
        }
        resolved = call(settings, "vault/document/resolve", page)
        document_id = resolved["document"]["id"]
        assert re.fullmatch(
            r"article-on-reading-notes-[0-9a-f]{8}", document_id
        ), document_id
        assert (
            resolved["highlights"] == [] and resolved["document"]["createdAt"] is None
        )
        assert resolved["document"]["url"] == "https://example.com/essay?id=7"
        bad = {**page, "text": "x", "anchor": {"kind": "web", "quote": {}}}
        assert code(settings, "vault/highlight/create", bad) == "invalid_params"
        assert (
            not default.exists()
        ), "Reads and rejected writes must not create the vault"

        # Create, list, and resolve the same page again.
        first = call(
            settings,
            "vault/highlight/create",
            {
                **page,
                "text": "Reading is thinking\nwith another mind.",
                "anchor": anchor("Reading is thinking", 10),
                "location": "Introduction",
            },
        )
        folder = default / "Articles" / document_id
        document = first["document"]
        assert document == {
            **resolved["document"],
            "title": "On Reading: Notes",
            "createdAt": document["createdAt"],
        }
        assert document["createdAt"] and document["folder"] == str(folder)
        assert document["highlightsPath"] == str(folder / "highlights.md")
        assert first["highlight"]["id"] == "h001"
        assert (
            first["highlight"]["threadIds"] == []
            and first["highlight"]["turnCount"] == 0
        )
        assert first["highlight"]["anchor"] == anchor("Reading is thinking", 10)
        assert (default / "Articles").is_dir() and (default / "Books").is_dir()
        agents = (default / "AGENTS.md").read_text()
        for expected in [
            "rg -n -i",
            "highlights.md",
            "Distinguish the author",
            str(default),
        ]:
            assert expected in agents, expected
        markdown = (folder / "highlights.md").read_text()
        assert markdown.startswith(
            '---\ntitle: "On Reading: Notes"\ntype: article\n'
            f'document_id: {document_id}\nsource: "https://example.com/essay?id=7"\n'
            'author: "A. Writer"\nsite: "Example"\ncreated: '
        ), markdown
        for expected in [
            "\n# 阅读笔记：《On Reading: Notes》\n",
            "\n## Highlight 001\n",
            "\n- 位置：Introduction\n",
            "\n- Anchor ID: h001\n",
            "\n> Reading is thinking\n> with another mind.\n",
        ]:
            assert expected in markdown, expected
        second_params = {
            **page,
            "text": "Second passage\n\nwith a paragraph break",
            "anchor": anchor("Second passage", 90),
        }
        second = call(settings, "vault/highlight/create", second_params)
        assert (
            second["highlight"]["id"] == "h002"
            and second["highlight"]["location"] == ""
        )
        assert (
            "\n> Second passage\n>\n> with a paragraph break\n"
            in (folder / "highlights.md").read_text()
        )
        retry = call(settings, "vault/highlight/create", second_params)
        assert retry["highlight"]["id"] == "h002", "A retried create must not duplicate"
        listed = call(settings, "vault/highlights/list", {"documentId": document_id})
        assert [h["id"] for h in listed["highlights"]] == ["h001", "h002"]
        same_page = {
            **page,
            "url": "https://example.com/essay?id=7#later",
            "title": "New",
        }
        again = call(settings, "vault/document/resolve", same_page)
        assert (
            again["document"] == document
            and again["highlights"] == listed["highlights"]
        )
        other = call(
            settings,
            "vault/document/resolve",
            {**page, "url": "https://example.com/essay?id=8"},
        )
        assert (
            other["document"]["id"] != document_id
            and other["document"]["createdAt"] is None
        )
        assert (folder / "highlights.md").read_text() == rendered(folder)
        print(
            "PASS vault defaults, create/list/resolve, fragments, retries and Markdown shape"
        )

        # Discussions are idempotent on (threadId, turnId).
        turn = {
            "documentId": document_id,
            "highlightId": "h001",
            "threadId": "thread-a",
            "turnId": "turn-1",
            "user": "Why is reading thinking?",
            "assistant": "Because the author argues...",
            "at": "2026-10-20T08:00:00Z",
        }
        result = call(settings, "vault/discussion/append", turn)
        assert result == {"ok": True, "duplicate": False, "document": document}
        before = (folder / "highlights.md").read_bytes()
        duplicate = call(
            settings, "vault/discussion/append", {**turn, "user": "changed"}
        )
        assert duplicate["duplicate"] is True
        assert (folder / "highlights.md").read_bytes() == before
        call(
            settings,
            "vault/discussion/append",
            {**turn, "turnId": "turn-2", "user": "Follow-up", "at": 1792483200000},
        )
        call(
            settings,
            "vault/discussion/append",
            {**turn, "threadId": "thread-b", "at": None},
        )
        discussion = call(
            settings,
            "vault/discussion/get",
            {"documentId": document_id, "highlightId": "h001"},
        )
        assert discussion["threadIds"] == ["thread-a", "thread-b"]
        assert [(t["threadId"], t["turnId"]) for t in discussion["turns"]] == [
            ("thread-a", "turn-1"),
            ("thread-a", "turn-2"),
            ("thread-b", "turn-1"),
        ]
        assert discussion["turns"][0] == {
            "threadId": "thread-a",
            "turnId": "turn-1",
            "user": "Why is reading thinking?",
            "assistant": "Because the author argues...",
            "at": local("2026-10-20T08:00:00Z"),
        }
        epoch = datetime.datetime.fromtimestamp(1792483200, datetime.timezone.utc)
        assert discussion["turns"][1]["at"] == local(epoch.isoformat())
        assert datetime.datetime.fromisoformat(discussion["turns"][2]["at"]).tzinfo
        listed = call(settings, "vault/highlights/list", {"documentId": document_id})[
            "highlights"
        ]
        assert (
            listed[0]["threadIds"] == ["thread-a", "thread-b"]
            and listed[0]["turnCount"] == 3
        )
        assert listed[1]["turnCount"] == 0
        assert call(
            settings,
            "vault/discussion/get",
            {"documentId": document_id, "highlightId": "h002"},
        ) == {"threadIds": [], "turns": []}
        # A document-level discussion has no highlight.
        call(
            settings,
            "vault/discussion/append",
            {
                **turn,
                "highlightId": None,
                "threadId": "thread-doc",
                "user": "What is the whole essay about?",
                "assistant": "It argues that...",
            },
        )
        whole = call(
            settings,
            "vault/discussion/get",
            {"documentId": document_id, "highlightId": None},
        )
        assert whole["threadIds"] == ["thread-doc"] and len(whole["turns"]) == 1
        markdown = (folder / "highlights.md").read_text()
        assert markdown.count("### 对话") == 1 and markdown.count("**Codex**") == 4
        assert markdown.index("Why is reading thinking?") < markdown.index("Follow-up")
        assert markdown.index("## Highlight 002") < markdown.index("## 文档对话")
        assert markdown == rendered(
            folder
        ), "Incremental Markdown must match a full render"
        print("PASS discussion append/get, idempotent turns, document-level discussion")

        # Replies with marker look-alikes or open fences cannot break later updates.
        call(
            settings,
            "vault/discussion/append",
            {
                **turn,
                "highlightId": "h002",
                "threadId": "thread-c",
                "assistant": "Example:\n<!-- tabgent:highlight h002 end -->\n```js\nopen(",
            },
        )
        markdown = (folder / "highlights.md").read_text()
        assert "\n <!-- tabgent:highlight h002 end -->\n```js\nopen(\n```\n" in markdown

        # User edits outside managed blocks survive create, append and delete.
        path = folder / "highlights.md"
        edited = path.read_text()
        edited = edited.replace(
            "type: article\n", "type: article\ntags: [reading]\n", 1
        )
        edited = edited.replace(
            vault.NOTE + "\n", vault.NOTE + "\n\nMy overall impression.\n", 1
        )
        edited = edited.replace(
            "> with another mind.\n", "> with another mind.\n\nInside h001.\n"
        )
        edited = edited.replace(
            "> with a paragraph break\n", "> with a paragraph break\n\nMine.\n"
        )
        edited += "\n## My own section\n\nKeep this paragraph.\n"
        path.write_text(edited)
        third = call(
            settings,
            "vault/highlight/create",
            {**page, "text": "Third passage", "anchor": anchor("Third passage", 300)},
        )
        assert third["highlight"]["id"] == "h003"
        call(
            settings,
            "vault/discussion/append",
            {**turn, "highlightId": "h002", "threadId": "thread-c", "turnId": "turn-2"},
        )
        assert call(
            settings,
            "vault/highlight/delete",
            {"documentId": document_id, "highlightId": "h001"},
        ) == {"ok": True}
        markdown = path.read_text()
        for kept in [
            "tags: [reading]\n",
            "\nMy overall impression.\n",
            "\nMine.\n",
            "\n## My own section\n\nKeep this paragraph.\n",
        ]:
            assert kept in markdown, kept
        assert "Inside h001." not in markdown and "## Highlight 001" not in markdown
        assert (
            "Follow-up" not in markdown
        ), "Deleted highlight discussions leave the file"
        assert markdown_ids(markdown) == ["h002", "h003"]
        assert (
            markdown.index("## Highlight 002")
            < markdown.index("## Highlight 003")
            < markdown.index("## 文档对话")
            < markdown.index("## My own section")
        )
        start, end, _ = vault._blocks(markdown.split("\n"), "highlight", "h002")[0]
        block = "\n".join(markdown.split("\n")[start : end + 1])
        assert block.count("**User**") == 2 and block.index("Mine.") < block.index(
            "### 对话"
        )
        assert markdown.endswith("Keep this paragraph.\n") and "\n\n\n" not in markdown
        data = json.loads((folder / "anchors.json").read_text())
        assert [h["id"] for h in data["highlights"]] == ["h002", "h003"]
        assert all(t["highlightId"] != "h001" for t in data["turns"])
        print("PASS user edits preserved; marker look-alikes and open fences contained")

        # Deleted highlights, idempotent delete, and unknown targets.
        delete = {"documentId": document_id, "highlightId": "h001"}
        assert call(settings, "vault/highlight/delete", delete) == {"ok": True}
        assert code(
            settings, "vault/highlight/delete", {**delete, "highlightId": "h999"}
        ) == ("not_found")
        assert code(settings, "vault/discussion/append", turn) == "not_found"
        assert code(settings, "vault/discussion/get", delete) == "not_found"
        missing = {"documentId": "article-missing-00000000"}
        assert code(settings, "vault/highlights/list", missing) == "not_found"
        assert code(
            settings, "vault/highlight/delete", {**missing, "highlightId": "h001"}
        ) == ("not_found")

        # A missing block or file is restored from anchors.json on the next write to it.
        lines = path.read_text().split("\n")
        start, end, _ = vault._blocks(lines, "highlight", "h003")[0]
        path.write_text("\n".join(lines[:start] + lines[end + 1 :]))
        call(
            settings,
            "vault/discussion/append",
            {**turn, "highlightId": "h003", "threadId": "thread-d", "turnId": "1"},
        )
        markdown = path.read_text()
        assert (
            markdown_ids(markdown) == ["h002", "h003"]
            and "## My own section" in markdown
        )
        path.unlink()
        call(
            settings,
            "vault/discussion/append",
            {**turn, "highlightId": "h003", "threadId": "thread-d", "turnId": "2"},
        )
        assert path.read_text() == rendered(folder)
        assert markdown_ids(path.read_text()) == ["h002", "h003"]

        # A first document-level discussion can create the document from its URL.
        fresh_page = {
            "url": "https://example.com/fresh",
            "title": "新文章 Fresh",
            "kind": "web",
        }
        fresh = call(settings, "vault/document/resolve", fresh_page)["document"]
        assert fresh["id"].startswith("article-新文章-fresh-")
        doc_turn = {
            "documentId": fresh["id"],
            "highlightId": None,
            "threadId": "thread-e",
            "turnId": "1",
            "user": "Summarize the claim?",
            "assistant": "It claims...",
        }
        assert code(settings, "vault/discussion/append", doc_turn) == "not_found"
        created = call(settings, "vault/discussion/append", {**doc_turn, **fresh_page})
        assert (
            created["document"]["id"] == fresh["id"]
            and created["document"]["createdAt"]
        )
        assert "## 文档对话" in Path(fresh["highlightsPath"]).read_text()
        assert call(settings, "vault/discussion/append", doc_turn)["duplicate"] is True

        # The URL index is rebuilt from document folders when lost or unreadable.
        index = default / ".tabgent/index.json"
        index.unlink()
        assert (
            call(settings, "vault/document/resolve", page)["document"]["id"]
            == document_id
        )
        index.write_text("{broken")
        assert (
            call(settings, "vault/document/resolve", fresh_page)["document"]
            == created["document"]
        )
        call(
            settings,
            "vault/highlight/create",
            {**page, "text": "Index rebuild", "anchor": anchor("Index rebuild", 500)},
        )
        assert set(json.loads(index.read_text())["urls"].values()) == {
            document_id,
            fresh["id"],
        }
        print(
            "PASS delete, not_found, block/file restoration, URL-created documents, index rebuild"
        )

        # Bad params and unknown methods are rejected with stable codes.
        source = {"url": "https://example.com/x", "title": "X", "kind": "web"}
        create = {**source, "text": "x", "anchor": anchor("x", 0)}
        append = {**turn, "documentId": document_id, "highlightId": "h002"}
        for method, params, expected in [
            ("vault/unknown", {}, "unknown_method"),
            (None, {}, "unknown_method"),
            ("vault/status", [], "invalid_params"),
            ("vault/configure", {}, "invalid_params"),
            ("vault/configure", {"path": "relative/vault"}, "invalid_params"),
            ("vault/document/resolve", {**source, "url": ""}, "invalid_params"),
            (
                "vault/document/resolve",
                {**source, "url": "example.com/x"},
                "invalid_params",
            ),
            ("vault/document/resolve", {**source, "kind": "video"}, "invalid_params"),
            ("vault/document/resolve", {**source, "kind": ["web"]}, "invalid_params"),
            ("vault/document/resolve", {**source, "title": 5}, "invalid_params"),
            ("vault/document/resolve", {**source, "meta": "x"}, "invalid_params"),
            ("vault/highlight/create", {**create, "text": "  "}, "invalid_params"),
            ("vault/highlight/create", {**create, "anchor": None}, "invalid_params"),
            (
                "vault/highlight/create",
                {**create, "anchor": {"quote": {}}},
                "invalid_params",
            ),
            ("vault/highlight/create", {**create, "location": 3}, "invalid_params"),
            (
                "vault/highlight/delete",
                {**delete, "documentId": "../../etc"},
                "invalid_params",
            ),
            (
                "vault/highlight/delete",
                {**delete, "highlightId": None},
                "invalid_params",
            ),
            (
                "vault/highlight/delete",
                {**delete, "highlightId": "../x"},
                "invalid_params",
            ),
            ("vault/highlights/list", {}, "invalid_params"),
            ("vault/highlights/list", {"documentId": "Articles/x"}, "invalid_params"),
            (
                "vault/discussion/append",
                {**append, "at": "yesterday"},
                "invalid_params",
            ),
            ("vault/discussion/append", {**append, "at": True}, "invalid_params"),
            ("vault/discussion/append", {**append, "threadId": ""}, "invalid_params"),
            ("vault/discussion/append", {**append, "user": 5}, "invalid_params"),
            (
                "vault/discussion/append",
                {**append, "documentId": None},
                "invalid_params",
            ),
            (
                "vault/discussion/append",
                {k: v for k, v in append.items() if k != "highlightId"},
                "invalid_params",
            ),
            ("vault/discussion/get", {"documentId": document_id}, "invalid_params"),
        ]:
            assert code(settings, method, params) == expected, (method, params)
        print("PASS invalid params and unknown methods")

        # Unreadable files are reported and never replaced.
        anchors = folder / "anchors.json"
        good = anchors.read_bytes()
        anchors.write_text("{not json")
        assert (
            code(settings, "vault/highlights/list", {"documentId": document_id})
            == "io_error"
        )
        blocked = {**page, "text": "x", "anchor": anchor("x", 0)}
        assert code(settings, "vault/highlight/create", blocked) == "io_error"
        assert code(settings, "vault/document/resolve", page) == "io_error"
        assert anchors.read_text() == "{not json"
        anchors.write_bytes(good)
        path.write_bytes(b"\xff\xfe legacy encoding")
        assert code(settings, "vault/discussion/append", append) == "io_error"
        assert path.read_bytes() == b"\xff\xfe legacy encoding"
        assert json.loads(anchors.read_bytes()) == json.loads(good)
        path.unlink()
        settings.parent.mkdir(parents=True)
        settings.write_text("[]")
        assert code(settings, "vault/status", {}) == "io_error"
        assert (
            code(settings, "vault/highlights/list", {"documentId": document_id})
            == "io_error"
        )
        settings.unlink()
        print(
            "PASS corrupt anchors, non-UTF-8 Markdown and settings are reported, not replaced"
        )

        # Configure: persisted host-side, scaffolded, user AGENTS.md left alone.
        custom = base / "Notes Vault"
        custom.mkdir()
        (custom / "AGENTS.md").write_text("# My own rules\n")
        configured = call(settings, "vault/configure", {"path": f" {custom}/ "})
        assert configured == {
            "configured": True,
            "path": str(custom),
            "defaultPath": str(default),
            "writable": True,
        }
        assert call(settings, "vault/status", {}) == configured
        assert json.loads(settings.read_text())["path"] == str(custom)
        assert settings.stat().st_mode & 0o777 == 0o600
        assert (custom / "AGENTS.md").read_text() == "# My own rules\n"
        assert (custom / "Articles").is_dir() and (custom / "Books").is_dir()
        assert (
            call(settings, "vault/document/resolve", page)["document"]["createdAt"]
            is None
        )
        with patch.dict(os.environ, {"HOME": str(base)}):
            assert call(settings, "vault/configure", {"path": "~/Home Vault"})[
                "path"
            ] == str(base / "Home Vault")
        # Tabgent's block in its AGENTS.md is refreshed; text around it is kept.
        agents_path = default / "AGENTS.md"
        stale = agents_path.read_text().replace("## Reading rules", "## Old rules")
        agents_path.write_text("My preface.\n\n" + stale + "\nMy appendix.\n")
        call(settings, "vault/configure", {"path": str(default)})
        assert (
            agents_path.read_text() == "My preface.\n\n" + agents + "\nMy appendix.\n"
        )
        print("PASS configure, settings persistence, AGENTS.md scaffold and refresh")

        if os.geteuid() != 0:
            locked = base / "locked"
            locked.mkdir()
            locked.chmod(0o500)
            try:
                assert code(
                    settings, "vault/configure", {"path": str(locked / "V")}
                ) == ("vault_unwritable")
                assert call(settings, "vault/status", {})["path"] == str(default)
                (folder).chmod(0o500)
                assert code(
                    settings,
                    "vault/highlight/create",
                    {**page, "text": "Blocked", "anchor": anchor("Blocked", 9)},
                ) == ("vault_unwritable")
                assert call(
                    settings, "vault/highlights/list", {"documentId": document_id}
                )
                folder.chmod(0o755)
                default.chmod(0o500)
                assert call(settings, "vault/status", {})["writable"] is False
            finally:
                for item in (locked, folder, default):
                    item.chmod(0o755)
            print("PASS vault_unwritable and writable status")

    # Concurrent threads and a second connector process share one vault.
    shared = base / "Shared Vault"
    call(settings, "vault/configure", {"path": str(shared)})
    busy = {"url": "https://example.com/busy", "title": "Busy", "kind": "web"}
    worker = r"""
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import vault
settings, tag = Path(sys.argv[2]), sys.argv[3]
page = {"url": "https://example.com/busy", "title": "Busy", "kind": "web"}
for i in range(12):
    exact = f"{tag} {i}"
    anchor = {"kind": "web", "quote": {"exact": exact}, "position": {"start": i}}
    params = {**page, "text": exact, "anchor": anchor}
    created = vault.handle(settings, "vault/highlight/create", params)
    assert "result" in created, created
    turn = {"documentId": created["result"]["document"]["id"],
            "highlightId": created["result"]["highlight"]["id"],
            "threadId": tag, "turnId": str(i), "user": "q", "assistant": "a"}
    assert "result" in vault.handle(settings, "vault/discussion/append", turn)
"""
    errors = []

    def thread_worker(tag):
        try:
            for i in range(10):
                exact = f"{tag} {i}"
                created = call(
                    settings,
                    "vault/highlight/create",
                    {**busy, "text": exact, "anchor": anchor(exact, i)},
                )
                call(
                    settings,
                    "vault/discussion/append",
                    {
                        "documentId": created["document"]["id"],
                        "highlightId": created["highlight"]["id"],
                        "threadId": tag,
                        "turnId": str(i),
                        "user": "q",
                        "assistant": "a",
                    },
                )
        except BaseException as error:
            errors.append(error)

    processes = [
        subprocess.Popen(
            [sys.executable, "-c", worker, str(NATIVE), str(settings), f"process-{n}"]
        )
        for n in range(2)
    ]
    threads = [
        threading.Thread(target=thread_worker, args=(f"thread-{n}",)) for n in range(6)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    for process in processes:
        assert process.wait(timeout=60) == 0
    assert not errors, errors
    documents = list((shared / "Articles").iterdir())
    assert len(documents) == 1, documents
    data = json.loads((documents[0] / "anchors.json").read_text())
    ids = [h["id"] for h in data["highlights"]]
    assert (
        len(ids) == 6 * 10 + 2 * 12 and len(set(ids)) == len(ids) and ids == sorted(ids)
    )
    assert len(data["turns"]) == len(ids) and data["nextHighlight"] == len(ids) + 1
    markdown = (documents[0] / "highlights.md").read_text()
    assert markdown_ids(markdown) == ids and markdown.count(
        "<!-- tabgent:turn "
    ) == len(ids)
    assert markdown == rendered(documents[0])
    assert not list(shared.rglob("*.tmp")), "Temporary files must be renamed or removed"
    print(f"PASS {len(ids)} concurrent highlights from 6 threads and 2 processes")

# The host routes op=vault without warm config, sessions or the Codex app-server.
with tempfile.TemporaryDirectory(prefix="tabgent-vault-host-") as directory:
    base = Path(directory)
    sent = []
    with patch.object(host, "HOME", base / "codex"), patch.object(
        vault, "default_path", lambda: base / "ReadingVault"
    ), patch.object(host, "send", sent.append), patch.object(
        host, "executable", side_effect=AssertionError("Codex must not be discovered")
    ), patch.object(
        host.subprocess, "Popen", side_effect=AssertionError("Codex must not start")
    ):
        assert host.CONFIG is None and not host.SESSIONS
        page = {"url": "https://example.com/host#x", "title": "Host", "kind": "web"}
        for message in [
            {"op": "vault", "id": "status", "method": "vault/status", "params": {}},
            {
                "op": "vault",
                "id": 2,
                "method": "vault/highlight/create",
                "params": {
                    **page,
                    "text": "Saved offline",
                    "anchor": anchor("Saved offline", 0),
                },
            },
            {
                "op": "vault",
                "id": "bad",
                "method": "vault/highlights/list",
                "params": {},
            },
            {"op": "vault", "id": "unknown", "method": "vault/nope", "params": {}},
            {
                "op": "vault",
                "id": "resolve",
                "method": "vault/document/resolve",
                "params": page,
            },
            {
                "op": "vault",
                "id": "configure",
                "method": "vault/configure",
                "params": {"path": str(base / "Configured")},
            },
        ]:
            host.handle(message)
        # One FIFO worker: once this no-op runs, every earlier request has replied.
        host.VAULT_POOL.submit(lambda: None).result(timeout=30)
        assert [m["id"] for m in sent] == [
            "status",
            2,
            "bad",
            "unknown",
            "resolve",
            "configure",
        ]
        assert all(m["op"] == "vault" for m in sent)
        assert sent[0] == {
            "op": "vault",
            "id": "status",
            "result": {
                "configured": False,
                "path": str(base / "ReadingVault"),
                "defaultPath": str(base / "ReadingVault"),
                "writable": True,
            },
        }
        assert set(sent[1]) == {"op", "id", "result"} and sent[1]["result"][
            "highlight"
        ]["id"] == ("h001")
        assert set(sent[2]) == {"op", "id", "error"} and sent[2]["error"]["code"] == (
            "invalid_params"
        )
        assert sent[3]["error"]["code"] == "unknown_method"
        assert [h["text"] for h in sent[4]["result"]["highlights"]] == ["Saved offline"]
        assert sent[5]["result"]["configured"] is True
        assert json.loads((base / "codex/projects/tabgent/vault.json").read_text())[
            "path"
        ] == (str(base / "Configured"))
        assert host.CONFIG is None and not host.SESSIONS
host.VAULT_POOL.shutdown(wait=True)
host.POOL.shutdown(wait=True, cancel_futures=True)
print("PASS op=vault host round trip without Codex, warm config or sessions")
