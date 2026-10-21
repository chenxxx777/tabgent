// Clipping: the main text of a page, read from its rendered DOM when the user clips it.
// The service worker injects this file on demand together with Defuddle, Turndown,
// DOMPurify (UMD), sanitize-config.js and clip-structure.js; it is never loaded otherwise.
// Its results are untrusted (a compromised page can forge them) and are bounded again by
// the worker.
(() => {
  if (globalThis.tabgentClip) return;
  const { config, remote } = globalThis.tabgentClipSanitize;
  const structure = globalThis.tabgentClipStructure;
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
  // The id of the post an X address names (/<handle>/status/<id>), or ''.
  function xStatus(url) {
    if (xPage(url) !== 'post') return '';
    return /^\/[^/]+\/status\/(\d+)/.exec(new URL(url).pathname)?.[1] || '';
  }
  // A short title for a post: who wrote it and how it starts, never the whole post. The start
  // is cut at 80 characters (graphemes, so no emoji or accent is split). Only a cut inside a
  // word of a space-separated script moves back to the space before that word, and by at
  // most 20 characters: Chinese and Japanese text, which has no spaces between words, is cut
  // by characters even when a space appears early.
  const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const wordChar = (c) => /[\p{L}\p{N}\p{M}]/u.test(c || '') && !unspaced.test(c || '');
  function xTitle(name, text) {
    const chars = [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(label(text, 4000)),
    ].map((part) => part.segment);
    let start = chars.join('');
    if (chars.length > 80) {
      let cut = 80;
      if (wordChar(chars[cut - 1]) && wordChar(chars[cut])) {
        let back = cut;
        while (back > cut - 20 && !/\s/.test(chars[back - 1])) back--;
        if (back > cut - 20) cut = back;
      }
      start = `${chars.slice(0, cut).join('').trimEnd()}…`;
    }
    return label(start ? `${name || 'Post'} on X: "${start}"` : `${name || 'Post'} on X`);
  }
  const escapeHtml = (value) =>
    String(value).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );
  // X shows visitors who are not logged in another layout, without data-testid: the
  // conversation is a list of plain <article>s. The post at the address and its author's
  // consecutive replies are kept, each once; other people's replies, counts, buttons and
  // the page's screen-reader heading (the whole post again) are not. null for other layouts.
  function xVisitorPost(url, id) {
    const list = document.querySelector(`[id^="urt:conversation:${id}:"]`);
    if (!list) return null;
    const posts = [...list.querySelectorAll('article')].filter(
      (article) => !article.parentElement?.closest('article'),
    );
    // Parts of a quoted post inside an article are not the article's own.
    const own = (article, node) => {
      const quote = node.closest('[role="link"]');
      return !quote || !article.contains(quote);
    };
    const handleOf = (article) => {
      for (const link of article.querySelectorAll('a[href^="/"]')) {
        const text = link.textContent.trim();
        if (/^@\w{1,15}$/.test(text) && own(article, link) && !link.closest('[dir="auto"]'))
          return text;
      }
      return '';
    };
    const status = new RegExp(`^/\\w{1,15}/status/${id}$`);
    const main = posts.findIndex((article) =>
      [...article.querySelectorAll('a[href]')].some(
        (link) => own(article, link) && status.test(link.getAttribute('href') || ''),
      ),
    );
    if (main < 0) return null;
    const handle = handleOf(posts[main]);
    const thread = [posts[main]];
    for (const article of posts.slice(main + 1)) {
      if (!handle || handleOf(article) !== handle) break;
      thread.push(article);
    }
    const name = handle
      ? [...posts[main].querySelectorAll(`a[href="/${handle.slice(1)}"]`)]
          .map((link) => link.textContent.trim())
          .find((text) => text && !text.startsWith('@')) || ''
      : '';
    // The text as paragraphs: links stay links, emoji images become their text, buttons
    // ("Show more", "Show translation") go.
    const text = (article) => {
      const element = [...article.querySelectorAll('[dir="auto"]')].find((node) =>
        own(article, node),
      );
      if (!element) return { html: '', plain: '' };
      const parts = [];
      (function walk(node) {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) parts.push(escapeHtml(child.data));
          else if (child.nodeType !== 1 || child.localName === 'button') continue;
          else if (child.localName === 'br') parts.push('\n');
          else if (child.localName === 'img')
            parts.push(escapeHtml(child.getAttribute('alt') || ''));
          else if (child.localName === 'a' && child.getAttribute('href'))
            parts.push(
              `<a href="${escapeHtml(child.getAttribute('href'))}">${escapeHtml(child.textContent)}</a>`,
            );
          else walk(child);
        }
      })(element);
      const html = parts
        .join('')
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
        .join('\n');
      return { html, plain: element.textContent };
    };
    // Photos and video posters of the post itself (not of a quoted post or an avatar).
    const media = (article) =>
      [
        ...article.querySelectorAll(
          'img[src*="pbs.twimg.com/media/"], img[src*="pbs.twimg.com/ext_tw_video_thumb/"], img[src*="pbs.twimg.com/amplify_video_thumb/"], img[src*="pbs.twimg.com/tweet_video_thumb/"]',
        ),
      ]
        .filter((img) => own(article, img))
        .map(
          (img) =>
            `<p><img src="${escapeHtml(img.getAttribute('src'))}" alt="${escapeHtml(img.getAttribute('alt') || '')}"></p>`,
        )
        .join('\n');
    const texts = thread.map(text);
    return {
      content: thread
        .map((article, index) => [texts[index].html, media(article)].filter(Boolean).join('\n'))
        .join('\n<hr>\n'),
      title: xTitle(name || handle, texts[0].plain),
      author: name && handle ? `${name} (${handle})` : name || handle,
      site: 'X',
      published: '',
      description: texts[0].plain,
      language: document.documentElement.lang,
      extractor: 'x',
    };
  }
  function meta(name) {
    const element = document.querySelector(
      `meta[name="${name}"],meta[property="${name}"],meta[itemprop="${name}"]`,
    );
    return label(element?.getAttribute('content'));
  }

  // Author, date and cover where Defuddle does not find them. Defuddle reads meta tags,
  // JSON-LD, <time> elements and English bylines ('metadata'); after it come a date or an
  // author line next to the title ('title-line'), and the layouts of a few sites
  // ('site:<host>'). Each value records its source. A date keeps the site's own time zone: a
  // date alone stays a date, and WeChat's publish time, a Unix time, is written in China
  // time, as WeChat shows it.
  const SITES = {
    'tech.meituan.com': {
      author: ['.vp-post-meta .vp-post-department'],
      published: '.vp-post-meta .vp-post-date',
      cover: '.vp-post-header .vp-post-cover img',
    },
    'mp.weixin.qq.com': {
      // The article's author, else the account that published it.
      author: ['#js_author_name_text', '#js_author_name', '#js_name'],
      cover: '',
      wechat: true,
    },
  };
  // 2026-08-07, 2026/8/7, 2026.08.07 or 2026年8月7日 as a date: YYYY-MM-DD.
  function dateText(text) {
    const match = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?!\d)/.exec(text || '');
    if (!match) return '';
    const [year, month, day] = match.slice(1).map(Number);
    if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return '';
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  // A Unix time as China time, with its offset: 2026-10-18T21:00:00+08:00.
  const chinaTime = (seconds) =>
    new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 19) + '+08:00';
  // Defuddle writes a date it read as text ("March 5, 2026") as midnight UTC in this exact
  // form; that is a date, not an instant. Times a page states (2026-03-05T00:00:00Z) stay.
  const dateOnly = (value) =>
    String(value || '').replace(/^(\d{4}-\d{2}-\d{2})T00:00:00\+00:00$/, '$1');
  // The few blocks before and after the page's first heading: its meta line.
  function titleLine(doc) {
    const h1 = doc.querySelector('h1');
    if (!h1) return [];
    const blocks = [];
    for (let el = h1.nextElementSibling, i = 0; el && i < 3; el = el.nextElementSibling, i++)
      blocks.push(el);
    for (
      let el = h1.previousElementSibling, i = 0;
      el && i < 2;
      el = el.previousElementSibling, i++
    )
      blocks.push(el);
    // Innermost elements first: "作者：…" is read from its own span, not with the date
    // next to it.
    const all = blocks.flatMap((block) => [block, ...block.querySelectorAll('*')].slice(0, 200));
    return [
      ...all.filter((el) => !el.childElementCount),
      ...all.filter((el) => el.childElementCount),
    ];
  }
  const hint = (el) => `${el.id || ''} ${el.getAttribute('class') || ''}`;
  const short = (el, limit) => {
    const text = label(el?.textContent || '');
    return text.length <= limit ? text : '';
  };
  function pageDetails(doc, url, found) {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {}
    const site = SITES[host];
    const sources = {};
    const pick = (key, candidates) => {
      for (const [value, source] of candidates) {
        const text = label(typeof value === 'function' ? value() : value);
        if (text) {
          sources[key] = source;
          return text;
        }
      }
      return '';
    };
    const wechat = { seconds: 0, cover: '' };
    if (site?.wechat)
      for (const script of [...doc.querySelectorAll('script:not([src])')].slice(0, 300)) {
        const text = script.textContent;
        wechat.seconds ||= Number(
          /\b(?:create_time|ct)\s*=\s*["'](\d{9,11})["']/.exec(text)?.[1] || 0,
        );
        wechat.cover ||= /\bmsg_cdn_url\s*=\s*["']([^"']+)["']/.exec(text)?.[1] || '';
        if (wechat.seconds && wechat.cover) break;
      }
    const line = titleLine(doc);
    const siteSource = `site:${host}`;
    const author = pick('author', [
      [found.author, 'metadata'],
      [
        () => site?.author?.map((selector) => short(doc.querySelector(selector), 80)).find(Boolean),
        siteSource,
      ],
      [
        () =>
          line
            .map((el) => /^(?:作者|文|撰文|By)\s*[:：|｜/]\s*(.{1,60})$/i.exec(short(el, 70))?.[1])
            .find(Boolean),
        'title-line',
      ],
    ]);
    const published = pick('publishedAt', [
      [dateOnly(found.published), 'metadata'],
      [() => wechat.seconds && chinaTime(wechat.seconds), siteSource],
      [() => site?.published && dateText(short(doc.querySelector(site.published), 60)), siteSource],
      [
        () =>
          line
            .filter((el) => /date|time|publish/i.test(hint(el)))
            .map((el) => dateText(short(el, 60)))
            .find(Boolean),
        'title-line',
      ],
    ]);
    if (found.site) sources.siteName = 'metadata';
    const image = (value) => {
      const address = absolute(value, url);
      return remote(address) ? address : '';
    };
    const cover = pick('cover', [
      [image(found.image), 'metadata'],
      [() => image(doc.querySelector('link[rel="image_src"]')?.getAttribute('href')), 'metadata'],
      [
        () => {
          const img = site?.cover && doc.querySelector(site.cover);
          return img && image(img.getAttribute('data-src') || img.getAttribute('src'));
        },
        siteSource,
      ],
      [() => image(wechat.cover), siteSource],
    ]);
    return { author, published, cover, sources };
  }

  // Defuddle normalizes some attributes in the document it is given, so it reads a copy:
  // the page the user is reading is never changed. A copy has no layout, so elements the
  // page does not display are marked hidden (Defuddle drops [hidden]) and images keep
  // their displayed size (tracking pixels are dropped by size). An element with
  // display: contents is displayed: it has no box of its own, but its children are drawn.
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
          !structure.displayed(element) &&
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
    // An X post: the logged-in layout is Defuddle's X extractor's; the visitors' layout is
    // read here. Any other layout is refused: generic extraction would mix other people's
    // replies into the post.
    const status = mode === 'article' ? xStatus(url) : '';
    const loggedIn = !!document.querySelector('article[data-testid="tweet"]');
    if (status && !loggedIn) return xVisitorPost(url, status) || { unknownX: true };
    const copy = snapshot();
    // Structure Defuddle would lose: ARIA tables become real tables; loose text in table
    // cells and spaces in otherwise empty inline elements are kept.
    structure.prepare(copy);
    const result = new Defuddle(copy, {
      url,
      useAsync: false,
      includeReplies: false,
      fetch: refuse,
      ...(mode === 'page' ? { contentSelector: 'body', removeLowScoring: false } : {}),
    }).parse();
    if (status) {
      const name = document
        .querySelector('article[data-testid="tweet"] [data-testid="User-Name"] a')
        ?.textContent.trim();
      return {
        ...result,
        title: xTitle(name || result.author, result.description),
        extractor: 'x',
      };
    }
    // The text the page shows in its content region against the text extracted from it.
    // (X posts are read above; Defuddle's site extractors, such as Substack's, read the
    // page's DOM too.) A check that fails leaves the clip as extracted.
    let coverage = null;
    if (xPage(url) !== 'post')
      try {
        coverage = structure.coverage(copy, result.content, {
          title: result.title || document.title,
        });
      } catch {}
    // Defuddle's extractorType is a minified class name in its bundle; name X by address.
    return {
      ...result,
      coverage,
      extractor: mode === 'article' && xPage(url) === 'post' ? 'x' : 'defuddle',
    };
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
      // An inline element holding only a space ("I<strong> </strong>was") keeps the space.
      blankReplacement: (content, node) =>
        node.isBlock ? '\n\n' : /\s/.test(node.textContent || '') ? ' ' : '',
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
    // A figure of images keeps its caption beside them: on the next line (or the line before,
    // where the page puts the caption first), in italics, with no blank line between. Other
    // figures (a quote, a list) keep the caption as its own paragraph: a line right after a
    // quote would join it.
    const pictures = (el) =>
      el.localName === 'img' ||
      (!el.textContent.trim() &&
        !!el.querySelector('img') &&
        !el.querySelector('table, pre, ul, ol, blockquote'));
    service.addRule('figure', {
      filter: (node) =>
        node.localName === 'figure' &&
        !!node.querySelector(':scope > figcaption') &&
        !!node.querySelector('img') &&
        [...node.childNodes].every(
          (child) =>
            (child.nodeType === 3 && !child.data.trim()) ||
            (child.nodeType === 1 && (child.localName === 'figcaption' || pictures(child))),
        ),
      replacement(content, node) {
        const lines = [];
        for (const child of node.children) {
          const caption = child.localName === 'figcaption';
          const text = service
            .turndown(caption ? child.innerHTML : child.outerHTML)
            .replace(/\s*\n+\s*/g, ' ')
            .trim();
          if (text) lines.push(caption && !/[*_]/.test(text) ? `*${text}*` : text);
        }
        return lines.length ? `\n\n${lines.join('\n')}\n\n` : '';
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
    // GFM pipe tables for simple tables (lines within a cell are joined with <br>); tables
    // with merged cells become lines of text.
    service.addRule('table', {
      filter: 'table',
      replacement(content, node) {
        const rows = [...node.rows];
        if (!rows.length) return '';
        const merged = rows.some((row) =>
          [...row.cells].some((c) => c.colSpan > 1 || c.rowSpan > 1 || c.querySelector('table')),
        );
        const cell = (element) =>
          service
            .turndown(element.innerHTML)
            .split(/\n+/)
            .map((line) => line.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join(merged ? ' ' : ' <br> ')
            .replace(/\|/g, '\\|');
        const caption = node.caption ? `*${cell(node.caption)}*\n\n` : '';
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
  // player: a YouTube video's player data, which the worker reads in the page's own world.
  const address = (value) => String(value).split('#')[0];
  async function run({ mode = 'article', url = location.href, expected = '', player = null } = {}) {
    // A single-page app can change its address without a new document: the text would no
    // longer be the page the clip is saved under.
    if (address(url) !== address(location.href)) return { ok: false, reason: 'navigated' };
    if (mode !== 'selection' && xPage(url) === 'other') return { ok: false, reason: 'x-not-post' };
    if (mode === 'selection' && !selected(expected)) return { ok: false, reason: 'no-selection' };
    const media = globalThis.tabgentClipMedia;
    let found;
    try {
      // A YouTube video: its description and captions, saved as a transcript.
      if (mode !== 'selection' && media) found = await media.youtube(url, player);
      found ||= extract(mode, url);
    } catch (error) {
      return { ok: false, reason: 'error', message: String(error?.message || error).slice(0, 300) };
    }
    // Not for X posts: their author is the post's, and the page's image is no cover. A page
    // these rules cannot read is clipped with Defuddle's metadata alone. A YouTube video has
    // its own from the player.
    if (found && !found.unknownX && found.extractor !== 'x' && found.extractor !== 'youtube') {
      try {
        const { author, published, cover, sources } = pageDetails(document, url, found);
        // A selection is a quote: it has the page's author and date, not a cover.
        if (mode === 'selection') delete sources.cover;
        found = { ...found, author, published, cover: mode === 'selection' ? '' : cover, sources };
      } catch {}
    }
    if (!found) return { ok: false, reason: 'no-selection' };
    if (found.unknownX) return { ok: false, reason: 'x-layout' };
    // A podcast episode: its transcript when the page has one, else only its show notes.
    if (mode !== 'selection' && media && found.extractor === 'defuddle')
      found = await media.podcast(document, url, found).catch(() => found);
    // A video or podcast clip is its notes and a transcript from captions, the page or a
    // linked page, not the page's text alone: the coverage check does not apply (putting a
    // passage back could repeat the transcript).
    if (found.transcript) found = { ...found, coverage: null };
    // Captions and transcripts are requested over the network: the page may have moved on.
    if (address(url) !== address(location.href)) return { ok: false, reason: 'navigated' };
    const selection = getSelection();
    return finish(found, url, {
      mode,
      fallbackTitle: document.title,
      language: document.documentElement.lang,
      direction: getComputedStyle(document.documentElement).direction,
      hasSelection: !!selection && !selection.isCollapsed && !!selection.toString().trim(),
    });
  }

  // Cleans extracted content the same way for every source: frames and media become links,
  // images keep only their address, DOMPurify keeps the allowlist, and Turndown writes the
  // Markdown, both within the vault's limits.
  function finish(
    found,
    url,
    { mode, fallbackTitle = '', language = '', direction = 'ltr', hasSelection = false },
  ) {
    // An inert document: nothing in it loads or runs.
    const doc = new DOMParser().parseFromString(found.content || '', 'text/html');
    const article = doc.createElement('div');
    article.append(...doc.body.childNodes);
    doc.body.append(article);
    // Passages the coverage check found missing go back first, and are cleaned like the rest.
    const restored = structure.restore(article, found.coverage?.patches);
    structure.normalize(article);
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
    // Images the size limits cut away are not saved; their places keep their index.
    const shown = new Set(
      [...article.querySelectorAll('img[data-remote-src]')].map((img) =>
        img.getAttribute('data-remote-src'),
      ),
    );
    let posts = 0;
    try {
      // An X thread saves the posts loaded on the page, separated by rules.
      if (found.extractor === 'x' && /\/status\/\d+/.test(new URL(url).pathname))
        posts = article.querySelectorAll('hr').length + 1;
    } catch {}
    // Links and a few words around them, no image: an embedded video or player, or a page
    // whose text did not load. It is saved, but not as a clip of the page's text. A
    // selection is what the user chose, and an X post's words are the post.
    const unlinked = article.cloneNode(true);
    for (const link of unlinked.querySelectorAll('a')) link.remove();
    const linksOnly =
      mode !== 'selection' &&
      found.extractor !== 'x' &&
      !shown.size &&
      !!article.querySelector('a[href]') &&
      count(unlinked.textContent).words <= 12;
    const sources = {};
    for (const key of ['author', 'publishedAt', 'siteName', 'cover'])
      if (/^[a-z][a-z0-9.:-]{0,59}$/.test(found.sources?.[key] || ''))
        sources[key] = found.sources[key];
    const cover = remote(found.cover) ? found.cover : '';
    if (!cover) delete sources.cover;
    // A video's or podcast's transcript: saved (with its language and kind), or why not.
    const one = (value, list) => (list.includes(value) ? value : '');
    const transcript =
      found.transcript && typeof found.transcript === 'object'
        ? {
            status: one(found.transcript.status, ['saved', 'unavailable']) || 'unavailable',
            reason: one(found.transcript.reason, ['login', 'none', 'empty', 'unplayable']),
            language: label(found.transcript.language, 35),
            kind: one(found.transcript.kind, ['manual', 'auto']),
            name: label(found.transcript.name, 200),
            source: one(found.transcript.source, ['captions', 'player', 'panel', 'page', 'link']),
          }
        : null;
    return {
      ok: true,
      mode,
      extractor: label(found.extractor, 60),
      title: label(found.title) || label(fallbackTitle),
      byline: label(found.author),
      siteName: label(found.site),
      publishedAt: label(found.published, 100),
      language: label(found.language || language, 35),
      direction: direction === 'rtl' ? 'rtl' : 'ltr',
      excerpt: label(found.description, LIMIT.excerpt),
      html: article.innerHTML,
      markdown,
      images: list.map((image) => (shown.has(image.url) ? image : { ...image, url: '' })),
      imageToken: token,
      words,
      chars,
      truncated,
      posts,
      cover,
      metaSources: sources,
      // notesOnly: a video's description or a podcast's show notes, without a transcript.
      // The page's own word that it has notes without a transcript comes first.
      contentStatus:
        found.contentStatus === 'notesOnly' ? 'notesOnly' : linksOnly ? 'linksOnly' : 'text',
      transcript,
      // How much of the text the page showed the clip kept, and what was put back.
      coverage: found.coverage
        ? {
            ...found.coverage.stats,
            restoredPassages: restored.passages,
            restoredChars: restored.chars,
          }
        : null,
      // A short post is still the whole post, and a video's page has nothing more: no "save
      // whole page" offer for X or YouTube.
      tooLittle: mode === 'article' && !enough && !['x', 'youtube'].includes(found.extractor),
      hasSelection,
    };
  }

  // Content from elsewhere, for Tabgent's reader: a feed item's own HTML (kind 'feed'), or
  // a page fetched without running it (kind 'page'), whose main text Defuddle finds. Both
  // are untrusted and parsed into inert documents.
  function clean({
    kind = 'feed',
    html = '',
    url = '',
    title = '',
    byline = '',
    siteName = '',
    publishedAt = '',
    language = '',
  } = {}) {
    try {
      if (kind === 'page') {
        const doc = new DOMParser().parseFromString(String(html), 'text/html');
        structure.prepare(doc);
        const result = new Defuddle(doc, {
          url,
          useAsync: false,
          includeReplies: false,
          fetch: refuse,
        }).parse();
        return finish({ ...result, extractor: 'defuddle' }, url, {
          mode: 'article',
          fallbackTitle: title,
          language: doc.documentElement.lang,
        });
      }
      return finish(
        {
          content: String(html),
          title,
          author: byline,
          site: siteName,
          published: publishedAt,
          language,
          extractor: 'feed',
        },
        url,
        { mode: 'article', fallbackTitle: title, language },
      );
    } catch (error) {
      return { ok: false, reason: 'error', message: String(error?.message || error).slice(0, 300) };
    }
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
    .box[data-tone='warning'] { box-shadow: 0 6px 20px rgb(0 0 0 / 0.25), 0 0 0 1px #fdd663; }
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
  // A prompt (ask) takes focus until it is answered; a status with an action does not, so
  // typing and the page's own shortcuts keep working.
  function show(text, tone, actions = [], prompt = actions.length > 0) {
    ensure();
    clearTimeout(timer);
    box.replaceChildren(text);
    box.dataset.tone = tone || 'info';
    box.setAttribute('role', prompt ? 'alertdialog' : 'status');
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
    if (prompt)
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
    show(
      String(text || '').slice(0, 1000),
      tone,
      open ? [['open', t('clipOpen'), true]] : [],
      false,
    );
    if (!busy) timer = setTimeout(hide, open ? 12000 : tone === 'error' ? 10000 : 7000);
  }
  // cutMarkdown and xTitle are exposed for tests; the worker calls run, ask and notify.
  globalThis.tabgentClip = { run, ask, notify, cutMarkdown, clean, xTitle };
})();
