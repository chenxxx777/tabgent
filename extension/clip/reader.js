// Tabgent's reader: clip/reader.html?url=<page URL>. It shows a webpage's clipped copy from
// the vault (article.html and its saved images), offline, or a feed item that is not saved
// yet (from the subscriptions, with its images fetched by the service worker), and loads the
// webpage reading layer on it, so highlights, notes and Ask AI belong to the page's own
// vault document. The HTML is untrusted: it is cleaned again here with the shared allowlist,
// under a policy that allows no remote loads, web frames or forms.
import DOMPurify from '../vendor/dompurify/purify.js';
import { localize, t, loadTimeData } from '../i18n.js';

const { config, remote } = globalThis.tabgentClipSanitize;
const $ = (id) => document.getElementById(id);
const CHUNK = 1024 * 1024;
const prefix = chrome.runtime.getURL('clip/reader.html') + '?url=';
const web = (value) => /^https?:\/\//i.test(value || '');
// The page this reader shows; the service worker reads the same address from this tab. A
// feed item without a link is named urn:tabgent:feed:<hash>.
const page = (() => {
  const rest = location.href.slice(prefix.length);
  const urn = /^urn:tabgent:feed:[0-9a-f]{64}(?=#|$)/.exec(rest);
  if (urn) return urn[0];
  try {
    const url = new URL(rest);
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
})();
const dates = new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), {
  dateStyle: 'medium',
  timeStyle: 'short',
});
localize();

// A feed item: { item, source, saved, current: { result, method } } once shown.
let feed = null;

// The worker accepts this reader's messages only while its 'clip' port is registered; it
// also asks the reader for a feed item's text before the item's first highlight.
let port,
  ready = null;
function connect() {
  const current = (port = chrome.runtime.connect({ name: 'clip' }));
  ready = new Promise((resolve) =>
    current.onMessage.addListener((message) => {
      if (message?.type === 'ready') resolve();
      else if (message?.type === 'command') answer(current, message);
    }),
  );
  current.onDisconnect.addListener(() => {
    ready = null;
    setTimeout(connect, 500);
  });
}
function answer(target, { id, command }) {
  let result = null;
  if (command?.type === 'feedCommit' && feed?.current && !feed.saved) {
    result = { result: feed.current.result, method: feed.current.method };
    savedNow();
  }
  target.postMessage({ type: 'reply', id, result });
}
async function send(message, retry = true) {
  if (!ready) connect();
  await ready;
  const reply = await chrome.runtime.sendMessage(message);
  // A restarted service worker has not seen this reader's port yet.
  if (reply?.error === 'Invalid clipped page reader' && retry) {
    port.disconnect();
    connect();
    return send(message, false);
  }
  if (reply?.error) throw Object.assign(Error(reply.error), { code: reply.code });
  return reply;
}
async function readAll(type, fields = {}) {
  const parts = [];
  let offset = 0,
    reply;
  do {
    reply = await send({ type, ...fields, offset, length: CHUNK });
    const bytes = Uint8Array.fromBase64(reply.data);
    if (!bytes.length && !reply.eof) throw Error('The vault returned no data');
    parts.push(bytes);
    offset += bytes.length;
  } while (!reply.eof);
  return { reply, bytes: new Uint8Array(await new Blob(parts).arrayBuffer()) };
}
async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Cleaning untrusted HTML (a feed item, or a page fetched for its full text) runs in the
// same-origin extract.html frame: its scripts run under the frame's own policy, without the
// Trusted Types this page enforces, which Defuddle and HTML parsing cannot meet.
const cleaner = new Promise((resolve) => {
  const frame = $('cleaner');
  const found = () =>
    frame.contentWindow?.tabgentClip?.clean && resolve(frame.contentWindow.tabgentClip);
  if (!found()) frame.addEventListener('load', () => found() || resolve(null), { once: true });
});
async function clean(request) {
  const frame = await cleaner;
  if (!frame) return { ok: false, message: 'The cleaner did not load' };
  return frame.clean(request);
}

