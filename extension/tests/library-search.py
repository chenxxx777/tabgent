"""Library search uses human Markdown, Unicode substrings and intersecting filters.
All fixture files (including a rebuildable SQLite index) live in a temporary vault.
"""

import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
import vault
import library_search


def call(settings, method, **params):
    reply = vault.handle(settings, method, params)
    assert "result" in reply, reply
    return reply["result"]


def search(settings, query="", **filters):
    return call(settings, "vault/library/search", query=query, **filters)


def ids(reply):
    return [item["id"] for item in reply["documents"]]


with tempfile.TemporaryDirectory(prefix="tabgent-search-") as directory:
    root = Path(directory) / "Tabgent"
    settings = Path(directory) / "settings.json"
    settings.write_text(json.dumps({"path": str(root)}))
    assert search(settings)["total"] == 0
    assert not root.exists()
    first = call(
        settings,
        "vault/highlight/create",
        url="https://example.test/learning",
        title="学习方法 Learning",
        kind="web",
        meta={"author": "Test Author"},
        text="中文连续高亮原文",
        note="评论里的独特见解",
        anchor={"kind": "web", "quote": {"exact": "中文连续高亮原文"}},
    )
    ident = first["document"]["id"]
    note = Path(first["document"]["notesPath"])
    text = note.read_text()
    text = text.replace("\n---\n", '\ntags:\n  - AI学习\n  - "Important"\n---\n', 1)
    text = text.replace(
        "## 高亮",
        "<!-- tabgent:comment document start -->\n## 全文评论\n\n整篇文章的想法\n## 自己的小标题\n后续思考\n<!-- tabgent:comment document end -->\n\n## 高亮",
    )
    note.write_text(text)
    other = call(
        settings,
        "vault/highlight/create",
        url="https://x.com/test/status/1",
        title="Another Learning",
        kind="web",
        text="another quote",
        anchor={"kind": "web", "quote": {"exact": "another quote"}},
    )
    call(
        settings,
        "vault/document/state",
        url="https://example.test/learning",
        title="",
        kind="web",
        state="later",
    )
    # The state mutation only writes machine data, preserving the externally edited md.
    for query, kind in [
        ("习方", "title"),
        ("LEARNING", "title"),
        ("test author", "author"),
        ("example.test/learning", "url"),
        ("特见", "comment"),
        ("后续思考", "comment"),
        ("续高亮", "highlight"),
    ]:
        result = search(settings, query)
        assert ident in ids(result), (query, result)
        item = next(item for item in result["documents"] if item["id"] == ident)
        assert any(
            hit["type"] == kind and query.casefold() in hit["snippet"].casefold()
            for hit in item["matches"]
        ), (query, item)
    hit = search(settings, "续高亮")["documents"][0]["matches"][0]
    assert hit["highlightId"] == "h001"
    assert ids(
        search(
            settings,
            category="articles",
            tags=["#ai学习", "IMPORTANT"],
            hasComments=True,
            hasHighlights=True,
            state="later",
        )
    ) == [ident]
    assert not ids(
        search(settings, category="tweets", tags=["AI学习"], hasComments=True)
    )
    assert not ids(search(settings, tags=["AI学习", "missing"]))
    assert not ids(search(settings, state="inbox"))  # Unmarked documents have no state.
    print(
        "PASS Chinese substring, English, title/author/URL/comments/highlights and combined filters"
    )

    # Full text and long discussions have independent types, including renamed parts.
    data = vault._load(root, ident)
    full = root / "Full Document Contents/Articles/学习.md"
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(
        f"---\ntabgent_id: {ident}\ntabgent_part: full\n---\n<!-- tabgent:section 1 -->\n剪藏正文中的独有内容 Body needle\n"
    )
    talk = root / "Discussions/Articles/学习.md"
    talk.parent.mkdir(parents=True, exist_ok=True)
    talk.write_text(
        f"---\ntabgent_id: {ident}\ntabgent_part: discussions\n---\n<!-- tabgent:discussion document start -->\n独立长对话 Dialog needle\n"
    )
    data["document"]["files"].update(
        full=[full.relative_to(root).as_posix()],
        discussions=talk.relative_to(root).as_posix(),
    )
    vault._save(root, data)
    result = search(settings, "body NEEDLE")
    assert (
        ids(result) == [ident]
        and result["documents"][0]["matches"][0]["type"] == "body"
    )
    assert ids(search(settings, "正文中的独")) == [ident]
    assert not ids(search(settings, "dialog needle"))
    assert (
        search(settings, "dialog needle", includeDiscussions=True)["documents"][0][
            "matches"
        ][0]["type"]
        == "discussion"
    )
    full.rename(full.with_name("renamed.md"))
    assert ids(search(settings, "Body needle")) == [ident]
    print("PASS full text/chapters, default discussion exclusion and opt-in")

    note.write_text(
        note.read_text().replace("独特见解", "最新判断").replace("Important", "Renamed")
    )
    assert not ids(search(settings, "独特见解"))
    assert ids(search(settings, "最新判断", tags=["renamed"])) == [ident]
    moved = root / "My notes/Moved.md"
    moved.parent.mkdir()
    note.rename(moved)
    assert ids(search(settings, "最新判断")) == [ident]
    assert search(settings, "最新判断")["documents"][0]["notesPath"] == str(moved)
    # Cache loss/corruption is recoverable; user Markdown is never rewritten.
    saved = moved.read_bytes()
    (root / library_search.DATABASE).write_bytes(b"broken sqlite")
    assert ids(search(settings, "最新判断")) == [ident]
    assert moved.read_bytes() == saved
    # A symlink cannot leak content from outside the vault.
    moved.unlink()
    outside = Path(directory) / "outside.md"
    outside.write_bytes(saved)
    moved.symlink_to(outside)
    assert not ids(search(settings, "最新判断"))
    print("PASS edits, tag changes, moves, cache rebuild and symlink exclusion")

    # Hundreds of notes with saved full text: warm search under one second, no rereads.
    moved.unlink()
    moved.write_bytes(saved)
    original = vault._load(root, ident)
    for index in range(500):
        clone = json.loads(json.dumps(original))
        clone_id = f"article-bench-{index:012x}"
        full_rel = f"Full Document Contents/Articles/Bench {index}.md"
        clone["document"].update(
            id=clone_id,
            files={"notes": f"Articles/Bench {index}.md", "full": [full_rel]},
        )
        folder = root / vault.RECORDS / clone_id
        folder.mkdir()
        (folder / "anchors.json").write_text(json.dumps(clone))
        (root / f"Articles/Bench {index}.md").write_text(
            f"---\ntabgent_id: {clone_id}\ntitle: Bench {index}\n---\n"
            + "<!-- tabgent:highlight h001 start -->\n- benchmark quote ^h001\n<!-- tabgent:highlight h001 end -->\n"
        )
        (root / full_rel).write_text(
            f"---\ntabgent_id: {clone_id}\ntabgent_part: full\n---\n"
            + "认真阅读并记录自己的思考。Some text about deliberate reading. " * 100
            + "searchable quote"
        )
    # A catalog rebuild should also find records after the cache is removed.
    (root / vault.CATALOG).unlink()
    cold = time.monotonic()
    assert search(settings, "searchable quote")["total"] == 500
    cold = time.monotonic() - cold
    started = time.monotonic()
    with patch.object(
        Path, "read_text", side_effect=AssertionError("warm search reread a file")
    ):
        result = search(settings, "searchable quote")
    elapsed = time.monotonic() - started
    assert result["total"] == 500 and len(result["documents"]) == 100
    assert elapsed < 1, elapsed
    assert len(search(settings, "searchable quote", offset=100)["documents"]) == 100
    print(
        f"PASS 502 documents, cold {cold:.3f}s / warm {elapsed:.3f}s, paginated without rereading Markdown"
    )

