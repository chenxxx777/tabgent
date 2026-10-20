"""Builds a small, synthetic EPUB 3 book for tests. Deterministic: the same bytes (and
SHA-256) on every run. Usage: python3 epub_fixture.py <output.epub> [title] [noise characters]
"""

import argparse
import io
import os
from pathlib import Path
import zipfile

TITLE = "A Small Book of Reading"
AUTHOR = "Test Author"
CHAPTERS = [
    (
        "ch1.xhtml",
        "Chapter One: Beginnings",
        """<h1>Chapter One: Beginnings</h1>
<p id="p1">Autonomy does not mean independence from others, but endorsement of one&#8217;s own actions.</p>
<p>People are <em>more persistent</em> when they endorse what they do.</p>
<ul><li>First idea</li><li>Second idea<ul><li>Nested idea</li></ul></li></ul>
<blockquote><p>A quoted passage from another book.</p></blockquote>
<script>document.title = 'SCRIPT-RAN'; window.parent.tabgentScriptRan = true;</script>
<p onclick="window.parent.tabgentScriptRan = true">Click handlers must stay inert.</p>
<p><a href="javascript:window.parent.tabgentScriptRan=true">A javascript link</a> and
<a href="https://example.invalid/page">an external link</a>.</p>
<img src="https://example.invalid/pixel.png" alt="remote pixel" onerror="window.parent.tabgentScriptRan = true"/>""",
    ),
    (
        "ch2.xhtml",
        "Chapter Two: Repetition",
        """<h1>Chapter Two: Repetition</h1>
<p>Repeated line. Shared ending one.</p>
<p>Repeated line. Shared ending two.</p>
<h2 id="s21">2.1 A subsection</h2>
<p>自主性并不意味着独立于他人，而是个体对于自己行为的认同。</p>
<pre>code  keeps   spacing
second line</pre>
<table><tr><th>Term</th><th>Meaning</th></tr><tr><td>CFI</td><td>Canonical Fragment Identifier</td></tr></table>""",
    ),
    (
        "ch3.xhtml",
        "Chapter Three: Endings",
        """<h1>Chapter Three: Endings</h1>
<p>The last chapter closes the argument and returns to autonomy once more.</p>
<p>Line one of a poem<br/>line two of a poem</p>""",
    ),
]


def xhtml(title, body):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>{title}</title><link rel="stylesheet" href="style.css"/></head>
<body>
{body}
</body>
</html>
"""


def build(
    chapters=CHAPTERS, title=TITLE, author=AUTHOR, fixed_layout=False, navigation=False
):
    """The EPUB file as bytes."""
    if navigation:
        chapters = [
            (
                (
                    href,
                    label,
                    '<p><a id="next-chapter" href="ch3.xhtml">Go to chapter three</a></p>'
                    + '<xmp>&lt;/xmp&gt;&lt;img id="raw-text-image" src="data:," '
                    + 'onerror="parent.tabgentScriptRan=true"/&gt;'
                    + "&lt;script&gt;parent.tabgentRawTextRan=true&lt;/script&gt;</xmp>"
                    + body,
                )
                if href == "ch1.xhtml"
                else (href, label, body)
            )
            for href, label, body in chapters
        ]
    manifest = "\n".join(
        f'<item id="c{i}" href="{href}" media-type="application/xhtml+xml"/>'
        for i, (href, _, _) in enumerate(chapters, 1)
    )
    spine = "\n".join(f'<itemref idref="c{i}"/>' for i in range(1, len(chapters) + 1))
    toc = "\n".join(
        f'<li><a href="{href}">{label}</a>'
        + (
            '<ol><li><a href="ch2.xhtml#s21">2.1 A subsection</a></li></ol>'
            if href == "ch2.xhtml"
            else ""
        )
        + "</li>"
        for href, label, _ in chapters
    )
    if navigation:
        toc += '<li><a href="missing.xhtml">Missing chapter</a></li>'
    layout = (
        '<meta property="rendition:layout">pre-paginated</meta>' if fixed_layout else ""
    )
    files = {
        "META-INF/container.xml": """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
""",
        "OEBPS/content.opf": f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:00000000-0000-4000-8000-000000000001</dc:identifier>
<dc:title>{title}</dc:title>
<dc:creator>{author}</dc:creator>
<dc:language>en</dc:language>
<dc:date>2026-01-01</dc:date>
<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
{layout}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
{manifest}
</manifest>
<spine>
<itemref idref="cover" linear="no"/>
{spine}
</spine>
</package>
""",
        "OEBPS/nav.xhtml": xhtml(
            "Contents",
            f'<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>{toc}</ol></nav>',
        ),
        "OEBPS/cover.xhtml": xhtml("Cover", "<div></div>"),
        "OEBPS/style.css": "body { line-height: 1.5; }\n",
    }
    for href, label, body in chapters:
        files["OEBPS/" + href] = xhtml(label, body)
    if fixed_layout:
        for name, text in files.items():
            if name.endswith(".xhtml"):
                files[name] = text.replace(
                    "</head>",
                    '<meta name="viewport" content="width=600,height=800"/></head>',
                )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        stamp = (2026, 1, 1, 0, 0, 0)
        archive.writestr(zipfile.ZipInfo("mimetype", stamp), "application/epub+zip")
        for name, text in files.items():
            info = zipfile.ZipInfo(name, stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, text.encode("utf-8"))
    return buffer.getvalue()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output")
    parser.add_argument("title", nargs="?", default=TITLE)
    parser.add_argument("noise", nargs="?", type=int, default=0)
    parser.add_argument("--fixed-layout", action="store_true")
    parser.add_argument("--navigation", action="store_true")
    args = parser.parse_args()
    chapters = CHAPTERS
    if args.noise:
        filler = "<p>" + os.urandom(args.noise // 2).hex() + "</p>"
        chapters = [*CHAPTERS, ("noise.xhtml", "Noise", filler)]
    Path(args.output).write_bytes(
        build(
            chapters,
            args.title,
            fixed_layout=args.fixed_layout,
            navigation=args.navigation,
        )
    )
