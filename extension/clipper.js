// Clipping a webpage into the ReadingVault. The service worker injects the clipping script
// into the page's top frame only when the user clips it, asks there before replacing an
// earlier clip, bounds what the page returns (it is untrusted) and saves it with
// vault/clip/save. The page and its clipped copy are one vault document, named by its URL.
import { cleanPageMeta, documentUrl } from './vault-client.js';

const FILES = [
  'vendor/defuddle/defuddle.js',
  'vendor/turndown/turndown.js',
  'vendor/dompurify/purify.umd.js',
  'clip/sanitize-config.js',
  'clip/clip-content.js',
];
export const CLIP_LIMIT = { markdown: 3 * 1024 * 1024, html: 4 * 1024 * 1024, images: 200 };
const METHODS = ['article', 'page', 'selection'];
const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
const count = (value) => (Number.isInteger(value) && value >= 0 ? Math.min(value, 1e8) : 0);
const bytes = (value) => new TextEncoder().encode(value).length;
const t = (key, ...values) => chrome.i18n.getMessage(key, values.map(String)) || key;

// The page's result reshaped to the vault contract; null when it is not usable.
export function cleanClip(result) {
  // Oversized text is refused, not cut: a cut could end inside markup.
  const markdown = text(result?.markdown, CLIP_LIMIT.markdown + 1),
    html = text(result?.html, CLIP_LIMIT.html + 1);
  if (
    result?.ok !== true ||
    !markdown.trim() ||
    !html.trim() ||
    bytes(markdown) > CLIP_LIMIT.markdown ||
    bytes(html) > CLIP_LIMIT.html
  )
    return null;
  const images = (Array.isArray(result.images) ? result.images : [])
    .slice(0, CLIP_LIMIT.images)
    .filter((image) => /^https?:\/\//i.test(text(image?.url, 4096)));
  return {
    title: text(result.title, 500),
    meta: cleanPageMeta({
      author: result.byline,
      siteName: result.siteName,
      publishedAt: result.publishedAt,
    }),
    markdown,
    html,
    method: METHODS.includes(result.mode) ? result.mode : 'article',
    extractor: text(result.extractor, 60),
    language: text(result.language, 35),
    direction: result.direction === 'rtl' ? 'rtl' : 'ltr',
    excerpt: text(result.excerpt, 1000),
    words: count(result.words),
    chars: count(result.chars),
    truncated: result.truncated === true,
    images: images.length,
    posts: count(result.posts),
  };
}

export function createClipper({ vault, changed = () => {} }) {
  const running = new Set();

  async function inject(tabId, func, args) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func,
      args,
    });
    return result;
  }
  // A status line in the page; it is shown only while the clipping script is there.
  const say = (tabId, value) =>
    inject(tabId, (o) => globalThis.tabgentClip?.notify(o), [value]).catch(() => {});

  async function clipTab(tabId, mode, expected) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    // The frame record follows same-document navigation; sender-style checks use it too.
    const frame =
      tab && !tab.incognito
        ? await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null)
        : null;
    if (!frame || !/^https?:/i.test(frame.url || '')) return { ok: false, reason: 'unsupported' };
    const url = documentUrl(frame.url);
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: FILES });
    // Every step checks that the page is still the document the user chose to clip.
    const current = (result) => {
      if (frame.documentId && result?.documentId && result.documentId !== frame.documentId)
        throw Object.assign(Error('The page changed while it was being clipped'), {
          reason: 'navigated',
        });
      return result?.result;
    };
    // A prompt can stay open while a single-page app moves to another address (the same
    // document): the clip would save that page under this one's URL.
    const still = async () => {
      const now = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);
      if (!now || now.documentId !== frame.documentId || documentUrl(now.url) !== url)
        throw Object.assign(Error('The page changed while it was being clipped'), {
          reason: 'navigated',
        });
    };
    const ask = async (options) => {
      const choice =
        current(await inject(tabId, (o) => globalThis.tabgentClip.ask(o), [options])) || 'cancel';
      await still();
      return choice;
    };
    const extract = async (method) =>
      current(
        await inject(tabId, (o) => globalThis.tabgentClip.run(o), [
          { mode: method, url: frame.url, ...(method === 'selection' ? { expected } : {}) },
        ]),
      );

    const resolved = await vault.request('vault/document/resolve', {
      url,
      title: text(tab.title, 500),
      kind: 'web',
    });
    const existing = resolved.document?.createdAt && resolved.clip ? resolved.clip : null;
    if (existing && (await ask({ kind: 'replace', clippedAt: existing.clippedAt })) !== 'replace')
      return { ok: false, reason: 'cancelled' };
    await say(tabId, { text: t('clipSaving'), busy: true });
    let result = await extract(mode);
    if (result?.ok && result.tooLittle) {
      const choice = await ask({ kind: 'tooLittle', hasSelection: result.hasSelection });
      if (!METHODS.includes(choice)) return { ok: false, reason: 'cancelled' };
      await say(tabId, { text: t('clipSaving'), busy: true });
      result = await extract(choice);
    }
    if (!result?.ok) {
      const reason = result?.reason || 'error';
      const message = {
        'x-not-post': t('clipXOpenPost'),
        'no-selection': t('clipNoSelection'),
        navigated: t('clipNavigated'),
      }[reason];
      await say(tabId, { text: message || t('clipFailed', result?.message || ''), tone: 'error' });
      return { ok: false, reason };
    }
    const clip = cleanClip(result);
    if (!clip) {
      await say(tabId, { text: t('clipFailed', ''), tone: 'error' });
      return { ok: false, reason: 'invalid' };
    }
    const saved = await vault.request(
      'vault/clip/save',
      {
        url,
        title: clip.title || text(tab.title, 500),
        kind: 'web',
        meta: clip.meta,
        markdown: clip.markdown,
        html: clip.html,
        origin: { method: clip.method, extractor: clip.extractor, pageUrl: frame.url },
        language: clip.language,
        direction: clip.direction,
        excerpt: clip.excerpt,
        words: clip.words,
        chars: clip.chars,
        truncated: clip.truncated,
        // Images stay at their addresses: article.md links them and the vault has no copy.
        images: { found: clip.images, saved: 0, remote: clip.images },
        ...(existing ? { replace: true, expected: existing.clippedAt } : {}),
      },
      { timeout: 60000 },
    );
    if (!saved.saved) {
      // Another tab saved a clip of this page meanwhile.
      await say(tabId, { text: t('clipConflict'), tone: 'error' });
      return { ok: false, reason: 'conflict' };
    }
    const title = clip.title || saved.document?.title || '';
    await say(tabId, {
      text: [
        t('clipSaved', title, clip.words),
        clip.posts ? t('clipXPartial', clip.posts) : '',
        clip.truncated ? t('clipTruncated') : '',
      ]
        .filter(Boolean)
        .join(' '),
    });
    changed(tabId);
    return { ok: true, document: saved.document, clip: saved.clip, backup: saved.backup || null };
  }

  // One clip at a time per tab; a repeated shortcut while one runs does nothing.
  // expected: for a selection, the quote the user chose; the page's selection must still hold it.
  async function clip(tabId, { mode = 'article', expected = '' } = {}) {
    if (!Number.isInteger(tabId) || running.has(tabId)) return { ok: false, reason: 'busy' };
    running.add(tabId);
    try {
      return await clipTab(tabId, METHODS.includes(mode) ? mode : 'article', text(expected, 20000));
    } catch (error) {
      if (error?.reason) {
        await say(tabId, { text: t('clipNavigated'), tone: 'error' });
        return { ok: false, reason: error.reason };
      }
      await say(tabId, { text: t('clipSaveFailed', error?.message || ''), tone: 'error' });
      return { ok: false, reason: 'error', message: error?.message || String(error) };
    } finally {
      running.delete(tabId);
    }
  }
  return { clip };
}
