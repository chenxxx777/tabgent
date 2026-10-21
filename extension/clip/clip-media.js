// Transcripts for clipping: a YouTube video's captions and a podcast page's transcript. They
// are read only when the user clips the page, in the user's own browser session, with
// requests to the page's own site, as the page makes them. Nothing logs in, nothing passes a
// sign-in or bot check, and audio is never transcribed: when no text is available, the clip
// says so. Injected with clip-content.js; every value from the page (the player's data,
// caption files, transcript pages) is untrusted and bounded.
(() => {
  if (globalThis.tabgentClipMedia) return;
  const t = (key, ...values) => chrome.i18n.getMessage(key, values.map(String)) || key;
  const LIMIT = {
    cues: 30000,
    text: 2 * 1024 * 1024,
    file: 8 * 1024 * 1024,
    description: 100000,
    timeout: 15000,
  };
  const escapeHtml = (value) =>
    String(value).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
    );
  const label = (value, limit = 500) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';

  // The id of the video a YouTube address shows (watch, shorts or live), or ''. The same
  // rule as youtubeVideoId in youtube-player.js, which the worker uses.
  function youtubeId(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return '';
    }
    if (parsed.protocol !== 'https:' || !/^(?:www\.|m\.)?youtube\.com$/.test(parsed.hostname))
      return '';
    const id =
      parsed.pathname === '/watch'
        ? parsed.searchParams.get('v')
        : /^\/(?:shorts|live)\/([\w-]{11})(?:\/|$)/.exec(parsed.pathname)?.[1];
    return /^[\w-]{11}$/.test(id || '') ? id : '';
  }

  // 1:02:03 or 12:34 as seconds.
  const seconds = (stamp) =>
    String(stamp)
      .split(':')
      .reduce((total, part) => total * 60 + Number(part), 0);
  function clock(value) {
    const whole = Math.max(0, Math.floor(value));
    const h = Math.floor(whole / 3600),
      m = Math.floor((whole % 3600) / 60),
      s = whole % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
  }

  // Text that came as HTML entities or markup (caption files often escape twice) as plain
  // text. An inert document: nothing in it loads or runs.
  function decode(value) {
    let text = String(value);
    for (let pass = 0; pass < 2 && /[&<]/.test(text); pass++)
      text = new DOMParser().parseFromString(text, 'text/html').documentElement.textContent;
    return text;
  }

  // Caption files as cues { start, end, text } in seconds: YouTube's json3, its XML formats
  // (srv1 <text start dur>, srv3 <p t d>) and WebVTT.
  function parseCaptions(raw) {
    const source = String(raw || '').trim();
    const cues = [];
    let size = 0;
    const add = (start, end, text) => {
      const clean = decode(text).replace(/\s+/g, ' ').trim();
      if (!clean || !Number.isFinite(start) || cues.length >= LIMIT.cues) return;
      size += clean.length;
      if (size > LIMIT.text) return;
      cues.push({ start, end: Number.isFinite(end) && end > start ? end : start, text: clean });
    };
    if (source.startsWith('{')) {
      let data;
      try {
        data = JSON.parse(source);
      } catch {
        return [];
      }
      for (const event of Array.isArray(data?.events) ? data.events : []) {
        if (cues.length >= LIMIT.cues) break;
        const segs = Array.isArray(event?.segs) ? event.segs : [];
        const start = Number(event?.tStartMs) / 1000;
        add(
          start,
          start + (Number(event?.dDurationMs) || 0) / 1000,
          segs.map((seg) => (typeof seg?.utf8 === 'string' ? seg.utf8 : '')).join(''),
        );
      }
    } else if (source.startsWith('<')) {
      const doc = new DOMParser().parseFromString(source, 'text/xml');
      if (doc.querySelector('parsererror')) return [];
      for (const node of doc.querySelectorAll('p[t], text[start]')) {
        if (cues.length >= LIMIT.cues) break;
        const ms = node.localName === 'p';
        const start = ms
          ? Number(node.getAttribute('t')) / 1000
          : Number(node.getAttribute('start'));
        const length = ms
          ? Number(node.getAttribute('d') || 0) / 1000
          : Number(node.getAttribute('dur') || 0);
        add(start, start + length, node.textContent);
      }
    } else if (/^WEBVTT/.test(source)) {
      const time = (value) => {
        const parts = value.trim().replace(',', '.').split(':').map(Number);
        return parts.reduce((total, part) => total * 60 + part, 0);
      };
      for (const block of source.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/);
        const at = lines.findIndex((line) => line.includes('-->'));
        if (at < 0) continue;
        const [from, to] = lines[at].split('-->');
        add(
          time(from),
          time(to.trim().split(/\s/)[0]),
          lines
            .slice(at + 1)
            .join(' ')
            .replace(/<[^>]+>/g, ''),
        );
      }
    }
    return cues;
  }

  // Chapters as YouTube reads them from a description: lines that start with a timestamp,
  // the first at 0:00, at least three, in increasing order.
  function chapters(description) {
    const found = [];
    for (const line of String(description || '').split('\n')) {
      const match =
        /^\s*(?:[-–—•*]\s*)?\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*(?:[-–—:|]\s*)?(\S.{0,199}?)\s*$/.exec(
          line,
        );
      if (match) found.push({ start: seconds(match[1]), title: match[2] });
    }
    if (found.length < 3 || found[0].start !== 0) return [];
    return found.every((chapter, i) => !i || chapter.start > found[i - 1].start) ? found : [];
  }

  // Cues joined into paragraphs: a new paragraph at a chapter, after a pause of more than
  // three seconds, at a sentence end once a paragraph is half a minute long, and at most
  // every minute and a half (automatic captions have no punctuation: every minute).
  function paragraphs(cues, marks, { auto = false, joiner = ' ' } = {}) {
    const list = [];
    let current = null,
      next = 0;
    for (const cue of cues) {
      let chapter = false;
      while (next < marks.length && cue.start >= marks[next].start - 0.5) {
        next++;
        chapter = true;
      }
      const long = current && cue.start - current.start >= (auto ? 60 : 90);
      const sentence =
        current &&
        cue.start - current.start >= 30 &&
        /[.!?。！？…]["'”’)]?$/.test(current.parts.at(-1));
      if (!current || chapter || cue.start - current.end > 3 || long || sentence) {
        current = { start: cue.start, end: cue.end, parts: [] };
        list.push(current);
      }
      current.parts.push(cue.text);
      current.end = Math.max(current.end, cue.end);
    }
    return list.map((paragraph) => ({ ...paragraph, text: paragraph.parts.join(joiner) }));
  }

  // A request to the page's own site, as the page makes it (with its cookies), bounded in
  // time and size. '' when it fails.
  async function sameSite(url) {
    let target;
    try {
      target = new URL(url, location.href);
    } catch {
      return '';
    }
    if (target.origin !== location.origin) return '';
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), LIMIT.timeout);
    try {
      const response = await fetch(target.href, {
        credentials: 'same-origin',
        signal: stop.signal,
      });
      if (!response.ok || Number(response.headers.get('content-length')) > LIMIT.file) return '';
      const text = await response.text();
      return text.length > LIMIT.file ? '' : text;
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  // The caption track to save: the original language's own captions (the language YouTube
  // generated automatic captions in), else those automatic captions, else the default track.
  function chooseTrack(tracks, defaultTrack) {
    const base = (code) =>
      String(code || '')
        .toLowerCase()
        .split('-')[0];
    const auto = tracks.find((track) => track.kind === 'asr');
    const manual = tracks.filter((track) => track.kind !== 'asr');
    if (auto) return manual.find((track) => base(track.language) === base(auto.language)) || auto;
    return tracks[defaultTrack]?.kind === '' ? tracks[defaultTrack] : manual[0] || null;
  }

  // The track's text: from its address; else from the player's own request for it (made
  // when captions are on; YouTube now answers caption requests only with the token the
  // player adds); else from the transcript panel when the user opened it.
  async function captionCues(track, videoId) {
    const timedtext = (value) => {
      try {
        const url = new URL(value, location.href);
        return url.origin === location.origin && url.pathname === '/api/timedtext' ? url : null;
      } catch {
        return null;
      }
    };
    const tries = [];
    const own = timedtext(track.url);
    if (own) {
      own.searchParams.set('fmt', 'json3');
      tries.push(['captions', own.href]);
    }
    const entries = performance.getEntriesByType('resource').slice(-1000).reverse();
    const player = entries
      .map((entry) => timedtext(entry.name))
      .find(
        (url) =>
          url &&
          url.searchParams.get('v') === videoId &&
          url.searchParams.get('lang') === track.language &&
          (url.searchParams.get('kind') === 'asr') === (track.kind === 'asr') &&
          !url.searchParams.has('tlang') &&
          url.searchParams.has('pot'),
      );
    if (player) tries.push(['player', player.href]);
    for (const [source, url] of tries) {
      const cues = parseCaptions(await sameSite(url));
      if (cues.length) return { cues, source };
    }
    const cues = panelCues();
    return cues.length ? { cues, source: 'panel' } : null;
  }
  // The transcript panel the user opened under the video ("Show transcript").
  function panelCues() {
    const cues = [];
    for (const segment of document.querySelectorAll(
      'ytd-transcript-segment-renderer, transcript-segment-view-model',
    )) {
      if (cues.length >= LIMIT.cues) break;
      const stamp = label(
        segment.querySelector('.segment-timestamp, [class*="Timestamp"]')?.textContent,
      );
      const text = label(
        segment.querySelector('.segment-text, [class*="SegmentText"], [role="text"]')
          ?.textContent || '',
        5000,
      );
      if (/^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(stamp) && text)
        cues.push({ start: seconds(stamp), end: seconds(stamp), text });
    }
    for (let i = 0; i < cues.length - 1; i++) cues[i].end = cues[i + 1].start;
    return cues;
  }

  // A description as paragraphs: web addresses and timestamps become links.
  function descriptionHtml(text, watch) {
    const pattern = /(https?:\/\/[^\s<>"]+)|(?<![\d:])((?:\d{1,2}:)?\d{1,2}:\d{2})(?![\d:])/g;
    const line = (value) => {
      let html = '',
        at = 0;
      for (const match of value.matchAll(pattern)) {
        html += escapeHtml(value.slice(at, match.index));
        const [whole, address, stamp] = match;
        const href = address ? address.replace(/[.,;:!?)]+$/, '') : watch(seconds(stamp));
        html += `<a href="${escapeHtml(href)}">${escapeHtml(address ? href : stamp)}</a>`;
        if (address) html += escapeHtml(whole.slice(href.length));
        at = match.index + whole.length;
      }
      return html + escapeHtml(value.slice(at));
    };
    return String(text)
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => `<p>${block.split('\n').map(line).join('<br>')}</p>`)
      .join('\n');
  }

  const CJK = /^(?:zh|ja|ko|yue)\b/i;
  // A YouTube video: its description and its captions as a transcript, from the player data
  // the worker read in the page's world (player). null when the data is not this video's:
  // the page is then clipped like any other.
  async function youtube(url, player) {
    const videoId = youtubeId(url);
    if (!videoId || !player || typeof player !== 'object' || player.videoId !== videoId)
      return null;
    const watch = (at) => `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(at)}s`;
    const description =
      typeof player.description === 'string' ? player.description.slice(0, LIMIT.description) : '';
    const tracks = (Array.isArray(player.tracks) ? player.tracks : [])
      .slice(0, 100)
      .filter((track) => track && typeof track.url === 'string')
      .map((track) => ({
        url: track.url.slice(0, 4096),
        language: label(track.language, 35),
        kind: track.kind === 'asr' ? 'asr' : '',
        name: label(track.name, 200),
      }));
    const status = label(player.status, 40);
    let transcript = { status: 'unavailable', reason: 'none' };
    let cues = null,
      track = null;
    if (status === 'LOGIN_REQUIRED' || status === 'AGE_CHECK_REQUIRED')
      transcript = { status: 'unavailable', reason: 'login' };
    else if (status && status !== 'OK' && !tracks.length)
      transcript = { status: 'unavailable', reason: 'unplayable' };
    else if (tracks.length) {
      track = chooseTrack(tracks, Number(player.defaultTrack));
      const found = track && (await captionCues(track, videoId));
      if (found) {
        cues = found.cues;
        transcript = {
          status: 'saved',
          language: track.language,
          kind: track.kind === 'asr' ? 'auto' : 'manual',
          name: track.name,
          source: found.source,
        };
      } else transcript = { status: 'unavailable', reason: 'empty' };
    } else {
      // No tracks in the player data: an open transcript panel may still have the text.
      const panel = panelCues();
      if (panel.length) {
        cues = panel;
        transcript = { status: 'saved', language: '', kind: '', name: '', source: 'panel' };
      }
    }
    const parts = [];
    if (description.trim())
      parts.push(
        `<h2>${escapeHtml(t('clipVideoDescription'))}</h2>`,
        descriptionHtml(description, watch),
      );
    if (cues) {
      const name = transcript.name || transcript.language;
      parts.push(
        `<h2>${escapeHtml(name ? t('clipTranscriptOf', name) : t('clipTranscriptHeading'))}</h2>`,
      );
      const marks = chapters(description);
      const joiner = CJK.test(transcript.language) ? '' : ' ';
      let next = 0;
      for (const paragraph of paragraphs(cues, marks, {
        auto: transcript.kind === 'auto',
        joiner,
      })) {
        while (next < marks.length && paragraph.start >= marks[next].start - 0.5) {
          const mark = marks[next++];
          parts.push(
            `<h3><a href="${watch(mark.start)}">${clock(mark.start)}</a> ${escapeHtml(mark.title)}</h3>`,
          );
        }
        parts.push(
          `<p><a href="${watch(paragraph.start)}">${clock(paragraph.start)}</a> ${escapeHtml(paragraph.text)}</p>`,
        );
      }
    }
    if (!parts.length)
      parts.push(
        `<p><a href="${watch(0).replace(/&t=0s$/, '')}">${escapeHtml(label(player.title) || videoId)}</a></p>`,
      );
    const site = `site:${new URL(url).hostname}`;
    return {
      content: parts.join('\n'),
      title: label(player.title),
      author: label(player.author, 300),
      site: 'YouTube',
      published: label(player.publishDate, 40),
      description: label(description, 1000),
      language: transcript.status === 'saved' ? transcript.language : '',
      extractor: 'youtube',
      cover: /^https:\/\//.test(player.thumbnail || '') ? player.thumbnail.slice(0, 4096) : '',
      sources: {
        ...(label(player.author) ? { author: site } : {}),
        ...(label(player.publishDate) ? { publishedAt: site } : {}),
        siteName: site,
        ...(player.thumbnail ? { cover: site } : {}),
      },
      contentStatus: cues ? 'text' : description.trim() ? 'notesOnly' : '',
      transcript,
    };
  }

  // Podcast pages: the hosts and players of podcast episodes, and pages that say they are
  // an episode. An article that only offers an audio version is not one.
  const PODCAST_HOSTS =
    /(?:^|\.)(?:podcasts\.apple\.com|xiaoyuzhoufm\.com|overcast\.fm|pca\.st|castbox\.fm|podbean\.com|pod\.link|player\.fm|listennotes\.com|podcastaddict\.com|ximalaya\.com)$/;
  const PODCAST_PLAYERS = [
    'embed.podcasts.apple.com',
    'open.spotify.com/embed/episode',
    'open.spotify.com/embed/show',
    'player.simplecast.com',
    'embed.acast.com',
    'libsyn.com/embed',
    'buzzsprout.com',
    'player.megaphone.fm',
    'share.transistor.fm',
    'player.captivate.fm',
    'omny.fm',
    'anchor.fm',
    'podcasters.spotify.com',
    'xiaoyuzhoufm.com',
  ];
  function podcastPage(doc, url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (PODCAST_HOSTS.test(parsed.hostname)) return true;
    if (parsed.hostname === 'open.spotify.com' && /^\/episode\//.test(parsed.pathname)) return true;
    if (/podcast|episode/i.test(doc.querySelector('meta[property="og:type"]')?.content || ''))
      return true;
    for (const frame of doc.querySelectorAll('iframe[src]')) {
      const src = frame.getAttribute('src') || '';
      if (PODCAST_PLAYERS.some((player) => src.includes(player))) return true;
    }
    return [...doc.querySelectorAll('script[type="application/ld+json"]')]
      .slice(0, 20)
      .some((script) => /"@type"\s*:\s*"Podcast(?:Episode|Series)"/.test(script.textContent));
  }

  const TRANSCRIPT =
    /^\s*(?:full\s+|episode\s+)?transcript(?:ion)?s?\s*:?\s*$|^\s*(?:文字稿|逐字稿|文稿|全文文稿|节目文稿)\s*[:：]?\s*$/i;
  const LINK = /transcript|文字稿|逐字稿|文稿/i;
  // The page's transcript: a block named transcript (also one the page keeps collapsed), the
  // part under a "Transcript" heading, or a page on the same site that a "transcript" link
  // leads to. { html, source } or null.
  async function podcastTranscript(doc, url) {
    const enough = (el) => label(el?.textContent || '', 100000).length >= 400;
    const outside = (el) => !el.closest('nav, header, footer, aside, [role="navigation"]');
    const named = [...doc.querySelectorAll('[id*="transcript" i], [class*="transcript" i]')]
      .filter((el) => outside(el) && enough(el) && el !== doc.body)
      .sort((a, b) => a.textContent.length - b.textContent.length)
      .find((el, i, all) => all.slice(i + 1).every((bigger) => bigger.contains(el)));
    if (named) return { html: named.innerHTML, source: 'page' };
    for (const heading of doc.querySelectorAll('h1, h2, h3, h4, summary, [role="heading"]')) {
      if (!TRANSCRIPT.test(heading.textContent) || !outside(heading)) continue;
      if (heading.localName === 'summary') {
        const box = heading.parentElement.cloneNode(true);
        box.querySelector('summary')?.remove();
        if (enough(box)) return { html: box.innerHTML, source: 'page' };
        continue;
      }
      // The blocks after the heading, up to the next heading of the same or a higher level.
      const level = Number(heading.localName.slice(1)) || 6;
      const box = doc.createElement('div');
      for (let el = heading.nextElementSibling; el; el = el.nextElementSibling) {
        const other = /^h([1-6])$/.exec(el.localName);
        if (other && Number(other[1]) <= level) break;
        box.append(el.cloneNode(true));
      }
      if (enough(box)) return { html: box.innerHTML, source: 'page' };
    }
    // At most three links are followed.
    let tries = 0;
    for (const link of doc.querySelectorAll('a[href]')) {
      if (tries >= 3) break;
      if (!LINK.test(link.textContent) || !outside(link)) continue;
      let target;
      try {
        target = new URL(link.getAttribute('href'), url);
      } catch {
        continue;
      }
      if (target.origin !== location.origin || target.href.split('#')[0] === url.split('#')[0])
        continue;
      tries++;
      const html = await sameSite(target.href);
      if (!html) continue;
      const page = new DOMParser().parseFromString(html, 'text/html');
      const result = new Defuddle(page, {
        url: target.href,
        useAsync: false,
        includeReplies: false,
        fetch: () => Promise.reject(Error('Clipping never fetches')),
      }).parse();
      const box = new DOMParser().parseFromString(result.content || '', 'text/html').body;
      if (enough(box)) return { html: result.content, source: 'link' };
    }
    return null;
  }

  // A podcast episode page: its transcript is added after the show notes when the page has
  // one and the clip does not hold it yet; otherwise the clip has only the show notes.
  async function podcast(doc, url, found) {
    if (!podcastPage(doc, url)) return found;
    const transcript = await podcastTranscript(doc, url).catch(() => null);
    if (!transcript) {
      return {
        ...found,
        contentStatus: 'notesOnly',
        transcript: { status: 'unavailable', reason: 'none' },
      };
    }
    const sample = label(
      new DOMParser().parseFromString(transcript.html, 'text/html').body.textContent,
      80,
    );
    const clipped = label(
      new DOMParser().parseFromString(found.content || '', 'text/html').body.textContent,
      10 * 1024 * 1024,
    );
    const content = clipped.includes(sample)
      ? found.content
      : `${found.content || ''}\n<h2>${escapeHtml(t('clipTranscriptHeading'))}</h2>\n${transcript.html}`;
    return {
      ...found,
      content,
      contentStatus: 'text',
      transcript: { status: 'saved', source: transcript.source },
    };
  }

  globalThis.tabgentClipMedia = Object.freeze({
    youtube,
    podcast,
    youtubeId,
    parseCaptions,
    chapters,
    paragraphs,
  });
})();
