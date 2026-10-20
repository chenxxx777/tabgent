// The subscription worker with a fake fetch, alarms and storage, and the real connector
// modules in a temporary vault: requests carry no cookies or referrer and send validators,
// feeds reach the connector as raw bytes, large and slow feeds stop, scheduled runs are
// bounded, and the alarm is kept only while there are subscriptions. Generated feeds only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
// The worker's reader routing reads extension addresses.
globalThis.chrome = { runtime: { getURL: (file) => 'chrome-extension://test/' + file } };
const { registerClipPort, clipViewerUrl } = await import('../clip-routing.js');
import {
  FEED_LIMIT,
  createFeeds,
  decodePage,
  feedAddress,
  fetchFeed,
  looksLikeFeed,
  retryAfter,
  toBase64,
  trackingImage,
} from '../feeds.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-feeds-'));
const python = spawn(
  process.env.PYTHON || 'python3',
  [new URL('./fixtures/vault-lines.py', import.meta.url).pathname, path.join(temp, 'vault.json')],
  { stdio: ['pipe', 'pipe', 'inherit'] },
);
const replies = new Map();
readline.createInterface({ input: python.stdout }).on('line', (line) => {
  const reply = JSON.parse(line);
  replies.get(reply.id)?.(reply);
  replies.delete(reply.id);
});
let sequence = 0;
const calls = [];
function request(method, params = {}) {
  calls.push({ method, params });
  const id = `r${++sequence}`;
  return new Promise((resolve, reject) => {
    replies.set(id, (reply) =>
      reply.error
        ? reject(Object.assign(Error(reply.error.message), { code: reply.error.code }))
        : resolve(reply.result),
    );
    python.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

// Generated feeds, served by a fake fetch that records every request.
const day = (n) => new Date(Date.UTC(2025, 0, 1) + n * 3600_000).toUTCString();
const rss = (title, numbers) =>
  `<?xml version="1.0"?><rss><channel><title>${title}</title><link>https://site.test/</link>` +
  numbers
    .map(
      (n) =>
        `<item><title>Post ${n}</title><guid>${title}-${n}</guid>` +
        `<link>https://site.test/${n}</link><pubDate>${day(n)}</pubDate></item>`,
    )
    .join('') +
  '</channel></rss>';
const encoder = new TextEncoder();
const routes = new Map();
const requests = [];
let inFlight = 0,
  maxInFlight = 0;
function body(bytes, chunk = 64 * 1024) {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(at, at + chunk));
      at += chunk;
    },
  });
}
async function fakeFetch(url, options) {
  requests.push({ url, options });
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    const route = routes.get(url);
    if (!route) throw TypeError('Failed to fetch');
    return await route(options);
  } finally {
    inFlight--;
  }
}
const respond = (data, headers = {}, status = 200, url) => {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return {
    status,
    url: url || '',
    headers: new Headers(headers),
    body: status === 304 ? null : body(bytes),
    arrayBuffer: async () => bytes.buffer,
  };
};

