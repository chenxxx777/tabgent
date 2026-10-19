// Webpage anchors: quote, normalized-text position, and a DOM hint that is only trusted
// after it is verified against the live text. Shared by content scripts and tests.
(() => {
  if (globalThis.tabgentWebAnchor) return;
  const CONTEXT = 32;
  const SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'TEXTAREA',
    'SELECT',
    'OPTION',
    'IFRAME',
    'OBJECT',
    'CANVAS',
    'VIDEO',
    'AUDIO',
  ]);
  // Boundaries of these elements separate words even when markup has no whitespace.
  const BLOCK = new Set(
    (
      'ADDRESS ARTICLE ASIDE BLOCKQUOTE BR CAPTION DD DETAILS DIALOG DIV DL DT FIELDSET ' +
      'FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER HGROUP HR IMG LEGEND LI MAIN ' +
      'NAV OL P PRE SECTION SUMMARY TABLE TBODY TD TFOOT TH THEAD TR UL'
    ).split(' '),
  );
  const space = (c) => c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 0x3000;
  // Soft hyphens and zero-width characters are often inserted by page scripts.
  const ignored = (c) => c === 0xad || (c >= 0x200b && c <= 0x200d) || c === 0xfeff;

  // Whitespace runs and block boundaries become one space; leading space is dropped.
  function buildIndex(root = document.body || document.documentElement, exclude = null) {
    const pieces = [],
      entries = [];
    let length = 0,
      pending = false;
    function text(node) {
      const data = node.data,
        offsets = new Int32Array(data.length + 1);
      let out = '',
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
          out += ' ';
          offsets[count++] = whitespace >= 0 ? whitespace : i;
        }
        pending = false;
        whitespace = -1;
        out += data[i];
        offsets[count++] = i;
      }
      if (!count) return;
      entries.push({
        node,
        start: length,
        end: length + count,
        offsets: offsets.subarray(0, count),
      });
      pieces.push(out);
      length += count;
    }
    function walk(node) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) text(child);
        else if (child.nodeType === 1) {
          if (SKIP.has(child.nodeName.toUpperCase()) || child === exclude) continue;
          const block = BLOCK.has(child.nodeName.toUpperCase());
          if (block) pending = true;
          walk(child);
          if (block) pending = true;
        }
      }
    }
    if (root) walk(root);
    return createIndex(pieces.join(''), entries);
  }

  function createIndex(text, entries) {
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
    // The normalized offset of the first character at or after a DOM boundary point.
    function pointToOffset(container, offset) {
      const entry = byNode.get(container);
      if (entry) {
        const offsets = entry.offsets;
        let low = 0,
          high = offsets.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (offsets[middle] < offset) low = middle + 1;
          else high = middle;
        }
        return entry.start + low;
      }
      const boundary = document.createRange();
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
      const range = document.createRange();
      range.setStart(first.node, first.offsets[start - first.start]);
      range.setEnd(last.node, last.offsets[end - 1 - last.start] + 1);
      return range;
    }
    function offsetsOfRange(range) {
      let start = pointToOffset(range.startContainer, range.startOffset),
        end = pointToOffset(range.endContainer, range.endOffset);
      if (start < 0 || end < 0) return null;
      while (start < end && text[start] === ' ') start++;
      while (end > start && text[end - 1] === ' ') end--;
      return end > start ? { start, end } : null;
    }
    return { text, entries, pointToOffset, rangeFromOffsets, offsetsOfRange };
  }

  // Same path format as selection-content.js; light DOM only.
  function domPath(node) {
    const parts = [];
    while (node && node !== document) {
      const parent = node.parentNode;
      if (!parent || parent.nodeType === 11) return null;
      parts.unshift(
        node.nodeType === 3
          ? `text()[${[...parent.childNodes].indexOf(node)}]`
          : `${node.localName}:nth-child(${[...parent.children].indexOf(node) + 1})`,
      );
      node = parent;
    }
    return node === document ? parts.join(' > ') : null;
  }
  function nodeFromPath(path) {
    if (typeof path !== 'string' || !path) return null;
    let node = document;
    for (const part of path.split(' > ')) {
      const text = /^text\(\)\[(\d+)\]$/.exec(part);
      if (text) {
        node = node.childNodes[Number(text[1])];
        if (node?.nodeType !== 3) return null;
        continue;
      }
      const element = /^([^:\s]+):nth-child\((\d+)\)$/.exec(part);
      if (!element) return null;
      node = node.children?.[Number(element[2]) - 1];
      if (!node || node.localName !== element[1]) return null;
    }
    return node;
  }

  function describe(range, index = buildIndex()) {
    const offsets = index.offsetsOfRange(range);
    if (!offsets) return null;
    const { start, end } = offsets,
      exact = index.text.slice(start, end);
    const anchor = {
      kind: 'web',
      quote: {
        exact,
        prefix: index.text.slice(Math.max(0, start - CONTEXT), start),
        suffix: index.text.slice(end, end + CONTEXT),
      },
      position: { start, end },
    };
    const exactRange = index.rangeFromOffsets(start, end);
    const startPath = exactRange && domPath(exactRange.startContainer),
      endPath = exactRange && domPath(exactRange.endContainer);
    if (startPath && endPath)
      anchor.dom = {
        start: { path: startPath, offset: exactRange.startOffset },
        end: { path: endPath, offset: exactRange.endOffset },
      };
    return anchor;
  }

  function context(index, start, end, size = 1500) {
    return {
      before: index.text.slice(Math.max(0, start - size), start).trimStart(),
      after: index.text.slice(end, end + size).trimEnd(),
    };
  }

  // Shared length of the end of a and the end of b (or starts, when fromStart).
  function common(a, b, fromStart) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    if (fromStart) while (i < n && a[i] === b[i]) i++;
    else while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }
  function contextScore(text, start, end, prefix, suffix) {
    const total = prefix.length + suffix.length;
    if (!total) return 1;
    const before = common(text.slice(Math.max(0, start - prefix.length), start), prefix, false),
      after = common(text.slice(end, end + suffix.length), suffix, true);
    return (before + after) / total;
  }
  function similarity(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    let previous = new Int32Array(b.length + 1),
      current = new Int32Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) previous[j] = j;
    for (let i = 1; i <= a.length; i++) {
      current[0] = i;
      const c = a.charCodeAt(i - 1);
      for (let j = 1; j <= b.length; j++)
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (c === b.charCodeAt(j - 1) ? 0 : 1),
        );
      [previous, current] = [current, previous];
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length);
  }
  function occurrences(text, needle, limit) {
    const found = [];
    if (!needle) return found;
    for (let i = text.indexOf(needle); i !== -1 && found.length < limit;)
      (found.push(i), (i = text.indexOf(needle, i + 1)));
    return found;
  }

  // Locates a quote in normalized text. Returns null when the match is not confident.
  function matchQuote(text, quote, hint = null) {
    const exact = quote?.exact || '',
      prefix = quote?.prefix || '',
      suffix = quote?.suffix || '';
    if (!exact) return null;
    const candidates = occurrences(text, exact, 1000).map((start) => ({
      start,
      end: start + exact.length,
      score: contextScore(text, start, start + exact.length, prefix, suffix),
    }));
    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score);
      const [best, second] = candidates;
      if (!second)
        return best.score >= 0.5 || exact.length >= CONTEXT ? { ...best, method: 'quote' } : null;
      if (best.score < 0.5) return null;
      if (best.score - second.score >= 0.15) return { ...best, method: 'quote' };
      // Identical passages in identical context: only a clearly closer position decides.
      if (!Number.isInteger(hint)) return null;
      const tied = candidates
        .filter((c) => best.score - c.score < 0.15)
        .sort((a, b) => Math.abs(a.start - hint) - Math.abs(b.start - hint));
      return Math.abs(tied[0].start - hint) * 4 < Math.abs(tied[1].start - hint)
        ? { ...tied[0], method: 'position-tiebreak' }
        : null;
    }
    // The quote itself changed: accept a near-identical span bracketed by its old context.
    if (exact.length < 8 || exact.length > 2000) return null;
    const head = prefix.slice(-16),
      tail = suffix.slice(0, 16);
    if (!head && !tail) return null;
    const starts = head ? occurrences(text, head, 50).map((i) => i + head.length) : [0];
    const spans = [];
    for (const start of starts) {
      const minimum = start + Math.floor(exact.length * 0.6),
        maximum = start + Math.ceil(exact.length * 1.4) + 8;
      let end = -1;
      if (tail) {
        const at = text.indexOf(tail, minimum);
        if (at !== -1 && at <= maximum) end = at;
      } else if (text.length >= minimum && text.length <= maximum) end = text.length;
      if (end < 0) continue;
      let s = start,
        e = end;
      while (s < e && text[s] === ' ') s++;
      while (e > s && text[e - 1] === ' ') e--;
      // Edit distance is at least the length difference; skip spans that cannot qualify.
      if (Math.abs(e - s - exact.length) > exact.length * 0.2) continue;
      spans.push({ start: s, end: e, score: similarity(text.slice(s, e), exact) });
      if (spans.length >= 5) break;
    }
    spans.sort((a, b) => b.score - a.score);
    const [best, second] = spans;
    if (!best || best.score < 0.8 || (second && best.score - second.score < 0.1)) return null;
    return { ...best, method: 'fuzzy' };
  }

  // DOM hint → position → quote search. A hint or position is accepted only when the quote
  // and its full context match; otherwise every occurrence competes on context.
  function resolve(anchor, index = buildIndex()) {
    if (anchor?.kind !== 'web' || !anchor.quote?.exact) return null;
    const { exact, prefix = '', suffix = '' } = anchor.quote;
    const exactAt = (start, end) => index.text.slice(start, end) === exact;
    const verified = (start, end) =>
      exactAt(start, end) && contextScore(index.text, start, end, prefix, suffix) === 1;
    const found = (start, end, method) => {
      const range = index.rangeFromOffsets(start, end);
      return range ? { start, end, method, range } : null;
    };
    let hint = Number.isInteger(anchor.position?.start) ? anchor.position.start : null;
    const first = anchor.dom && nodeFromPath(anchor.dom.start?.path),
      last = anchor.dom && nodeFromPath(anchor.dom.end?.path);
    if (first && last) {
      try {
        const range = document.createRange();
        range.setStart(first, anchor.dom.start.offset);
        range.setEnd(last, anchor.dom.end.offset);
        const offsets = index.offsetsOfRange(range);
        if (offsets && verified(offsets.start, offsets.end))
          return found(offsets.start, offsets.end, 'dom');
        if (offsets && exactAt(offsets.start, offsets.end)) hint = offsets.start;
      } catch {}
    }
    const position = anchor.position;
    if (Number.isInteger(position?.start) && verified(position.start, position.end))
      return found(position.start, position.end, 'position');
    const match = matchQuote(index.text, anchor.quote, hint);
    return match && found(match.start, match.end, match.method);
  }

  globalThis.tabgentWebAnchor = {
    buildIndex,
    describe,
    resolve,
    context,
    matchQuote,
    similarity,
    domPath,
    nodeFromPath,
  };
})();