// Links open in a new tab; fragments point to the prefixed ids DOMPurify writes.
function links(root) {
  for (const link of root.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (href.startsWith('#')) {
      if (href.length > 1 && !href.startsWith('#user-content-'))
        link.setAttribute('href', '#user-content-' + href.slice(1));
    } else if (/^(?:https?|mailto):/i.test(href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = href;
    } else link.removeAttribute('href');
  }
}
// Images are loaded when they come into view: a clip's from its vault copy, a feed item's
// through the service worker. An image that cannot be shown shows its description and a
// link to it online.
const images = new Map();
const watcher = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      watcher.unobserve(entry.target);
      void showImage(entry.target);
    }
  },
  { rootMargin: '800px 0px' },
);
function missing(img, source) {
  const box = document.createElement(remote(source) ? 'a' : 'span');
  box.className = 'missing';
  box.textContent = [img.getAttribute('alt') || '', t('clipImageMissing')]
    .filter(Boolean)
    .join(' · ');
  if (remote(source)) {
    box.href = source;
    box.target = '_blank';
    box.rel = 'noopener noreferrer';
  }
  img.replaceWith(box);
}
function prepareImages(root, assets) {
  const files = new Map(
    (Array.isArray(assets) ? assets : [])
      .filter((asset) => /^assets\/[0-9a-f]{16}\.(?:jpg|png|gif|webp|avif)$/.test(asset?.file))
      .map((asset) => [asset.source, asset.file]),
  );
  const pending = [];
  for (const img of root.querySelectorAll('img')) {
    const source = img.getAttribute('data-remote-src');
    const file = files.get(source);
    if (!file) {
      missing(img, source);
      continue;
    }
    img.setAttribute('data-tabgent-asset', file);
    img.decoding = 'async';
    pending.push(img);
  }
  return pending;
}
// A feed item's images, unless the user turned them off for its subscription.
function prepareRemoteImages(root, allowed) {
  const pending = [];
  for (const img of root.querySelectorAll('img')) {
    const source = img.getAttribute('data-remote-src');
    if (!allowed || !remote(source)) {
      missing(img, source);
      continue;
    }
    img.decoding = 'async';
    pending.push(img);
  }
  return pending;
}
async function showImage(img) {
  const file = img.getAttribute('data-tabgent-asset');
  const source = img.getAttribute('data-remote-src');
  const key = file || source;
  if (!images.has(key))
    images.set(
      key,
      file
        ? readAll('clipAsset', { file }).then(({ reply, bytes }) =>
            URL.createObjectURL(new Blob([bytes], { type: reply.mime })),
          )
        : send({ type: 'feedImage', url: source }).then((reply) =>
            URL.createObjectURL(
              new Blob([Uint8Array.fromBase64(reply.data)], { type: reply.mime }),
            ),
          ),
    );
  try {
    img.src = await images.get(key);
  } catch {
    missing(img, source);
  }
}
addEventListener('pagehide', () => {
  for (const url of images.values()) void url.then(URL.revokeObjectURL, () => {});
});

// Reading position and text size stay in extension storage, as for EPUB books.
const POSITIONS = 'clipPositions',
  SETTINGS = 'clipReader';
async function savePosition() {
  const room = document.documentElement.scrollHeight - innerHeight;
  const all = (await chrome.storage.local.get(POSITIONS))[POSITIONS] || {};
  all[page] = { fraction: room > 0 ? scrollY / room : 0, at: Date.now() };
  const recent = Object.entries(all)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, 500);
  await chrome.storage.local.set({ [POSITIONS]: Object.fromEntries(recent) });
}
async function restorePosition() {
  const saved = (await chrome.storage.local.get(POSITIONS))[POSITIONS]?.[page];
  if (!saved) return;
  scrollTo(0, saved.fraction * (document.documentElement.scrollHeight - innerHeight));
}
let size = 19;
async function setSize(value) {
  size = Math.min(28, Math.max(14, value));
  document.documentElement.style.setProperty('--size', `${size}px`);
  await chrome.storage.local.set({ [SETTINGS]: { size } });
}

