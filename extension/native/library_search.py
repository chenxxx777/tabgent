"""Rebuildable library search, independent of the Codex reading_vault tool.

Markdown is authoritative. SQLite caches documents and typed passages; instr on
Unicode-normalized text deliberately supports Chinese substrings without a tokenizer.
Only changed Markdown/record files are read again. No third-party Python packages.
"""

import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import unicodedata

import vault

VERSION = 2
DATABASE = ".tabgent/library-search.db"
HIGHLIGHT = re.compile(
    r"<!-- tabgent:highlight (h\d{3,9}) start -->\n(.*?)\n<!-- tabgent:highlight \1 end -->",
    re.S,
)
COMMENT = re.compile(r"^ {4}- 评论[：:] ?(.*)$", re.M)
MARKERS = re.compile(r"<!--.*?-->", re.S)


def folded(text):
    return unicodedata.normalize("NFKC", text).casefold()


def tag_key(tag):
    if hasattr(vault, "tag_key"):
        return vault.tag_key(tag)
    return unicodedata.normalize("NFC", tag).strip().lstrip("#").strip().casefold()


def scalar(value):
    value = value.strip()
    if value.startswith('"'):
        try:
            return json.loads(value)
        except ValueError:
            return value.strip('"')
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return re.split(r"\s+#", value, maxsplit=1)[0].strip()


def front(text):
    """The scalar fields and tags used here: quoted/plain YAML and flow/block lists.
    This is intentionally a read-only subset, never a general YAML interpreter.
    """
    lines = text.splitlines()
    span = vault._front_span(lines)
    if not span:
        return {}, text
    values = {}
    key = None
    for line in lines[1 : span[1]]:
        match = re.match(r"^([\w-]+):\s*(.*)$", line)
        if match:
            key, value = match.groups()
            if key == "tags":
                # Split commas outside quotes (including a quoted tag with a comma).
                parts = re.findall(
                    r""""(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,\[\]]+""", value
                )
                if not value.startswith("["):
                    parts = (
                        [value] if value[:1] in "\"'" else re.split(r"[,\s]+", value)
                    )
                values[key] = [
                    scalar(part).lstrip("#").rstrip(",")
                    for part in parts
                    if scalar(part)
                ]
            else:
                values[key] = scalar(value)
        elif key == "tags" and (match := re.match(r"^\s*-\s+(.*)$", line)):
            values[key].append(scalar(match[1]).lstrip("#"))
    unique = {}
    for tag in values.get("tags", []):
        if tag_key(tag):
            unique.setdefault(tag_key(tag), unicodedata.normalize("NFC", tag).strip())
    values["tags"] = list(unique.values())
    # Prefer the annotation worker's canonical parser after its PR is merged.
    if hasattr(vault, "note_tags"):
        values["tags"] = vault.note_tags(lines)
    return values, "\n".join(lines[span[1] + 1 :])


def plain(text):
    text = MARKERS.sub("", text)
    text = re.sub(r"\[\[([^\]|]+)\|([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^\n)]*\)", r"\1", text)
    text = re.sub(r"\^h\d{3,9}\b", "", text)
    return " ".join(text.split()).strip()


def passages(text):
    """Personal comments and quoted highlights, read from the human-edited Markdown.
    Document comments use their own marked block. Discussion files are indexed
    with a separate type.
    """
    for match in HIGHLIGHT.finditer(text):
        ident, body = match.groups()
        comment = COMMENT.search(body)
        quote_end = re.search(r"\^h\d{3,9}\b", body)
        quote = body[: quote_end.start()] if quote_end else body.split("\n    - ")[0]
        yield "highlight", ident, plain(re.sub(r"^- ", "", quote))
        if comment:
            tail = body[comment.end() :].splitlines()
            continuation = []
            for line in tail:
                if re.match(r"^ {4}- ", line):
                    break
                continuation.append(line[6:] if line.startswith("      ") else line)
            yield "comment", ident, plain(comment[1] + "\n" + "\n".join(continuation))
    comment = document_comment(text)
    if comment:
        yield "comment", "", plain(comment)


def document_comment(text):
    if hasattr(vault, "note_comment"):
        return vault.note_comment(text.splitlines()) or ""
    section = re.search(
        r"^<!-- tabgent:comment document start -->\n(.*?)^<!-- tabgent:comment document end -->",
        text,
        re.M | re.S,
    )
    if not section:
        return ""
    return re.sub(r"^\s*## 全文评论\s*\n?", "", section[1], count=1).strip()


