// PDF highlight anchors. A page's text is its PDF.js text-layer text, normalized like webpage
// text: whitespace runs and line ends become one space. An anchor keeps the page, the quote
// with its context, offsets into that text, and PDF-space rects. Restoring always verifies
// the quote; offsets and rects are hints, never trusted alone.
import '../web-anchor.js';

const { matchQuote } = globalThis.tabgentWebAnchor;
export const CONTEXT = 32;
const space = (c) => c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x3000;
// Soft hyphens and zero-width characters.
const ignored = (c) => c === 0xad || (c >= 0x200b && c <= 0x200d) || c === 0xfeff;

// Pieces are strings or null (a line end). Each entry maps output characters to the
// UTF-16 offsets of its piece, so DOM text nodes can be addressed.
function normalize(pieces) {
  const out = [],
    entries = [];
  let length = 0,
    pending = false;
  pieces.forEach((data, piece) => {
    if (data === null) return void (pending = true);
    const offsets = new Int32Array(data.length + 1);
    let chunk = '',
      count = 0,
      whitespace = -1;
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      if (ignored(c)) continue;
      if (space(c)) {
        if (whitespace < 0) whitespace = i;
        pending = true;
        continue;
      }
      if (pending && length + count > 0) {
        chunk += ' ';
        offsets[count++] = whitespace >= 0 ? whitespace : i;
      }
      pending = false;
      whitespace = -1;
      chunk += data[i];
      offsets[count++] = i;
    }
    if (!count) return;
    entries.push({
      piece,
      start: length,
      end: length + count,
      offsets: offsets.subarray(0, count),
    });
    out.push(chunk);
    length += count;
  });
  return { text: out.join(''), entries };
}

// Page text from PDF.js getTextContent items, mirroring how the text layer is built:
// one text node per item and a <br> after items that end a line.
export function pageText(items) {
  const pieces = [];
  for (const item of items || []) {
    if (typeof item?.str !== 'string') continue; // Marked-content markers.
    pieces.push(item.str);
    if (item.hasEOL) pieces.push(null);
  }
  return normalize(pieces).text;
}

// Text-layer DOM ↔ page text offsets. Only text nodes and line breaks count, so PDF.js
// moving its empty endOfContent element during a selection changes nothing.
export function layerIndex(layer) {
  const nodes = [],
    pieces = [];
  (function walk(node) {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        nodes.push(child);
        pieces.push(child.data);
      } else if (child.nodeType === 1) {
        if (child.localName === 'br') {
          nodes.push(null);
          pieces.push(null);
        } else if (
          child.getAttribute('role') !== 'img' &&
          !child.classList.contains('editToolbar') &&
          !child.classList.contains('textLayerImages')
        )
          walk(child);
      }
    }
  })(layer);
  const { text, entries } = normalize(pieces);
  for (const entry of entries) entry.node = nodes[entry.piece];
  const byNode = new Map(entries.map((entry) => [entry.node, entry]));
  function entryAt(offset) {
    let low = 0,
      high = entries.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1,
        entry = entries[middle];
      if (offset < entry.start) high = middle - 1;
      else if (offset >= entry.end) low = middle + 1;
      else return entry;
    }
    return null;
  }
  // The offset of the first character at or after a DOM boundary point inside the layer.
  function pointToOffset(container, offset) {
    const entry = byNode.get(container);
    if (entry) {
      let low = 0,
        high = entry.offsets.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (entry.offsets[middle] < offset) low = middle + 1;
        else high = middle;
      }
      return entry.start + low;
    }
    const boundary = layer.ownerDocument.createRange();
    try {
      boundary.setStart(container, offset);
    } catch {
      return -1;
    }
    let low = 0,
      high = entries.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (boundary.comparePoint(entries[middle].node, 0) < 0) low = middle + 1;
      else high = middle;
    }
    return low < entries.length ? entries[low].start : text.length;
  }
  function rangeFromOffsets(start, end) {
    if (!(start >= 0 && end > start && end <= text.length)) return null;
    const first = entryAt(start),
      last = entryAt(end - 1);
    if (!first || !last) return null;
    const range = layer.ownerDocument.createRange();
    range.setStart(first.node, first.offsets[start - first.start]);
    range.setEnd(last.node, last.offsets[end - 1 - last.start] + 1);
    return range;
  }
  return { text, pointToOffset, rangeFromOffsets };
}

// Page segments of a span of `texts` (consecutive pages from `firstPage`, joined by a space).
export function segments(texts, firstPage, start, end) {
  const out = [];
  let base = 0;
  texts.forEach((text, i) => {
    let s = Math.max(start, base) - base,
      e = Math.min(end, base + text.length) - base;
    while (s < e && text[s] === ' ') s++;
    while (e > s && text[e - 1] === ' ') e--;
    if (e > s) out.push({ page: firstPage + i, start: s, end: e });
    base += text.length + 1;
  });
  return out;
}

