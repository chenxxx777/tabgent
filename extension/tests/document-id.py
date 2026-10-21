"""Unicode document ids, and the same accept/reject rules in Python and JavaScript."""

import errno
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1] / "native"
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(NATIVE))
import vault


def call(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"result"}, (method, reply)
    return reply["result"]


def web_anchor(exact):
    return {
        "kind": "web",
        "quote": {"exact": exact, "prefix": "", "suffix": ""},
        "position": {"start": 0, "end": len(exact)},
    }


JS = r"""
import { isDocumentId, isSection } from './extension/document-id.js';
const payload = JSON.parse(await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (data += chunk));
  process.stdin.on('end', () => resolve(data));
}));
const bad = [];
for (const id of payload.accept) if (!isDocumentId(id)) bad.push(['accept', id]);
for (const id of payload.reject) if (isDocumentId(id)) bad.push(['reject', id]);
for (const n of payload.sections) if (!isSection(n)) bad.push(['section', n]);
for (const n of payload.badSections) if (isSection(n)) bad.push(['badSection', n]);
if (bad.length) {
  console.error(JSON.stringify(bad));
  process.exit(1);
}
"""

SLUGS = {
    "耳夹式无线耳机体验": "耳夹式无线耳机体验",
    "TDS REVIEW｜vivo Buds Clip 耳夹式无线耳机体验 - 少数派": (
        "tds-review-vivo-buds-clip-耳夹式无线耳机体验-少数派"
    ),
    "こんにちは世界": "こんにちは世界",
    "Hello 🎉 World": "hello-world",
    "📚読書": "読書",
    "Mixed 中文 and 日本語 😀": "mixed-中文-and-日本語",
    "a/b\\c..d": "a-b-c-d",
    "   ": "",
    "—": "",
}
for title, slug in SLUGS.items():
    assert vault._slug(title) == slug, (title, vault._slug(title))
assert vault._slug("文" * 80) == "文" * vault.SLUG_MAX
plain = OSError("plain")
assert plain.errno is None and vault._os_code(plain) == "io_error"
assert vault._os_code(PermissionError("Permission denied")) == "vault_unwritable"
assert vault._os_code(OSError(errno.ENOSPC, "No space")) == "disk_full"
# A missing EDQUOT is None. An OSError with no errno must not become disk_full.
with patch.object(errno, "EDQUOT", None, create=True):
    assert vault._os_code(OSError("plain")) == "io_error"

