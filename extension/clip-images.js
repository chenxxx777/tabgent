// A clip's images: the service worker downloads them with its host access (no CORS), keeps
// only real images by their first bytes, within count, size and time limits, and uploads
// each to the vault in chunks before the clip is saved. An image that cannot be saved stays
// linked at its web address.
export const IMAGE_LIMIT = {
  count: 50,
  size: 5 * 1024 * 1024,
  total: 30 * 1024 * 1024,
  timeout: 15000,
  budget: 45000,
  parallel: 4,
};
const CHUNK = 2 * 1024 * 1024;

// The image type from its first bytes; SVG and anything else are not saved.
export function sniff(bytes) {
  const at = (offset, text) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x89 && at(1, 'PNG\r\n\u001a\n')) return 'png';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(4, 'ftyp') && (at(8, 'avif') || at(8, 'avis'))) return 'avif';
  return null;
}

// Same site, roughly the registrable domain: the last two labels, or three under a short
// second-level label such as co.uk or com.cn. Cookies are sent only to the page's own site.
// Without the Public Suffix List this is an approximation: hosts under a shared suffix (for
// example *.github.io) count as one site, and IP addresses compare their last two numbers.
export function sameSite(url, pageUrl) {
  const site = (value) => {
    try {
      const labels = new URL(value).hostname.split('.');
      const two = labels.length > 2 && labels.at(-1).length === 2 && labels.at(-2).length <= 3;
      return labels.slice(two ? -3 : -2).join('.');
    } catch {
      return null;
    }
  };
  const a = site(url);
  return !!a && a === site(pageUrl);
}

async function hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Reads a response body up to limit bytes; null when it is larger.
async function body(response, limit, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) return null;
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    if (signal.aborted) throw signal.reason || Error('Aborted');
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

// images: [{ url }] in page order. Returns { assets, files, failed, skipped }: the images to
// upload (one per distinct file, with every address that returned it), the saved file name for each image index, and why others
// were not saved.
export async function fetchImages(
  images,
  pageUrl,
  { limit = IMAGE_LIMIT, fetch = globalThis.fetch, onProgress = () => {} } = {},
) {
  const started = Date.now();
  const assets = new Map(),
    byUrl = new Map(),
    files = new Map(),
    failed = [];
  let total = 0,
    done = 0;
  const wanted = [...new Set(images.map((image) => image.url).filter(Boolean))];
  const queue = wanted.slice(0, limit.count);
  const skipped = wanted.slice(limit.count).map((source) => ({ source, reason: 'count_limit' }));
  async function download(url) {
    const remaining = limit.budget - (Date.now() - started);
    if (remaining <= 0) return { reason: 'time_limit' };
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(Error('timeout')),
      Math.min(limit.timeout, remaining),
    );
    try {
      const options = { referrerPolicy: 'no-referrer', signal: controller.signal };
      // Cookies only on the first request: a redirect from the page's site is followed again
      // without them, so another site never receives its cookies.
      const include = sameSite(url, pageUrl);
      let response = await fetch(url, {
        ...options,
        credentials: include ? 'include' : 'omit',
        redirect: include ? 'manual' : 'follow',
      });
      if (response.type === 'opaqueredirect')
        response = await fetch(url, { ...options, credentials: 'omit', redirect: 'follow' });
      if (!response.ok) return { reason: `http_${response.status}` };
      const bytes = await body(response, limit.size, controller.signal);
      if (!bytes) return { reason: 'too_large' };
      const ext = sniff(bytes);
      if (!ext) return { reason: 'not_image' };
      return { bytes, ext, sha256: await hex(bytes) };
    } catch (error) {
      return { reason: controller.signal.aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
  async function work() {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const result = await download(url);
      onProgress(++done, Math.min(wanted.length, limit.count));
      if (result.reason) {
        failed.push({ source: url, reason: result.reason });
        continue;
      }
      if (!assets.has(result.sha256)) {
        if (total + result.bytes.length > limit.total) {
          failed.push({ source: url, reason: 'total_limit' });
          continue;
        }
        total += result.bytes.length;
        assets.set(result.sha256, {
          sha256: result.sha256,
          ext: result.ext,
          size: result.bytes.length,
          source: url,
          sources: [],
          bytes: result.bytes,
        });
      }
      // Every address that returned these bytes: the reader shows the file at each of them.
      const saved = assets.get(result.sha256);
      saved.sources.push(url);
      byUrl.set(url, `${result.sha256.slice(0, 16)}.${saved.ext}`);
    }
  }
  await Promise.all(Array.from({ length: limit.parallel }, work));
  images.forEach((image, index) => {
    if (byUrl.has(image.url)) files.set(index, byUrl.get(image.url));
  });
  return { assets: [...assets.values()], files, failed: [...failed, ...skipped] };
}

// Uploads one image at a time, so other vault requests wait for at most one chunk.
export async function uploadImages(vault, assets) {
  for (const asset of assets) {
    const base = { sha256: asset.sha256, size: asset.size };
    let reply = await vault.request('vault/clip/asset', { ...base, offset: 0, data: '' });
    while (!reply.complete) {
      const offset = reply.received;
      reply = await vault.request(
        'vault/clip/asset',
        { ...base, offset, data: asset.bytes.subarray(offset, offset + CHUNK).toBase64() },
        { timeout: 60000 },
      );
      if (!reply.complete && reply.received <= offset) throw Error('The vault stopped the upload');
    }
  }
}

// A Markdown link destination, as the clipping script writes it.
export const destination = (url) => (/[\s()<>]/.test(url) ? `<${url.replace(/>/g, '%3E')}>` : url);

// The clipping script writes each image as a placeholder named by a token only it and the
// worker know; saved images point to assets/, others to their web address.
// With remote false, images that were not saved lose their link (when the addresses would
// make the Markdown too long).
export function localizeMarkdown(markdown, token, images, files, { remote = true } = {}) {
  if (!/^[0-9a-f]{32}$/.test(token || '')) return markdown;
  // ![alt](placeholder), as the clipping script writes it; alt is already escaped.
  const pattern = new RegExp(
    `!\\[((?:\\\\.|[^\\]\\\\])*)\\]\\(tabgent-image-${token}-(\\d+)\\)`,
    'g',
  );
  return markdown.replace(pattern, (_, alt, index) => {
    const file = files.get(Number(index));
    const url = images[Number(index)]?.url;
    if (file) return `![${alt}](assets/${file})`;
    if (url && remote) return `![${alt}](${destination(url)})`;
    // Not saved and no address: only its description stays.
    return alt;
  });
}