# Unsaved RSS text stays in feeds.db; saving promotes only that document into search.
import base64
import feeds

with tempfile.TemporaryDirectory(prefix="tabgent-search-feeds-") as directory:
    root = Path(directory) / "Tabgent"
    settings = Path(directory) / "settings.json"
    settings.write_text(json.dumps({"path": str(root)}))
    feed = b'<rss version="2.0"><channel><title>Fixture</title><item><guid>1</guid><link>https://example.test/post</link><title>Unsavedneedle</title><description>RSSonlyneedle</description></item></channel></rss>'
    reply = feeds.handle(
        settings,
        "vault/feeds/subscribe",
        {"url": "https://example.test/feed", "data": base64.b64encode(feed).decode()},
    )
    assert "result" in reply, reply
    assert search(settings, "Unsavedneedle")["total"] == 0
    saved = call(
        settings,
        "vault/clip/save",
        url="https://example.test/post",
        title="Saved feed",
        kind="web",
        markdown="Savedbodyneedle 中文正文",
        html="<p>Savedbodyneedle 中文正文</p>",
        origin={
            "type": "feed",
            "method": "feed",
            "sourceId": "feed-test",
            "sourceTitle": "Fixture",
            "sourceUrl": "https://example.test/feed",
        },
    )
    assert ids(search(settings, "文正文", category="articles", state="inbox")) == [
        saved["document"]["id"]
    ]
    assert not ids(search(settings, "RSSonlyneedle", includeDiscussions=True))
    print("PASS unsaved RSS exclusion and saved feed inbox/full-text search")
