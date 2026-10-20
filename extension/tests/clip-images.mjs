// A clip's images in the service worker, with a scripted fetch: real image types by their
// first bytes, count, size, total and time limits, cookies only for the page's own site, no
// referrer, one file per distinct image, chunked uploads one image at a time, and the
// Markdown placeholders filled with saved files or web addresses. Nothing is fetched.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  IMAGE_LIMIT,
  sniff,
  sameSite,
  fetchImages,
  uploadImages,
  localizeMarkdown,
  destination,
} from '../clip-images.js';

Uint8Array.prototype.toBase64 ??= function () {
  return Buffer.from(this).toString('base64');
};
const bytes = (head, size = 64) => {
  const value = new Uint8Array(size);
  value.set(typeof head === 'string' ? Buffer.from(head, 'latin1') : head);
  return value;
};
const PNG = bytes([0x89, ...Buffer.from('PNG\r\n\u001a\n', 'latin1')], 300);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], 200);
const GIF = bytes('GIF89a', 100);
const WEBP = bytes('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 120);
const AVIF = bytes('\u0000\u0000\u0000\u001cftypavif', 120);
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

assert.equal(sniff(PNG), 'png');
assert.equal(sniff(JPEG), 'jpg');
assert.equal(sniff(GIF), 'gif');
assert.equal(sniff(WEBP), 'webp');
assert.equal(sniff(AVIF), 'avif');
assert.equal(sniff(bytes('<svg xmlns="http://www.w3.org/2000/svg">')), null);
assert.equal(sniff(bytes('<!doctype html><title>Not found</title>')), null);
assert.equal(sniff(new Uint8Array(0)), null);
console.log('PASS image types come from their first bytes; SVG and HTML are not images');

assert(sameSite('https://cdn.example.test/a.png', 'https://www.example.test/post'));
assert(sameSite('https://example.co.uk/a.png', 'https://news.example.co.uk/post'));
assert(!sameSite('https://other.co.uk/a.png', 'https://example.co.uk/post'));
assert(!sameSite('https://pbs.twimg.com/media/a.jpg', 'https://x.com/a/status/1'));
assert(!sameSite('not a url', 'https://example.test/'));
console.log('PASS cookies go only to images on the page site');

// A scripted network: each address answers with a status, bytes, headers or a delay.
function network(routes) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, ...options });
    const route = routes[url];
    if (!route) throw TypeError('Failed to fetch');
    // A redirect: opaque when not followed, as fetch reports it; else the target's answer.
    if (route.redirect) {
      if (options.redirect === 'manual') return { type: 'opaqueredirect', ok: false, status: 0 };
      calls.push({ url: route.redirect, ...options, redirected: true });
      return new Response(routes[route.redirect].body);
    }
    if (route.delay)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, route.delay);
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(options.signal.reason);
        });
      });
    const headers = new Headers(route.headers || {});
    return new Response(route.status === 304 ? null : route.body || new Uint8Array(0), {
      status: route.status || 200,
      headers,
    });
  };
  return { fetch, calls };
}
const page = 'https://www.example.test/essay';
const routes = {
  'https://www.example.test/a.png': { body: PNG },
  'https://cdn.example.test/b.jpg': { body: JPEG },
  'https://cdn.other.test/same-as-a.png': { body: PNG },
  'https://cdn.other.test/forbidden.png': { status: 403, body: bytes('Forbidden') },
  'https://cdn.other.test/vector.svg': { body: bytes('<svg xmlns="http://www.w3.org/2000/svg">') },
  'https://cdn.other.test/huge.png': { body: PNG, headers: { 'content-length': '999999999' } },
  'https://cdn.other.test/stream.png': { body: bytes(PNG.subarray(0, 9), 6000) },
  'https://cdn.other.test/slow.gif': { body: GIF, delay: 400 },
};
const { fetch, calls } = network(routes);
const images = [
  { url: 'https://www.example.test/a.png' },
  { url: 'https://cdn.example.test/b.jpg' },
  { url: 'https://cdn.other.test/same-as-a.png' },
  { url: 'https://cdn.other.test/forbidden.png' },
  { url: 'https://cdn.other.test/vector.svg' },
  { url: 'https://cdn.other.test/huge.png' },
  { url: 'https://cdn.other.test/stream.png' },
  { url: 'https://cdn.other.test/slow.gif' },
  { url: 'https://cdn.other.test/missing.png' },
  { url: '' },
  { url: 'https://www.example.test/a.png' },
];
const progress = [];
const result = await fetchImages(images, page, {
  fetch,
  limit: { ...IMAGE_LIMIT, size: 5000, timeout: 100 },
  onProgress: (done, total) => progress.push([done, total]),
});
// One file per distinct image: the same bytes at two addresses are one asset.
assert.deepEqual(
  result.assets.map(({ ext, size, sha256 }) => [ext, size, sha256]),
  [
    ['png', PNG.length, sha(PNG)],
    ['jpg', JPEG.length, sha(JPEG)],
  ],
);
const pngFile = `${sha(PNG).slice(0, 16)}.png`;
assert.deepEqual(
  [...result.files],
  [
    [0, pngFile],
    [1, `${sha(JPEG).slice(0, 16)}.jpg`],
    [2, pngFile],
    [10, pngFile],
  ],
);
assert.deepEqual(
  Object.fromEntries(result.failed.map(({ source, reason }) => [source.split('/').pop(), reason])),
  {
    'forbidden.png': 'http_403',
    'vector.svg': 'not_image',
    'huge.png': 'too_large',
    'stream.png': 'too_large',
    'slow.gif': 'timeout',
    'missing.png': 'network',
  },
);
// Each address is fetched once, without a referrer; cookies only on the page's site.
const fetched = calls.map((call) => call.url);
assert.equal(new Set(fetched).size, fetched.length);
assert(calls.every((call) => call.referrerPolicy === 'no-referrer'));
assert.deepEqual(
  calls.filter((call) => call.credentials === 'include').map((call) => call.url),
  ['https://www.example.test/a.png', 'https://cdn.example.test/b.jpg'],
);
assert.equal(progress.at(-1)[0], 9);
assert(progress.every(([, total]) => total === 9));
console.log('PASS images are fetched once each, checked, limited and deduplicated');

