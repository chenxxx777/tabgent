// EPUB anchors: a CFI plus the quote and 32 characters of context in the chapter's normalized
// text (built by web-anchor.js, loaded before this module). A CFI is trusted only when the quote
// and its context match there; otherwise the quote is searched in the chapter, and anything less
// certain is unanchored and never painted.
const CONTEXT = 32;
const text = () => globalThis.tabgentWebAnchor;

export function chapterIndex(doc) {
  return text().buildIndex(doc.body || doc.documentElement);
}

// web-anchor.js builds ranges in the top document; the reader's chapters live in iframes.
export function rangeAt(doc, index, start, end) {
  if (!(start >= 0 && end > start && end <= index.text.length)) return null;
  const entryAt = (offset) => {
    let low = 0,
      high = index.entries.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1,
        entry = index.entries[middle];
      if (offset < entry.start) high = middle - 1;
      else if (offset >= entry.end) low = middle + 1;
      else return entry;
    }
    return null;
  };
  const first = entryAt(start),
    last = entryAt(end - 1);
  if (!first || !last) return null;
  const range = doc.createRange();
  range.setStart(first.node, first.offsets[start - first.start]);
  range.setEnd(last.node, last.offsets[end - 1 - last.start] + 1);
  return range;
}

// { anchor, range, context } for a selection, or null when it holds no text.
// cfiOf(range) returns the book CFI of a range in this chapter.
export function describe(doc, range, { cfiOf, chapter, index = chapterIndex(doc) }) {
  const offsets = index.offsetsOfRange(range);
  if (!offsets) return null;
  const { start, end } = offsets,
    exact = index.text.slice(start, end),
    exactRange = rangeAt(doc, index, start, end);
  if (!exactRange) return null;
  return {
    anchor: {
      kind: 'epub',
      cfi: cfiOf(exactRange),
      quote: {
        exact,
        prefix: index.text.slice(Math.max(0, start - CONTEXT), start),
        suffix: index.text.slice(end, end + CONTEXT),
      },
      chapter,
      position: { start, end },
    },
    range: exactRange,
    context: text().context(index, start, end),
  };
}

// { range, start, end, method, context } or null. rangeOfCfi(cfi) resolves a CFI in this chapter.
export function resolve(doc, anchor, { rangeOfCfi, index = chapterIndex(doc) }) {
  if (anchor?.kind !== 'epub' || !anchor.quote?.exact) return null;
  const { exact, prefix = '', suffix = '' } = anchor.quote;
  const found = (start, end, method) => {
    const range = rangeAt(doc, index, start, end);
    return range && { range, start, end, method, context: text().context(index, start, end) };
  };
  let hint = Number.isInteger(anchor.position?.start) ? anchor.position.start : null;
  let range = null;
  try {
    range = anchor.cfi ? rangeOfCfi(anchor.cfi) : null;
  } catch {}
  const offsets = range?.startContainer?.ownerDocument === doc && index.offsetsOfRange(range);
  if (offsets && index.text.slice(offsets.start, offsets.end) === exact) {
    const { start, end } = offsets;
    if (
      index.text.slice(Math.max(0, start - prefix.length), start) === prefix &&
      index.text.slice(end, end + suffix.length) === suffix
    )
      return found(start, end, 'cfi');
    hint = start;
  }
  const match = text().matchQuote(index.text, anchor.quote, hint);
  return match && found(match.start, match.end, match.method);
}