try {
  // Helpers.
  assert.equal(feedAddress('example.test/feed#x'), 'https://example.test/feed');
  assert.equal(feedAddress('http://example.test'), 'http://example.test/');
  assert.equal(feedAddress('javascript:alert(1)'), '');
  assert.equal(feedAddress('file:///etc/passwd'), '');
  assert.equal(feedAddress(''), '');
  assert.equal(looksLikeFeed('text/html', encoder.encode('﻿<?xml version="1.0"?>\n<rss>')), true);
  assert.equal(
    looksLikeFeed('', encoder.encode('<feed xmlns="http://www.w3.org/2005/Atom">')),
    true,
  );
  assert.equal(looksLikeFeed('', encoder.encode('<rdf:RDF xmlns:rdf="x">')), true);
  assert.equal(
    looksLikeFeed(
      'application/json',
      encoder.encode('{"version": "https://jsonfeed.org/version/1.1"}'),
    ),
    true,
  );
  assert.equal(looksLikeFeed('application/json', encoder.encode('{"data": 1}')), false);
  assert.equal(looksLikeFeed('text/html', encoder.encode('<!doctype html><html>')), false);
  assert.equal(looksLikeFeed('application/rss+xml; charset=utf-8', new Uint8Array()), true);
  assert.equal(looksLikeFeed('application/xhtml+xml', encoder.encode('<p>')), false);
  assert.equal(retryAfter('120'), 120);
  assert.equal(retryAfter('999999'), 86400);
  assert.equal(retryAfter(new Date(1_700_000_060_000).toUTCString(), 1_700_000_000_000), 60);
  assert.equal(retryAfter('soon'), 0);
  const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]); // 中文
  const page = new Uint8Array([...encoder.encode('<meta charset="gbk"><title>'), ...gbk]);
  assert.match(decodePage(page, 'text/html'), /中文/);
  assert.match(decodePage(gbk, 'text/html; charset=GBK'), /中文/);
  assert.equal(toBase64(encoder.encode('hi')), 'aGk=');
  console.log('PASS addresses, feed detection, Retry-After and page charsets');

  // Requests: no cookies, no referrer, no HTTP cache, the stored validators.
  routes.set('https://feed.test/a.xml', (options) =>
    options.headers['If-None-Match'] === '"v1"'
      ? respond('', { etag: '"v1"' }, 304)
      : respond(rss('A', [1, 2]), {
          'content-type': 'application/rss+xml',
          etag: '"v1"',
          'last-modified': day(2),
          'cache-control': 'max-age=7200',
        }),
  );
  let fetched = await fetchFeed('https://feed.test/a.xml', {}, fakeFetch);
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.headers, {
    etag: '"v1"',
    lastModified: day(2),
    cacheControl: 'max-age=7200',
    retryAfter: 0,
  });
  const options = requests.at(-1).options;
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.redirect, 'follow');
  assert.match(options.headers.Accept, /application\/rss\+xml/);
  assert.equal(options.headers['If-None-Match'], undefined);
  fetched = await fetchFeed(
    'https://feed.test/a.xml',
    { etag: '"v1"', lastModified: day(2) },
    fakeFetch,
  );
  assert.equal(fetched.status, 304);
  assert.equal(fetched.bytes, undefined);
  assert.equal(requests.at(-1).options.headers['If-Modified-Since'], day(2));

  // A feed over 5 MB stops while it downloads; a feed that does not answer times out.
  let pulled = 0;
  routes.set('https://feed.test/huge.xml', () => ({
    ...respond(''),
    body: new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    }),
  }));
  fetched = await fetchFeed('https://feed.test/huge.xml', {}, fakeFetch);
  assert.equal(fetched.status, 0);
  assert.match(fetched.error, /larger than 5 MB/);
  assert.ok(pulled <= 8, `stopped reading after ${pulled} MB`);
  routes.set(
    'https://feed.test/slow.xml',
    (options) =>
      new Promise((resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))),
      ),
  );
  fetched = await fetchFeed('https://feed.test/slow.xml', { timeout: 50 }, fakeFetch);
  assert.equal(fetched.status, 0);
  assert.match(fetched.error, /did not answer/);
  routes.set('https://feed.test/limited.xml', () => respond('', { 'retry-after': '600' }, 429));
  fetched = await fetchFeed('https://feed.test/limited.xml', {}, fakeFetch);
  assert.equal(fetched.status, 429);
  assert.equal(fetched.headers.retryAfter, 600);
  console.log('PASS feed requests: no cookies or referrer, validators, size and time limits');

  // The worker with fake alarms and storage.
  const alarms = new Map();
  const stored = {};
  const fakeAlarms = {
    get: async (name) => alarms.get(name) || null,
    create: async (name, info) => void alarms.set(name, { name, ...info }),
    clear: async (name) => alarms.delete(name),
  };
  const storage = {
    get: async (keys) =>
      Object.fromEntries(
        [keys]
          .flat()
          .filter((k) => k in stored)
          .map((k) => [k, stored[k]]),
      ),
    set: async (values) => void Object.assign(stored, values),
  };
  const feeds = createFeeds({ request, fetch: fakeFetch, alarms: fakeAlarms, storage });

  // Without subscriptions there is no alarm, and the connector is not woken.
  assert.deepEqual(await feeds.message({ type: 'feedsSources' }), { sources: [], paused: false });
  assert.equal(stored.feedsActive, false);
  await feeds.start();
  assert.equal(alarms.size, 0);
  calls.length = 0;
  await feeds.onAlarm({ name: 'feeds' });
  assert.deepEqual(
    calls.map((c) => c.method),
    [],
    'An alarm without subscriptions does not call the connector',
  );

  // Probing: a feed is previewed by the connector; a page comes back for the library.
  const probed = await feeds.message({ type: 'feedsProbe', url: 'feed.test/a.xml' });
  assert.equal(probed.kind, 'feed');
  assert.equal(probed.preview.title, 'A');
  assert.equal(probed.preview.count, 2);
  routes.set('https://site.test/', () =>
    respond(
      '<html><head><link rel="alternate" type="application/rss+xml" href="/a.xml"></head></html>',
      { 'content-type': 'text/html' },
      200,
      'https://site.test/',
    ),
  );
  const site = await feeds.message({ type: 'feedsProbe', url: 'https://site.test/' });
  assert.equal(site.kind, 'page');
  assert.match(site.html, /rel="alternate"/);
  await assert.rejects(feeds.message({ type: 'feedsProbe', url: 'ftp://x' }), /web address/);
  // A feed over 5 MB is refused when it is checked, not cut and misread.
  routes.set('https://feed.test/large.xml', () =>
    respond('<rss><channel>' + ' '.repeat(6 * 1024 * 1024), {
      'content-type': 'application/rss+xml',
    }),
  );
  await assert.rejects(
    feeds.message({ type: 'feedsProbe', url: 'https://feed.test/large.xml' }),
    /larger than 5 MB/,
  );
  await assert.rejects(
    feeds.message({ type: 'feedsProbe', url: 'https://feed.test/limited.xml' }),
    /HTTP 429/,
  );

  // Subscribing sends the raw bytes (GBK stays GBK) and starts the periodic alarm.
  const gbkFeed = new Uint8Array([
    ...encoder.encode('<?xml version="1.0" encoding="gbk"?><rss><channel><title>'),
    ...gbk,
    ...encoder.encode('</title><item><guid>g1</guid><title>x</title></item></channel></rss>'),
  ]);
  routes.set('https://feed.test/gbk.xml', () => respond(gbkFeed, { 'content-type': 'text/xml' }));
  calls.length = 0;
  const subscribed = await feeds.message({
    type: 'feedsSubscribe',
    url: 'https://feed.test/gbk.xml',
  });
  assert.equal(subscribed.created, true);
  assert.equal(subscribed.source.title, '中文');
  assert.equal(subscribed.new, 1);
  const sent = calls.find((c) => c.method === 'vault/feeds/subscribe').params;
  assert.deepEqual(Buffer.from(sent.data, 'base64'), Buffer.from(gbkFeed));
  assert.equal(stored.feedsActive, true);
  assert.equal(alarms.get('feeds').periodInMinutes, 15);
  assert.ok(stored.feedsChangedAt);
  const a = (await feeds.message({ type: 'feedsSubscribe', url: 'https://feed.test/a.xml' }))
    .source;
  assert.equal(a.unread, 2);
  console.log('PASS subscribing sends raw bytes and keeps the alarm while subscribed');

  // A browser start (or an install or update) checks overdue subscriptions a minute later.
  alarms.clear();
  await feeds.start();
  assert.equal(alarms.get('feeds').periodInMinutes, 15);
  assert.equal(alarms.get('feeds-next').delayInMinutes, 1);

  // Refresh all: conditional requests; 304 adds nothing.
  requests.length = 0;
  const refreshed = await feeds.message({ type: 'feedsRefresh' });
  assert.deepEqual(refreshed, { checked: 2, new: 0, failed: 0 });
  const conditional = requests.find((r) => r.url === 'https://feed.test/a.xml');
  assert.equal(conditional.options.headers['If-None-Match'], '"v1"');
  assert.equal((await request('vault/feeds/items', {})).total, 3);

  // Scheduled runs: three requests at a time, within the time budget, never when paused.
  const outlines = Array.from({ length: 12 }, (_, i) => ({
    url: `https://many.test/${i}.xml`,
    title: `Many ${i}`,
    category: 'Bulk',
  }));
  for (const outline of outlines)
    routes.set(outline.url, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return respond(rss(outline.title, [1]), { 'content-type': 'application/rss+xml' });
    });
  const imported = await feeds.message({
    type: 'feedsImport',
    outlines: [...outlines, { url: 'x' }],
  });
  assert.deepEqual(imported, { created: 12, existing: 0, failed: 1 });
  // The import starts a run for the first ten; two wait a minute.
  await until(async () => (await request('vault/feeds/items', {})).total === 13);
  assert.ok(maxInFlight <= FEED_LIMIT.parallel, `at most 3 at once (${maxInFlight})`);
  const due = await request('vault/feeds/due', {});
  assert.ok(due.nextAt > Date.now() + 30_000, 'the rest are due a minute later');
  assert.ok(alarms.get('feeds-next').when >= Date.now() + 30_000);

  await request('vault/feeds/refresh', {});
  stored.feedsPaused = true;
  requests.length = 0;
  await feeds.onAlarm({ name: 'feeds' });
  assert.equal(requests.length, 0, 'Paused subscriptions are not checked');
  stored.feedsPaused = false;
  await feeds.onAlarm({ name: 'unrelated' });
  assert.equal(requests.length, 0);

  // The time budget: a run stops starting new requests after 60 seconds.
  let clock = Date.now();
  const timed = createFeeds({
    request,
    fetch: async (url, options) => {
      clock += 25_000;
      return fakeFetch(url, options);
    },
    alarms: fakeAlarms,
    storage,
    now: () => clock,
  });
  requests.length = 0;
  maxInFlight = 0;
  const bounded = await timed.refresh();
  assert.ok(bounded.checked >= 3 && bounded.checked < 14, JSON.stringify(bounded));
  console.log('PASS scheduled runs: three at a time, a time budget, paused and other alarms');

  // The reader at an item's address: open, images, full text, state and saving.
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  routes.set('https://feed.test/reader.xml', () =>
    respond(
      '<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/">' +
        '<channel><title>Reader</title><link>https://read.test/</link>' +
        '<item><title>Short one</title><guid>r1</guid>' +
        '<link>https://read.test/short?utm_source=rss</link>' +
        '<description>Just a summary.</description></item></channel></rss>',
      { 'content-type': 'application/rss+xml' },
    ),
  );
  await feeds.message({ type: 'feedsSubscribe', url: 'https://feed.test/reader.xml' });
  const itemUrl = 'https://read.test/short';
  const readerSender = { tab: { id: 77 }, url: clipViewerUrl(itemUrl), frameId: 0 };
  const openedItem = await feeds.reader({ type: 'feedOpen' }, readerSender);
  assert.equal(openedItem.item.title, 'Short one');
  assert.equal(openedItem.item.link, 'https://read.test/short?utm_source=rss');
  assert.equal(openedItem.saved, false);
  assert.equal(openedItem.document, null);
  const unreadNow = await request('vault/feeds/library', { view: 'unread' });
  assert(!unreadNow.items.some((entry) => entry.url === itemUrl), 'Opening marks it read');
  await assert.rejects(
    feeds.reader({ type: 'feedOpen' }, { ...readerSender, url: 'https://read.test/short' }),
    /Invalid clipped page reader/,
  );

  // Images: no cookies or referrer; trackers and non-images are refused.
  routes.set('https://img.test/a.png', () => respond(PNG, { 'content-type': 'text/html' }));
  routes.set('https://img.test/page.png', () => respond('<html>', { 'content-type': 'image/png' }));
  requests.length = 0;
  const image = await feeds.reader(
    { type: 'feedImage', url: 'https://img.test/a.png' },
    readerSender,
  );
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(Buffer.from(image.data, 'base64'), Buffer.from(PNG));
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
  await assert.rejects(
    feeds.reader({ type: 'feedImage', url: 'https://img.test/page.png' }, readerSender),
    /Not an image/,
  );
  assert.equal(trackingImage('https://feeds.feedburner.com/~r/x/~4/abc'), true);
  assert.equal(trackingImage('https://stats.wordpress.com/b.gif?v=1'), true);
  assert.equal(trackingImage('https://news.test/open.gif'), true);
  assert.equal(trackingImage('https://img.test/a.png'), false);
  await assert.rejects(
    feeds.reader({ type: 'feedImage', url: 'https://pixel.wp.com/g.gif' }, readerSender),
    /Not loaded/,
  );
  // Images off for this subscription: nothing is fetched.
  await feeds.message({
    type: 'feedsUpdate',
    sourceId: openedItem.source.id,
    settings: { images: false },
  });
  await feeds.reader({ type: 'feedOpen' }, readerSender);
  requests.length = 0;
  await assert.rejects(
    feeds.reader({ type: 'feedImage', url: 'https://img.test/a.png' }, readerSender),
    /Images are off/,
  );
  assert.equal(requests.length, 0);

  // Full text: the item's own link, with the site's cookies (R3), never another address.
  routes.set('https://read.test/short?utm_source=rss', () =>
    respond('<html><body><article><p>Whole text.</p></article></body></html>', {
      'content-type': 'text/html; charset=utf-8',
    }),
  );
  requests.length = 0;
  const page = await feeds.reader(
    { type: 'feedFullText', url: 'https://evil.test/' },
    readerSender,
  );
  assert.match(page.html, /Whole text/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://read.test/short?utm_source=rss');
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(requests[0].options.referrerPolicy, 'no-referrer');
  await feeds.reader({ type: 'feedContent', html: '<p>Whole text.</p>' }, readerSender);
  assert.equal((await request('vault/feeds/open', { url: itemUrl })).content.kind, 'fulltext');

  // Later and archive for an item not saved yet stay in the subscriptions.
  await feeds.reader({ type: 'feedState', state: 'later' }, readerSender);
  assert.deepEqual(
    (await request('vault/feeds/library', { view: 'later' })).items.map((entry) => entry.url),
    [itemUrl],
  );

  // Before the first highlight the reader hands over its text; the item becomes a document
  // with a feed origin, and its later state moves to the document.
  const replies = [];
  const portListeners = [];
  const port = {
    name: 'clip',
    sender: { tab: { id: 77 }, frameId: 0, documentId: 'reader-doc', url: readerSender.url },
    onMessage: { addListener: (fn) => portListeners.push(fn) },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      replies.push(message);
      if (message.type !== 'command') return;
      queueMicrotask(() =>
        portListeners.forEach((fn) =>
          fn({
            type: 'reply',
            id: message.id,
            result: {
              method: 'fulltext',
              result: {
                ok: true,
                mode: 'article',
                extractor: 'defuddle',
                title: 'Short one',
                html: '<p>Whole text.</p>',
                markdown: 'Whole text.',
                images: [],
                imageToken: '',
                words: 2,
                chars: 11,
              },
            },
          }),
        ),
      );
    },
    disconnect() {},
  };
  assert.equal(registerClipPort(port), true);
  const committed = await feeds.commit(77, itemUrl);
  assert.equal(committed.saved, true);
  assert.equal(replies.at(-1).command.type, 'feedCommit');
  const resolved = await request('vault/document/resolve', {
    url: itemUrl,
    title: '',
    kind: 'web',
  });
  assert.equal(resolved.clip.complete, true);
  assert.equal(resolved.document.library.state, 'later');
  const article = JSON.parse(
    fs.readFileSync(path.join(resolved.document.folder, 'article.json'), 'utf8'),
  );
  assert.equal(article.origin.type, 'feed');
  assert.equal(article.origin.method, 'fulltext');
  assert.equal(article.origin.sourceTitle, 'Reader');
  assert.equal(article.origin.pageUrl, 'https://read.test/short?utm_source=rss');
  const later = await request('vault/feeds/library', { view: 'later' });
  assert.deepEqual(
    later.items.map((entry) => [entry.kind, entry.url]),
    [['document', itemUrl]],
  );
  // Saved: the reader now shows the vault copy; state changes go to the document.
  assert.equal((await feeds.reader({ type: 'feedOpen' }, readerSender)).saved, true);
  await feeds.reader({ type: 'feedState', state: 'archive' }, readerSender);
  assert.equal(
    (await request('vault/document/resolve', { url: itemUrl, title: '', kind: 'web' })).document
      .library.state,
    'archive',
  );
  // A reader that is not showing an unsaved item answers nothing: nothing is saved.
  port.postMessage = (message) => {
    if (message.type === 'command')
      queueMicrotask(() => portListeners.forEach((fn) => fn({ type: 'reply', id: message.id })));
  };
  assert.equal(await feeds.commit(77, itemUrl), null);
  console.log('PASS the reader opens, fetches images and full text, and saves feed items');

  // Unsubscribing everything removes the alarms.
  for (const source of (await feeds.message({ type: 'feedsSources' })).sources)
    await feeds.message({ type: 'feedsUnsubscribe', sourceId: source.id });
  assert.equal(stored.feedsActive, false);
  assert.equal(alarms.size, 0);
  await assert.rejects(feeds.message({ type: 'feedsNope' }), /Unknown subscription message/);
  console.log('PASS unsubscribing the last feed stops the schedule');
} finally {
  python.stdin.end();
  fs.rmSync(temp, { recursive: true, force: true });
}

async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    if (await check()) return;
  }
  throw Error('Timed out waiting for ' + check);
}
