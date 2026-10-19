// Builds small text-only PDFs for viewer tests: Letter pages, one Helvetica line per entry.
// Lines are ASCII; the generated files contain only the given fixture text.
const escape = (text) => text.replace(/[\\()]/g, (c) => '\\' + c);
function textPdf(pages, { title = '', author = '' } = {}) {
  const objects = [];
  const add = (body) => objects.push(body);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(null); // Pages, filled in below.
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add(`<< /Title (${escape(title)}) /Author (${escape(author)}) >>`);
  const kids = [];
  for (const lines of pages) {
    const stream = `BT /F1 12 Tf 16 TL 72 720 Td ${lines.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`;
    add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${objects.length} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(out);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
module.exports = { textPdf };
