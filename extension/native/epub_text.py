"""Plain-text chapters of an EPUB for the ReadingVault, so Codex can read one chapter
or search a whole book without receiving the book itself.

Standard library only. Entries are read into memory with size limits and are never
extracted to disk. Book scripts are never run. XML that declares entities is
rejected, and (X)HTML goes through the tolerant html.parser instead of an XML parser.
"""

from html.parser import HTMLParser
import posixpath
import re
from urllib.parse import unquote
import xml.etree.ElementTree as ElementTree
import zipfile
import zlib

ENTRY_LIMIT = (
    32 * 1024 * 1024
)  # Uncompressed bytes of one container, OPF, nav or chapter.
TOTAL_LIMIT = 256 * 1024 * 1024  # Uncompressed bytes read from one book.
ENTRIES_LIMIT = 20_000
CHAPTER_LIMIT = 8 * 1024 * 1024  # Characters of Markdown per chapter.
# Deeper elements are attached flat, so recursive walks stay far below Python's limit.
DEPTH_LIMIT = 200
# Starting one of these closes an open one, as HTML parsing does (<p>a<p>b, <li>a<li>b).
IMPLIED = {"p": set(), "li": {"ul", "ol"}, "dt": {"dl"}, "dd": {"dl"}, "tr": {"table"}}
IMPLIED |= {"td": {"tr"}, "th": {"tr"}, "option": {"select"}}
BLOCK_STARTS_CLOSE_P = {"address", "article", "aside", "blockquote", "div", "dl", "h1"}
BLOCK_STARTS_CLOSE_P |= {"h2", "h3", "h4", "h5", "h6", "header", "footer", "hr", "ol"}
BLOCK_STARTS_CLOSE_P |= {"p", "pre", "section", "table", "ul", "figure", "nav"}
SKIP = {"head", "script", "style", "template", "noscript", "iframe", "object", "embed"}
SKIP |= {"svg:script", "math:annotation-xml"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta"}
VOID |= {"param", "source", "track", "wbr"}
BLOCK = {"address", "article", "aside", "body", "blockquote", "caption", "center"}
BLOCK |= {"dd", "details", "dialog", "div", "dl", "dt", "figcaption", "figure"}
BLOCK |= {"footer", "header", "hgroup", "hr", "li", "main", "nav", "ol", "p", "pre"}
BLOCK |= {"section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr"}
BLOCK |= {"ul", "h1", "h2", "h3", "h4", "h5", "h6"}
HEADING = re.compile(r"h([1-6])")
INLINE = {"a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "font"}
INLINE |= {
    "i",
    "kbd",
    "mark",
    "q",
    "s",
    "samp",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
}
INLINE |= {"time", "u", "var", "big", "tt", "ruby", "rt", "rp"}
DOCUMENT_TYPES = {"application/xhtml+xml", "text/html"}


class EpubError(Exception):
    pass


def extract(path):
    """{"metadata": {...}, "chapters": [{"index", "href", "title", "markdown"}],
    "skipped": [{"href", "error"}]} for every spine document with text, in reading
    order. index is the spine position. Unreadable chapters are skipped and named."""
    try:
        archive = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as error:
        raise EpubError(f"Not a readable EPUB archive: {error}")
    try:
        with archive:
            return _Book(archive).extract()
    except RecursionError:
        raise EpubError("The EPUB markup is nested too deeply")


class _Book:
    def __init__(self, archive):
        self.archive = archive
        self.read_total = 0
        infos = archive.infolist()
        if len(infos) > ENTRIES_LIMIT:
            raise EpubError("The EPUB has too many files")
        self.infos = {info.filename: info for info in infos}

    def read(self, name):
        info = self.infos.get(name)
        if info is None:
            raise EpubError(f"Missing file in EPUB: {name}")
        if info.file_size > ENTRY_LIMIT:
            raise EpubError(f"File too large in EPUB: {name}")
        if self.read_total + info.file_size > TOTAL_LIMIT:
            raise EpubError("The EPUB text is too large")
        try:
            with self.archive.open(info) as file:
                data = file.read(ENTRY_LIMIT + 1)  # Sizes in headers can lie.
        except (
            OSError,
            RuntimeError,
            EOFError,
            ValueError,
            NotImplementedError,
            zipfile.BadZipFile,
            zlib.error,
        ) as error:
            raise EpubError(f"Cannot read {name} from the EPUB: {error}")
        if len(data) > ENTRY_LIMIT:
            raise EpubError(f"File too large in EPUB: {name}")
        self.read_total += len(data)
        return data

    def xml(self, name):
        data = self.read(name)
        if b"<!ENTITY" in data:
            raise EpubError(
                f"{name} declares XML entities; Tabgent does not expand them"
            )
        try:
            return ElementTree.fromstring(data)
        except ElementTree.ParseError as error:
            raise EpubError(f"{name} is not valid XML: {error}")

    def extract(self):
        container = self.xml("META-INF/container.xml")
        rootfile = next(
            (e.get("full-path") for e in container.iter() if _local(e) == "rootfile"),
            None,
        )
        if not rootfile:
            raise EpubError("The EPUB container names no package document")
        opf_path = posixpath.normpath(unquote(rootfile))
        opf = self.xml(opf_path)
        base = posixpath.dirname(opf_path)
        items, spine, toc_id = {}, [], None
        for element in opf.iter():
            name = _local(element)
            if name == "item" and element.get("id") and element.get("href"):
                items[element.get("id")] = {
                    "href": _resolve(base, element.get("href")),
                    "type": (element.get("media-type") or "").strip().lower(),
                    "properties": (element.get("properties") or "").split(),
                }
            elif name == "spine":
                toc_id = element.get("toc")
            elif name == "itemref" and element.get("idref") in items:
                spine.append(items[element.get("idref")])
        titles = self.toc_titles(items, toc_id)
        chapters, skipped = [], []
        for index, item in enumerate(spine):
            if item["type"] not in DOCUMENT_TYPES:
                continue
            try:
                tree = _parse(self.read(item["href"]).decode("utf-8", "replace"))
            except EpubError as error:
                # One damaged chapter does not hide the rest of the book.
                skipped.append({"href": item["href"], "error": str(error)})
                continue
            markdown, heading = _markdown(tree)
            if not markdown.strip():
                continue
            if len(markdown) > CHAPTER_LIMIT:
                markdown = markdown[:CHAPTER_LIMIT] + "\n\n[Chapter text truncated]"
            title = titles.get(item["href"]) or heading or f"Section {index + 1}"
            chapters.append(
                {
                    "index": index,
                    "href": item["href"],
                    "title": " ".join(title.split())[:300],
                    "markdown": markdown,
                }
            )
        return {"metadata": _metadata(opf), "chapters": chapters, "skipped": skipped}

    def toc_titles(self, items, toc_id):
        """Spine document path -> label of the first table-of-contents entry for it."""
        entries = []
        nav = next((i for i in items.values() if "nav" in i["properties"]), None)
        if nav:
            try:
                tree = _parse(self.read(nav["href"]).decode("utf-8", "replace"))
                entries = _nav_entries(tree, posixpath.dirname(nav["href"]))
            except EpubError:
                entries = []
        if not entries and toc_id in items:
            ncx = items[toc_id]["href"]
            try:
                entries = _ncx_entries(self.xml(ncx), posixpath.dirname(ncx))
            except EpubError:
                entries = []
        titles = {}
        for href, label in entries:
            if label and href not in titles:
                titles[href] = label
        return titles


def _local(element):
    return element.tag.rsplit("}", 1)[-1] if isinstance(element.tag, str) else ""


def _resolve(base, href):
    path = unquote(href.split("#", 1)[0])
    return posixpath.normpath(posixpath.join(base, path)) if path else ""


def _metadata(opf):
    values = {}
    for element in opf.iter():
        name = _local(element)
        text = " ".join("".join(element.itertext()).split())
        if name in ("title", "creator", "language", "date", "identifier") and text:
            values.setdefault(name, []).append(text)
    return {
        "title": (values.get("title") or [""])[0],
        "author": ", ".join(values.get("creator") or []),
        "language": (values.get("language") or [""])[0],
        "date": (values.get("date") or [""])[0],
    }


def _ncx_entries(ncx, base):
    entries = []
    for point in ncx.iter():
        if _local(point) != "navPoint":
            continue
        label = next((e for e in point.iter() if _local(e) == "text"), None)
        content = next((e for e in point if _local(e) == "content"), None)
        if content is not None and content.get("src"):
            text = (
                " ".join("".join(label.itertext()).split()) if label is not None else ""
            )
            entries.append((_resolve(base, content.get("src")), text))
    return entries


def _nav_entries(tree, base):
    navs = list(_find_all(tree, "nav"))
    toc = next(
        (
            n
            for n in navs
            if "toc" in (n.attrs.get("epub:type") or "").split()
            or n.attrs.get("role") == "doc-toc"
        ),
        navs[0] if navs else None,
    )
    if toc is None:
        return []
    return [
        (_resolve(base, a.attrs["href"]), " ".join(_text(a).split()))
        for a in _find_all(toc, "a")
        if a.attrs.get("href")
    ]


# A tolerant element tree: EPUB documents often break XML rules or use HTML entities.


class _Node:
    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag, attrs):
        self.tag = tag
        self.attrs = attrs
        self.children = []


class _Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("#document", {})
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        self.close_implied(tag)
        node = _Node(tag, {k: v or "" for k, v in attrs})
        self.stack[-1].children.append(node)
        if tag not in VOID and len(self.stack) < DEPTH_LIMIT:
            self.stack.append(node)

    def close_implied(self, tag):
        """Closes an open element that this start tag implicitly ends."""
        targets = {"p"} if tag in BLOCK_STARTS_CLOSE_P else set()
        if tag in IMPLIED:
            targets.add(tag)
        for depth in range(len(self.stack) - 1, 0, -1):
            name = self.stack[depth].tag
            if name in targets:
                del self.stack[depth:]
                return
            # A list, table or other container bounds the search for an open item.
            if name in IMPLIED.get(tag, ()) or (name not in INLINE and name != "p"):
                return

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(_Node(tag, {k: v or "" for k, v in attrs}))

    def handle_endtag(self, tag):
        for depth in range(len(self.stack) - 1, 0, -1):
            if self.stack[depth].tag == tag:
                del self.stack[depth:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)

    def unknown_decl(self, data):
        if data.startswith("CDATA["):
            self.stack[-1].children.append(data[6:])


def _parse(text):
    builder = _Builder()
    builder.feed(text)
    builder.close()
    return builder.root


def _find_all(node, tag):
    for child in node.children:
        if isinstance(child, _Node):
            if child.tag == tag:
                yield child
            yield from _find_all(child, tag)


def _text(node):
    if isinstance(node, str):
        return node
    if node.tag in SKIP:
        return ""
    return "".join(_text(child) for child in node.children)


BREAK = "\x00"  # A <br> inside a block; other whitespace collapses.


class _Writer:
    """Markdown blocks: headings, paragraphs, lists, quotes and fenced preformatted text."""

    def __init__(self):
        self.blocks = []  # (text, tight): adjacent list items are not separated.
        self.buffer = []
        self.marker = ""
        self.heading = ""
        self.listing = 0

    def flush(self, prefix="", lead=""):
        raw, self.buffer = "".join(self.buffer), []
        lines = [" ".join(line.split()) for line in raw.split(BREAK)]
        lines = [line for line in lines if line]
        if not lines:
            return
        lead = lead or self.marker
        self.marker = ""
        indent = (
            prefix + " " * len(lead) if lead and not lead.startswith("#") else prefix
        )
        out = [prefix + lead + lines[0], *(indent + line for line in lines[1:])]
        text = "\n".join(line.rstrip() for line in out)
        self.blocks.append((text, self.listing > 0 and not lead.startswith("#")))

    def preformatted(self, prefix, text):
        text = text.strip("\n")
        if not text.strip():
            return
        fence = "````" if "```" in text else "```"
        lines = [fence, *text.split("\n"), fence]
        text = "\n".join((prefix + line).rstrip() for line in lines)
        self.blocks.append((text, False))

    def text(self):
        out = []
        for index, (text, tight) in enumerate(self.blocks):
            if index:
                out.append("\n" if tight and self.blocks[index - 1][1] else "\n\n")
            out.append(text)
        return "".join(out) + "\n"


def _markdown(tree):
    """Markdown text of a parsed chapter and its first h1-h3 heading."""
    writer = _Writer()
    body = next(_find_all(tree, "body"), tree)

    def walk(node, quote, depth):
        for child in node.children:
            if isinstance(child, str):
                writer.buffer.append(child)
                continue
            tag = child.tag
            if tag in SKIP or "hidden" in child.attrs:
                continue
            prefix = "> " * quote + "  " * max(0, depth - 1)
            if tag == "br":
                writer.buffer.append(BREAK)
            elif tag == "img":
                alt = " ".join(child.attrs.get("alt", "").split())
                if alt:
                    writer.buffer.append(f" [image: {alt}] ")
            elif tag in ("td", "th"):
                if writer.buffer and "".join(writer.buffer).strip():
                    writer.buffer.append(" | ")
                walk(child, quote, depth)
            elif tag == "pre":
                writer.flush(prefix)
                writer.preformatted(prefix, _text(child))
            elif HEADING.fullmatch(tag):
                writer.flush(prefix)
                walk(child, quote, depth)
                level = int(tag[1])
                if level <= 3 and not writer.heading:
                    writer.heading = " ".join("".join(writer.buffer).split())
                writer.flush(prefix, "#" * level + " ")
            elif tag in ("ul", "ol"):
                writer.flush(prefix)
                writer.listing += 1
                walk(child, quote, depth + 1)
                writer.flush(prefix)
                writer.listing -= 1
            elif tag == "li":
                writer.flush(prefix)
                writer.marker = "- "
                walk(child, quote, max(depth, 1))
                writer.flush("> " * quote + "  " * max(0, max(depth, 1) - 1))
            elif tag == "blockquote":
                writer.flush(prefix)
                walk(child, quote + 1, depth)
                writer.flush("> " * (quote + 1) + "  " * max(0, depth - 1))
            elif tag in BLOCK:
                writer.flush(prefix)
                walk(child, quote, depth)
                writer.flush(prefix)
            else:
                walk(child, quote, depth)

    walk(body, 0, 0)
    writer.flush()
    return writer.text(), writer.heading