function fail(message) {
  $('status').hidden = false;
  $('status').replaceChildren(message);
  const original = feed ? feed.item.url : page;
  if (web(original)) {
    const link = document.createElement('a');
    link.href = original;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = t('clipOriginal');
    $('status').append(' ', link);
  }
}
function notice(message) {
  $('notice').hidden = !message;
  $('notice').textContent = message || '';
}

// Shows cleaned HTML and loads the webpage reading layer on it; its anchors are marked as
// made in this view.
async function present({ html, title, byline, language, direction, meta, images: prepare }) {
  const fragment = DOMPurify.sanitize(html, {
    ...config,
    SANITIZE_NAMED_PROPS: true,
    RETURN_DOM_FRAGMENT: true,
  });
  links(fragment);
  const pending = prepare(fragment);
  const content = $('content');
  content.lang = language || '';
  content.dir = direction === 'rtl' ? 'rtl' : 'ltr';
  content.replaceChildren(fragment);
  for (const img of pending) watcher.observe(img);
  document.title = title;
  $('pageTitle').textContent = title;
  $('byline').textContent = byline.filter(Boolean).join(' · ');
  $('status').hidden = true;
  globalThis.tabgentReadingView = { name: 'clip', url: page, root: content, title, meta };
  await import('../selection-content.js');
  await import('../highlight-content.js');
  await restorePosition();
  let timer;
  addEventListener(
    'scroll',
    () => {
      clearTimeout(timer);
      timer = setTimeout(() => void savePosition(), 800);
    },
    { passive: true },
  );
}

async function showClip() {
  let loaded;
  try {
    loaded = await readAll('clipRead');
  } catch (error) {
    return fail(error.code === 'not_found' ? t('clipNotFound') : error.message);
  }
  const { reply, bytes } = loaded;
  const clip = reply.clip;
  if (!clip.summary?.complete || (await sha256(bytes)) !== clip.html?.sha256)
    return fail(t('clipIncomplete'));
  const when = Date.parse(clip.origin?.clippedAt);
  const title = clip.title || reply.document?.title || page;
  if (!feed) $('delete').hidden = false;
  await present({
    html: new TextDecoder().decode(bytes),
    title,
    byline: [
      clip.author,
      clip.siteName || (web(page) ? new URL(page).hostname : ''),
      Number.isNaN(when) ? '' : loadTimeData.getStringF('readingClipped', dates.format(when)),
    ],
    language: clip.language,
    direction: clip.direction,
    meta: {
      author: clip.author || '',
      siteName: clip.siteName || '',
      publishedAt: clip.publishedAt || '',
    },
    images: (root) => prepareImages(root, clip.assets),
  });
}

// A feed item's full text: its page, fetched by the worker with the site's cookies, read
// without running it. null when it is not a readable article.
async function fullText() {
  const fetched = await send({ type: 'feedFullText' });
  const result = await clean({
    kind: 'page',
    html: fetched.html,
    url: fetched.url,
    title: feed.item.title,
  });
  if (!result.ok || result.tooLittle) return null;
  await send({ type: 'feedContent', html: result.html }).catch(() => {});
  return result;
}
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

async function showItem({ item, source, content }) {
  const base = web(item.link) ? item.link : source.url;
  const described = {
    url: base,
    title: item.title,
    byline: item.author,
    publishedAt: item.publishedAt || '',
  };
  const mode = source.settings.fullText || 'auto';
  let result = null,
    method = 'feed';
  if (content?.kind === 'fulltext') {
    result = await clean({ kind: 'feed', html: content.html, ...described });
    method = 'fulltext';
  } else if (
    web(item.link) &&
    (mode === 'always' || (mode === 'auto' && item.contentKind === 'summary'))
  ) {
    $('status').textContent = t('feedsLoadingFullText');
    result = await fullText().catch(() => null);
    if (result) method = 'fulltext';
    else notice(t('feedsFullTextFailed'));
  }
  if (!result?.ok) {
    method = 'feed';
    const html = content?.html || `<p>${escapeHtml(item.summary || '')}</p>`;
    result = await clean({ kind: 'feed', html, ...described });
  }
  if (!result.ok) return fail(result.message || t('clipNotFound'));
  feed.current = { result, method };
  $('fullText').hidden = method === 'fulltext' || !web(item.link);
  const published = Date.parse(item.publishedAt);
  await present({
    html: result.html,
    title: item.title || result.title || page,
    byline: [
      item.author,
      loadTimeData.getStringF('feedsFrom', item.sources.join(', ') || source.title),
      Number.isNaN(published) ? '' : dates.format(published),
    ],
    language: result.language,
    direction: result.direction,
    meta: {
      author: item.author || '',
      siteName: source.title || '',
      publishedAt: item.publishedAt || '',
    },
    images: (root) => prepareRemoteImages(root, source.settings.images !== false),
  });
}

