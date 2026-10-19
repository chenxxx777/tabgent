"""Small text-only PDFs for Python tests, like text-pdf.cjs: Letter pages with one
Helvetica line per entry. Lines are ASCII; files contain only the given fixture text."""


def _escape(text):
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build(pages, title=""):
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        None,  # Pages, filled in below.
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        f"<< /Title ({_escape(title)}) >>",
    ]
    kids = []
    for lines in pages:
        shown = " ".join(f"({_escape(line)}) Tj T*" for line in lines)
        stream = f"BT /F1 12 Tf 16 TL 72 720 Td {shown} ET"
        objects.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents "
            f"{len(objects)} 0 R /Resources << /Font << /F1 3 0 R >> >> >>"
        )
        kids.append(len(objects))
    objects[1] = (
        f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] "
        f"/Count {len(kids)} >>"
    )
    out = "%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out.encode("latin-1")))
        out += f"{number} 0 obj\n{body}\nendobj\n"
    xref = len(out.encode("latin-1"))
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    out += "".join(f"{at:010d} 00000 n \n" for at in offsets)
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 4 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    )
    return out.encode("latin-1")
