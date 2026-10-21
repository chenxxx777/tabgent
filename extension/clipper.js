// Clipping a webpage into the ReadingVault. The service worker injects the clipping script
// into the page's top frame only when the user clips it, asks there before replacing an
// earlier clip, bounds what the page returns (it is untrusted) and saves it with
// vault/clip/save. The page and its clipped copy are one vault document, named by its URL.
import { cleanPageMeta, documentUrl } from './vault-client.js';
import { fetchImages, localizeMarkdown, uploadImages } from './clip-images.js';
import { refererFetch } from './referer.js';
import { youtubePlayerData, youtubeVideoId } from './youtube-player.js';
import './user-error.js';

const FILES = [
  'vendor/defuddle/defuddle.js',
  'vendor/turndown/turndown.js',
  'vendor/dompurify/purify.umd.js',
  'clip/sanitize-config.js',
  'clip/clip-media.js',
  'clip/clip-content.js',
];
export const CLIP_LIMIT = { markdown: 3 * 1024 * 1024, html: 4 * 1024 * 1024, images: 200 };
const METHODS = ['article', 'page', 'selection'];
const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
const count = (value) => (Number.isInteger(value) && value >= 0 ? Math.min(value, 1e8) : 0);
const bytes = (value) => new TextEncoder().encode(value).length;
const t = (key, ...values) => chrome.i18n.getMessage(key, values.map(String)) || key;
// Clip reasons the page returns. Mapped by code so a real locale shows the sentence, and a
// test whose translator echoes the key still shows that key.
// Why a video's or podcast's transcript was not saved.
const TRANSCRIPT_REASON = {
  login: 'clipTranscriptLogin',
  none: 'clipTranscriptNone',
  empty: 'clipTranscriptEmpty',
  unplayable: 'clipTranscriptUnplayable',
};
const one = (value, list) => (list.includes(value) ? value : '');
const CLIP_REASON = {
  'x-layout': 'clipXLayout',
  'x-not-post': 'clipXOpenPost',
  'no-selection': 'clipNoSelection',
  navigated: 'clipNavigated',
};
function clipFailure(reason, message) {
  const key = CLIP_REASON[reason];
  const explained = key ? globalThis.tabgentExplainError?.({ code: reason, message: '' }, t) : '';
  if (explained && explained !== t('errorGeneric')) return explained;
  return key ? t(key) : t('clipFailed', message || '');
}

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
  // Image addresses keep their page order: the placeholders in the Markdown use it.
  const images = (Array.isArray(result.images) ? result.images : [])
    .slice(0, CLIP_LIMIT.images)
    .map((image) => ({ url: text(image?.url, 4096) }))
    .map((image) => (/^https?:\/\//i.test(image.url) ? image : { url: '' }));
  const cover = text(result.cover, 4097);
  // Where each value came from: a short name such as metadata or site:<host>.
  const metaSources = {};
  for (const key of ['author', 'publishedAt', 'siteName', 'cover']) {
    const source = result.metaSources?.[key];
    if (typeof source === 'string' && /^[a-z][a-z0-9.:-]{0,59}$/.test(source))
      metaSources[key] = source;
  }
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
    images,
    imageToken: /^[0-9a-f]{32}$/.test(result.imageToken || '') ? result.imageToken : '',
    posts: count(result.posts),
    // The page's cover image (og:image and the like), saved with the clip's images.
    cover: /^https?:\/\//i.test(cover) && cover.length <= 4096 ? cover : '',
    metaSources,
    // linksOnly: only links were found (an embedded video, a page whose text did not load);
    // notesOnly: a video's description or a podcast's show notes, without a transcript.
    contentStatus: one(result.contentStatus, ['linksOnly', 'notesOnly']) || 'text',
    transcript:
      result.transcript && typeof result.transcript === 'object'
        ? {
            status: one(result.transcript.status, ['saved', 'unavailable']) || 'unavailable',
            reason: one(result.transcript.reason, Object.keys(TRANSCRIPT_REASON)),
            language: text(result.transcript.language, 35),
            kind: one(result.transcript.kind, ['manual', 'auto']),
            name: text(result.transcript.name, 200),
            source: one(result.transcript.source, ['captions', 'player', 'panel', 'page', 'link']),
          }
        : null,
  };
}