def stamp(path):
    stat = path.stat()
    return f"{stat.st_mtime_ns}:{stat.st_ctime_ns}:{stat.st_size}:{stat.st_ino}"


def safe(root, rel):
    return isinstance(rel, str) and vault._tool_canonical(root, root / rel)


def markdown_files(db, root, known):
    """Stat every visible Markdown file, reading headers only for changed files.
    Keeping ownership in SQLite makes a warm search cheap even after a restart.
    Symlinks and hidden directories are never followed.
    """
    cached = {row[0]: row[1:] for row in db.execute("SELECT * FROM files")}
    found, live = {}, set()
    for folder, directories, names in os.walk(root, followlinks=False):
        directories[:] = [
            name
            for name in directories
            if not name.startswith(".")
            and name not in ("node_modules", vault.ATTACHMENTS)
            and not (Path(folder) / name).is_symlink()
        ]
        for name in names:
            if name.startswith(".") or not name.endswith(".md"):
                continue
            path = Path(folder) / name
            if path.is_symlink():
                continue
            rel = path.relative_to(root).as_posix()
            try:
                signature = stamp(path)
                previous = cached.get(rel)
                if previous and previous[0] == signature:
                    _, ident, part = previous
                else:
                    owner = vault._owner(root, rel)
                    ident, part = owner or ("", "")
                    db.execute(
                        "INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?)",
                        (rel, signature, ident, part),
                    )
                live.add(rel)
                if ident in known:
                    found.setdefault((ident, part), []).append(
                        (path.stat().st_mtime_ns, rel, signature)
                    )
            except OSError:
                continue
    db.executemany(
        "DELETE FROM files WHERE path = ?", [(rel,) for rel in cached.keys() - live]
    )
    return {key: sorted(paths, reverse=True) for key, paths in found.items()}


def select_files(ident, entry, found):
    files = entry.get("files") or {}
    selected = {}
    parts = [("notes", files.get("notes")), ("discussions", files.get("discussions"))]
    parts += [
        (vault._label_of("full", n), rel)
        for n, rel in enumerate(files.get("full") or [], 1)
    ]
    for part, recorded in parts:
        candidates = found.get((ident, part), [])
        if candidates:
            selected[part] = next(
                (item for item in candidates if item[1] == recorded), candidates[0]
            )
    return selected


def descriptor(root, data, selected):
    doc = data["document"]
    files = doc["files"] = dict(doc["files"])
    for part in ("notes", "discussions"):
        if part in selected:
            files[part] = selected[part][1]
    files["full"] = [
        item[1] for key, item in selected.items() if key.startswith("full")
    ]
    record = vault._source_record(root, data)
    return {
        **vault._public_document(root, doc, doc["createdAt"]),
        "author": doc.get("meta", {}).get("author", ""),
        "updatedAt": doc.get("updatedAt"),
        "clip": vault._clip_summary(root, data),
        "source": record
        and {key: record.get(key) for key in ("name", "size", "sha256", "importedAt")},
    }


