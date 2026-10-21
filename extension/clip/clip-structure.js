// Clipping: page structure that extraction would otherwise lose. Loaded before
// clip-content.js, in the page (injected with it) and in the reader's cleaning frame.
// - Tables drawn with ARIA roles on other elements become real tables; tables used for
//   layout become plain blocks; cells mixing loose text with blocks keep that text.
// - A coverage check compares the text the page shows in its content region with the text
//   extracted from it. Passages that went missing (and author or guest cards, always) are
//   put back where they were; navigation, comments, recommendations, buttons and counts
//   are not counted.
(() => {
  if (globalThis.tabgentClipStructure) return;

  // checkVisibility() is false for display: contents, which draws its children.
  function displayed(element) {
    if (typeof element.checkVisibility !== 'function' || element.checkVisibility()) return true;
    return getComputedStyle(element).display === 'contents';
  }

  const role = (node) =>
    (node?.nodeType === 1 &&
      (node.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0]) ||
    '';
  const GRID = new Set(['table', 'grid', 'treegrid']);
  const CELL = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);
  const BLOCKS = new Set(
    (
      'address article aside blockquote details dialog dd div dl dt fieldset figcaption figure ' +
      'footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table ul'
    ).split(' '),
  );
  const media = 'img,picture,video,audio,iframe,embed,object,svg,math,canvas';
  const filled = (node) => !!(node.textContent.trim() || node.querySelector?.(media));
  const isGrid = (node) =>
    node.nodeType === 1 && (node.localName === 'table' || GRID.has(role(node)));

  // The source element's attributes (class, id, test ids, hidden...) on the new table, row or
  // cell, except its role: Defuddle reads them to drop noise such as a grid of related posts.
  // Copies of the attributes: a name the parser accepted from broken markup (<span =x>)
  // would make setAttribute throw.
  const keep = (from, to) => {
    for (const attribute of from.attributes)
      if (!/^(?:role|aria-colspan|aria-rowspan)$/.test(attribute.name))
        to.setAttributeNode(attribute.cloneNode());
  };

  // A table drawn with role="table" (or grid) on other elements becomes a real table, so its
  // rows and columns reach the Markdown. Content of the element outside its rows stays
  // before or after the table, as on the page. Inner tables are converted first.
  function ariaTables(root) {
    const doc = root.ownerDocument || root;
    const grids = [...root.querySelectorAll('[role]')].filter(
      (element) => GRID.has(role(element)) && element.localName !== 'table',
    );
    for (const grid of grids.reverse()) {
      if (grid.hasAttribute('hidden')) continue;
      const rows = [],
        extras = [];
      (function collect(node) {
        for (const child of [...node.childNodes]) {
          if (child.nodeType !== 1) {
            if (child.nodeType === 3 && child.data.trim()) extras.push(child);
            continue;
          }
          if (role(child) === 'row') rows.push(child);
          else if (isGrid(child) || !child.querySelector('[role]')) {
            if (filled(child)) extras.push(child);
          } else if ([...child.querySelectorAll('[role]')].some((e) => role(e) === 'row'))
            collect(child);
          else if (filled(child)) extras.push(child);
        }
      })(grid);
      const cellsOf = (row) => {
        const cells = [];
        (function walk(node) {
          for (const child of node.children) {
            if (CELL.has(role(child))) cells.push(child);
            else if (role(child) !== 'row' && !isGrid(child)) walk(child);
          }
        })(row);
        return cells;
      };
      const matrix = rows.map(cellsOf);
      if (!matrix.some((cells) => cells.length)) continue;
      const table = doc.createElement('table');
      keep(grid, table);
      let heading = 0;
      while (
        heading < matrix.length - 1 &&
        matrix[heading].length &&
        matrix[heading].every((cell) => role(cell) === 'columnheader')
      )
        heading++;
      const head = heading ? doc.createElement('thead') : null,
        body = doc.createElement('tbody');
      matrix.forEach((cells, index) => {
        const tr = doc.createElement('tr');
        keep(rows[index], tr);
        for (const cell of cells) {
          const kind = role(cell);
          const td = doc.createElement(
            kind === 'columnheader' || kind === 'rowheader' ? 'th' : 'td',
          );
          keep(cell, td);
          if (kind === 'columnheader') td.setAttribute('scope', 'col');
          if (kind === 'rowheader') td.setAttribute('scope', 'row');
          for (const [aria, name] of [
            ['aria-colspan', 'colspan'],
            ['aria-rowspan', 'rowspan'],
          ]) {
            const span = Number.parseInt(cell.getAttribute(aria), 10);
            if (span > 1 && span < 1000) td.setAttribute(name, String(span));
          }
          td.append(...cell.childNodes);
          tr.append(td);
        }
        // Text of the row outside its cells keeps a cell of its own.
        if (filled(rows[index])) {
          const td = doc.createElement('td');
          td.append(...rows[index].childNodes);
          tr.append(td);
        }
        (index < heading ? head : body).append(tr);
      });
      if (head) table.append(head);
      table.append(body);
      const first = rows[0];
      const before = extras.filter(
        (node) => node.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const after = extras.filter((node) => !before.includes(node));
      grid.replaceWith(...before, table, ...after);
    }
  }

  // A cell holding loose text next to block elements: the text is put in a block of its own.
  // Defuddle replaces a layout table by the one block of its only filled cell, which would
  // drop that text ("A guest post by" above a name card).
  function mixedCells(root) {
    const doc = root.ownerDocument || root;
    for (const cell of root.querySelectorAll('td, th')) {
      const nodes = [...cell.childNodes];
      if (!nodes.some((node) => node.nodeType === 1 && BLOCKS.has(node.localName))) continue;
      let run = [];
      const flush = () => {
        while (run.length && run[0].nodeName === 'BR') run.shift();
        while (run.length && run.at(-1).nodeName === 'BR') run.pop();
        if (run.some((node) => node.textContent.trim() || node.nodeName === 'IMG')) {
          const box = doc.createElement('div');
          run[0].before(box);
          box.append(...run);
        }
        run = [];
      };
      for (const node of nodes) {
        if (node.nodeType === 1 && BLOCKS.has(node.localName)) flush();
        else if (node.nodeType === 1 || node.nodeType === 3) run.push(node);
      }
      flush();
    }
  }

  // A table used for layout, not data: marked presentational, or holding tables, headings,
  // or at most one filled cell per row. Tables with headers or a caption are data.
  function layoutTable(table) {
    const kind = role(table);
    if (kind === 'presentation' || kind === 'none') return true;
    const rows = [...table.rows];
    if (!rows.length) return false;
    const cells = rows.flatMap((row) => [...row.cells]);
    if (table.caption || table.tHead || cells.some((cell) => cell.localName === 'th')) return false;
    if (cells.some((cell) => cell.querySelector('table, h1, h2, h3, h4, h5, h6'))) return true;
    return rows.every((row) => [...row.cells].filter(filled).length <= 1);
  }
  // Layout tables become blocks: one per row, one per filled cell, in reading order.
  function layoutTables(root) {
    const doc = root.ownerDocument || root;
    for (const table of [...root.querySelectorAll('table')]) {
      if (!layoutTable(table)) continue;
      const box = doc.createElement('div');
      if (table.caption) {
        const caption = doc.createElement('p');
        caption.append(...table.caption.childNodes);
        box.append(caption);
      }
      for (const row of [...table.rows]) {
        const line = doc.createElement('div');
        for (const cell of [...row.cells]) {
          if (!filled(cell)) continue;
          const part = doc.createElement('div');
          part.append(...cell.childNodes);
          line.append(part);
        }
        if (line.childNodes.length) box.append(line);
      }
      table.replaceWith(box);
    }
  }

  const INLINE =
    'a, abbr, b, cite, code, del, em, font, i, ins, mark, q, s, small, span, strong, sub, sup, u';
  // An inline element holding only a space ("I<strong> </strong>was") becomes that space:
  // Defuddle removes empty elements, and the words would run together.
  function blankInlines(root) {
    const doc = root.ownerDocument || root;
    for (const element of root.querySelectorAll(INLINE))
      if (!element.firstElementChild && element.textContent && !element.textContent.trim())
        element.replaceWith(doc.createTextNode(element.textContent));
  }
  // A line break at the end (or start) of emphasis or a link goes after (before) it, so the
  // Markdown does not break the emphasis ("**Automated evals<br>**").
  function breaks(root) {
    const blank = (node) => node && node.nodeType === 3 && !node.data.trim();
    for (const br of root.querySelectorAll('br')) {
      for (let parent = br.parentElement; parent?.matches(INLINE); parent = br.parentElement) {
        let next = br.nextSibling,
          previous = br.previousSibling;
        while (blank(next)) next = next.nextSibling;
        while (blank(previous)) previous = previous.previousSibling;
        if (!next) parent.after(br);
        else if (!previous) parent.before(br);
        else break;
      }
    }
  }

  // Before extraction, on the document Defuddle reads.
  function prepare(doc) {
    const body = doc.body || doc;
    ariaTables(body);
    mixedCells(body);
    blankInlines(body);
  }
  // Markdown cannot put a table in a table's cell: a table inside a cell becomes lines, one
  // per row, its cells joined with " · ".
  function nestedTables(root) {
    const doc = root.ownerDocument || root;
    const inner = [...root.querySelectorAll('td table, th table')];
    // Innermost first, so each table holds plain lines when it is turned into lines.
    for (const table of inner.reverse()) {
      const box = doc.createElement('div');
      for (const row of [...table.rows]) {
        const line = doc.createElement('p');
        for (const cell of [...row.cells].filter(filled)) {
          if (line.childNodes.length) line.append(' · ');
          line.append(...cell.childNodes);
        }
        if (line.childNodes.length) box.append(line);
      }
      table.replaceWith(box);
    }
  }

  // On the extracted content, before it is cleaned.
  function normalize(root) {
    ariaTables(root);
    layoutTables(root);
    nestedTables(root);
    breaks(root);
  }

  // Coverage. Words of class names, ids and labels, split at punctuation and camelCase.
  // Generated parts (CSS-module hashes such as "NyXPlw" or "Z3bHXa") are skipped: they could
  // spell a word by chance.
  const generated = (part) =>
    /\d/.test(part) || (part.length <= 8 && /[A-Z]/.test(part.slice(1)) && /[a-z]/.test(part));
  function words(element, memo) {
    let found = memo.get(element);
    if (found) return found;
    found = new Set(
      [
        element.getAttribute('class'),
        element.id,
        element.getAttribute('aria-label'),
        element.getAttribute('data-testid'),
        element.getAttribute('data-component'),
        element.getAttribute('data-component-name'),
      ]
        .filter(Boolean)
        .join(' ')
        .split(/[\s_\-.:/]+/)
        .filter((part) => part && !generated(part))
        .flatMap((part) =>
          part
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .toLowerCase()
            .split(/[^a-z]+/),
        )
        .filter((word) => word.length >= 2),
    );
    memo.set(element, found);
    return found;
  }
  const NOISE_TAGS = new Set(
    'nav form button select option textarea input label dialog menu'.split(' '),
  );
  const NOISE_ROLES = new Set(
    (
      'navigation dialog alertdialog menu menubar menuitem toolbar search tablist tab button ' +
      'form status alert log marquee timer'
    ).split(' '),
  );
  const NOISE_WORDS = new Set(
    (
      'comment comments reply replies share sharing social related recommend recommended ' +
      'recommendations subscribe subscription signup cta promo promoted advert advertisement ' +
      'ad ads sponsor sponsored breadcrumb breadcrumbs pagination pager toc menu navbar nav ' +
      'navigation cookie cookies consent modal popup reaction reactions like likes vote votes ' +
      'follow tags tag skip ufi engagement toolbar paywall login signin register reflist ' +
      'refbegin footnote footnotes citation citations cite bibliography endnote endnotes ' +
      'infobox navbox'
    ).split(' '),
  );
  const NOISE_PHRASES =
    /sr-only|visually-hidden|screen-reader|table-of-contents|read-?next|more-?from|read-?time/;
  const WEAK_TAGS = new Set(['header', 'footer', 'aside']);
  const WEAK_ROLES = new Set(['banner', 'contentinfo', 'complementary']);
  const WEAK_WORDS = new Set(
    'header footer masthead hero sidebar meta byline dateline timestamp date'.split(' '),
  );
  const CARD_WORDS = new Set(
    'author authors bio biography contributor contributors guest acknowledgments acknowledgements writer'.split(
      ' ',
    ),
  );
  // Back matter extractors drop or rewrite (references, link lists), by its heading.
  const BACK_MATTER = new RegExp(
    '^(?:references?|notes?|footnotes?|citations?|sources?|bibliography|works cited|' +
      'further reading|external links|see also|related (?:articles|posts|reading|links)|' +
      '参考文献|参考资料|延伸阅读|扩展阅读|外部链接|相关链接|相关阅读|相关文章|注释|脚注|另见|参见)$',
    'i',
  );
  const CARD_TEXT =
    /^(?:a )?guest post by\b|^about the author\b|^written by\b|^(?:作者|嘉宾|关于作者)/i;
  const CONTENT_BLOCKS =
    'p,li,dt,dd,h1,h2,h3,h4,h5,h6,blockquote,pre,figcaption,caption,td,th,[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]';
  const COUNT = /^[\d\s.,:;%+#·•|/()\-–—kKmMwW万亿千]*$/;
  const SKIP = new Set(
    (
      'script style noscript template svg math button select option textarea input label ' +
      'object iframe video audio canvas'
    ).split(' '),
  );
  const squash = (text) =>
    String(text || '')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  // Navigation, forms, buttons, comments, sharing, recommendations, ads and the like.
  function noisy(element, memo) {
    const raw = `${element.getAttribute('class') || ''} ${element.id}`.toLowerCase();
    return (
      NOISE_TAGS.has(element.localName) ||
      NOISE_ROLES.has(role(element)) ||
      NOISE_PHRASES.test(raw) ||
      /(?:^|\s)ads?(?:[-_\s]|$)/.test(raw) ||
      [...words(element, memo)].some((word) => NOISE_WORDS.has(word))
    );
  }

  // What a text node of the page is: 'noise' (navigation, buttons, comments, link lists...),
  // 'minor' (a count or a short label on its own: not counted, but part of what it sits in),
  // 'card' (an author or guest card) or 'text'. memo caches per-element results.
  function kindOf(node, region, memo) {
    let strong = false,
      weak = null,
      header = false,
      card = null;
    const parent = node.parentElement;
    // Inside a table, "header" names its header row, not the page's header.
    const table = parent.closest('table, [role="table"], [role="grid"]');
    // The region's own names do not count ("newsletter-post" holds a Substack post).
    for (let element = parent; element && element !== region; element = element.parentElement) {
      const tag = element.localName,
        kind = role(element),
        names = words(element, memo.words);
      if (noisy(element, memo.words)) strong = true;
      if (tag === 'header' || kind === 'banner') header = true;
      if (
        !weak &&
        (WEAK_TAGS.has(tag) ||
          WEAK_ROLES.has(kind) ||
          (!(table && table.contains(element)) && [...names].some((word) => WEAK_WORDS.has(word))))
      )
        weak = element;
      if (!card && [...names].some((word) => CARD_WORDS.has(word))) card = element;
    }
    if (strong) return 'noise';
    const text = squash(node.data);
    if (!card) {
      // A card without telling names: "A guest post by", "About the author"...
      const block = parent.closest('p, div, li, td, th, section, article');
      if (block && region.contains(block)) {
        let start = memo.starts.get(block);
        if (start === undefined) {
          start = squash(block.textContent.slice(0, 200));
          memo.starts.set(block, start);
        }
        if (CARD_TEXT.test(start)) card = block;
      }
    }
    const block = parent.closest(CONTENT_BLOCKS);
    const cell = parent.closest(
      'td, th, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]',
    );
    // Link lists (more posts, tags, menus) are not the text; nor is a card that is one
    // ("More from this author").
    const links = (
      container = block || parent.closest('div, section, article, li, p') || parent,
    ) => {
      // Links in a table's cells are the table's content.
      if (cell && (cell.contains(container) || container.contains(cell))) return false;
      let share = memo.links.get(container);
      if (share === undefined) {
        const all = squash(container.textContent).length || 1;
        const linked = [...container.querySelectorAll('a')].reduce(
          (sum, link) => sum + squash(link.textContent).length,
          0,
        );
        share = linked / all;
        memo.links.set(container, share);
      }
      return share > 0.6;
    };
    // A card in a header, however deep, is the byline: metadata, kept in the front matter.
    // A card's own links (the author's name) are part of it: the share is the whole card's.
    if (card && !header && (!weak || weak.contains(card))) return links(card) ? 'noise' : 'card';
    if (weak) return 'noise';
    // A count or date on its own (a share count, a date line) is not text; one in a sentence
    // ("about <strong>4%</strong> lower") or in a table's cell is.
    if (!cell && COUNT.test(text)) {
      const host = block || parent.closest('div, section, article, li, p') || parent;
      let alone = memo.alone.get(host);
      if (alone === undefined) {
        alone = COUNT.test(squash(host.textContent));
        memo.alone.set(host, alone);
      }
      if (alone) return 'minor';
    }
    if (!block && text.length <= 20) return 'minor';
    return links() ? 'noise' : 'text';
  }

  // Compares the page's visible text with the extracted content. doc is the copy Defuddle
  // read (elements the page does not display are marked hidden), content the extracted
  // HTML. Returns { stats, patches, missing }: patches put missing passages back (see
  // restore); null when the page is too large to check or nothing was extracted.
  function coverage(doc, content, { title = '', maxNodes = 40000 } = {}) {
    const body = doc.body;
    if (!body) return null;
    const output = squash(
      new DOMParser().parseFromString(String(content || ''), 'text/html').body?.textContent,
    );
    const heading = squash(title);
    const nodes = [];
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1)
          return node.hasAttribute('hidden') || SKIP.has(node.localName)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP;
        return node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    // The extracted text keeps the page's order: a search goes on from the last match, then
    // back from it, so text not found costs one pass over the extracted text.
    const searcher = (haystack) => {
      let cursor = 0;
      return (needle) => {
        let at = haystack.indexOf(needle, cursor);
        if (at < 0 && cursor > 0) at = haystack.lastIndexOf(needle, cursor - 1);
        if (at >= cursor) cursor = at + needle.length;
        return at >= 0;
      };
    };
    // Longer text is searched now, to find the region; the rest only inside it, below.
    const exact = searcher(output);
    for (let node; (node = walker.nextNode());) {
      if (nodes.length >= maxNodes) return null;
      const text = squash(node.data);
      if (!text) continue;
      nodes.push({ node, text, found: text.length >= 20 ? exact(text) : null });
    }
    // The content region: the deepest element holding nearly all the extracted text the page
    // shows, widened to its article when that is not much larger.
    const counts = new Map();
    let matched = 0;
    for (const item of nodes) {
      if (!item.found || item.text.length < 20) continue;
      matched += item.text.length;
      for (let element = item.node.parentElement; element; element = element.parentElement)
        counts.set(element, (counts.get(element) || 0) + item.text.length);
    }
    if (!matched) return null;
    let region = body;
    for (;;) {
      const next = [...region.children].find((child) => (counts.get(child) || 0) >= matched * 0.95);
      if (!next) break;
      region = next;
    }
    const size = (element) =>
      nodes.reduce((sum, item) => sum + (element.contains(item.node) ? item.text.length : 0), 0);
    const article = region.parentElement?.closest('article, [role="article"]');
    if (article && article !== body && size(article) <= size(region) * 1.5 + 2000) region = article;

    // Inside the region, the rest is searched too. Extraction may change spacing ("team :)"
    // becomes "team:)"): longer text not found as it is is looked for again without spaces.
    const inside = searcher(output),
      tight = searcher(output.replace(/\s+/g, ''));
    for (const item of nodes) {
      if (item.found || !region.contains(item.node)) continue;
      item.found =
        (item.found === null && inside(item.text)) ||
        (item.text.length >= 20 && tight(item.text.replace(/\s+/g, ''))) ||
        (!!heading && heading.includes(item.text));
    }

    const memo = { words: new Map(), links: new Map(), starts: new Map(), alone: new Map() };
    // A section headed "References", "Further reading", "参考文献"... is back matter until a
    // heading of its level or above.
    let back = 0;
    const classified = nodes
      .filter((item) => region.contains(item.node))
      .map((item) => {
        const heading = item.node.parentElement.closest('h1, h2, h3, h4, h5, h6');
        if (heading && region.contains(heading)) {
          const level = Number(heading.localName[1]);
          if (BACK_MATTER.test(squash(heading.textContent).replace(/\s*\[[^\]]*\]$/, '')))
            back = back && back < level ? back : level;
          else if (back && level <= back) back = 0;
        }
        return { ...item, kind: back ? 'noise' : kindOf(item.node, region, memo) };
      });
    const items = classified.filter((item) => item.kind !== 'noise' && item.kind !== 'minor');
    const visible = items.reduce((sum, item) => sum + item.text.length, 0);
    const kept = items.reduce((sum, item) => sum + (item.found ? item.text.length : 0), 0);
    const missing = visible - kept;
    const ratio = visible ? kept / visible : 1;

    // Runs of consecutive missing text; each goes back after the kept text before it.
    const runs = [];
    let run = null;
    items.forEach((item, index) => {
      if (item.found) return void (run = null);
      if (!run) runs.push((run = { start: index, items: [] }));
      run.items.push(item);
    });
    const anchor = (from, step) => {
      let fallback = '';
      for (let i = from, seen = 0; i >= 0 && i < items.length && seen < 40; i += step, seen++) {
        if (!items[i].found) continue;
        if (items[i].text.length >= 15) return items[i].text;
        fallback ||= items[i].text;
      }
      return fallback;
    };
    // Each element's text, its missing part and its noise, to restore whole elements: an
    // element is copied only when all its text is missing and none of it is noise (a copy
    // would bring back the share buttons or link lists it holds). Counts and short labels
    // ('minor') do not stop it.
    const totals = new Map();
    for (const item of classified)
      for (let element = item.node.parentElement; element; element = element.parentElement) {
        const entry = totals.get(element) || { all: 0, gone: 0, noise: 0 };
        if (item.kind === 'noise') entry.noise += item.text.length;
        else if (item.kind !== 'minor') {
          entry.all += item.text.length;
          if (!item.found) entry.gone += item.text.length;
        }
        totals.set(element, entry);
        if (element === region) break;
      }
    const whole = (element) => {
      const entry = totals.get(element);
      return !!entry && entry.all > 0 && entry.all === entry.gone && !entry.noise;
    };
    const largest = Math.max(0, ...runs.map((r) => r.items.reduce((s, i) => s + i.text.length, 0)));
    const significant = (ratio < 0.95 && missing >= 150) || largest >= 300;
    // Most of the page missing suggests the wrong region rather than a lost passage.
    const suspicious = missing > Math.max(5000, kept);
    const patches = [];
    let budget = 512 * 1024;
    for (const r of runs) {
      const card = r.items.some((item) => item.kind === 'card');
      const after = anchor(r.start - 1, -1),
        before = anchor(r.start + r.items.length, 1);
      // Text missing between kept text is a loss. At the region's edges it is more often what
      // the extractor leaves out on purpose (summary boxes, reference and link sections).
      if (!card && !(significant && !suspicious && after && before)) continue;
      // Only whole elements are put back, links and emphasis included: an element that lost
      // part of its text was rewritten by the extractor (footnotes, citations), not dropped.
      const parts = [];
      const done = new Set();
      let chars = 0;
      for (const item of r.items) {
        let element = item.node.parentElement.closest(CONTENT_BLOCKS) || item.node.parentElement;
        if (!region.contains(element) || !whole(element)) continue;
        while (
          element.parentElement &&
          element.parentElement !== region &&
          region.contains(element.parentElement) &&
          whole(element.parentElement)
        )
          element = element.parentElement;
        if ([...done].some((other) => other.contains(element))) continue;
        done.add(element);
        chars += totals.get(element).all;
        const copy = element.cloneNode(true);
        const names = new Map();
        for (const drop of copy.querySelectorAll('*'))
          if (
            drop.hasAttribute('hidden') ||
            SKIP.has(drop.localName) ||
            /^(?:img|picture)$/.test(drop.localName) ||
            noisy(drop, names)
          )
            drop.remove();
        // Parts of a table stay in a table: alone, the parser would drop their row and cell tags.
        const tag = element.localName;
        parts.push(
          tag === 'td' || tag === 'th'
            ? `<p>${copy.innerHTML}</p>`
            : tag === 'tr'
              ? `<table><tbody>${copy.outerHTML}</tbody></table>`
              : /^(?:thead|tbody|tfoot)$/.test(tag)
                ? `<table>${copy.outerHTML}</table>`
                : copy.outerHTML,
        );
      }
      const html = parts.join('');
      if (chars < (card ? 30 : 40) || html.length > budget) continue;
      budget -= html.length;
      patches.push({ after, before, html, chars });
    }
    return {
      stats: {
        visibleChars: visible,
        keptChars: kept,
        ratio: Math.round(ratio * 1000) / 1000,
        incomplete: suspicious && missing > 0,
      },
      patches,
      // The start of each missing run, for diagnostics; not saved.
      missing: runs.map((r) =>
        r.items
          .map((item) => item.text)
          .join(' ')
          .slice(0, 160),
      ),
    };
  }

  // Puts missing passages back into the extracted content, after the kept text that came
  // before them on the page (else before the text after them, else at the end). Returns the
  // number of passages and characters put back.
  function restore(article, patches = []) {
    const doc = article.ownerDocument;
    let passages = 0,
      chars = 0;
    const texts = () => {
      const list = [];
      const walker = doc.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) list.push(node);
      return list;
    };
    const near = (node) => {
      let target = node.parentElement.closest(
        'p,h1,h2,h3,h4,h5,h6,li,dt,dd,pre,blockquote,figure,figcaption,table,ul,ol,dl,details,div,section',
      );
      if (!target || target === article || !article.contains(target)) {
        target = node;
        while (target.parentElement && target.parentElement !== article)
          target = target.parentElement;
        return target;
      }
      for (let element = target; element && element !== article; element = element.parentElement)
        if (/^(?:table|ul|ol|dl|figure|blockquote|pre|details)$/.test(element.localName))
          target = element;
      // A wrapper of many blocks: right after the text's own part of it.
      if (/^(?:div|section)$/.test(target.localName) && target.querySelector('p, h1, h2, h3, li')) {
        let part = node;
        while (part.parentElement !== target) part = part.parentElement;
        return part;
      }
      return target;
    };
    let last = null;
    const later = (node) =>
      !last || !!(last.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
    // The first match after the previous passage put back, else the first match.
    const find = (list, text) =>
      text &&
      (list.find((node) => later(node) && squash(node.data).includes(text)) ||
        list.find((node) => squash(node.data).includes(text)));
    for (const patch of patches) {
      const parsed = new DOMParser().parseFromString(String(patch.html || ''), 'text/html').body;
      const box = doc.createElement('div');
      box.append(...[...parsed.childNodes].map((node) => doc.importNode(node, true)));
      if (!box.textContent.trim()) continue;
      const list = texts();
      const after = find(list, patch.after);
      const before = !after && find(list, patch.before);
      if (after) near(after).after(box);
      else if (before) near(before).before(box);
      else article.append(box);
      last = box;
      passages++;
      chars += squash(box.textContent).length;
    }
    return { passages, chars };
  }

  globalThis.tabgentClipStructure = Object.freeze({
    displayed,
    prepare,
    normalize,
    coverage,
    restore,
  });
})();
