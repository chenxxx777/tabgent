// Messages from the reader to the service worker, and book import/reopen through the vault.
// The worker accepts messages only from a reader document that registered its 'epub' port.
const CHUNK = 2 * 1024 * 1024;
let port,
  ready = null;

export function connect() {
  port = chrome.runtime.connect({ name: 'epub' });
  ready = new Promise((resolve) => {
    port.onMessage.addListener((message) => {
      if (message?.type === 'ready') resolve();
    });
  });
  port.onDisconnect.addListener(() => {
    ready = null;
    setTimeout(connect, 500);
  });
}

export async function send(message, retry = true) {
  if (!ready) connect();
  await ready;
  const reply = await chrome.runtime.sendMessage(message);
  // A restarted service worker has not seen this reader's port yet.
  if (reply?.error === 'Invalid EPUB reader sender' && retry) {
    port.disconnect();
    connect();
    return send(message, false);
  }
  if (reply?.error) throw Object.assign(Error(reply.error), { code: reply.code });
  return reply;
}

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Uploads the original in order; an interrupted import resumes where the vault stopped.
export async function importBook({ bytes, sha256, title, meta, name, onProgress }) {
  const base = { type: 'epubSourceSave', sha256, title, meta, name, size: bytes.byteLength };
  let reply = await send({ ...base, offset: 0, data: '' });
  while (!reply.complete) {
    const offset = reply.received;
    onProgress?.(offset / bytes.byteLength);
    reply = await send({
      ...base,
      offset,
      data: bytes.subarray(offset, offset + CHUNK).toBase64(),
    });
    if (!reply.complete && reply.received <= offset) throw Error('The vault stopped the import');
  }
  return reply;
}

// Reads a vault book back and checks it against the recorded SHA-256.
export async function loadBook(documentId, onProgress) {
  const parts = [];
  let offset = 0,
    reply;
  do {
    reply = await send({ type: 'epubSourceRead', documentId, offset, length: CHUNK });
    const bytes = Uint8Array.fromBase64(reply.data);
    if (!bytes.length && !reply.eof) throw Error('The vault returned no data');
    parts.push(bytes);
    offset += bytes.length;
    onProgress?.(offset / reply.source.size);
  } while (!reply.eof);
  const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== reply.source.sha256) throw Error('The stored book does not match its checksum');
  const name = reply.source.name || 'book.epub';
  return {
    file: new File([bytes], name, { type: 'application/epub+zip' }),
    bytes,
    sha256,
    source: reply.source,
    document: reply.document,
  };
}

// Reading positions stay in extension storage, keyed by the book's SHA-256.
const POSITIONS = 'epubPositions';
export async function position(sha256) {
  return (await chrome.storage.local.get(POSITIONS))[POSITIONS]?.[sha256] || null;
}
export async function savePosition(sha256, value) {
  const all = (await chrome.storage.local.get(POSITIONS))[POSITIONS] || {};
  all[sha256] = { ...value, at: Date.now() };
  const recent = Object.entries(all)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, 200);
  await chrome.storage.local.set({ [POSITIONS]: Object.fromEntries(recent) });
}
export async function positions() {
  return (await chrome.storage.local.get(POSITIONS))[POSITIONS] || {};
}