// The quote for a selection from `start` on the first page to `end` on the last one.
// Context stays within those pages; textLayer offsets index the pages' joined text.
export function describe(texts, firstPage, start, end) {
  const lastBase = texts.slice(0, -1).reduce((n, text) => n + text.length + 1, 0);
  const parts = segments(texts, firstPage, start, lastBase + end);
  if (!parts.length) return null;
  const page = parts[0].page,
    endPage = parts.at(-1).page;
  const window = texts.slice(page - firstPage, endPage - firstPage + 1);
  const s = parts[0].start,
    e = window.slice(0, -1).reduce((n, text) => n + text.length + 1, 0) + parts.at(-1).end;
  const joined = window.join(' ');
  return {
    anchor: {
      kind: 'pdf',
      page,
      ...(endPage > page ? { endPage } : {}),
      quote: {
        exact: joined.slice(s, e),
        prefix: joined.slice(Math.max(0, s - CONTEXT), s),
        suffix: joined.slice(e, e + CONTEXT),
      },
      textLayer: { start: s, end: e },
    },
    segments: parts,
  };
}

const offsets = (value) =>
  Number.isInteger(value?.start) && Number.isInteger(value?.end) && value.end > value.start;
function verified(text, start, end, { exact, prefix = '', suffix = '' }) {
  return (
    text.slice(start, end) === exact &&
    start >= prefix.length &&
    text.slice(start - prefix.length, start) === prefix &&
    text.slice(end, end + suffix.length) === suffix
  );
}

// Page `page` → its text. Batches keep a whole-document search from flooding the worker.
async function texts(pages, first, last) {
  const out = [];
  for (let page = first; page <= last; page += 8) {
    const batch = [];
    for (let p = page; p <= Math.min(last, page + 7); p++) batch.push(pages.text(p));
    out.push(...(await Promise.all(batch)));
  }
  return out;
}

// Saved page + verified offsets → same-page quote search → whole-document quote search.
// Returns { segments, method } or null when no match is confident (never a guess).
export async function resolve(anchor, pages) {
  const quote = anchor?.quote;
  if (anchor?.kind !== 'pdf' || !quote?.exact || !Number.isInteger(anchor.page)) return null;
  const first = anchor.page,
    hint = offsets(anchor.textLayer) ? anchor.textLayer.start : null;
  if (first >= 1 && first <= pages.count) {
    const last = Math.min(Number.isInteger(anchor.endPage) ? anchor.endPage : first, pages.count);
    const window = await texts(pages, first, Math.max(first, last));
    const joined = window.join(' ');
    if (hint !== null && verified(joined, hint, anchor.textLayer.end, quote))
      return {
        segments: segments(window, first, hint, anchor.textLayer.end),
        method: 'position',
      };
    const match = matchQuote(joined, quote, hint);
    if (match)
      return { segments: segments(window, first, match.start, match.end), method: match.method };
  }
  // Moved text (for example a revised PDF at the same URL): every page competes on context.
  const all = await texts(pages, 1, pages.count);
  const base = all.slice(0, first - 1).reduce((n, text) => n + text.length + 1, 0);
  const match = matchQuote(all.join(' '), quote, hint === null ? null : base + hint);
  return match
    ? { segments: segments(all, 1, match.start, match.end), method: `document-${match.method}` }
    : null;
}

// PDF user-space rects, rounded and merged per line: [{ page, pdf: [x1, y1, x2, y2] }].
export function mergeRects(rects, limit = 200) {
  const round = (n) => Math.round(n * 100) / 100;
  const boxes = rects
    .filter((r) => Number.isInteger(r?.page) && r.pdf?.length === 4 && r.pdf.every(Number.isFinite))
    .map(({ page, pdf: [a, b, c, d] }) => ({
      page,
      pdf: [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)],
    }))
    .filter(({ pdf }) => pdf[2] > pdf[0] && pdf[3] > pdf[1]);
  const out = [];
  for (const box of boxes) {
    const previous = out.at(-1),
      [x1, y1, x2, y2] = box.pdf;
    if (previous?.page === box.page) {
      const [px1, py1, px2, py2] = previous.pdf;
      const overlap = Math.min(y2, py2) - Math.max(y1, py1),
        height = Math.min(y2 - y1, py2 - py1);
      const gap = Math.max(x1, px1) - Math.min(x2, px2);
      if (overlap >= height * 0.5 && gap <= height) {
        previous.pdf = [Math.min(x1, px1), Math.min(y1, py1), Math.max(x2, px2), Math.max(y2, py2)];
        continue;
      }
    }
    out.push(box);
  }
  return out.slice(0, limit).map(({ page, pdf }) => ({ page, pdf: pdf.map(round) }));
}

// Nearby page text for the prompt.
export function context(before, after, size = 1500) {
  return { before: before.slice(-size).trimStart(), after: after.slice(0, size).trimEnd() };
}
