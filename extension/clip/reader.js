// Tabgent's reader of a clipped webpage: clip/reader.html?url=<page URL>. It shows the
// page's clipped copy from the vault (article.html and its saved images), offline, and
// loads the webpage reading layer on it, so highlights, notes and Ask AI belong to the
// page's own vault document. The clipped HTML is untrusted: it is cleaned again here with
// the shared allowlist, under a policy that allows no remote loads, frames or forms.
import DOMPurify from '../vendor/dompurify/purify.js';
import { localize, t, loadTimeData } from '../i18n.js';

const { config, remote } = globalThis.tabgentClipSanitize;
const $ = (id) => document.getElementById(id);
const CHUNK = 1024 * 1024;
const prefix = chrome.runtime.getURL('clip/reader.html') + '?url=';
// The page this reader shows; the service worker reads the same address from this tab.
const page = (() => {
  try {
    const url = new URL(location.href.slice(prefix.length));
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
})();
localize();

// The worker accepts this reader's messages only while its 'clip' port is registered.
let port,
  ready = null;
function connect() {
  const current = (port = chrome.runtime.connect({ name: 'clip' }));
  ready = new Promise((resolve) =>
    current.onMessage.addListener((message) => message?.type === 'ready' && resolve()),
  );
  current.onDisconnect.addListener(() => {
    ready = null;
    setTimeout(connect, 500);
  });
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
// Images show their vault copy, loaded when they come into view; an image that was not
// saved shows its description and a link to it online.
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
      // Every address the image was saved from (records before sources name only source).
      .flatMap((asset) =>
        [asset.source, ...(Array.isArray(asset.sources) ? asset.sources : [])].map((source) => [
          source,
          asset.file,
        ]),
      ),
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
async function showImage(img) {
  const file = img.getAttribute('data-tabgent-asset');
  if (!images.has(file))
    images.set(
      file,
      readAll('clipAsset', { file }).then(({ reply, bytes }) =>
        URL.createObjectURL(new Blob([bytes], { type: reply.mime })),
      ),
    );
  try {
    img.src = await images.get(file);
  } catch {
    missing(img, img.getAttribute('data-remote-src'));
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
  if (page) {
    const link = document.createElement('a');
    link.href = page;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = t('clipOriginal');
    $('status').append(' ', link);
  }
}

async function show() {
  if (!page) return fail(t('clipNotFound'));
  $('original').href = page;
  $('original').hidden = false;
  $('site').textContent = new URL(page).hostname;
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
  const fragment = DOMPurify.sanitize(new TextDecoder().decode(bytes), {
    ...config,
    SANITIZE_NAMED_PROPS: true,
    RETURN_DOM_FRAGMENT: true,
  });
  links(fragment);
  const pending = prepareImages(fragment, clip.assets);
  const content = $('content');
  content.lang = clip.language || '';
  content.dir = clip.direction === 'rtl' ? 'rtl' : 'ltr';
  content.replaceChildren(fragment);
  for (const img of pending) watcher.observe(img);
  const title = clip.title || reply.document?.title || page;
  document.title = title;
  $('pageTitle').textContent = title;
  const when = Date.parse(clip.origin?.clippedAt);
  $('byline').textContent = [
    clip.author,
    clip.siteName || new URL(page).hostname,
    Number.isNaN(when)
      ? ''
      : loadTimeData.getStringF(
          'readingClipped',
          new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(when),
        ),
  ]
    .filter(Boolean)
    .join(' · ');
  $('status').hidden = true;
  $('delete').hidden = false;
  // The webpage reading layer works on the clipped text as on the live page; its anchors
  // are marked as made in the clipped copy.
  globalThis.tabgentReadingView = {
    name: 'clip',
    url: page,
    root: content,
    title,
    meta: {
      author: clip.author || '',
      siteName: clip.siteName || '',
      publishedAt: clip.publishedAt || '',
    },
  };
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

$('library').onclick = () => {
  location.href = chrome.runtime.getURL('epub/reader.html');
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
const stored = (await chrome.storage.local.get(SETTINGS))[SETTINGS];
if (Number.isInteger(stored?.size)) await setSize(stored.size);
connect();
await show();
