"""The vault's layout: categories, file names, notes found again after the user renames or
moves them, front matter Tabgent only adds to, and full texts split into parts."""

import hashlib
import base64
import json
from pathlib import Path
import sys
import tempfile
import unicodedata
from unittest.mock import patch

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent / "native"))
sys.path.insert(0, str(TESTS / "fixtures"))
import epub_fixture
import vault


def call(settings, method, params):
    reply = vault.handle(settings, method, params)
    assert set(reply) == {"result"}, (method, reply)
    return reply["result"]


def highlight(settings, url, title, text="Passage", kind="web", **extra):
    anchor = {"kind": kind, "quote": {"exact": text}}
    if kind == "pdf":
        anchor["page"] = 1
    return call(
        settings,
        "vault/highlight/create",
        {
            "url": url,
            "title": title,
            "kind": kind,
            "text": text,
            "anchor": anchor,
            **extra,
        },
    )


# Categories: by kind and address, chosen once.
for kind, url, hint, expected in [
    ("web", "https://example.test/essay", None, "articles"),
    ("web", "urn:tabgent:feed:" + "a" * 64, None, "articles"),
    ("web", "https://x.com/someone/status/1", None, "tweets"),
    ("web", "https://mobile.twitter.com/someone/status/1", None, "tweets"),
    ("web", "https://www.youtube.com/watch?v=abc", None, "videos"),
    ("web", "https://youtu.be/abc", None, "videos"),
    ("web", "https://www.youtube.com/@channel", None, "articles"),
    ("web", "https://example.test/talk", {"extractor": "youtube"}, "videos"),
    ("web", "https://www.xiaoyuzhoufm.com/episode/1", None, "podcasts"),
    ("web", "https://podcasts.apple.com/us/podcast/x/id1", None, "podcasts"),
    ("web", "https://open.spotify.com/episode/1", None, "podcasts"),
    (
        "web",
        "https://example.test/show/1",
        {"extractor": "defuddle", "transcript": {"status": "saved"}},
        "podcasts",
    ),
    ("pdf", "https://example.test/paper.pdf", None, "pdfs"),
    ("pdf", "urn:sha256:" + "0" * 64, None, "pdfs"),
    ("epub", "urn:sha256:" + "1" * 64, None, "books"),
    ("web", "file:///Users/me/notes.md", None, "local-files"),
]:
    assert vault._category(kind, url, hint) == expected, (kind, url)
assert list(vault.CATEGORIES.values()) == [
    "Articles",
    "Tweets",
    "Videos",
    "Podcasts",
    "PDFs",
    "Books",
    "Local Files",
]
print("PASS seven categories by kind, address and what the clip read")

# File names: valid everywhere and in Obsidian links, readable, bounded.
created = "2026-10-19T21:03:00+08:00"
for title, url, expected in [
    ("On Reading: Notes", "https://example.test/a", "On Reading Notes"),
    ('A/B\\C*D?"E"<F>|G#H^I[J]', "https://example.test/a", "A B C D E F G H I J"),
    ("中文标题：副标题？", "https://example.test/a", "中文标题：副标题？"),
    ("  .hidden title. ", "https://example.test/a", "hidden title"),
    ("(3) Inbox", "https://example.test/a", "Inbox"),
    ("Talk title - YouTube", "https://www.youtube.com/watch?v=a", "Talk title"),
    (
        'Ada Lin on X: "Reading is a loop, not a line" / X',
        "https://x.com/adalin/status/1",
        "Ada Lin：Reading is a loop, not a line",
    ),
    ("Home / X", "https://x.com/home", "X 时间线 2026-10-19"),
    ("", "https://x.com/adalin/status/123", "@adalin 的帖子 2026-10-19"),
    ("Untitled", "https://www.example.test/page", "example.test 2026-10-19"),
    ("notes.md", "file:///Users/me/notes.md", "notes"),
    ("CON", "https://example.test/a", "CON_"),
    ("zero​width‮direction", "https://example.test/a", "zerowidthdirection"),
]:
    name = vault._file_title(title, url, "web", created)
    assert name == expected, (title, name)
