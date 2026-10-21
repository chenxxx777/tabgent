"""Page text of an imported PDF for the reading vault, read with macOS PDFKit.

One osascript process reads every page, as the PDF fallback reader does for one page.
The text is untrusted data: it is written to Markdown files, never interpreted."""

import json
import re
import subprocess

PAGE_LIMIT = 5000
PAGE_CHARS = 100_000
TOTAL_CHARS = 20_000_000
TIMEOUT = 90
SCRIPT = """ObjC.import('PDFKit');
function run(a) {
  const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(a[0]));
  if (!d || d.isNil()) throw Error('Not a readable PDF');
  if (d.isLocked) throw Error('The PDF is encrypted');
  const count = Number(d.pageCount), text = [];
  for (let i = 0; i < Math.min(count, Number(a[1])); i++)
    text.push(ObjC.unwrap(d.pageAtIndex(i).string) || '');
  return JSON.stringify({ count, text });
}"""
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class PdfError(Exception):
    pass


def extract(path):
    """{"count": pages in the PDF, "pages": [{"page", "text"}], "truncated": bool}."""
    try:
        done = subprocess.run(
            ["/usr/bin/osascript", "-l", "JavaScript", "-e", SCRIPT, str(path)]
            + [str(PAGE_LIMIT)],
            capture_output=True,
            text=True,
            timeout=TIMEOUT,
        )
    except FileNotFoundError:
        raise PdfError("Reading PDF text needs macOS PDFKit")
    except subprocess.TimeoutExpired:
        raise PdfError("Reading the PDF text took too long")
    if done.returncode:
        # osascript reports "execution error: Error: Error: <reason> (-2700)".
        reasons = re.findall(r"(?:Error: )+([^()\n]+?) \(-?\d+\)", done.stderr)
        raise PdfError(reasons[-1] if reasons else "PDFKit could not read the PDF")
    try:
        value = json.loads(done.stdout)
        count, texts = int(value["count"]), list(value["text"])
    except (ValueError, KeyError, TypeError):
        raise PdfError("PDFKit returned no page text")
    pages, total = [], 0
    truncated = count > len(texts)
    for number, text in enumerate(texts, 1):
        text = text if isinstance(text, str) else ""
        lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        text = CONTROL.sub("", "\n".join(line.rstrip() for line in lines)).strip()
        if len(text) > PAGE_CHARS:
            text, truncated = text[:PAGE_CHARS], True
        if total + len(text) > TOTAL_CHARS:
            truncated = True
            break
        total += len(text)
        pages.append({"page": number, "text": text})
    return {"count": count, "pages": pages, "truncated": truncated}