def refresh(db, root):
    catalog, _ = vault._catalog(root)
    known = catalog["documents"]
    found = markdown_files(db, root, known)
    previous = dict(db.execute("SELECT id, signature FROM documents"))
    live = set()
    for ident, entry in known.items():
        selected = select_files(ident, entry, found)
        try:
            record_files = [
                f"{vault.RECORDS}/{ident}/{name}"
                for name in (
                    "anchors.json",
                    "source.json",
                    "article.json",
                    "article.html",
                    "original.pdf",
                    "original.epub",
                )
            ]
            records = [
                (rel, stamp(root / rel)) for rel in record_files if safe(root, rel)
            ]
            signature = json.dumps([selected, records], sort_keys=True)
            live.add(ident)
            if previous.get(ident) == signature:
                continue
            data = vault._existing(root, ident)
            item = descriptor(root, data, selected)
            files = entry.get("files") or {}
            expected = ["notes"]
            if files.get("discussions"):
                expected.append("discussions")
            expected += [
                vault._label_of("full", n)
                for n, _ in enumerate(files.get("full") or [], 1)
            ]
            unavailable = [part for part in expected if part not in selected]
            note = None
            if "notes" in selected:
                try:
                    note = (root / selected["notes"][1]).read_text(encoding="utf-8")
                except (OSError, UnicodeError):
                    unavailable.append("notes")
                    signature = None  # Retry transient read failures next time.
            meta, body = front(note) if note is not None else ({}, "")
            for key, field in (("title", "title"), ("author", "author")):
                if isinstance(meta.get(key), str):
                    item[field] = plain(meta[key])
            if meta.get("category") in vault.CATEGORIES:
                item["category"] = meta["category"]
            item["tags"] = meta.get("tags", [])
            item["comment"] = document_comment(body)
            sections = [(kind, hid, text) for kind, hid, text in passages(body) if text]
            item["highlightCount"] = (
                sum(kind == "highlight" for kind, _, _ in sections)
                if note is not None
                else len(data["highlights"])
            )
            item["hasComments"] = any(kind == "comment" for kind, _, _ in sections)
            item["searchState"] = (item.get("library") or {}).get("state")
            # Inbox is meaningful only for saved feed items, not arbitrary older notes.
            if (
                not item["searchState"]
                and (item.get("clip") or {}).get("method") in vault.FEED_METHODS
            ):
                item["searchState"] = "inbox"
            sections += [
                (kind, "", item[field])
                for kind, field in (
                    ("title", "title"),
                    ("author", "author"),
                    ("url", "url"),
                )
            ]
            if meta.get("source") and meta["source"] != item["url"]:
                sections.append(("url", "", meta["source"]))
            full_count = 0
            for part, (_, rel, _) in selected.items():
                if part == "notes":
                    continue
                try:
                    _, content = front((root / rel).read_text(encoding="utf-8"))
                except (OSError, UnicodeError):
                    unavailable.append(part)
                    signature = None
                    continue
                kind = "discussion" if part == "discussions" else "body"
                content = plain(content)
                # Overlap covers even the longest permitted query across chunk edges.
                for offset in range(0, len(content), 32000):
                    sections.append(
                        (kind, "", content[max(0, offset - 500) : offset + 32000])
                    )
                if kind == "body":
                    full_count += 1
            item["hasFullText"] = bool(full_count)
            item["unavailableParts"] = unavailable
            drop(db, ident)
            db.execute(
                "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    ident,
                    signature,
                    json.dumps(item, ensure_ascii=False),
                    item["category"],
                    item["hasComments"],
                    bool(item["highlightCount"]),
                    item["searchState"],
                    vault._instant(item.get("updatedAt")),
                ),
            )
            db.executemany(
                "INSERT INTO tags VALUES (?, ?, ?)",
                [(ident, tag_key(tag), tag) for tag in item["tags"]],
            )
            db.executemany(
                "INSERT INTO passages(document, kind, highlight, text, folded) VALUES (?, ?, ?, ?, ?)",
                [
                    (ident, kind, hid, text, folded(text))
                    for kind, hid, text in sections
                    if text
                ],
            )
        except (OSError, UnicodeError, vault.VaultError):
            live.discard(ident)
    for ident in previous.keys() - live:
        drop(db, ident)


def drop(db, ident):
    for table, key in (
        ("documents", "id"),
        ("passages", "document"),
        ("tags", "document"),
    ):
        db.execute(f"DELETE FROM {table} WHERE {key} = ?", (ident,))


