// Clipping: the main text of a page, read from its rendered DOM when the user clips it.
// The service worker injects this file on demand together with Defuddle, Turndown,
// DOMPurify (UMD) and sanitize-config.js; it is never loaded otherwise. Its results are
// untrusted (a compromised page can forge them) and are bounded again by the worker.
(() => {
  if (globalThis.tabgentClip) return;
  const { config, remote } = globalThis.tabgentClipSanitize;
  const t = (key, ...values) => chrome.i18n.getMessage(key, values.map(String)) || key;
  // UTF-8 bytes, as the vault counts them; reading_vault reads files up to 4 MiB.
  const LIMIT = { html: 4 * 1024 * 1024, markdown: 3 * 1024 * 1024, images: 200, excerpt: 1000 };
  const bytes = (text) => new TextEncoder().encode(text).length;
  const label = (value, limit = 500) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  // Defuddle's network fallbacks are off (useAsync: false); this makes sure nothing is fetched.
  const refuse = () => Promise.reject(Error('Clipping never fetches'));

  // X posts: a single post or an article can be clipped; timelines and profiles cannot.
  function xPage(url) {
    const { hostname, pathname } = new URL(url);
    if (!/^(?:www\.|mobile\.)?(?:x|twitter)\.com$/.test(hostname)) return null;
    return /^\/(?:[^/]+\/status\/\d+|(?:i|[^/]+)\/article\/\d+)/.test(pathname) ? 'post' : 'other';
  }
  function meta(name) {
    const element = document.querySelector(
      `meta[name="${name}"],meta[property="${name}"],meta[itemprop="${name}"]`,
    );
    return label(element?.getAttribute('content'));
  }

  // Defuddle normalizes some attributes in the document it is given, so it reads a copy:
  // the page the user is reading is never changed. A copy has no layout, so elements the
  // page does not display are marked hidden (Defuddle drops [hidden]) and images keep
  // their displayed size (tracking pixels are dropped by size).
  function snapshot() {
    const copy = document.cloneNode(true);
    const stack = [[document.body, copy.body]];
    while (stack.length) {
      const [live, twin] = stack.pop();
      if (!live || !twin) continue;
      for (let i = 0; i < live.children.length && i < twin.children.length; i++) {
        const element = live.children[i],
          other = twin.children[i];
        if (element.localName !== other.localName) continue;
        if (
          typeof element.checkVisibility === 'function' &&
          !element.checkVisibility() &&
          !element.closest('details:not([open])') &&
          element.localName !== 'math' &&
          !element.querySelector('math')
        ) {
          other.setAttribute('hidden', '');
          continue;
        }
        if (element.localName === 'img' && element.offsetWidth && !other.hasAttribute('width')) {
          other.setAttribute('width', String(element.offsetWidth));
          other.setAttribute('height', String(element.offsetHeight));
        }
        stack.push([element, other]);
      }
    }
    return copy;
  }

  // The live selection, when it still holds the quote the user chose to clip (if any).
  function selected(expected) {
    const selection = getSelection();
    const live = (selection?.toString() || '').replace(/\s+/g, ' ').trim();
    const want = String(expected || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!live || selection.isCollapsed) return false;
    return !want || live.includes(want.slice(0, 200)) || want.includes(live.slice(0, 200));
  }

  // { content (HTML), title, author, site, published, description, language, extractor }
  function extract(mode, url) {
    if (mode === 'selection') {
      const selection = getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) return null;
      const box = document.createElement('div');
      for (let i = 0; i < selection.rangeCount; i++) {
        const part = document.createElement('div');
        part.append(selection.getRangeAt(i).cloneContents());
        box.append(part);
      }
      return {
        content: box.innerHTML,
        title: document.title,
        author: meta('author') || meta('article:author'),
        site: meta('og:site_name'),
        published: meta('article:published_time') || meta('date'),
        description: '',
        language: document.documentElement.lang,
        extractor: 'selection',
      };
    }
    const result = new Defuddle(snapshot(), {
      url,
      useAsync: false,
      includeReplies: false,
      fetch: refuse,
      ...(mode === 'page' ? { contentSelector: 'body', removeLowScoring: false } : {}),
    }).parse();
    // Defuddle's extractorType is a minified class name in its bundle; name X by address.
    return { ...result, extractor: xPage(url) === 'post' ? 'x' : 'defuddle' };
  }

  // The largest srcset candidate up to 2048 pixels wide (or 2x), else the smallest above.
  function bestSource(srcset) {
    const candidates = String(srcset || '')
      .split(/,\s+/)
      .map((part) => /^(\S+)(?:\s+(\d+(?:\.\d+)?)([wx]))?$/.exec(part.trim()))
      .filter(Boolean)
      .map(([, url, size, unit]) => ({ url, size: Number(size || 1), unit: unit || 'x' }));
    if (!candidates.length) return '';
    const limit = (candidate) => (candidate.unit === 'w' ? 2048 : 2);
    const fitting = candidates.filter((c) => c.size <= limit(c)).sort((a, b) => b.size - a.size);
    return (fitting[0] || candidates.sort((a, b) => a.size - b.size)[0]).url;
  }
  function absolute(value, base) {
    if (!value || !String(value).trim()) return '';
    try {
      return new URL(value, base).href;
    } catch {
      return '';
    }
  }
  // Images keep their remote address as data (data-remote-src); nothing is loaded here.
  // Returns the distinct images in page order and the index of each address.
  function images(root, base) {
    const doc = root.ownerDocument;
    const found = [],
      index = new Map();
    for (const img of [...root.querySelectorAll('img')]) {
      const width = Number(img.getAttribute('width')),
        height = Number(img.getAttribute('height'));
      let url = absolute(
        img.getAttribute('data-remote-src') ||
          bestSource(img.getAttribute('srcset')) ||
          img.getAttribute('data-src') ||
          img.getAttribute('src') ||
          '',
        base,
      );
      const alt = label(img.getAttribute('alt'), 1000);
      if (remote(url)) {
        const parsed = new URL(url);
        if (parsed.hostname === 'pbs.twimg.com' && parsed.searchParams.has('name')) {
          parsed.searchParams.set('name', 'large');
          url = parsed.href;
        }
      }
      // Tracking pixels, inline data and unknown schemes are dropped; alt text stays.
      if (
        (width > 0 && width <= 2) ||
        (height > 0 && height <= 2) ||
        !remote(url) ||
        (!index.has(url) && found.length >= LIMIT.images)
      ) {
        img.replaceWith(alt ? doc.createTextNode(alt) : '');
        continue;
      }
      for (const name of [...img.getAttributeNames()])
        if (!['alt', 'title', 'width', 'height'].includes(name)) img.removeAttribute(name);
      img.setAttribute('data-remote-src', url);
      if (!index.has(url)) {
        index.set(url, found.length);
        found.push({ url, alt });
      }
    }
    return { found, index };
  }
  // Embedded media and frames become a link to their source; a video keeps its poster.
  function embeds(root, base) {
    const doc = root.ownerDocument;
    for (const element of [...root.querySelectorAll('iframe,video,audio,embed,object')]) {
      const source = absolute(
        element.getAttribute('src') ||
          element.querySelector('source[src]')?.getAttribute('src') ||
          element.getAttribute('data') ||
          '',
        base,
      );
      const box = doc.createElement('p');
      const poster = absolute(element.getAttribute('poster') || '', base);
      if (remote(poster)) {
        const img = doc.createElement('img');
        img.setAttribute('data-remote-src', poster);
        img.setAttribute('alt', label(element.getAttribute('title')));
        box.append(img, doc.createElement('br'));
      }
      if (remote(source)) {
        const link = doc.createElement('a');
        link.setAttribute('href', source);
        link.textContent = t('clipEmbedded', new URL(source).hostname);
        box.append(link);
      }
      element.replaceWith(box.childNodes.length ? box : '');
    }
  }
  // Code blocks keep their language in an attribute the sanitizer allows.
  function code(root) {
    for (const block of root.querySelectorAll('pre')) {
      const element = block.querySelector('code') || block;
      const language = (
        element.getAttribute('data-lang') ||
        /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(element.getAttribute('class') || '')?.[1] ||
        ''
      ).toLowerCase();
      if (/^[\w+#.-]{1,30}$/.test(language)) block.setAttribute('data-language', language);
    }
  }
  // Links are absolute web or mail addresses, or fragments within the page.
  function links(root, base) {
    const page = base.split('#')[0];
    for (const link of root.querySelectorAll('a[href]')) {
      const href = absolute(link.getAttribute('href'), base);
      if (href.split('#')[0] === page && href.includes('#'))
        link.setAttribute('href', href.slice(href.indexOf('#')));
      else if (/^(?:https?|mailto):/i.test(href)) link.setAttribute('href', href);
      else link.removeAttribute('href');
    }
  }

  // Images are written as placeholders named by a token the page cannot know; the worker
  // replaces each with its saved file or its web address.
  function converter(token, index) {
    const service = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
    });
    const destination = (url) => (/[\s()<>]/.test(url) ? `<${url.replace(/>/g, '%3E')}>` : url);
    service.addRule('tabgentImage', {
      filter: 'img',
      replacement(content, node) {
        const src = node.getAttribute('data-remote-src');
        const alt = (node.getAttribute('alt') || '').replace(/[[\]\\]/g, '\\$&');
        if (index.has(src)) return `![${alt}](tabgent-image-${token}-${index.get(src)})`;
        return src ? `![${alt}](${destination(src)})` : alt;
      },
    });
    service.addRule('fencedCode', {
      filter: (node) => node.nodeName === 'PRE',
      replacement(content, node) {
        const text = node.textContent.replace(/\n$/, '');
        const fence = '`'.repeat(
          Math.max(3, ...(text.match(/`{3,}/g) || []).map((m) => m.length + 1)),
        );
        return `\n\n${fence}${node.getAttribute('data-language') || ''}\n${text}\n${fence}\n\n`;
      },
    });
    service.addRule('strikethrough', {
      filter: ['del', 's', 'strike'],
      replacement: (content) => (content.trim() ? `~~${content}~~` : ''),
    });
    service.addRule('math', {
      filter: (node) => node.localName === 'math',
      replacement(content, node) {
        const latex = (
          node.getAttribute('data-latex') ||
          node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ||
          ''
        ).trim();
        if (!latex) return node.textContent;
        return node.getAttribute('display') === 'block' ? `\n\n$$\n${latex}\n$$\n\n` : `$${latex}$`;
      },
    });
    // GFM pipe tables for simple tables; tables with merged cells become lines of text.
    service.addRule('table', {
      filter: 'table',
      replacement(content, node) {
        const rows = [...node.rows];
        if (!rows.length) return '';
        const cell = (element) =>
          service
            .turndown(element.innerHTML)
            .replace(/\s*\n+\s*/g, ' ')
            .replace(/\|/g, '\\|')
            .trim();
        const caption = node.caption ? `*${cell(node.caption)}*\n\n` : '';
        const merged = rows.some((row) =>
          [...row.cells].some((c) => c.colSpan > 1 || c.rowSpan > 1 || c.querySelector('table')),
        );
        const values = rows.map((row) => [...row.cells].map(cell));
        if (merged)
          return `\n\n${caption}${values.map((row) => row.filter(Boolean).join(' · ')).join('\n\n')}\n\n`;
        const width = Math.max(...values.map((row) => row.length));
        const line = (row) =>
          `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`;
        const [head, ...body] = values;
        return `\n\n${caption}${[line(head), line(Array(width).fill('---')), ...body.map(line)].join('\n')}\n\n`;
      },
    });
    return service;
  }

  // The bytes the worker may add by putting web addresses in place of the placeholders,
  // counted for every occurrence of each image.
  function reserve(markdown, token, list) {
    let total = 0;
    for (const [, index] of markdown.matchAll(new RegExp(`tabgent-image-${token}-(\\d+)`, 'g')))
      total += (list[Number(index)]?.url.length || 0) + 4;
    return total;
  }
  // Cuts long Markdown at a paragraph break (else a line break) until it fits, never inside
  // a surrogate pair, closes a code fence the cut left open, and ends with a note. Every pass
  // makes the text shorter, so it ends even for a cap of zero or less.
  function cutMarkdown(markdown, cap) {
    cap = Math.max(0, Math.floor(Number(cap) || 0));
    let truncated = false;
    while (markdown && bytes(markdown) > cap) {
      const size = Math.max(
        0,
        Math.floor((markdown.length * (cap - Math.min(3072, cap / 4))) / bytes(markdown)),
      );
      let at = markdown.lastIndexOf('\n\n', size);
      if (at <= size / 2) at = markdown.lastIndexOf('\n', size);
      if (at <= size / 2) at = size;
      at = Math.min(at, markdown.length - 1);
      const code = markdown.charCodeAt(at - 1);
      if (at > 0 && code >= 0xd800 && code <= 0xdbff) at--;
      markdown = markdown.slice(0, Math.max(0, at));
      truncated = true;
    }
    if (!truncated) return { markdown, truncated };
    const fences = markdown.match(/^ {0,3}(`{3,}|~{3,})/gm) || [];
    if (fences.length % 2) markdown += `\n${/(`+|~+)/.exec(fences.at(-1))[1]}`;
    return { markdown: `${markdown}\n\n*${t('clipTruncated')}*`, truncated };
  }

  const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g;
  function count(text) {
    const cjk = (text.match(CJK) || []).length;
    const latin = (text.replace(CJK, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
    return {
      words: cjk + latin,
      chars: text.replace(/\s+/g, '').length,
      enough: cjk >= 100 || latin >= 40,
    };
  }
  // Removes trailing blocks until the HTML fits, then says so at the end.
  function fit(article) {
    if (bytes(article.innerHTML) <= LIMIT.html) return false;
    let box = article;
    while (box.children.length === 1 && box.firstElementChild.children.length > 1)
      box = box.firstElementChild;
    // Sizes are measured once per block, so a long page is cut in one pass.
    let size = bytes(article.innerHTML);
    while (box.lastChild && size > LIMIT.html - 4096) {
      const last = box.lastChild;
      size -= bytes(last.nodeType === 1 ? last.outerHTML : last.textContent);
      last.remove();
    }
    // Escaped text can serialize longer than estimated; check the real size.
    while (box.lastChild && bytes(article.innerHTML) > LIMIT.html - 1024) box.lastChild.remove();
    const note = article.ownerDocument.createElement('p');
    note.append(article.ownerDocument.createElement('em'));
    note.firstChild.textContent = t('clipTruncated');
    box.append(note);
    return true;
  }

  // Returns the clipped text, or { ok: false, reason } when there is nothing to clip.
  const address = (value) => String(value).split('#')[0];
  function run({ mode = 'article', url = location.href, expected = '' } = {}) {
    // A single-page app can change its address without a new document: the text would no
    // longer be the page the clip is saved under.
    if (address(url) !== address(location.href)) return { ok: false, reason: 'navigated' };
    if (mode !== 'selection' && xPage(url) === 'other') return { ok: false, reason: 'x-not-post' };
    if (mode === 'selection' && !selected(expected)) return { ok: false, reason: 'no-selection' };
    let found;
    try {
      found = extract(mode, url);
    } catch (error) {
      return { ok: false, reason: 'error', message: String(error?.message || error).slice(0, 300) };
    }
    if (!found) return { ok: false, reason: 'no-selection' };
    // An inert document: nothing in it loads or runs.
    const doc = new DOMParser().parseFromString(found.content || '', 'text/html');
    const article = doc.createElement('div');
    article.append(...doc.body.childNodes);
    doc.body.append(article);
    embeds(article, url);
    const { found: list, index } = images(article, url);
    const token = crypto.randomUUID().replace(/-/g, '');
    links(article, url);
    code(article);
    // In place on the wrapper: DOMPurify refuses a root it would remove, such as body.
    DOMPurify.sanitize(article, { ...config, IN_PLACE: true });
    for (const img of article.querySelectorAll('img[data-remote-src]'))
      if (!remote(img.getAttribute('data-remote-src'))) img.remove();
    let truncated = fit(article);
    let markdown = converter(token, index).turndown(article).trim();
    // Long text is cut until it fits, leaving room for the image addresses the worker may put
    // in place of the placeholders.
    // The room kept for addresses is bounded: one long address used many times (a signed
    // CDN link, or a hostile page) must not leave no room for the text.
    const room = Math.min(reserve(markdown, token, list), LIMIT.markdown / 2);
    const cut = cutMarkdown(markdown, LIMIT.markdown - 1024 - room);
    markdown = cut.markdown;
    truncated ||= cut.truncated;
    const { words, chars, enough } = count(article.textContent);
    const selection = getSelection();
    // Images the size limits cut away are not saved; their places keep their index.
    const shown = new Set(
      [...article.querySelectorAll('img[data-remote-src]')].map((img) =>
        img.getAttribute('data-remote-src'),
      ),
    );
    return {
      ok: true,
      mode,
      extractor: label(found.extractor, 60),
      title: label(found.title) || label(document.title),
      byline: label(found.author),
      siteName: label(found.site),
      publishedAt: label(found.published, 100),
      language: label(found.language || document.documentElement.lang, 35),
      direction: getComputedStyle(document.documentElement).direction === 'rtl' ? 'rtl' : 'ltr',
      excerpt: label(found.description, LIMIT.excerpt),
      html: article.innerHTML,
      markdown,
      images: list.map((image) => (shown.has(image.url) ? image : { ...image, url: '' })),
      imageToken: token,
      words,
      chars,
      truncated,
      // An X thread saves the posts loaded on the page, separated by rules.
      posts:
        found.extractor === 'x' && /\/status\/\d+/.test(new URL(url).pathname)
          ? article.querySelectorAll('hr').length + 1
          : 0,
      tooLittle: mode === 'article' && !enough,
      hasSelection: !!selection && !selection.isCollapsed && !!selection.toString().trim(),
    };
  }

  // A small prompt or status in a closed shadow root on a top-layer popover, like the
  // reading toolbar, so page CSS can neither restyle it nor hide it.
  let host, root, box, timer, pending;
  const styles = `
    .box { position: fixed; right: 16px; bottom: 16px; max-width: min(380px, calc(100vw - 32px));
      padding: 12px 14px; border-radius: 10px; background: #202124; color: #fff;
      font: 13px/1.45 system-ui, -apple-system, sans-serif; box-shadow: 0 6px 20px rgb(0 0 0 / 0.25),
      0 0 0 1px rgb(255 255 255 / 0.08); }
    .box[hidden] { display: none; }
    .box[data-tone='error'] { box-shadow: 0 6px 20px rgb(0 0 0 / 0.25), 0 0 0 1px #f28b82; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; justify-content: flex-end; }
    button { all: unset; box-sizing: border-box; padding: 6px 12px; border-radius: 7px; cursor: pointer;
      background: rgb(255 255 255 / 0.1); white-space: nowrap; }
    button.primary { background: #8ab4f8; color: #202124; font-weight: 600; }
    button:hover { filter: brightness(1.15); }
    button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }`;
  function ensure() {
    if (host?.isConnected) return;
    host = document.createElement('tabgent-clip');
    for (const [name, value] of [
      ['all', 'initial'],
      ['position', 'fixed'],
      ['inset', '0 auto auto 0'],
      ['width', '0'],
      ['height', '0'],
      ['z-index', '2147483647'],
    ])
      host.style.setProperty(name, value, 'important');
    host.popover = 'manual';
    root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(styles);
    root.adoptedStyleSheets = [sheet];
    box = document.createElement('div');
    box.className = 'box';
    box.setAttribute('role', 'status');
    box.hidden = true;
    box.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') settle('cancel');
    });
    root.append(box);
    document.documentElement.append(host);
  }
  function show(text, tone, actions = []) {
    ensure();
    clearTimeout(timer);
    box.replaceChildren(text);
    box.dataset.tone = tone || 'info';
    box.setAttribute('role', actions.length ? 'alertdialog' : 'status');
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'actions';
      for (const [value, name, primary] of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = name;
        if (primary) button.className = 'primary';
        button.addEventListener('click', () => choose(value));
        row.append(button);
      }
      box.append(row);
    }
    box.hidden = false;
    if (!host.matches(':popover-open')) host.showPopover();
    if (actions.length)
      (box.querySelector('button.primary') || box.querySelector('button'))?.focus({
        preventScroll: true,
      });
  }
  function hide() {
    if (!box) return;
    box.hidden = true;
    if (host.matches(':popover-open')) host.hidePopover();
  }
  // A prompt's answer, or a status line's action: the saved copy opens beside the page.
  function choose(value) {
    if (pending) return settle(value);
    hide();
    if (value === 'open') void chrome.runtime.sendMessage({ type: 'clipOpen' }).catch(() => {});
  }
  function settle(value) {
    const done = pending;
    pending = null;
    hide();
    done?.(value);
  }
  // Asks the user and resolves with the chosen action; a minute without an answer cancels.
  function ask({ kind, clippedAt, hasSelection } = {}) {
    settle('cancel');
    return new Promise((resolve) => {
      // A single-page app that moves to another address cancels the prompt.
      const at = address(location.href);
      const moved = () => {
        if (address(location.href) !== at) settle('cancel');
      };
      const stop = new AbortController();
      globalThis.navigation?.addEventListener('currententrychange', moved, { signal: stop.signal });
      addEventListener('popstate', moved, { signal: stop.signal });
      pending = (value) => {
        stop.abort();
        resolve(value);
      };
      if (kind === 'replace') {
        const when = new Date(clippedAt);
        const date = Number.isNaN(when.getTime())
          ? ''
          : new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }).format(when);
        show(date ? t('clipReplaceAsk', date) : t('clipReplaceIncomplete'), 'info', [
          ['cancel', t('clipCancel')],
          ['replace', t('clipReplace'), true],
        ]);
      } else {
        show(t('clipTooLittle'), 'info', [
          ['cancel', t('clipCancel')],
          ...(hasSelection ? [['selection', t('clipSelection')]] : []),
          ['page', t('clipWholePage'), true],
        ]);
      }
      timer = setTimeout(() => settle('cancel'), 60000);
    });
  }
  // A status line: progress stays until the next one; results hide after a few seconds.
  function notify({ text, tone = 'info', busy = false, open = false } = {}) {
    if (pending) return;
    show(String(text || '').slice(0, 1000), tone, open ? [['open', t('clipOpen'), true]] : []);
    if (!busy) timer = setTimeout(hide, open ? 12000 : tone === 'error' ? 10000 : 7000);
  }
  // cutMarkdown is exposed for tests; the worker calls run, ask and notify.
  globalThis.tabgentClip = { run, ask, notify, cutMarkdown };
})();
