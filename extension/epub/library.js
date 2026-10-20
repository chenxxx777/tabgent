// Messages from the reader to the service worker, and book import/reopen through the vault.
// The worker accepts messages only from a reader document that registered its 'epub' port.
// The port also tells the worker which book is open and carries its highlight commands.
const CHUNK = 2 * 1024 * 1024;
let port,
  ready = null,
  book = null,
  commands = null;

export function connect() {
  const current = (port = chrome.runtime.connect({ name: 'epub' }));
  ready = new Promise((resolve) => {
    current.onMessage.addListener((message) => {
      if (message?.type === 'ready') {
        // A restarted worker learns the open book again.
        if (book) current.postMessage({ type: 'book', ...book });
        resolve();
      } else if (message?.type === 'command') void answer(current, message);
    });
  });
  port.onDisconnect.addListener(() => {
    ready = null;
    setTimeout(connect, 500);
  });
}

// The book this reader shows, as { sha256, title }, or null.
export function announce(value) {
  book = value;
  try {
    port?.postMessage({ type: 'book', ...(value || { sha256: '' }) });
  } catch {}
}
export function handleCommands(handler) {
  commands = handler;
}
async function answer(target, { id, command }) {
  try {
    const result = await commands?.(command);
    target.postMessage({ type: 'reply', id, result: result ?? null });
  } catch (error) {
    target.postMessage({ type: 'reply', id, error: error?.message || String(error) });
  }
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
  if (reply?.error)
    throw Object.assign(Error(reply.error), {
      code: reply.code,
      ...(reply.folder ? { folder: reply.folder } : {}),
    });
  return reply;
}

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Uploads the original in order; an interrupted import resumes where the vault stopped.
// The library imports PDFs the same way (kind 'pdf'); EPUB is the default.
export async function importBook({ bytes, sha256, title, meta, name, kind, onProgress }) {
  const base = {
    type: 'epubSourceSave',
    sha256,
    title,
    meta,
    name,
    size: bytes.byteLength,
    ...(kind ? { kind } : {}),
  };
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

// The title and author an imported PDF is saved under, read with PDF.js as the viewer reads
// them, so the vault document and the viewer's highlights agree. Parsing it first also
// refuses a damaged file before it is copied into the vault.
export async function pdfDetails(bytes, name, url) {
  const [pdfjs, { pdfInfo }] = await Promise.all([
    import('../vendor/pdfjs/build/pdf.mjs'),
    import('../pdf/pdf-info.js'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/build/pdf.worker.mjs');
  // PDF.js moves the buffer it is given to its worker; the caller keeps the original.
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false });
  try {
    const pdf = await new Promise((resolve, reject) => {
      // An encrypted PDF is named by its file; the viewer asks for the password.
      task.onPassword = () => resolve(null);
      task.promise.then(resolve, reject);
    });
    return pdf ? await pdfInfo(pdf, url, name) : { title: name, meta: {} };
  } finally {
    void task.destroy();
  }
}