def connect(path):
    db = sqlite3.connect(str(path), timeout=10)
    try:
        if db.execute("PRAGMA user_version").fetchone()[0] != VERSION:
            db.executescript(
                "DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS passages; DROP TABLE IF EXISTS tags; DROP TABLE IF EXISTS files;"
            )
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, signature TEXT, item TEXT, category TEXT, comments INTEGER, highlights INTEGER, state TEXT, updated REAL);
            CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, signature TEXT, document TEXT, part TEXT);
            CREATE TABLE IF NOT EXISTS passages (document TEXT, kind TEXT, highlight TEXT, text TEXT, folded TEXT);
            CREATE INDEX IF NOT EXISTS passages_document ON passages(document);
            CREATE TABLE IF NOT EXISTS tags (document TEXT, tag TEXT, label TEXT);
            CREATE INDEX IF NOT EXISTS tags_document ON tags(document, tag);
        """
        )
        db.execute(f"PRAGMA user_version = {VERSION}")
        return db
    except Exception:
        db.close()
        raise


def snippet(text, query):
    pos = folded(text).find(query)
    start = max(0, pos - 55)
    end = min(len(text), max(pos + len(query) + 75, start + 150))
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")


@contextlib.contextmanager
def index_lock(root):
    """Serialize cache writers/recovery without blocking vault mutations.
    Source files are read just as in list_documents: their atomic replacements
    need no reader lock, and any intervening edits are picked up next request.
    """
    vault._ensure_dir(root / ".tabgent")
    descriptor = os.open(
        root / ".tabgent/library-search.lock",
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
        0o600,
    )
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def search(settings, params):
    query = vault._string({"query": params.get("query", "")}, "query", 500).strip()
    category = params.get("category") or None
    state = params.get("state") or None
    tags = params.get("tags", [])
    if category is not None and category not in vault.CATEGORIES:
        raise vault.VaultError("invalid_params", "Unknown category")
    if state is not None and state not in ("inbox", "later", "archive"):
        raise vault.VaultError("invalid_params", "Unknown reading state")
    if (
        not isinstance(tags, list)
        or len(tags) > 100
        or any(not isinstance(tag, str) or len(tag) > 200 for tag in tags)
    ):
        raise vault.VaultError("invalid_params", "tags must be a list of strings")
    for key in ("hasComments", "hasHighlights", "includeDiscussions"):
        if key in params and not isinstance(params[key], bool):
            raise vault.VaultError("invalid_params", f"{key} must be a boolean")
    offset = vault._integer(params, "offset", 0, 100000, 0)
    root = vault._root(settings)
    if not root.exists():
        return {"documents": [], "tags": [], "total": 0, "offset": offset}
    with index_lock(root):
        path = root / DATABASE
        if path.is_symlink():
            raise vault.VaultError(
                "io_error", "The library index must not be a symlink"
            )
        for attempt in range(2):
            db = None
            try:
                db = connect(path)
                with db:
                    refresh(db, root)
                return results(db, query, category, state, tags, offset, params)
            except sqlite3.DatabaseError:
                if attempt:
                    raise
                if db:
                    db.close()
                    db = None
                path.unlink(missing_ok=True)
            finally:
                if db:
                    db.close()


def results(db, query, category, state, tags, offset, params):
    where, args = [], []
    for field, value in (
        ("category", category),
        ("state", state),
        ("comments", params.get("hasComments")),
        ("highlights", params.get("hasHighlights")),
    ):
        if value:
            where.append(f"d.{field} = ?")
            args.append(value)
    for tag in tags:
        where.append(
            "EXISTS (SELECT 1 FROM tags t WHERE t.document = d.id AND t.tag = ?)"
        )
        args.append(tag_key(tag))
    needle = folded(query)
    allowed = "" if params.get("includeDiscussions") else "AND p.kind != 'discussion'"
    if needle:
        where.append(
            f"EXISTS (SELECT 1 FROM passages p WHERE p.document = d.id {allowed} AND instr(p.folded, ?) > 0)"
        )
        args.append(needle)
    clause = " WHERE " + " AND ".join(where) if where else ""
    total = db.execute("SELECT count(*) FROM documents d" + clause, args).fetchone()[0]
    rows = db.execute(
        "SELECT d.id, d.item FROM documents d"
        + clause
        + " ORDER BY d.updated DESC, d.id LIMIT 100 OFFSET ?",
        [*args, offset],
    )
    documents = []
    for ident, item in rows:
        item = json.loads(item)
        item["matches"] = []
        if needle:
            hits = db.execute(
                f"SELECT p.kind, p.highlight, p.text FROM passages p WHERE p.document = ? {allowed} AND instr(p.folded, ?) > 0 ORDER BY CASE p.kind WHEN 'title' THEN 0 WHEN 'comment' THEN 1 WHEN 'highlight' THEN 2 WHEN 'author' THEN 3 WHEN 'url' THEN 4 ELSE 5 END LIMIT 4",
                (ident, needle),
            )
            item["matches"] = [
                {
                    "type": kind,
                    "highlightId": hid or None,
                    "snippet": snippet(text, needle),
                }
                for kind, hid, text in hits
            ]
        documents.append(item)
    return {
        "documents": documents,
        "total": total,
        "offset": offset,
        "tags": [
            tag
            for (tag,) in db.execute(
                "SELECT min(label) FROM tags GROUP BY tag ORDER BY tag"
            )
        ],
    }