with tempfile.TemporaryDirectory(prefix="tabgent-document-id-") as directory:
    base = Path(directory)
    settings = base / "codex/vault.json"
    default = base / "Tabgent"
    with patch.object(vault, "default_path", lambda: default):
        made = []
        cases = [
            ("web", "https://example.test/earbuds", "耳夹式无线耳机体验"),
            (
                "web",
                "https://sspai.test/buds",
                "TDS REVIEW｜vivo Buds Clip 耳夹式无线耳机体验 - 少数派",
            ),
            ("web", "https://example.test/ja", "こんにちは世界"),
            ("web", "https://example.test/emoji", "Hello 🎉 World"),
            ("web", "https://example.test/book-emoji", "📚読書"),
            ("web", "https://example.test/mix", "Mixed 中文 and 日本語 😀"),
            ("pdf", "https://example.test/paper.pdf", "动机研究"),
            ("epub", "https://example.test/book.epub", "第一章 开始"),
            ("web", "https://example.test/long", "文" * 80),
        ]
        prefix = {"web": "article", "pdf": "paper", "epub": "book"}
        for kind, url, title in cases:
            ident = call(
                settings,
                "vault/document/resolve",
                {"url": url, "title": title, "kind": kind},
            )["document"]["id"]
            slug = vault._slug(title) or "untitled"
            assert re.fullmatch(
                rf"{prefix[kind]}-{re.escape(slug)}-[0-9a-f]{{8}}", ident
            ), ident
            assert vault.DOCUMENT_ID.fullmatch(ident), ident
            assert "🎉" not in ident and "📚" not in ident and "😀" not in ident
            made.append(ident)
        assert re.fullmatch(r"article-耳夹式无线耳机体验-[0-9a-f]{8}", made[0])
        long_slug = made[-1][len("article-") :].rsplit("-", 1)[0]
        assert long_slug == "文" * vault.SLUG_MAX

        rounds = [
            (
                "web",
                "https://example.test/zh-note",
                "耳夹式无线耳机体验",
                web_anchor("耳夹"),
                "耳夹",
            ),
            (
                "pdf",
                "https://example.test/zh.pdf",
                "动机研究",
                {"kind": "pdf", "page": 1, "quote": {"exact": "动机"}},
                "动机",
            ),
            (
                "epub",
                "urn:sha256:" + "ab" * 32,
                "第一章 开始",
                {
                    "kind": "epub",
                    "cfi": "epubcfi(/6/2!/4/2)",
                    "quote": {"exact": "开始"},
                },
                "开始",
            ),
        ]
        for kind, url, title, anchor, text in rounds:
            created = call(
                settings,
                "vault/highlight/create",
                {
                    "url": url,
                    "title": title,
                    "kind": kind,
                    "text": text,
                    "anchor": anchor,
                },
            )
            ident = created["document"]["id"]
            assert created["highlight"]["id"] == "h001", ident
            assert ident.startswith(prefix[kind] + "-"), ident
            noted = call(
                settings,
                "vault/highlight/update",
                {"documentId": ident, "highlightId": "h001", "note": "笔记"},
            )
            assert noted["highlight"]["note"] == "笔记"
            call(
                settings,
                "vault/discussion/append",
                {
                    "documentId": ident,
                    "highlightId": "h001",
                    "threadId": "thread-zh",
                    "turnId": "turn-zh",
                    "user": "问题",
                    "assistant": "回答",
                },
            )
            stored = json.loads(
                (Path(created["document"]["folder"]) / "anchors.json").read_text()
            )
            assert stored["turns"][0]["highlightId"] == "h001"
            assert stored["highlights"][0]["note"] == "笔记"
            made.append(ident)
        print("PASS Unicode titles make document ids and bind notes and discussions")

        rejected = [
            "article-a/b",
            "article-a\\b",
            "article-..",
            "article-a b",
            "article-" + "a" * 161,
            "article-" + "中" * 161,
            "../article-ok",
            "article-hello-🎉-abcd1234",
            "article-",
            "paper-hello world",
        ]
        for bad in rejected:
            reply = vault.handle(settings, "vault/highlights/list", {"documentId": bad})
            assert reply["error"]["code"] == "invalid_params", bad
            assert "/" not in reply["error"]["message"], reply
            assert "\\" not in reply["error"]["message"], reply
        accepted = made + [
            "article-" + "a" * 160,
            "article-" + "中" * 160,
            "book-こんにちは世界-abcdef12",
            "paper-mixed-中文-and-日本語-0123abcd",
            "article-a_b-0123abcd",
        ]
        for ident in accepted:
            assert vault.DOCUMENT_ID.fullmatch(ident), ident
        for bad in rejected:
            assert vault.DOCUMENT_ID.fullmatch(bad) is None, bad
        payload = json.dumps(
            {
                "accept": accepted,
                "reject": rejected,
                "sections": [1, 2, 100000],
                "badSections": [0, -1, 1.5, "1", 100001, None, True],
            }
        )
        compared = subprocess.run(
            ["node", "--input-type=module", "-e", JS],
            input=payload,
            text=True,
            cwd=ROOT,
            capture_output=True,
            check=False,
        )
        assert compared.returncode == 0, compared.stderr or compared.stdout
        print("PASS JavaScript and Python accept the same document ids")

        if os.geteuid() != 0:
            locked = base / "locked"
            locked.mkdir()
            locked.chmod(0o500)
            try:
                reply = vault.handle(
                    settings, "vault/configure", {"path": str(locked / "V")}
                )
            finally:
                locked.chmod(0o755)
            assert reply["error"]["code"] == "vault_unwritable", reply
            assert "/" not in reply["error"]["message"], reply
            assert "Permission denied" not in reply["error"]["message"]
            assert ".." not in reply["error"].get("folder", "")
        named = base / "named-folder"
        call(settings, "vault/configure", {"path": str(named)})
        original_mkdir = Path.mkdir

        def fail_articles(self, *args, **kwargs):
            if self.name == "Articles":
                full = OSError(errno.ENOSPC, "No space left on device")
                # A temp-file name must not be shown as the folder.
                full.filename = str(named / ".anchors.json.3f9a1b2c4d5e.tmp")
                raise full
            return original_mkdir(self, *args, **kwargs)

        with patch.object(Path, "mkdir", fail_articles):
            reply = vault.handle(
                settings,
                "vault/highlight/create",
                {
                    "url": "https://example.test/disk-full",
                    "title": "满",
                    "kind": "web",
                    "text": "满",
                    "anchor": web_anchor("满"),
                },
            )
        assert reply["error"]["code"] == "disk_full", reply
        assert reply["error"]["folder"] == "Articles", reply
        assert ".tmp" not in reply["error"]["folder"]
        assert str(named) not in reply["error"]["message"]
        assert "/" not in reply["error"]["message"]
        assert "No space" not in reply["error"]["message"]

        real_open = open

        def fail_temp(file, mode="r", *args, **kwargs):
            # The note's folder: Tabgent's own records are not a folder the user named.
            if (
                isinstance(mode, str)
                and "x" in mode
                and str(file).endswith(".tmp")
                and Path(file).parent.name == "Articles"
            ):
                denied = PermissionError(errno.EACCES, "Permission denied")
                denied.filename = str(file)
                raise denied
            return real_open(file, mode, *args, **kwargs)

        with patch("builtins.open", fail_temp):
            reply = vault.handle(
                settings,
                "vault/highlight/create",
                {
                    "url": "https://example.test/write-denied",
                    "title": "耳夹式无线耳机体验",
                    "kind": "web",
                    "text": "耳夹",
                    "anchor": web_anchor("耳夹"),
                },
            )
        assert reply["error"]["code"] == "vault_unwritable", reply
        assert reply["error"].get("folder") == "Articles", reply
        assert "Permission denied" not in reply["error"]["message"]
        assert "/" not in reply["error"]["message"]

        original_open = os.open

        def fail_lock(path, flags, mode=0o777):
            if Path(path).name == "lock":
                denied = PermissionError(errno.EACCES, "Permission denied")
                denied.filename = os.fspath(path)
                raise denied
            return original_open(path, flags, mode)

        with patch.object(os, "open", fail_lock):
            reply = vault.handle(
                settings,
                "vault/highlight/create",
                {
                    "url": "https://example.test/lock-denied",
                    "title": "锁",
                    "kind": "web",
                    "text": "锁",
                    "anchor": web_anchor("锁"),
                },
            )
        assert reply["error"]["code"] == "vault_unwritable", reply
        assert "folder" not in reply["error"], reply
        assert "lock" not in reply["error"]["message"].lower()
        assert "Permission denied" not in reply["error"]["message"]
        print("PASS folder errors name a folder and hide the path")