// Count, total and time limits.
const many = Array.from({ length: 5 }, (_, i) => ({ url: `https://www.example.test/${i}.gif` }));
const manyRoutes = Object.fromEntries(
  many.map(({ url }, i) => [url, { body: bytes([...Buffer.from('GIF89a'), i], 2000) }]),
);
const counted = await fetchImages(many, page, {
  fetch: network(manyRoutes).fetch,
  limit: { ...IMAGE_LIMIT, count: 3, total: 5000, parallel: 1 },
});
assert.equal(counted.assets.length, 2);
assert.deepEqual(
  counted.failed.map(({ reason }) => reason),
  ['total_limit', 'count_limit', 'count_limit'],
);
const late = await fetchImages(many, page, {
  fetch: network(manyRoutes).fetch,
  limit: { ...IMAGE_LIMIT, budget: 0 },
});
assert.equal(late.assets.length, 0);
assert(late.failed.every(({ reason }) => reason === 'time_limit'));
console.log('PASS count, total and time limits leave the rest linked online');

// Cookies only on the first request: a same-site image that redirects is fetched again
// without cookies, so the site it redirects to never gets them.
const hop = network({
  'https://www.example.test/r?u=tracker': { redirect: 'https://tracker.test/p.png' },
  'https://tracker.test/p.png': { body: PNG },
});
const hopped = await fetchImages([{ url: 'https://www.example.test/r?u=tracker' }], page, {
  fetch: hop.fetch,
});
assert.deepEqual(
  hop.calls.map(({ url, credentials, redirect, redirected }) => [
    url,
    credentials,
    redirect,
    !!redirected,
  ]),
  [
    ['https://www.example.test/r?u=tracker', 'include', 'manual', false],
    ['https://www.example.test/r?u=tracker', 'omit', 'follow', false],
    ['https://tracker.test/p.png', 'omit', 'follow', true],
  ],
);
assert.equal(hopped.assets.length, 1);
console.log('PASS a redirect from the page site is followed without cookies');

// Uploads: one image at a time in chunks, resuming where the vault stopped.
const big = bytes(PNG, 5 * 1024 * 1024);
const requests = [];
const stored = new Map();
const vault = {
  async request(method, params) {
    requests.push({ method, params });
    const have = stored.get(params.sha256) || 0;
    if (params.data) {
      const chunk = Buffer.from(params.data, 'base64');
      if (params.offset === have) stored.set(params.sha256, have + chunk.length);
    }
    const received = stored.get(params.sha256) || 0;
    return { complete: received === params.size, received };
  },
};
await uploadImages(vault, [
  { sha256: sha(big), size: big.length, bytes: big },
  { sha256: sha(GIF), size: GIF.length, bytes: GIF },
]);
assert.deepEqual(
  requests.map(({ params }) => [params.sha256.slice(0, 4), params.offset, params.data.length > 0]),
  [
    [sha(big).slice(0, 4), 0, false],
    [sha(big).slice(0, 4), 0, true],
    [sha(big).slice(0, 4), 2 * 1024 * 1024, true],
    [sha(big).slice(0, 4), 4 * 1024 * 1024, true],
    [sha(GIF).slice(0, 4), 0, false],
    [sha(GIF).slice(0, 4), 0, true],
  ],
);
assert(requests.every(({ method }) => method === 'vault/clip/asset'));
await assert.rejects(
  uploadImages({ request: async () => ({ complete: false, received: 0 }) }, [
    { sha256: sha(GIF), size: GIF.length, bytes: GIF },
  ]),
  /stopped/,
);
console.log('PASS images upload in chunks, one at a time');

// Placeholders: saved images point to assets/, others to their address; a wrong token or
// a placeholder for an unknown image leaves nothing the page could choose.
const token = 'a'.repeat(32);
const markdown = [
  `![A](tabgent-image-${token}-0)`,
  `![B](tabgent-image-${token}-1)`,
  `![C](tabgent-image-${token}-7)`,
  `Text that mentions tabgent-image-${'b'.repeat(32)}-0.`,
].join('\n');
assert.equal(
  localizeMarkdown(
    markdown,
    token,
    [{ url: 'https://x.test/a.png' }, { url: 'https://x.test/a b (1).png' }],
    new Map([[0, 'abc.png']]),
  ),
  [
    '![A](assets/abc.png)',
    '![B](<https://x.test/a b (1).png>)',
    '![C]()',
    `Text that mentions tabgent-image-${'b'.repeat(32)}-0.`,
  ].join('\n'),
);
assert.equal(localizeMarkdown(markdown, 'not-a-token', [], new Map()), markdown);
// When web addresses would make the Markdown too long, unsaved images keep no link.
assert.equal(
  localizeMarkdown(
    `![A](tabgent-image-${token}-0) ![B](tabgent-image-${token}-1)`,
    token,
    [{ url: 'https://x.test/a.png' }, { url: 'https://x.test/b.png' }],
    new Map([[0, 'abc.png']]),
    { remote: false },
  ),
  '![A](assets/abc.png) ![B]()',
);
assert.equal(destination('https://x.test/a>b c'), '<https://x.test/a%3Eb c>');
console.log('PASS Markdown placeholders become saved files or web addresses');