function savedNow() {
  feed.saved = true;
  $('save').disabled = true;
  $('save').textContent = t('feedsSaved');
}
function pressed(state) {
  $('later').setAttribute('aria-pressed', String(state === 'later'));
  $('archive').setAttribute('aria-pressed', String(state === 'archive'));
}

async function show() {
  if (!page) return fail(t('clipNotFound'));
  if (web(page)) {
    $('original').href = page;
    $('original').hidden = false;
    $('site').textContent = new URL(page).hostname;
  }
  // A feed item shows from the subscriptions until it is saved; then from the vault.
  let opened = null;
  try {
    opened = await send({ type: 'feedOpen' });
  } catch (error) {
    if (error.code !== 'not_found') return fail(error.message);
  }
  if (opened) {
    feed = { item: opened.item, source: opened.source, saved: opened.saved };
    $('feedTools').hidden = false;
    $('site').textContent = opened.item.sources.join(', ') || opened.source.title;
    // "Original page" opens the address without tracking parameters.
    $('original').hidden = !web(opened.item.url);
    if (web(opened.item.url)) $('original').href = opened.item.url;
    pressed(opened.saved ? opened.document?.library?.state : opened.item.state);
    if (opened.saved) savedNow();
    if (!opened.saved) return showItem(opened);
  }
  await showClip();
}

$('library').onclick = () => {
  location.href = chrome.runtime.getURL('epub/reader.html');
};
$('back').onclick = () => {
  location.href = chrome.runtime.getURL('epub/reader.html') + '?view=feeds';
};
$('smaller').onclick = () => void setSize(size - 1);
$('larger').onclick = () => void setSize(size + 1);
$('delete').onclick = async () => {
  if (!confirm(t('clipDeleteConfirm'))) return;
  try {
    await send({ type: 'clipDelete' });
    $('content').replaceChildren();
    $('delete').hidden = true;
    fail(t('clipDeleted'));
  } catch (error) {
    fail(error.message);
  }
};
$('fullText').onclick = async () => {
  $('fullText').disabled = true;
  notice(t('feedsLoadingFullText'));
  const result = await fullText().catch(() => null);
  // The reading layer works on the text it loaded with; the page shows the full text again.
  if (result) location.reload();
  else {
    notice(t('feedsFullTextFailed'));
    $('fullText').disabled = false;
  }
};
$('save').onclick = async () => {
  if (!feed?.current || feed.saved) return;
  $('save').disabled = true;
  try {
    await send({ type: 'feedSave', result: feed.current.result, method: feed.current.method });
    savedNow();
    notice(t('feedsSavedNotice'));
  } catch (error) {
    $('save').disabled = false;
    notice(loadTimeData.getStringF('feedsSaveFailed', error.message));
  }
};
for (const state of ['later', 'archive'])
  $(state).onclick = async () => {
    const next = $(state).getAttribute('aria-pressed') === 'true' ? 'inbox' : state;
    try {
      await send({ type: 'feedState', state: next });
      pressed(next);
    } catch (error) {
      notice(error.message);
    }
  };
const stored = (await chrome.storage.local.get(SETTINGS))[SETTINGS];
if (Number.isInteger(stored?.size)) await setSize(stored.size);
connect();
await show();
