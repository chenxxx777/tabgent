import { CLIP_LIMIT, cleanClip, storeClip } from './clipper.js';
import { clipCommand, clipNotify, clipSource } from './clip-routing.js';
import { sameSite, sniff } from './clip-images.js';

// Subscriptions: the service worker fetches feeds on a schedule (chrome.alarms) and hands
// the raw bytes to the connector, which parses them outside the vault queue and keeps
// subscriptions and items in the vault's .tabgent/feeds.db. Feed requests never carry
// cookies or a referrer; only the library page may manage subscriptions.
export const FEED_LIMIT = {
  size: 5 * 1024 * 1024, // a feed's bytes
  page: 2 * 1024 * 1024, // a web page read to find its feeds
  timeout: 20000,
  parallel: 3,
  budget: 60000, // one scheduled run; the rest wait for the next
  due: 20,
  import: 10, // OPML subscriptions first checked per minute
};
const ALARM = 'feeds',
  NEXT = 'feeds-next',
  PERIOD = 15; // minutes
// Storage keys: whether there are subscriptions (so the alarm wakes the connector only then),
// the "pause all" switch, and when items last changed (the library listens for it).
const ACTIVE = 'feedsActive',
  PAUSED = 'feedsPaused',
  CHANGED = 'feedsChangedAt';
const ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, */*;q=0.5';

export const feedMessages = new Set([
  'feedsSources',
  'feedsItems',
  'feedsProbe',
  'feedsSubscribe',
  'feedsImport',
  'feedsUnsubscribe',
  'feedsUpdate',
  'feedsRefresh',
  'feedsPause',
  'feedsOpmlParse',
  'feedsOpmlExport',
  'feedsList',
  'feedsMark',
  'feedsMarkAll',
  'feedsDocumentState',
]);
// Messages from Tabgent's reader showing a feed item (the clip reader at the item's address).
export const feedReaderMessages = new Set([
  'feedOpen',
  'feedFullText',
  'feedContent',
  'feedImage',
  'feedSave',
  'feedState',
]);
// Images known to count readers rather than illustrate the item.
const TRACKERS =
  /(?:^|\.)(?:doubleclick\.net|google-analytics\.com|googletagmanager\.com|scorecardresearch\.com|quantserve\.com|pixel\.wp\.com|stats\.wordpress\.com|feeds\.feedburner\.com|feedproxy\.google\.com|feedsportal\.com)$/i;
export function trackingImage(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return (
      TRACKERS.test(hostname) ||
      /\/(?:pixel|beacon|track(?:ing)?|open)\.(?:gif|png)$/i.test(pathname)
    );
  } catch {
    return true;
  }
}
const IMAGE_SIZE = 5 * 1024 * 1024;

const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
export function feedAddress(value) {
  const raw = text(value, 4096).trim();
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// A feed by its bytes (XML with an rss, feed or rdf:RDF root, or a JSON Feed), else by type.
export function looksLikeFeed(contentType, bytes) {
  const [a, b] = bytes;
  const encoding =
    a === 0xff && b === 0xfe ? 'utf-16le' : a === 0xfe && b === 0xff ? 'utf-16be' : 'latin1';
  const start = a === 0xef && b === 0xbb && bytes[2] === 0xbf ? 3 : encoding === 'latin1' ? 0 : 2;
  const head = new TextDecoder(encoding).decode(bytes.subarray(start, start + 2048));
  if (/^\s*\{/.test(head)) return /"version"\s*:\s*"https:\/\/jsonfeed\.org\/version\//.test(head);
  if (/^\s*</.test(head)) {
    if (/<(rss|feed|rdf:RDF)[\s>]/i.test(head)) return true;
    if (/<html[\s>]|<!doctype html/i.test(head)) return false;
  }
  const type = String(contentType || '').toLowerCase();
  return !/html/.test(type) && /(rss|atom|xml|feed\+json)/.test(type);
}

// Seconds from a Retry-After header (seconds or an HTTP date), or 0.
export function retryAfter(value, now = Date.now()) {
  if (!value) return 0;
  if (/^\s*\d+\s*$/.test(value)) return Math.min(Number(value), 86400);
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.min(Math.round((at - now) / 1000), 86400));
}

// The body's bytes; past the limit, the download stops: an error, or (truncate) the first
// limit bytes with truncated set.
async function readBody(response, limit, truncate) {
  const reader = response.body?.getReader();
  if (!reader) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.length > limit && !truncate)
      throw Object.assign(Error('The feed is larger than 5 MB'), { tooLarge: true });
    return { bytes: whole.slice(0, limit), truncated: whole.length > limit };
  }
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    parts.push(value);
    if (size > limit) {
      void reader.cancel().catch(() => {});
      if (!truncate) throw Object.assign(Error('The feed is larger than 5 MB'), { tooLarge: true });
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(size, limit));
  const truncated = size > limit;
  let at = 0;
  for (const part of parts) {
    const room = bytes.length - at;
    if (room <= 0) break;
    bytes.set(room < part.length ? part.subarray(0, room) : part, at);
    at += Math.min(room, part.length);
  }
  return { bytes, truncated };
}

// One request: { status (0 when it failed), finalUrl, contentType, headers, bytes?, error? }.
export async function fetchFeed(url, options = {}, fetchImpl = globalThis.fetch) {
  const { etag = '', lastModified = '', limit = FEED_LIMIT.size, page = false } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? FEED_LIMIT.timeout);
  try {
    const headers = { Accept: ACCEPT };
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
    const response = await fetchImpl(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'follow',
      cache: 'no-store',
      headers,
      signal: controller.signal,
    });
    const ok = response.status >= 200 && response.status < 300;
    const result = {
      status: ok ? 200 : response.status,
      finalUrl: response.url || url,
      contentType: text(response.headers.get('content-type'), 200),
      headers: {
        etag: text(response.headers.get('etag'), 1000),
        lastModified: text(response.headers.get('last-modified'), 200),
        cacheControl: text(response.headers.get('cache-control'), 500),
        retryAfter: retryAfter(response.headers.get('retry-after')),
      },
    };
    if (ok) {
      Object.assign(result, await readBody(response, limit, page));
    } else void response.body?.cancel().catch(() => {});
    return result;
  } catch (error) {
    const reason = controller.signal.aborted
      ? 'The feed did not answer within 20 seconds'
      : error?.tooLarge
        ? error.message
        : text(error?.message, 300) || 'The request failed';
    return { status: 0, finalUrl: url, contentType: '', headers: {}, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

// A web page's text, decoded by its HTTP or <meta> charset (the library finds its feeds).
export function decodePage(bytes, contentType) {
  const declared =
    /charset=["']?([\w.:-]+)/i.exec(contentType || '')?.[1] ||
    /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(
      new TextDecoder('latin1').decode(bytes.subarray(0, 4096)),
    )?.[1];
  try {
    return new TextDecoder(declared || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function createFeeds({
  request,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  alarms = chrome.alarms,
  storage = chrome.storage.local,
  now = () => Date.now(),
}) {
  let running = null;

  async function active(value) {
    await storage.set({ [ACTIVE]: value });
    if (!value) {
      await alarms.clear(ALARM);
      await alarms.clear(NEXT);
    } else if (!(await alarms.get(ALARM)))
      await alarms.create(ALARM, { periodInMinutes: PERIOD, delayInMinutes: 1 });
  }

  // The next subscription due sooner than the periodic check gets its own alarm.
  async function schedule(nextAt) {
    if (nextAt == null || nextAt > now() + PERIOD * 60000) return void (await alarms.clear(NEXT));
    await alarms.create(NEXT, { when: Math.max(nextAt, now() + 60000) });
  }

  async function ingest(source) {
    const fetched = await fetchFeed(source.url, source, fetchImpl);
    const params = {
      sourceId: source.id,
      status: fetched.status,
      finalUrl: fetched.finalUrl,
      contentType: fetched.contentType,
      headers: fetched.headers,
    };
    if (fetched.error) params.error = fetched.error;
    if (fetched.bytes) params.data = toBase64(fetched.bytes);
    const result = await request('vault/feeds/ingest', params, { timeout: 60000 });
    return { new: result.new || 0, failed: !!result.source?.failures };
  }

  async function run({ sourceId } = {}) {
    const started = now();
    const due = await request(
      'vault/feeds/due',
      sourceId ? { sourceId } : { limit: FEED_LIMIT.due },
    );
    const sources = due.sources || [];
    const summary = { checked: 0, new: 0, failed: 0 };
    let index = 0;
    const lane = async () => {
      while (index < sources.length && now() - started < FEED_LIMIT.budget) {
        const source = sources[index++];
        try {
          const result = await ingest(source);
          summary.new += result.new;
          if (result.failed) summary.failed++;
        } catch (error) {
          summary.failed++;
          console.warn('Feed check failed', error?.message || error);
        }
        summary.checked++;
      }
    };
    await Promise.all(Array.from({ length: FEED_LIMIT.parallel }, lane));
    if (summary.checked) await storage.set({ [CHANGED]: now() });
    const after = await request('vault/feeds/due', { limit: 1 });
    await schedule(after.nextAt);
    return summary;
  }

  // One run at a time; a scheduled run joins the one in progress.
  function refresh(options = {}) {
    if (running && !options.sourceId) return running;
    const previous = running || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => run(options))
      .finally(() => {
        if (running === current) running = null;
      });
    running = current;
    return current;
  }

  async function onAlarm(alarm) {
    if (alarm?.name !== ALARM && alarm?.name !== NEXT) return;
    const stored = await storage.get([ACTIVE, PAUSED]);
    if (!stored[ACTIVE]) return void (await active(false));
    if (stored[PAUSED]) return;
    try {
      await refresh();
    } catch (error) {
      console.warn('Feed refresh failed', error?.message || error);
    }
  }

  // After a browser start, an install or an update: the periodic alarm may be gone, and
  // subscriptions that fell due while Chrome was closed are checked once, a minute later.
  async function start() {
    const stored = await storage.get(ACTIVE);
    if (!stored[ACTIVE]) return;
    await active(true);
    await alarms.create(NEXT, { delayInMinutes: 1 });
  }

  async function probe(value) {
    const url = feedAddress(value);
    if (!url) throw Object.assign(Error('Enter a web address'), { code: 'invalid_url' });
    const fetched = await fetchFeed(url, { page: true, limit: FEED_LIMIT.size }, fetchImpl);
    if (fetched.status !== 200)
      throw Object.assign(Error(fetched.error || `HTTP ${fetched.status}`), {
        code: 'fetch_failed',
      });
    if (looksLikeFeed(fetched.contentType, fetched.bytes)) {
      if (fetched.truncated)
        throw Object.assign(Error('The feed is larger than 5 MB'), { code: 'too_large' });
      const preview = await request(
        'vault/feeds/preview',
        { data: toBase64(fetched.bytes), contentType: fetched.contentType, url: fetched.finalUrl },
        { timeout: 60000 },
      );
      return { kind: 'feed', url: fetched.finalUrl, preview };
    }
    const html = decodePage(fetched.bytes.subarray(0, FEED_LIMIT.page), fetched.contentType);
    return { kind: 'page', url: fetched.finalUrl, html };
  }

  async function subscribe(msg) {
    const url = feedAddress(msg.url);
    if (!url) throw Object.assign(Error('Enter a web address'), { code: 'invalid_url' });
    const params = { url, title: text(msg.title, 500), category: text(msg.category, 200) };
    const fetched = await fetchFeed(url, {}, fetchImpl);
    if (fetched.bytes) {
      Object.assign(params, {
        data: toBase64(fetched.bytes),
        contentType: fetched.contentType,
        finalUrl: fetched.finalUrl,
        headers: fetched.headers,
      });
    }
    const result = await request('vault/feeds/subscribe', params, { timeout: 60000 });
    await active(true);
    if (result.created) await storage.set({ [CHANGED]: now() });
    // Fetched now; a feed that did not answer is checked again by the scheduler soon.
    const { nextAt } = await request('vault/feeds/due', { limit: 1 });
    await schedule(nextAt);
    return result;
  }

  // OPML: subscriptions are added at once and first checked ten a minute.
  async function importOutlines(outlines) {
    const summary = { created: 0, existing: 0, failed: 0 };
    const list = Array.isArray(outlines) ? outlines.slice(0, 500) : [];
    for (const [index, outline] of list.entries()) {
      try {
        // Normalized as addresses typed in the library are, so an OPML entry that differs
        // only in case or encoding is the same subscription.
        const url = feedAddress(outline?.url);
        if (!url) throw Error('Not a web address');
        const result = await request('vault/feeds/subscribe', {
          url,
          title: text(outline?.title, 500),
          category: text(outline?.category, 200),
          siteUrl: text(outline?.siteUrl, 4096),
          delay: Math.floor(index / FEED_LIMIT.import) * 60,
        });
        summary[result.created ? 'created' : 'existing']++;
      } catch {
        summary.failed++;
      }
    }
    if (summary.created) {
      await active(true);
      await storage.set({ [CHANGED]: now() });
      void refresh().catch((error) => console.warn('Feed refresh failed', error?.message));
    }
    return summary;
  }

  async function message(msg) {
    const sourceId = msg.sourceId == null ? undefined : text(msg.sourceId, 100);
    switch (msg.type) {
      case 'feedsSources': {
        const result = await request('vault/feeds/sources', {});
        await active(result.sources.length > 0);
        return { ...result, paused: !!(await storage.get(PAUSED))[PAUSED] };
      }
      case 'feedsItems':
        return request('vault/feeds/items', {
          view: msg.view === 'all' ? 'all' : 'unread',
          ...(sourceId ? { sourceId } : {}),
          limit: Number.isInteger(msg.limit) ? msg.limit : 50,
          offset: Number.isInteger(msg.offset) ? msg.offset : 0,
        });
      case 'feedsProbe':
        return probe(msg.url);
      case 'feedsSubscribe':
        return subscribe(msg);
      case 'feedsImport':
        return importOutlines(msg.outlines);
      case 'feedsUnsubscribe': {
        const result = await request('vault/feeds/unsubscribe', { sourceId });
        const { sources } = await request('vault/feeds/sources', {});
        await active(sources.length > 0);
        await storage.set({ [CHANGED]: now() });
        return result;
      }
      case 'feedsUpdate': {
        const params = { sourceId };
        if (typeof msg.title === 'string') params.title = text(msg.title, 500);
        if (typeof msg.category === 'string') params.category = text(msg.category, 200);
        if (msg.settings && typeof msg.settings === 'object') params.settings = msg.settings;
        if (msg.retry === true) params.retry = true;
        const result = await request('vault/feeds/update', params);
        if (msg.retry === true) await schedule(now());
        return result;
      }
      case 'feedsRefresh':
        // One subscription whatever its state, or every active one: the first twenty now,
        // the rest a minute later.
        if (!sourceId) await request('vault/feeds/refresh', {});
        return refresh(sourceId ? { sourceId } : {});
      case 'feedsPause':
        await storage.set({ [PAUSED]: msg.paused === true });
        return { paused: msg.paused === true };
      case 'feedsOpmlParse':
        return request(
          'vault/feeds/opml/parse',
          { text: text(msg.text, 2 * 1024 * 1024) },
          { timeout: 60000 },
        );
      case 'feedsOpmlExport':
        return request('vault/feeds/opml/export', {});
      case 'feedsList':
        return request('vault/feeds/library', {
          view: ['unread', 'later', 'archive', 'all'].includes(msg.view) ? msg.view : 'unread',
          ...(sourceId ? { sourceId } : {}),
          limit: Number.isInteger(msg.limit) ? msg.limit : 50,
          offset: Number.isInteger(msg.offset) ? msg.offset : 0,
        });
      case 'feedsMark': {
        const params = { urls: Array.isArray(msg.urls) ? msg.urls.slice(0, 500) : [] };
        if (typeof msg.read === 'boolean') params.read = msg.read;
        if (['inbox', 'later', 'archive'].includes(msg.state)) params.state = msg.state;
        const result = await request('vault/feeds/mark', params);
        await storage.set({ [CHANGED]: now() });
        return result;
      }
      case 'feedsMarkAll': {
        const result = await request('vault/feeds/mark', {
          allRead: true,
          ...(sourceId ? { sourceId } : {}),
        });
        await storage.set({ [CHANGED]: now() });
        return result;
      }
      case 'feedsDocumentState': {
        const state = ['later', 'archive'].includes(msg.state) ? msg.state : null;
        const result = await request('vault/document/state', {
          url: text(msg.url, 16384),
          title: '',
          kind: 'web',
          state,
        });
        await storage.set({ [CHANGED]: now() });
        return result;
      }
    }
    throw Error('Unknown subscription message');
  }

  // A reader tab's item: the subscription settings and link, kept while the worker runs.
  // A reader tab's item: the subscription settings and link, kept while the worker runs, for
  // the most recently used items only.
  const opened = new Map();
  const OPENED = 50;
  async function item(url) {
    const value = opened.get(url) || (await request('vault/feeds/open', { url }));
    opened.delete(url);
    opened.set(url, value);
    while (opened.size > OPENED) opened.delete(opened.keys().next().value);
    return value;
  }
  async function changedNow() {
    await storage.set({ [CHANGED]: now() });
  }

  // Saves what the reader shows of an item as a vault document (article.md, article.html
  // and images, fetched without cookies), and links the item to it. result is the reader's
  // cleaned text, as the clipping script returns it for a page.
  function oversized(result) {
    if (result?.ok !== true) return false;
    const markdown = typeof result.markdown === 'string' ? result.markdown : '';
    const html = typeof result.html === 'string' ? result.html : '';
    if (!markdown.trim() || !html.trim()) return false;
    const size = (value) => new TextEncoder().encode(value).length;
    return size(markdown) > CLIP_LIMIT.markdown || size(html) > CLIP_LIMIT.html;
  }
  async function saveItem(url, { result, method }) {
    const clip = cleanClip(result);
    if (!clip) {
      const long = oversized(result);
      const error = Error(long ? 'The item is too long to save' : 'The item has no text to save');
      error.code = long ? 'too_long' : 'no_text';
      throw error;
    }
    const { item: entry, source } = await item(url);
    const link = /^https?:/i.test(entry.link || '') ? entry.link : '';
    const stored = await storeClip(
      { request },
      {
        url,
        title: clip.title || entry.title,
        clip,
        imagesFrom: '',
        origin: {
          type: 'feed',
          method: method === 'fulltext' ? 'fulltext' : 'feed',
          extractor: clip.extractor,
          pageUrl: link,
          sourceId: source.id,
          sourceUrl: source.url,
          sourceTitle: source.title,
          guid: text(entry.key, 1024),
          publishedAt: entry.publishedAt || '',
        },
        fetch: fetchImpl,
      },
    );
    if (!stored.ok) {
      const error = Error('The item is too long to save');
      error.code = 'too_long';
      throw error;
    }
    // The page was clipped already: the item joins that document.
    await request('vault/feeds/saved', { url });
    opened.delete(url);
    await changedNow();
    return {
      saved: true,
      document: stored.saved.document || null,
      clip: stored.saved.clip || null,
      already: !stored.saved.saved,
    };
  }

  // Before the first highlight on an item that is not saved yet, the reader hands over its
  // text and the item becomes a vault document, so the highlight has its article.
  // The reader is told how it went: it shows the item as saved only once it is.
  async function commit(tabId, url) {
    const value = await clipCommand(tabId, { type: 'feedCommit' }).catch(() => null);
    if (!value?.result) return null;
    try {
      const saved = await saveItem(url, value);
      clipNotify(tabId, { type: 'feedSaved' });
      return saved;
    } catch (error) {
      clipNotify(tabId, {
        type: 'feedSaveFailed',
        message: error?.message || String(error),
        ...(error?.code ? { code: error.code } : {}),
        ...(typeof error?.folder === 'string' && error.folder ? { folder: error.folder } : {}),
      });
      throw error;
    }
  }

  // Messages from the reader at an item's address (the sender is checked by the caller).
  async function reader(msg, sender) {
    const url = clipSource(sender.url);
    if (!url) throw Error('Invalid clipped page reader');
    if (msg.type === 'feedOpen') {
      opened.delete(url);
      const value = await item(url);
      const resolved = await request('vault/document/resolve', {
        url,
        title: value.item.title,
        kind: 'web',
      });
      await changedNow();
      return {
        ...value,
        document: resolved.document?.createdAt ? resolved.document : null,
        saved: !!resolved.clip?.complete,
      };
    }
    const { item: entry, source } = await item(url);
    if (msg.type === 'feedFullText') {
      // The item's address without tracking parameters; never an address from the request.
      const address = /^https?:/i.test(entry.url || '') ? entry.url : '';
      if (!address) throw Error('The item has no page');
      // As if the user opened the page, with that site's cookies (subscriber-only text the
      // user can read), but only for an item on the subscription's own site: an aggregator's
      // links (Hacker News, Reddit, news digests) are chosen by others. The cookies go to that
      // site only: a redirect elsewhere is followed without them. No referrer.
      const own = sameSite(address, source.url) || sameSite(address, source.siteUrl || '');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FEED_LIMIT.timeout);
      const get = (target, cookies) =>
        fetchImpl(target, {
          credentials: cookies ? 'include' : 'omit',
          redirect: cookies ? 'manual' : 'follow',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
      try {
        let response = await get(address, own);
        if (own && response.type === 'opaqueredirect') {
          // Where the redirects lead, learned without cookies; the cookies are sent again
          // only when that is still the item's own site (http to https, www, a slash).
          response = await get(address, false);
          const final = response.url || address;
          if (sameSite(final, address)) {
            const again = await get(final, true);
            if (again.type !== 'opaqueredirect') {
              void response.body?.cancel().catch(() => {});
              response = again;
            }
          }
        }
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const type = response.headers.get('content-type') || '';
        if (type && !/html|xml/i.test(type)) throw Error('The page is not HTML');
        const { bytes } = await readBody(response, FEED_LIMIT.size, false);
        return { html: decodePage(bytes, type), url: response.url || address };
      } catch (error) {
        throw Error(
          controller.signal.aborted ? 'The page did not answer within 20 seconds' : error.message,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    if (msg.type === 'feedContent')
      return request('vault/feeds/content', { url, html: text(msg.html, 4 * 1024 * 1024) });
    if (msg.type === 'feedImage') {
      // Item images: without cookies or a referrer, never trackers, off when the user
      // turned images off for this subscription.
      const address = text(msg.url, 4096);
      if (source.settings.images === false) throw Error('Images are off for this subscription');
      if (!/^https?:/i.test(address) || trackingImage(address)) throw Error('Not loaded');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FEED_LIMIT.timeout);
      try {
        const response = await fetchImpl(address, {
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const { bytes } = await readBody(response, IMAGE_SIZE, false);
        const kind = sniff(bytes);
        if (!kind) throw Error('Not an image');
        const mime = {
          jpg: 'image/jpeg',
          png: 'image/png',
          gif: 'image/gif',
          webp: 'image/webp',
          avif: 'image/avif',
        }[kind];
        return { mime, data: toBase64(bytes) };
      } finally {
        clearTimeout(timer);
      }
    }
    if (msg.type === 'feedSave') return saveItem(url, { result: msg.result, method: msg.method });
    if (msg.type === 'feedState') {
      const state = ['inbox', 'later', 'archive'].includes(msg.state) ? msg.state : 'inbox';
      const resolved = await request('vault/document/resolve', { url, title: '', kind: 'web' });
      if (resolved.document?.createdAt && resolved.clip?.complete)
        await request('vault/document/state', {
          url,
          title: '',
          kind: 'web',
          state: state === 'inbox' ? null : state,
        });
      else await request('vault/feeds/mark', { urls: [url], state });
      await changedNow();
      return { state };
    }
    throw Error('Unknown subscription message');
  }

  return { onAlarm, start, refresh, message, reader, commit };
}