# NFD input (as macOS may give file names) is compared and written as NFC.
decomposed = unicodedata.normalize("NFD", "がくもん")
assert vault._file_title(decomposed, "https://example.test/a", "web", created) == (
    "がくもん"
)
# Long titles are cut at a space (spaced words) or anywhere (CJK), within the limits,
# never inside an emoji sequence.
long_words = vault._file_title("word " * 60, "https://example.test/a", "web", created)
assert long_words.endswith("word…") and len(long_words) <= vault.NAME_CHARS
long_cjk = vault._file_title("文" * 300, "https://example.test/a", "web", created)
assert len(long_cjk.encode()) <= vault.NAME_BYTES and long_cjk.endswith("…")
family = "👨‍👩‍👧"
emoji = vault._file_title(family * 40, "https://example.test/a", "web", created)
assert emoji[:-1].replace(family, "") == "" and emoji.endswith("…")
print("PASS file names: unsafe characters, noise, X titles, generic titles, limits")

with tempfile.TemporaryDirectory(prefix="tabgent-layout-") as directory:
    base = Path(directory)
    settings = base / "codex/projects/tabgent/vault.json"
    root = base / "Tabgent"
    with patch.object(vault, "default_path", lambda: root):
        # One note per document, in its category folder; same titles get (2), and a
        # file of the user's own (any case) is never taken.
        (root / "Articles").mkdir(parents=True)
        (root / "Articles/my essay.md").write_text("The user's own note.\n")
        first = highlight(settings, "https://example.test/1", "Same Title")
        second = highlight(settings, "https://example.test/2", "Same Title")
        mine = highlight(settings, "https://example.test/3", "My Essay")
        assert Path(first["document"]["notesPath"]).name == "Same Title.md"
        assert Path(second["document"]["notesPath"]).name == "Same Title (2).md"
        assert Path(mine["document"]["notesPath"]).name == "My Essay (2).md"
        assert (root / "Articles/my essay.md").read_text() == "The user's own note.\n"
        tweet = highlight(settings, "https://x.com/a/status/9", 'A on X: "Hi there"')
        local = highlight(settings, "file:///Users/me/plan.txt", "plan.txt")
        paper = highlight(settings, "https://example.test/p.pdf", "Paper", kind="pdf")
        assert tweet["document"]["notesPath"] == str(root / "Tweets/A：Hi there.md")
        assert local["document"]["notesPath"] == str(root / "Local Files/plan.md")
        assert paper["document"]["notesPath"] == str(root / "PDFs/Paper.md")
        assert sorted(p.name for p in root.iterdir()) == [
            ".tabgent",
            "AGENTS.md",
            "Articles",
            "Local Files",
            "PDFs",
            "Tweets",
        ]
        # The catalog maps documents to files and addresses to documents.
        catalog = json.loads((root / ".tabgent/catalog.json").read_text())
        entry = catalog["documents"][first["document"]["id"]]
        assert entry["files"] == {"notes": "Articles/Same Title.md"}
        assert entry["category"] == "articles" and entry["name"] == "Same Title"
        assert catalog["urls"]["https://example.test/2"] == second["document"]["id"]
        print("PASS notes by category, same titles get (2), the user's files are kept")

        # The user renames and moves notes: Tabgent follows them by tabgent_id and never
        # moves them back; the record and catalog learn the new place.
        ident = first["document"]["id"]
        call(
            settings,
            "vault/discussion/append",
            {
                "documentId": ident,
                "highlightId": "h001",
                "threadId": "t",
                "turnId": "1",
                "user": "Why?",
                "assistant": "Because.",
            },
        )
        reading = root / "精读"
        reading.mkdir()
        moved = reading / "Renamed by me.md"
        (root / "Articles/Same Title.md").rename(moved)
        talk = root / "Discussions/Articles/Same Title.md"
        talk.rename(talk.with_name("Talk renamed.md"))
        resolved = call(
            settings,
            "vault/document/resolve",
            {"url": "https://example.test/1", "title": "", "kind": "web"},
        )
        assert resolved["document"]["notesPath"] == str(moved)
        added = highlight(settings, "https://example.test/1", "Same Title", "Another")
        assert added["highlight"]["id"] == "h002"
        assert (
            "^h002" in moved.read_text()
            and not (root / "Articles/Same Title.md").exists()
        )
        assert "[[../Discussions/Articles/Talk renamed#高亮 001|讨论 1 条]]" in (
            moved.read_text()
        )
        record = json.loads(
            (root / ".tabgent/documents" / ident / "anchors.json").read_text()
        )
        assert record["document"]["files"]["notes"] == "精读/Renamed by me.md"
        assert record["document"]["files"]["discussions"] == (
            "Discussions/Articles/Talk renamed.md"
        )
        assert json.loads((root / ".tabgent/catalog.json").read_text())["documents"][
            ident
        ]["files"]["notes"] == ("精读/Renamed by me.md")
        # reading_vault reads it at its new place.
        listed = vault.tool(settings, {"action": "list", "document": ident})
        assert listed["documents"][0]["notes"] == "精读/Renamed by me.md"
        # A note the user deleted (here: into Obsidian's .trash) is written again where
        # the record says, at the next write.
        (root / ".trash").mkdir()
        moved.rename(root / ".trash/Renamed by me.md")
        highlight(settings, "https://example.test/1", "Same Title", "Third")
        assert [
            b[2] for b in vault._blocks(moved.read_text().split("\n"), "highlight")
        ] == [
            "h001",
            "h002",
            "h003",
        ]
        print(
            "PASS renamed and moved notes are followed by tabgent_id; deleted ones return"
        )

        # Front matter: keys are only added, never changed; tabgent_id comes back.
        text = moved.read_text()
        text = text.replace('title: "Same Title"', 'title: "My own title"')
        text = text.replace("category: articles\n", "")
        text = text.replace(f"tabgent_id: {ident}\n", "tags: [mine]\n")
        moved.write_text(text)
        highlight(settings, "https://example.test/1", "Same Title", "Fourth")
        front = moved.read_text().split("\n---\n", 1)[0]
        assert 'title: "My own title"' in front and "tags: [mine]" in front
        assert f"tabgent_id: {ident}" in front, "Tabgent needs its id to find the note"
        assert "category:" not in front, "A key the user removed is not written again"
        print("PASS front matter keys are only added; the user's changes stay")

        # Full texts split into parts at chapter boundaries above the size limit.
        book = epub_fixture.build(
            title="Long Book",
            chapters=[
                (
                    f"c{n}.xhtml",
                    f"Chapter {n}",
                    f"<h1>Chapter {n}</h1><p>{'x' * 3000}</p>",
                )
                for n in range(1, 7)
            ],
        )
        digest = hashlib.sha256(book).hexdigest()
        with patch.object(vault, "FULL_PART_LIMIT", 9000 + 8192):
            imported = call(
                settings,
                "vault/source/save",
                {
                    "url": "urn:sha256:" + digest,
                    "title": "Long Book",
                    "kind": "epub",
                    "sha256": digest,
                    "size": len(book),
                    "offset": 0,
                    "data": base64.b64encode(book).decode(),
                },
            )
        parts = imported["source"]["fullTextParts"]
        assert [Path(p).name for p in parts] == [
            "Long Book.md",
            "Long Book（第 2 部分）.md",
        ], parts
        placed = [section["part"] for section in imported["source"]["sections"]]
        assert placed == sorted(placed) and placed[0] == 1 and placed[-1] == 2, placed
        later = placed.index(2) + 1  # The first chapter in part 2.
        one, two = (Path(p).read_text() for p in parts)
        assert "parts: 2" in one and "tabgent_part: full-2" in two
        assert f"- [[Long Book（第 2 部分）#Chapter {later}|Chapter {later}]]" in one
        assert f"<!-- tabgent:section {later} -->" in two
        assert f"<!-- tabgent:section {later} -->" not in one
        book_id = imported["document"]["id"]
        chapter = vault.tool(
            settings,
            {"action": "read", "document": book_id, "part": "full", "section": 6},
        )
        assert chapter["path"].endswith("（第 2 部分）.md")
        assert chapter["section"]["title"] == "Chapter 6"
        notes = Path(imported["document"]["notesPath"]).read_text()
        assert "（共 2 部分）" in notes
        print("PASS full texts split into parts at chapter boundaries, read by section")