// Saves a cleaned clip: its images are downloaded (cookies only for imagesFrom's own site;
// none when it is empty; with the Referer of the page they are on, referer, as the browser
// sends it) and uploaded first, then vault/clip/save writes the clip.
// Returns { ok, saved, kept, failed }; ok is false when the Markdown cannot fit.
export async function storeClip(
  vault,
  { url, title, clip, imagesFrom = '', referer = '', origin, existing = null, fetch, onProgress },
) {
  const images = clip.images.filter((image) => image.url);
  const cover = clip.cover || '';
  // The cover comes first, so the count limit never leaves it out; it has the same limits,
  // cookies and Referer as the page's images, and is not counted as one of them.
  const list = cover ? [{ url: cover }, ...clip.images] : clip.images;
  const downloaded =
    images.length || cover
      ? await fetchImages(list, imagesFrom, {
          fetch: referer ? refererFetch(referer, fetch) : fetch,
          onProgress,
        })
      : { assets: [], files: new Map(), failed: [] };
  const shift = cover ? 1 : 0;
  const files = new Map(
    [...downloaded.files]
      .filter(([index]) => index >= shift)
      .map(([index, file]) => [index - shift, file]),
  );
  const coverFile = (cover && downloaded.files.get(0)) || '';
  await uploadImages(vault, downloaded.assets);
  // Web addresses replace the placeholders of unsaved images, unless that makes the
  // Markdown too long: then those images keep only their description.
  let markdown = localizeMarkdown(clip.markdown, clip.imageToken, clip.images, files);
  if (bytes(markdown) > CLIP_LIMIT.markdown)
    markdown = localizeMarkdown(clip.markdown, clip.imageToken, clip.images, files, {
      remote: false,
    });
  if (bytes(markdown) > CLIP_LIMIT.markdown) return { ok: false };
  // Counted by address: an image the page shows at two addresses is one file.
  const addresses = new Set(images.map((image) => image.url));
  const failed = downloaded.failed.filter((entry) => addresses.has(entry.source));
  const found = addresses.size;
  const kept = found - failed.length;
  const saved = await vault.request(
    'vault/clip/save',
    {
      url,
      title,
      kind: 'web',
      meta: clip.meta,
      markdown,
      html: clip.html,
      origin,
      language: clip.language,
      direction: clip.direction,
      excerpt: clip.excerpt,
      words: clip.words,
      chars: clip.chars,
      truncated: clip.truncated,
      assets: downloaded.assets.map(({ sha256, ext, size, source, sources }) => ({
        sha256,
        ext,
        size,
        source,
        sources,
      })),
      images: {
        found,
        saved: kept,
        remote: failed.length,
        failed: failed.slice(0, 200),
      },
      cover: cover ? { source: cover, file: coverFile && `assets/${coverFile}` } : null,
      metaSources: clip.metaSources || {},
      contentStatus: clip.contentStatus || 'text',
      transcript: clip.transcript || null,
      ...(existing ? { replace: true, expected: existing.clippedAt } : {}),
    },
    { timeout: 60000 },
  );
  return { ok: true, saved, kept, failed: failed.length };
}

export function createClipper({ vault, changed = () => {}, fetch = globalThis.fetch }) {
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
    const extract = async (method) => {
      // A YouTube video's data (description, caption tracks) is in the page's own world, in
      // its player; it is read there now, for this video only.
      const videoId = method === 'selection' ? '' : youtubeVideoId(frame.url);
      const [read] = videoId
        ? await chrome.scripting
            .executeScript({
              target: { tabId, frameIds: [0] },
              world: 'MAIN',
              func: youtubePlayerData,
              args: [videoId],
            })
            .catch(() => [])
        : [];
      const player = read ? current(read) : null;
      return current(
        await inject(tabId, (o) => globalThis.tabgentClip.run(o), [
          {
            mode: method,
            url: frame.url,
            ...(method === 'selection' ? { expected } : {}),
            ...(player ? { player } : {}),
          },
        ]),
      );
    };

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
      await say(tabId, { text: clipFailure(reason, result?.message), tone: 'error' });
      return { ok: false, reason };
    }
    const clip = cleanClip(result);
    if (!clip) {
      await say(tabId, { text: t('clipFailed', ''), tone: 'error' });
      return { ok: false, reason: 'invalid' };
    }
    // Progress lines are shown in order, before the result.
    let shown = Promise.resolve();
    const stored = await storeClip(vault, {
      url,
      title: clip.title || text(tab.title, 500),
      clip,
      imagesFrom: frame.url,
      referer: frame.url,
      origin: { method: clip.method, extractor: clip.extractor, pageUrl: frame.url },
      existing,
      fetch,
      onProgress: (done, total) => {
        shown = shown.then(() =>
          say(tabId, { text: t('clipSavingImages', done, total), busy: true }),
        );
      },
    });
    await shown;
    if (!stored.ok) {
      await say(tabId, { text: t('clipFailed', ''), tone: 'error' });
      return { ok: false, reason: 'invalid' };
    }
    const { saved, kept, failed } = stored;
    if (!saved.saved) {
      // Another tab saved a clip of this page meanwhile.
      await say(tabId, { text: t('clipConflict'), tone: 'error' });
      return { ok: false, reason: 'conflict' };
    }
    const title = clip.title || saved.document?.title || '';
    // Only links were found (an embedded video, a page whose text did not load), or only a
    // video's description or a podcast's show notes: the clip is kept, but not reported as
    // the page's text, and a missing transcript says why.
    const partial = clip.contentStatus !== 'text';
    const transcript = clip.transcript;
    const label = transcript?.name || transcript?.language || '';
    await say(tabId, {
      text: [
        clip.contentStatus === 'linksOnly'
          ? t('clipLinksOnly', title)
          : clip.contentStatus === 'notesOnly'
            ? t('clipNotesOnly', title)
            : t('clipSaved', title, clip.words),
        transcript?.status === 'saved' && label
          ? t(
              'clipTranscriptSaved',
              transcript.kind === 'auto' ? t('clipTranscriptAuto', label) : label,
            )
          : '',
        transcript?.status === 'unavailable' && TRANSCRIPT_REASON[transcript.reason]
          ? t(TRANSCRIPT_REASON[transcript.reason])
          : '',
        kept ? t('clipImagesSaved', kept) : '',
        failed ? t('clipImagesFailed', failed) : '',
        clip.posts ? t('clipXPartial', clip.posts) : '',
        clip.truncated ? t('clipTruncated') : '',
      ]
        .filter(Boolean)
        .join(' '),
      tone: partial ? 'warning' : 'info',
      open: true,
    });
    changed(tabId);
    return {
      ok: true,
      document: saved.document,
      clip: saved.clip,
      backup: saved.backup || null,
      contentStatus: clip.contentStatus,
    };
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
      const detail = globalThis.tabgentExplainError?.(error, t) || t('errorGeneric');
      await say(tabId, { text: t('clipSaveFailed', detail), tone: 'error' });
      return { ok: false, reason: 'error', message: detail };
    } finally {
      running.delete(tabId);
    }
  }
  return { clip };
}
