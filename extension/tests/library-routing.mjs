// Local PDFs and the library in the service worker, with the real vault module in a
// temporary folder: the library imports a PDF named by its SHA-256, the PDF.js viewer of
// that PDF reads its vault copy back, and its highlights and saved turns belong to the
// imported document. No Codex process, account, or model is involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pdfInfo } from '../pdf/pdf-info.js';
import { instructions, readingContextPrefix } from '../session-config.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-library-'));
const vaultPath = path.join(temp, 'ReadingVault');
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
let directId = 0;
function direct(method, params) {
  const id = `direct-${++directId}`;
  return new Promise((resolve, reject) => {
    replies.set(id, (reply) => (reply.error ? reject(reply.error) : resolve(reply.result)));
    python.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const wait = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait()) {
    const value = await check();
    if (value) return value;
  }
  throw Error('Timed out waiting for ' + check);
}
const event = () => ({
  listeners: [],
  addListener(fn) {
    this.listeners.push(fn);
  },
  removeListener() {},
});
const sent = [];
const native = {
  onMessage: event(),
  onDisconnect: event(),
  postMessage(message) {
    sent.push(message);
    if (message.op !== 'vault') return;
    replies.set(message.id, (reply) => {
      for (const listener of native.onMessage.listeners) listener({ op: 'vault', ...reply });
    });
    python.stdin.write(
      JSON.stringify({ id: message.id, method: message.method, params: message.params }) + '\n',
    );
  },
};

// A generated, non-sensitive PDF; the vault stores it without parsing it.
const pdf = Buffer.from(
  '%PDF-1.4\n% Library routing fixture: autonomy is endorsement.\n' +
    '0'.repeat(5000) +
    '\n%%EOF\n',
);
const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
const urn = 'urn:sha256:' + sha256;
const base = 'chrome-extension://test/';
const viewerUrl = base + 'pdf/viewer.html?url=' + urn + '#page=2';
const reader = base + 'epub/reader.html';
const tabs = new Map([
  [1, { id: 1, windowId: 1, index: 0, url: viewerUrl, title: 'companion.pdf' }],
  [2, { id: 2, windowId: 1, index: 1, url: reader, title: 'Library' }],
  [3, { id: 3, windowId: 5, index: 4, url: 'https://example.test/article', title: 'Article' }],
]);
const created = [],
  menus = [],
  rules = [],
  updates = [],
  contentMessages = [];
globalThis.chrome = {
  runtime: {
    id: 'test',
    getURL: (p) => base + p,
    onConnect: event(),
    onMessage: event(),
    onInstalled: event(),
    connectNative: () => native,
  },
  i18n: { getMessage: (key) => key },
  contextMenus: {
    onClicked: event(),
    removeAll: (done) => done(),
    create: (item) => menus.push(item),
  },
  scripting: { executeScript: async () => [] },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
  declarativeNetRequest: {
    updateDynamicRules: async () => {},
    updateSessionRules: async (value) => rules.push(value),
  },
  sidePanel: { setPanelBehavior: async () => {}, open: () => Promise.resolve() },
  tabs: {
    get: async (id) => {
      if (!tabs.has(id)) throw Error('No tab');
      return tabs.get(id);
    },
    create: async (options) => (created.push(options), { id: 9 }),
    update: async (id, value) => updates.push([id, value]),
    sendMessage: async (tabId, message, options) => {
      contentMessages.push({ tabId, message, options });
      return null;
    },
    onRemoved: event(),
  },
  webNavigation: {
    onCommitted: event(),
    // Chrome hides extension documents from getFrame.
    getFrame: async ({ tabId }) =>
      /^https?:/.test(tabs.get(tabId)?.url)
        ? { documentId: 'web', url: tabs.get(tabId).url }
        : null,
  },
};

await direct('vault/configure', { path: vaultPath });
const routing = await import('../pdf-routing.js');
await import('../background.js');
await wait();

const call = (message, sender) =>
  new Promise((resolve) => {
    for (const listen of chrome.runtime.onMessage.listeners) listen(message, sender, resolve);
  });
const connect = (port) => {
  for (const listen of chrome.runtime.onConnect.listeners) listen(port);
};
const vaultCalls = (method) =>
  sent.filter((m) => m.op === 'vault' && (!method || m.method === method));
async function attach(tabId) {
  const messages = [],
    port = {
      name: 'chat',
      sender: { url: base + 'ui/chat.html', id: 'test' },
      onMessage: event(),
      onDisconnect: event(),
      postMessage: (m) => messages.push(m),
    };
  connect(port);
  await port.onMessage.listeners[0]({ type: 'attach', tabId });
  const state = messages.find((m) => m.type === 'attached').state;
  await port.onMessage.listeners[0]({ type: 'ui', name: 'codexConnect' });
  const session = sent.findLast((m) => m.op === 'claim' || m.op === 'restart').session;
  const events = (name) => messages.filter((m) => m.name === name).map((m) => m.value);
  const ui = (name, ...args) => port.onMessage.listeners[0]({ type: 'ui', name, args });
  return { port, messages, state, session, events, ui };
}

try {
  // Identity: the viewer address names an imported PDF by the hash of its bytes.
  const { pdfSource, isLocalPdf, pdfViewerUrl, pdfTab } = routing;
  assert.equal(pdfSource(viewerUrl), urn + '#page=2');
  assert.equal(pdfViewerUrl(urn), base + 'pdf/viewer.html?url=' + urn);
  assert.equal(pdfSource(pdfViewerUrl(urn)), urn);
  assert(isLocalPdf(urn) && isLocalPdf(urn + '#page=3'));
  for (const bad of [
    'urn:sha256:' + sha256.toUpperCase(),
    'urn:sha256:' + sha256.slice(1),
    'urn:sha256:' + sha256 + '?x=1',
    'urn:isbn:9780000000000',
    'file:///tmp/paper.pdf',
    'javascript:alert(1)',
  ]) {
    assert.equal(pdfSource(base + 'pdf/viewer.html?url=' + bad), null, bad);
    assert(!isLocalPdf(bad), bad);
  }
  assert.equal(pdfSource('https://example.test/pdf/viewer.html?url=' + urn), null);
  assert.deepEqual(pdfTab(tabs.get(1)), {
    ...tabs.get(1),
    url: urn + '#page=2',
    contentType: 'application/pdf',
    viewer: 'pdfjs',
  });
  console.log('PASS an imported PDF viewer is named by urn:sha256 and is a PDF tab');

  // The library (the EPUB reader page) imports the PDF into the vault.
  const library = {
    id: 'test',
    tab: { id: 2, title: 'Library' },
    frameId: 0,
    documentId: 'library-document',
    url: reader,
  };
  connect({
    name: 'epub',
    sender: library,
    onMessage: event(),
    onDisconnect: event(),
    postMessage: () => {},
    disconnect: () => {},
  });
  assert.deepEqual(await call({ type: 'libraryDocuments' }, library), { documents: [] });
  const upload = {
    type: 'epubSourceSave',
    kind: 'pdf',
    sha256,
    size: pdf.length,
    title: 'A Paper on Autonomy',
    meta: { author: 'Fixture Author', siteName: '' },
    name: 'companion.pdf',
    url: 'https://attacker.example/',
  };
  const probe = await call({ ...upload, offset: 0, data: '' }, library);
  assert.equal(probe.received, 0);
  assert.deepEqual(fs.readdirSync(vaultPath + '/Books'), [], 'A progress check writes nothing');
  const half = 3000;
  await call({ ...upload, offset: 0, data: pdf.subarray(0, half).toString('base64') }, library);
  const imported = await call(
    { ...upload, offset: half, data: pdf.subarray(half).toString('base64') },
    library,
  );
  assert.equal(imported.complete, true, JSON.stringify(imported));
  const documentId = imported.document.id;
  assert.match(documentId, /^paper-a-paper-on-autonomy-[0-9a-f]{8}$/);
  const folder = path.join(vaultPath, 'Books', documentId);
  assert.deepEqual(fs.readFileSync(path.join(folder, 'original.pdf')), pdf);
  assert.deepEqual(
    (({ url, kind, title, meta }) => ({ url, kind, title, meta }))(
      vaultCalls('vault/source/save').at(-1).params,
    ),
    { url: urn, kind: 'pdf', title: 'A Paper on Autonomy', meta: { author: 'Fixture Author' } },
    'The vault URL comes from the hash; the page cannot choose it',
  );
  // Without kind 'pdf' the reader still imports EPUB books.
  await call({ ...upload, kind: 'web', offset: 0, data: '' }, library);
  assert.equal(vaultCalls('vault/source/save').at(-1).params.kind, 'epub');
  const { documents } = await call({ type: 'libraryDocuments' }, library);
  assert.deepEqual(
    documents.map(({ id, kind, url, highlightCount, source }) => ({
      id,
      kind,
      url,
      highlightCount,
      name: source?.name,
    })),
    [{ id: documentId, kind: 'pdf', url: urn, highlightCount: 0, name: 'companion.pdf' }],
  );
  const stranger = { ...library, documentId: 'another-reader' };
  assert.match((await call({ type: 'libraryDocuments' }, stranger)).error, /Invalid EPUB reader/);
  console.log('PASS the library imports a PDF as urn:sha256 and lists vault documents');

  // The viewer reads its own copy back, only through its registered port.
  const viewer = {
    id: 'test',
    tab: { id: 1, title: 'companion.pdf' },
    frameId: 0,
    documentId: 'viewer-document',
    url: viewerUrl,
  };
  const reads = () => vaultCalls('vault/source/read').length;
  assert.equal((await call({ type: 'pdfLocalRead', offset: 0 }, viewer)).error, 'Stale PDF viewer');
  assert.equal(reads(), 0);
  connect({
    name: 'pdf',
    sender: { ...viewer },
    onMessage: event(),
    onDisconnect: event(),
    postMessage: () => {},
  });
  const parts = [];
  for (let offset = 0, eof = false; !eof;) {
    const chunk = await call({ type: 'pdfLocalRead', offset, length: 2048 }, viewer);
    assert.equal(chunk.document.id, documentId, JSON.stringify(chunk));
    const bytes = Buffer.from(chunk.data, 'base64');
    parts.push(bytes);
    offset += bytes.length;
    eof = chunk.eof;
  }
  assert(parts.length > 1);
  assert.deepEqual(Buffer.concat(parts), pdf);
  assert.deepEqual(vaultCalls('vault/document/resolve').at(-1).params, {
    url: urn,
    title: '',
    kind: 'pdf',
  });
  const before = reads();
  for (const [sender, error] of [
    [{ ...viewer, documentId: 'previous-viewer' }, /Stale PDF viewer/],
    [{ ...viewer, frameId: 2 }, /Invalid PDF viewer sender/],
    [{ ...viewer, tab: { id: 1, incognito: true } }, /Invalid PDF viewer sender/],
    [
      { ...viewer, url: base + 'pdf/viewer.html?url=https://example.test/a.pdf' },
      /Invalid PDF viewer sender/,
    ],
    [library, /Invalid PDF viewer sender/],
  ])
    assert.match((await call({ type: 'pdfLocalRead', offset: 0 }, sender)).error, error);
  // A viewer for a PDF that is not in the vault reads nothing.
  const missing = 'urn:sha256:' + 'b'.repeat(64);
  tabs.set(4, { id: 4, windowId: 1, url: base + 'pdf/viewer.html?url=' + missing });
  const other = { ...viewer, tab: { id: 4 }, documentId: 'other', url: tabs.get(4).url };
  connect({
    name: 'pdf',
    sender: { ...other },
    onMessage: event(),
    onDisconnect: event(),
    postMessage: () => {},
  });
  const absent = await call({ type: 'pdfLocalRead', offset: 0 }, other);
  assert.equal(absent.code, 'not_found');
  assert.equal(reads(), before, 'Rejected readers never reach vault/source/read');
  // Chrome's own viewer needs a web address; an imported PDF has none.
  const fallback = await new Promise((resolve) => {
    for (const listen of chrome.runtime.onMessage.listeners)
      listen({ type: 'pdfFallback' }, viewer, resolve);
  });
  assert.match(fallback.error, /no web address/);
  assert.deepEqual([rules, updates], [[], []]);
  console.log('PASS the viewer reads its vault copy through its port; others are refused');

  // Highlights, Ask AI and saved turns belong to the imported document.
  const view = await attach(1);
  const anchor = {
    kind: 'pdf',
    page: 2,
    quote: { exact: 'autonomy is endorsement', prefix: 'fixture: ', suffix: '.' },
  };
  const resolved = await call({ type: 'highlightResolve', title: 'A Paper on Autonomy' }, viewer);
  assert.equal(resolved.url, urn);
  assert.equal(resolved.document.id, documentId);
  const asked = await call(
    {
      type: 'highlightCreate',
      ask: true,
      text: 'autonomy is endorsement',
      anchor,
      title: 'A Paper on Autonomy',
      meta: { author: 'Fixture Author' },
      location: 'p. 2',
      context: { before: 'Library routing fixture: ', after: '.' },
    },
    viewer,
  );
  assert.equal(asked.document.id, documentId);
  assert.equal(asked.highlight.id, 'h001');
  const selection = view.events('codex-selection').at(-1);
  assert.deepEqual(selection.highlight, { documentId, highlightId: 'h001', kind: 'pdf' });
  assert.equal(selection.url, urn + '#page=2');
  assert.deepEqual((({ kind, page }) => ({ kind, page }))(selection.locator), {
    kind: 'pdf',
    page: 2,
  });
  await view.port.onMessage.listeners[0]({ type: 'bind', threadId: 'thread-local' });
  const before2 = sent.length;
  await view.ui('codexRpc', {
    id: 1,
    method: 'turn/start',
    params: {
      threadId: 'thread-local',
      input: [{ type: 'text', text: 'What does this mean?', text_elements: [] }],
      additionalContext: { pageSelection: { kind: 'untrusted', value: JSON.stringify(selection) } },
    },
  });
  const input = sent.slice(before2).find((m) => m.op === 'rpc').message.params.input;
  const page = JSON.parse(input[0].text.slice(input[0].text.indexOf('{')));
  assert.equal(page.url, urn + '#page=2', 'The browser context names the imported PDF');
  const reading = JSON.parse(
    input
      .find((p) => p.text?.startsWith(readingContextPrefix))
      .text.slice(readingContextPrefix.length),
  );
  assert.equal(reading.saving, 'highlight');
  // The reading context names the imported PDF and its page files.
  assert.deepEqual((({ url, kind, id, pages }) => ({ url, kind, id, pages }))(reading.document), {
    url: urn,
    kind: 'pdf',
    id: documentId,
    pages: path.join(folder, 'pages'),
  });
  const emit = (method, params) =>
    native.onMessage.listeners[0]({ session: view.session, message: { method, params } });
  const item = (id, value) => ({
    threadId: 'thread-local',
    turnId: 'turn-1',
    item: { id, ...value },
  });
  await emit('item/started', item('u', { type: 'userMessage', content: input }));
  await emit('item/completed', item('u', { type: 'userMessage', content: input }));
  await emit(
    'item/completed',
    item('a', {
      type: 'agentMessage',
      text: 'Agreeing with your own actions.',
      phase: 'final_answer',
    }),
  );
  await emit('turn/completed', {
    threadId: 'thread-local',
    turn: { id: 'turn-1', status: 'completed', items: [], completedAt: 1760000000 },
  });
  const notes = await until(() => {
    const text = fs.readFileSync(path.join(folder, 'highlights.md'), 'utf8');
    return text.includes('Agreeing with your own actions.') && text;
  });
  assert.match(notes, /^source: "urn:sha256:[0-9a-f]{64}"$/m);
  assert.match(notes, /## Highlight 001[\s\S]*p\. 2[\s\S]*What does this mean\?/);
  // A note from the viewer's popover belongs to the imported document's highlight.
  const userNote = 'My view: agreeing, not isolation.';
  const noted = await call(
    { type: 'highlightNote', documentId, highlightId: 'h001', note: userNote, title: 'A Paper' },
    viewer,
  );
  assert.equal(noted.highlight.note, userNote);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(folder, 'anchors.json'), 'utf8')).highlights[0].note,
    userNote,
  );
  assert.match(
    fs.readFileSync(path.join(folder, 'highlights.md'), 'utf8'),
    /## Highlight 001[\s\S]*### 笔记\n\nMy view: agreeing, not isolation\.\n[\s\S]*### 对话/,
  );
  assert.equal(
    (await call({ type: 'highlightNote', documentId, highlightId: 'h009', note: 'x' }, viewer))
      .code,
    'not_found',
  );
  console.log('PASS highlights, notes and saved turns on an imported PDF use its vault document');

  // The side panel's reading state maps the viewer tab to the imported document.
  const panel = { id: 'test', url: base + 'ui/chat.html' };
  const state = await call(
    { type: 'readingState', conversationKey: view.state.conversationKey, companionTabId: 1 },
    panel,
  );
  assert.deepEqual(state.page, { url: urn, title: 'companion.pdf', kind: 'pdf' });
  assert.equal(state.document.id, documentId);
  assert.deepEqual(
    state.highlights.map((h) => [h.id, h.turnCount]),
    [['h001', 1]],
  );
  // A plain selection in the viewer names the imported PDF too.
  await call(
    {
      type: 'pageSelection',
      text: 'endorsement',
      title: 'companion.pdf',
      selectionId: 'plain',
      locator: { kind: 'pdf', page: 2 },
    },
    viewer,
  );
  assert.equal(view.events('codex-selection').at(-1).url, urn + '#page=2');
  console.log('PASS the side panel and plain selections map the viewer to the imported PDF');

  // The side panel opens the library beside its page; web pages cannot ask for it.
  assert.deepEqual(
    await call(
      { type: 'openLibrary', conversationKey: view.state.conversationKey, companionTabId: 3 },
      panel,
    ),
    {},
  );
  assert.deepEqual(created, [{ url: reader, windowId: 5, index: 5 }]);
  const page3 = { id: 'test', tab: { id: 3 }, frameId: 0, url: 'https://example.test/article' };
  assert.match(
    (await call({ type: 'openLibrary', companionTabId: 3 }, page3)).error,
    /Invalid sender/,
  );
  assert.equal(created.length, 1);
  chrome.runtime.onInstalled.listeners[0]();
  assert.deepEqual(
    menus.map(({ id, title, contexts }) => [id, title, contexts]),
    [
      ['quote-selection', 'selectionMenu', ['selection']],
      ['open-epub-reader', 'libraryOpen', ['action']],
      ['clip-page', 'clipPage', ['action']],
      ['clip-page-context', 'clipPage', ['page']],
    ],
  );
  console.log('PASS the side panel and the toolbar menu open the library');
  assert(
    !sent.some((m) => m.op === 'rpc' && m.message.method !== 'turn/start'),
    'No other Codex calls',
  );

  // The import and the viewer name a PDF by its metadata title. A title with a hyphen is
  // kept; one with a character from U+FFF0-U+FFFF (a broken decode) uses the Info title.
  const metadataPdf = (title, Title = 'Info title') => ({
    getMetadata: async () => ({
      info: { Title, Author: ' A. Author ' },
      metadata: { get: (key) => (key === 'dc:title' ? title : null) },
    }),
  });
  assert.deepEqual(await pdfInfo(metadataPdf('Self-trust - a survey'), urn, 'companion.pdf'), {
    title: 'Self-trust - a survey',
    meta: { author: 'A. Author', siteName: '' },
  });
  for (const broken of ['Broken \uFFF0 title', 'Broken \uFFFF title', 'Untitled'])
    assert.equal((await pdfInfo(metadataPdf(broken), urn, 'companion.pdf')).title, 'Info title');
  assert.equal(
    (await pdfInfo(metadataPdf('Broken \uFFFE', ' '), urn, 'companion.pdf')).title,
    'companion.pdf',
  );
  assert.equal(
    (await pdfInfo(metadataPdf(undefined), 'https://example.test/a.pdf', 'a.pdf')).meta.siteName,
    'example.test',
  );
  assert.deepEqual(
    await pdfInfo({ getMetadata: () => Promise.reject(Error('bad')) }, urn, 'companion.pdf'),
    { title: 'companion.pdf', meta: {} },
  );
  console.log('PASS PDF titles keep hyphens and skip titles with U+FFF0-U+FFFF');

  // "These links" must still follow the online-PDF #page=N&search= link guidance; the
  // imported-PDF guidance comes after the PDF.js block and does not split it.
  const sentences = instructions.split(/(?<=\.) /);
  const linkNote = sentences.indexOf(
    'These links show temporary search highlights, not saved annotations.',
  );
  assert.match(sentences[linkNote - 1], /^Prefer a short distinctive passage;/);
  assert.match(sentences[linkNote - 2], /^Preserve the original query string/);
  const importedRule = sentences.findIndex((s) => s.startsWith('A PDF imported from the user'));
  assert(importedRule > linkNote, 'Imported-PDF guidance follows the online-PDF links');
  assert.match(sentences[importedRule - 1], /^Native PDF selections from Quote in Agent/);
  assert.match(sentences[importedRule + 1], /^Its text is also in the vault/);
  assert.doesNotMatch(sentences[importedRule + 2], /^These\b/);
  console.log('PASS imported-PDF instructions do not split the online-PDF link guidance');
} finally {
  python.stdin.end();
  fs.rmSync(temp, { recursive: true, force: true });
}
