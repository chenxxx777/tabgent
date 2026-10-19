// Vault requests share the native connector port but never wait for a Codex session.
export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

export function createVaultClient(connect, { timeout = 15000 } = {}) {
  const pending = new Map();
  let sequence = 0;
  function request(method, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
      const id = `vault-${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new VaultError('timeout', `Vault request timed out: ${method}`));
      }, options.timeout ?? timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        connect().postMessage({ op: 'vault', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new VaultError('disconnected', error?.message || 'Connector unavailable'));
      }
    });
  }
  // Returns true when the message belonged to the vault channel.
  function receive(message) {
    if (message?.op !== 'vault') return false;
    const entry = pending.get(message.id);
    if (!entry) return true;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error)
      entry.reject(
        new VaultError(
          String(message.error.code || 'io_error'),
          String(message.error.message || 'Vault request failed'),
        ),
      );
    else entry.resolve(message.result ?? {});
    return true;
  }
  function disconnect(reason = '') {
    const code = /native messaging host not found/i.test(reason) ? 'host_missing' : 'disconnected';
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new VaultError(code, reason || 'Connector disconnected'));
    }
    pending.clear();
  }
  return {
    request,
    receive,
    disconnect,
    get size() {
      return pending.size;
    },
  };
}

const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
const offset = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
function point(value) {
  const path = text(value?.path, 4000);
  const at = offset(value?.offset);
  return path && at !== null ? { path, offset: at } : null;
}

// Page-supplied anchors are bounded and reshaped to the contract before reaching the host.
export function cleanWebAnchor(anchor) {
  const exact = text(anchor?.quote?.exact, 20000);
  const start = offset(anchor?.position?.start),
    end = offset(anchor?.position?.end);
  if (anchor?.kind !== 'web' || !exact.trim() || start === null || end === null || end <= start)
    return null;
  const clean = {
    kind: 'web',
    quote: {
      exact,
      prefix: text(anchor.quote.prefix, 64),
      suffix: text(anchor.quote.suffix, 64),
    },
    position: { start, end },
  };
  const domStart = point(anchor.dom?.start),
    domEnd = point(anchor.dom?.end);
  if (domStart && domEnd) clean.dom = { start: domStart, end: domEnd };
  return clean;
}

// PDF anchors: one-based page (endPage when a highlight crosses pages), the quote from the
// pages' text-layer text, offsets into that text, and PDF user-space rects.
export function cleanPdfAnchor(anchor) {
  const exact = text(anchor?.quote?.exact, 20000);
  const page = Number.isInteger(anchor?.page) && anchor.page >= 1 ? anchor.page : null;
  if (anchor?.kind !== 'pdf' || !exact.trim() || !page || page > 1000000) return null;
  const endPage =
    Number.isInteger(anchor.endPage) && anchor.endPage > page && anchor.endPage <= page + 50
      ? anchor.endPage
      : page;
  const clean = {
    kind: 'pdf',
    page,
    ...(endPage > page ? { endPage } : {}),
    quote: {
      exact,
      prefix: text(anchor.quote.prefix, 64),
      suffix: text(anchor.quote.suffix, 64),
    },
  };
  const start = offset(anchor.textLayer?.start),
    end = offset(anchor.textLayer?.end);
  if (start !== null && end !== null && end > start) clean.textLayer = { start, end };
  const rects = (Array.isArray(anchor.rects) ? anchor.rects : [])
    .slice(0, 200)
    .filter(
      (rect) =>
        Number.isInteger(rect?.page) &&
        rect.page >= page &&
        rect.page <= endPage &&
        Array.isArray(rect.pdf) &&
        rect.pdf.length === 4 &&
        rect.pdf.every(Number.isFinite),
    )
    .map((rect) => ({ page: rect.page, pdf: rect.pdf.map((n) => Math.round(n * 100) / 100) }));
  if (rects.length) clean.rects = rects;
  return clean;
}

export function cleanPageMeta(meta) {
  const clean = {};
  for (const key of ['author', 'siteName', 'publishedAt']) {
    const value = text(meta?.[key], 300).trim();
    if (value) clean[key] = value;
  }
  return clean;
}

// Vault URL identity ignores fragments but keeps queries.
export function documentUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}
