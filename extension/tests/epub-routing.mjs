import assert from 'node:assert/strict';
import { bookUrl, cleanEpubAnchor } from '../vault-client.js';
import { readingContextPrefix } from '../session-config.js';
const event = () => ({
  listeners: [],
  addListener(fn) {
    this.listeners.push(fn);
  },
});
// A fake connector that answers only the vault channel; Codex never becomes ready.
const sent = [];
const host = {};
const native = {
  onMessage: event(),
  onDisconnect: event(),
  postMessage(message) {
    sent.push(message);
    if (message.op !== 'vault' || !host[message.method]) return;
    setTimeout(() => {
      let reply;
      try {
        reply = { op: 'vault', id: message.id, result: host[message.method](message.params) };
      } catch (error) {
        reply = { op: 'vault', id: message.id, error };
      }
      for (const listener of native.onMessage.listeners) listener(reply);
    }, 0);
  },
};
const reader = 'chrome-extension://test/epub/reader.html';
const tabs = { 1: { id: 1, windowId: 1, url: reader + '?book=book-small-1a2b3c4d' } };
const created = [],
  menus = [];
globalThis.chrome = {
  runtime: {
    id: 'test',
    getURL: (p) => 'chrome-extension://test/' + p,
    onConnect: event(),
    onMessage: event(),
    onInstalled: event(),
    connectNative: () => native,
    getManifest: () => ({}),
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
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  tabs: {
    get: async (id) => tabs[id] || { id, windowId: 1, url: 'https://example.test/' },
    create: async (options) => (created.push(options), { id: 9 }),
    onRemoved: event(),
  },
  webNavigation: { onCommitted: event(), getFrame: async () => null },
};
await import('../background.js');
await new Promise((r) => setTimeout(r, 0));

const sha256 = 'a'.repeat(64);
async function until(check) {
  for (let i = 0; i < 100; i++, await new Promise((r) => setTimeout(r, 10))) {
    const value = check();
    if (value) return value;
  }
  return null;
}
const anchor = {
  kind: 'epub',
  cfi: 'epubcfi(/6/4!/4/4,/1:0,/1:15)',
  quote: { exact: 'more persistent', prefix: 'People are ', suffix: ' when they' },
  chapter: { href: 'OEBPS/ch1.xhtml', title: 'Chapter One', index: 1, extra: 'dropped' },
  position: { start: 10, end: 25 },
  dom: { ignored: true },
};
// Book identity and reader-supplied anchors.
assert.equal(bookUrl(sha256), 'urn:sha256:' + sha256);
for (const bad of ['A'.repeat(64), 'a'.repeat(63), null, 'urn:sha256:' + sha256])
  assert.equal(bookUrl(bad), '');
assert.deepEqual(cleanEpubAnchor(anchor), {
  kind: 'epub',
  cfi: anchor.cfi,
  quote: anchor.quote,
  chapter: { href: 'OEBPS/ch1.xhtml', title: 'Chapter One', index: 1 },
  position: { start: 10, end: 25 },
});
for (const bad of [
  { ...anchor, kind: 'web' },
  { ...anchor, cfi: '/6/4!/4' },
  { ...anchor, quote: { exact: '  ' } },
  null,
])
  assert.equal(cleanEpubAnchor(bad), null);
assert.equal(
  cleanEpubAnchor({ ...anchor, quote: { exact: 'x'.repeat(30000) } }).quote.exact.length,
  20000,
);
console.log('PASS book identity from the file hash and EPUB anchor cleaning');

// The chat sidebar for the reader tab.
const messages = [];
const chat = {
  name: 'chat',
  sender: { url: 'chrome-extension://test/ui/chat.html', id: 'test' },
  onMessage: event(),
  onDisconnect: event(),
  postMessage: (m) => messages.push(m),
};
const onConnect = chrome.runtime.onConnect.listeners[0];
onConnect(chat);
await chat.onMessage.listeners[0]({ type: 'attach', tabId: 1 });
const selections = () => messages.filter((m) => m.name === 'codex-selection').map((m) => m.value);

// Reader documents register a port; only the current one may send messages.
const sender = {
  id: 'test',
  tab: { id: 1, title: 'A Small Book' },
  frameId: 0,
  documentId: 'reader-doc',
  url: reader,
};
const listener = chrome.runtime.onMessage.listeners[0];
const call = (m, s = sender) => new Promise((resolve) => listener(m, s, resolve));
assert.match((await call({ type: 'epubBooks' })).error, /Invalid EPUB reader sender/);
const posted = [];
const readerCommands = {};
const port = {
  name: 'epub',
  sender,
  onMessage: event(),
  onDisconnect: event(),
  // The reader answers highlight commands on the same port.
  postMessage(m) {
    posted.push(m);
    if (m.type !== 'command') return;
    const result = readerCommands[m.command.action]?.(m.command);
    setTimeout(() => {
      for (const listener of port.onMessage.listeners)
        listener({ type: 'reply', id: m.id, result });
    }, 0);
  },
  disconnect() {},
};
onConnect(port);
assert.deepEqual(posted, [{ type: 'ready' }]);
let rejected = false;
onConnect({
  name: 'epub',
  sender: { ...sender, url: 'https://example.test/epub/reader.html' },
  onDisconnect: event(),
  postMessage() {},
  disconnect: () => (rejected = true),
});
assert(rejected, 'A web page cannot register as the reader');

const vaultCalls = () => sent.filter((m) => m.op === 'vault');
host['vault/books/list'] = () => ({ books: [{ id: 'book-small-1a2b3c4d' }] });
assert.deepEqual(await call({ type: 'epubBooks' }), { books: [{ id: 'book-small-1a2b3c4d' }] });
assert.deepEqual(vaultCalls().at(-1).params, { kind: 'epub' });
for (const stale of [
  { ...sender, documentId: 'previous' },
  { ...sender, frameId: 3 },
  { ...sender, url: 'chrome-extension://test/ui/chat.html' },
  { ...sender, tab: { id: 2 } },
]) {
  const before = vaultCalls().length;
  assert.match((await call({ type: 'epubBooks' }, stale)).error, /Invalid EPUB reader sender/);
  assert.equal(vaultCalls().length, before);
}
assert(!sent.some((m) => ['claim', 'rpc'].includes(m.op)), 'Vault calls never claim Codex');
console.log('PASS only the registered reader document of a tab can use the vault');

// Import and reopen relay chunks with longer timeouts; the URL comes from the hash.
host['vault/source/save'] = (params) => ({ complete: false, received: params.offset + 3 });
await call({
  type: 'epubSourceSave',
  sha256,
  size: 6,
  offset: 0,
  data: 'QUJD',
  title: 'A Small Book',
  meta: { author: 'Writer', other: 'dropped' },
  name: 'small.epub',
  url: 'https://attacker.example/',
});
assert.deepEqual(vaultCalls().at(-1).params, {
  url: 'urn:sha256:' + sha256,
  title: 'A Small Book',
  kind: 'epub',
  meta: { author: 'Writer' },
  sha256,
  size: 6,
  offset: 0,
  data: 'QUJD',
  name: 'small.epub',
});
assert.equal((await call({ type: 'epubSourceSave', sha256: 'nope' })).code, 'invalid_params');
host['vault/source/read'] = () => ({ data: '', eof: true });
await call({ type: 'epubSourceRead', documentId: 'book-small-1a2b3c4d', offset: 0, length: 9 });
assert.deepEqual(vaultCalls().at(-1).params, {
  documentId: 'book-small-1a2b3c4d',
  offset: 0,
  length: 9,
});
console.log('PASS import and reopen requests are relayed for the hashed book identity');

// Highlight and Ask AI: the quote carries the vault record, nearby text and a locator.
const folder = '/vault/Books/book-small-1a2b3c4d';
const document = { id: 'book-small-1a2b3c4d', kind: 'epub', folder, createdAt: 'now' };
const saved = {
  id: 'h001',
  text: 'more persistent',
  anchor: cleanEpubAnchor(anchor),
  turnCount: 0,
};
host['vault/highlight/create'] = () => ({ document, highlight: saved });
host['vault/discussion/get'] = () => ({ threadIds: [], turns: [] });
const reply = await call({
  type: 'epubHighlightCreate',
  ask: true,
  sha256,
  title: 'A Small Book',
  text: 'more persistent',
  anchor,
  context: { before: 'People are ', after: ' when they endorse.', extra: 'x' },
  chapterFile: 'chapters/01-chapter-one.md',
});
assert.deepEqual(reply, { document, highlight: saved });
assert.deepEqual(vaultCalls().findLast((m) => m.method === 'vault/highlight/create').params, {
  url: 'urn:sha256:' + sha256,
  title: 'A Small Book',
  kind: 'epub',
  meta: {},
  text: 'more persistent',
  anchor: cleanEpubAnchor(anchor),
  location: 'Chapter One',
});
const asked = selections().at(-1);
assert.equal(asked.text, 'more persistent');
// The quote names the book by its vault identity, so the conversation binds to it.
assert.equal(asked.url, 'urn:sha256:' + sha256);
assert.deepEqual(asked.highlight, { documentId: document.id, highlightId: 'h001', kind: 'epub' });
assert.equal(asked.location, 'Chapter One');
assert.deepEqual(asked.context, { before: 'People are ', after: ' when they endorse.' });
assert.equal(asked.locator.kind, 'epub');
assert.deepEqual(asked.locator.anchor, cleanEpubAnchor(anchor));
assert.equal(asked.locator.documentId, document.id);
assert.equal(asked.locator.chapterFile, folder + '/chapters/01-chapter-one.md');
assert.ok(asked.locator.capturedAt);
assert.equal(asked.documentId, 'reader-doc');
// Chapter files outside the book's chapters folder are never named.
await call({
  type: 'epubHighlightCreate',
  ask: true,
  sha256,
  text: 'more persistent',
  anchor,
  chapterFile: '../../../etc/passwd.md',
});
assert.equal(selections().at(-1).locator.chapterFile, undefined);
// A failed save still hands off the quote, without a highlight.
host['vault/highlight/create'] = () => {
  throw { code: 'vault_unwritable', message: 'Read-only' };
};
const failed = await call({ type: 'epubHighlightCreate', ask: true, sha256, text: 'x', anchor });
assert.equal(failed.vaultError, 'Read-only');
assert.equal(selections().at(-1).highlight, null);
assert.equal(
  (await call({ type: 'epubHighlightCreate', sha256, text: 'x', anchor })).code,
  'vault_unwritable',
);
assert.equal(
  (await call({ type: 'epubHighlightCreate', sha256, text: 'x', anchor: { ...anchor, cfi: '' } }))
    .code,
  'invalid_params',
);
console.log('PASS Ask AI hands off highlight, context and an EPUB locator with the chapter file');

// Saved highlights are checked against this book before Ask AI or Delete.
host['vault/document/resolve'] = (params) =>
  params.url === 'urn:sha256:' + sha256
    ? { document, highlights: [saved] }
    : { document: null, highlights: [] };
host['vault/highlight/delete'] = () => ({ ok: true });
assert.deepEqual(
  await call({ type: 'epubHighlightDelete', sha256, documentId: document.id, highlightId: 'h001' }),
  { ok: true },
);
assert.deepEqual(vaultCalls().at(-1).params, { documentId: document.id, highlightId: 'h001' });
const otherBook = 'b'.repeat(64);
assert.equal(
  (
    await call({
      type: 'epubHighlightDelete',
      sha256: otherBook,
      documentId: document.id,
      highlightId: 'h001',
    })
  ).code,
  'not_found',
);
assert.equal(vaultCalls().at(-1).method, 'vault/document/resolve');
await call({
  type: 'epubHighlightAsk',
  sha256,
  documentId: document.id,
  highlightId: 'h001',
  context: { before: 'b', after: 'a' },
});
assert.deepEqual(selections().at(-1).highlight, {
  documentId: document.id,
  highlightId: 'h001',
  kind: 'epub',
});
assert.equal(selections().at(-1).locator.anchor.cfi, anchor.cfi);
// The user's own note is saved for a highlight of this book only.
host['vault/highlight/update'] = (params) => ({
  document,
  highlight: { ...saved, note: params.note },
});
const changes = () => messages.filter((m) => m.name === 'codex-reading-changed').length;
const changesBefore = changes();
assert.equal(
  (
    await call({
      type: 'epubHighlightNote',
      sha256,
      documentId: document.id,
      highlightId: 'h001',
      note: 'My reading',
    })
  ).highlight.note,
  'My reading',
);
assert.deepEqual(vaultCalls().at(-1).params, {
  documentId: document.id,
  highlightId: 'h001',
  note: 'My reading',
});
assert.equal(changes(), changesBefore + 1, 'The panel list refreshes');
for (const params of [
  { sha256: otherBook, note: 'x' },
  { sha256, note: { text: 'x' } },
]) {
  const before = vaultCalls().filter((m) => m.method === 'vault/highlight/update').length;
  const failed = await call({
    type: 'epubHighlightNote',
    documentId: document.id,
    highlightId: 'h001',
    ...params,
  });
  assert(failed.error, JSON.stringify(params));
  assert.equal(vaultCalls().filter((m) => m.method === 'vault/highlight/update').length, before);
}
assert.deepEqual(await call({ type: 'epubResolve', sha256, title: 'A Small Book' }), {
  document,
  highlights: [saved],
});
await call({
  type: 'epubHighlightStatus',
  sha256,
  documentId: document.id,
  anchored: 1,
  unanchored: ['h009'],
});
assert.deepEqual(messages.filter((m) => m.name === 'codex-highlight-status').at(-1).value, {
  url: 'urn:sha256:' + sha256,
  documentId: document.id,
  anchored: 1,
  unanchored: ['h009'],
});
await call({ type: 'epubHighlightStatus', sha256: null });
assert.equal(messages.filter((m) => m.name === 'codex-highlight-status').at(-1).value, null);
console.log(
  'PASS Delete and Ask on saved highlights are scoped to the book; status reaches the chat',
);

// Plain selections in the reader use the existing quote flow with an EPUB locator.
await call({
  type: 'pageSelection',
  text: 'endorse',
  title: 'A Small Book',
  selectionId: 's1',
  locator: { kind: 'epub', anchor, capturedAt: 'now' },
});
const quoted = selections().at(-1);
assert.equal(quoted.text, 'endorse');
assert.equal(quoted.url, reader, 'Before the reader names its book');
assert.equal(quoted.locator.kind, 'epub');
assert.equal(quoted.highlight, undefined);
const stale = await call({ type: 'pageSelection', text: 'x' }, { ...sender, documentId: 'old' });
assert.match(stale.error, /Stale EPUB selection/);
await call({ type: 'pageSelectionCleared', selectionId: 's1' });
assert.equal(selections().at(-1), null);
for (const listener of port.onMessage.listeners)
  listener({ type: 'book', sha256, title: 'A Small Book' });
await call({
  type: 'pageSelection',
  text: 'endorse',
  selectionId: 's2',
  locator: { kind: 'epub' },
});
assert.equal(selections().at(-1).url, 'urn:sha256:' + sha256);
console.log(
  'PASS reader selections reach the tab conversation; stale reader documents are rejected',
);

// The reading companion sees the reader tab as the book: page, binding, jump and reopen.
const conversationKey = messages.find((m) => m.type === 'attached').state.conversationKey;
const side = (m) => call({ conversationKey, companionTabId: 1, ...m }, chat.sender);
host['vault/status'] = () => ({ configured: true, path: '/vault', writable: true });
const state = await side({ type: 'readingState' });
assert.deepEqual(state.page, { url: 'urn:sha256:' + sha256, title: 'A Small Book', kind: 'epub' });
assert.deepEqual(vaultCalls().findLast((m) => m.method === 'vault/document/resolve').params, {
  url: 'urn:sha256:' + sha256,
  title: 'A Small Book',
  kind: 'epub',
});
assert.equal(state.binding?.highlightId, 'h001', 'Ask AI bound the conversation to the book');
readerCommands.jump = (command) => ({ found: command.highlightId === 'h001' });
assert.deepEqual(await side({ type: 'readingJump', highlightId: 'h001' }), { found: true });
assert.deepEqual(posted.findLast((m) => m.type === 'command').command, {
  type: 'tabgentHighlight',
  action: 'jump',
  highlightId: 'h001',
});
readerCommands.context = () => ({
  before: 'People are ',
  after: ' when',
  chapterFile: 'chapters/01-chapter-one.md',
});
await side({ type: 'readingOpen', documentId: document.id, highlightId: 'h001' });
const opened = selections().at(-1);
assert.equal(opened.url, 'urn:sha256:' + sha256);
assert.deepEqual(opened.context, { before: 'People are ', after: ' when' });
assert.equal(opened.locator.kind, 'epub');
assert.equal(opened.locator.chapterFile, folder + '/chapters/01-chapter-one.md');
// A note from the panel list is saved and the reader refreshes its highlight records.
readerCommands.refresh = () => null;
await side({ type: 'readingNote', documentId: document.id, highlightId: 'h001', note: 'Mine' });
assert.deepEqual(vaultCalls().findLast((m) => m.method === 'vault/highlight/update').params, {
  documentId: document.id,
  highlightId: 'h001',
  note: 'Mine',
});
assert.deepEqual(posted.findLast((m) => m.type === 'command').command, {
  type: 'tabgentHighlight',
  action: 'refresh',
});
saved.note = 'Mine';
// Messages from the reader tab carry a reading context that names the book's chapters.
await chat.onMessage.listeners[0]({
  type: 'ui',
  name: 'codexRpc',
  args: [{ id: 50, method: 'turn/start', params: { input: [{ type: 'text', text: 'Why?' }] } }],
});
const turn = await until(() =>
  sent.findLast((m) => m.op === 'rpc' && m.message.method === 'turn/start'),
);
const part = turn.message.params.input.find((p) => p.text?.startsWith(readingContextPrefix));
const reading = JSON.parse(part.text.slice(readingContextPrefix.length));
assert.equal(reading.document.kind, 'epub');
assert.equal(reading.document.url, 'urn:sha256:' + sha256);
assert.equal(reading.document.chapters, folder + '/chapters');
assert.equal(reading.highlight.userNote, 'Mine', "The user's note goes with the message");
// A closed book leaves the reader tab without a document.
for (const listener of port.onMessage.listeners) listener({ type: 'book', sha256: '' });
assert.equal((await side({ type: 'readingState' })).page, null);
console.log(
  'PASS the reading companion maps the reader tab to its book; jump and reopen use the port',
);

// The toolbar button's context menu opens the reader next to the current tab.
chrome.runtime.onInstalled.listeners[0]();
assert.deepEqual(
  menus.map(({ id, contexts }) => [id, contexts]),
  [
    ['quote-selection', ['selection']],
    ['open-epub-reader', ['action']],
  ],
);
chrome.contextMenus.onClicked.listeners[0](
  { menuItemId: 'open-epub-reader' },
  { id: 4, index: 2, windowId: 7 },
);
await new Promise((r) => setTimeout(r, 0));
assert.deepEqual(created, [{ url: reader, windowId: 7, index: 3 }]);
console.log('PASS the toolbar context menu opens the EPUB reader');
