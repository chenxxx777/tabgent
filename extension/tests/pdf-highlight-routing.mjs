// PDF viewer highlights through background.js with a fake connector that answers only the
// vault channel. The current PDF.js viewer is the sender; its document is the original PDF URL.
import assert from 'node:assert/strict';
const event = () => ({
  listeners: [],
  addListener(fn) {
    this.listeners.push(fn);
  },
});
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
const source = 'https://papers.example.test/paper.pdf?v=2#page=3';
const viewerUrl = 'chrome-extension://test/pdf/viewer.html?url=' + source;
let tabUrl = viewerUrl;
const opened = [];
globalThis.chrome = {
  alarms: {
    onAlarm: event(),
    get: async () => null,
    create: async () => {},
    clear: async () => true,
  },
  runtime: {
    id: 'test',
    getURL: (p) => 'chrome-extension://test/' + p,
    onConnect: event(),
    onMessage: event(),
    onInstalled: event(),
    onStartup: event(),
    connectNative: () => native,
  },
  contextMenus: { onClicked: event() },
  scripting: { executeScript: async () => [] },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
  declarativeNetRequest: {
    updateDynamicRules: async () => {},
    updateSessionRules: async () => {},
  },
  sidePanel: {
    setPanelBehavior: async () => {},
    open: (options) => {
      opened.push(options);
      return Promise.resolve();
    },
  },
  tabs: {
    get: async (id) => ({ id, windowId: 1, url: tabUrl }),
    onRemoved: event(),
  },
  webNavigation: {
    onCommitted: event(),
    // Chrome hides extension documents from getFrame.
    getFrame: async () => null,
  },
};
await import('../background.js');
await new Promise((r) => setTimeout(r, 0));
const connect = (port) => {
  for (const listener of chrome.runtime.onConnect.listeners) listener(port);
};
const messages = [],
  chat = {
    name: 'chat',
    sender: { url: 'chrome-extension://test/ui/chat.html', id: 'test' },
    onMessage: event(),
    onDisconnect: event(),
    postMessage: (m) => messages.push(m),
  };
connect(chat);
await chat.onMessage.listeners[0]({ type: 'attach', tabId: 1 });
const listeners = chrome.runtime.onMessage.listeners;
const send = (m, s, resolve) => {
  for (const listener of listeners) listener(m, s, resolve);
};
const call = (m, s) => new Promise((resolve) => send(m, s, resolve));
const viewer = {
  id: 'test',
  tab: { id: 1, title: 'paper.pdf' },
  frameId: 0,
  documentId: 'viewer-document',
  url: viewerUrl,
};
const vaultCalls = () => sent.filter((m) => m.op === 'vault');

assert.match((await call({ type: 'highlightResolve' }, viewer)).error, /Stale PDF viewer/);
assert.equal(vaultCalls().length, 0, 'A viewer without its PDF port is not trusted');
const pdfPort = {
  name: 'pdf',
  sender: { ...viewer },
  onMessage: event(),
  onDisconnect: event(),
  postMessage: () => {},
};
connect(pdfPort);

const anchor = {
  kind: 'pdf',
  page: 3,
  quote: { exact: 'quoted words', prefix: 'before ', suffix: ' after' },
  textLayer: { start: 7, end: 19 },
  rects: [{ page: 3, pdf: [72, 700, 140, 712] }],
};
const document = {
  id: 'paper-a-study-1a2b3c4d',
  kind: 'pdf',
  title: 'A study',
  createdAt: '2026-10-20T10:00:00+08:00',
};
const saved = { id: 'h001', text: 'quoted words', anchor, location: 'p. 3', turnCount: 0 };
host['vault/document/resolve'] = () => ({ document, highlights: [saved] });
const resolved = await call(
  { type: 'highlightResolve', title: 'A study', meta: { author: 'A. Author', siteName: 'x' } },
  viewer,
);
assert.equal(resolved.url, 'https://papers.example.test/paper.pdf?v=2');
assert.deepEqual(resolved.highlights, [saved]);
assert.deepEqual(vaultCalls().at(-1).params, {
  url: 'https://papers.example.test/paper.pdf?v=2',
  title: 'A study',
  kind: 'pdf',
  meta: { author: 'A. Author', siteName: 'x' },
});
assert(!sent.some((m) => ['claim', 'rpc'].includes(m.op)), 'Vault calls need no Codex session');
console.log('PASS PDF viewer resolves the original PDF URL (no fragment) as a pdf document');

const before = vaultCalls().length;
for (const sender of [
  { ...viewer, documentId: 'previous-viewer' },
  { ...viewer, frameId: 3 },
  { ...viewer, tab: { id: 1, incognito: true } },
  { ...viewer, url: 'chrome-extension://test/pdf/viewer.html?url=javascript:alert(1)' },
  { ...viewer, url: 'chrome-extension://test/ui/chat.html' },
])
  assert((await call({ type: 'highlightResolve' }, sender)).error);
tabUrl = 'chrome-extension://test/pdf/viewer.html?url=https://papers.example.test/other.pdf';
assert((await call({ type: 'highlightResolve' }, viewer)).error, 'The tab moved to another PDF');
tabUrl = viewerUrl;
assert.equal(vaultCalls().length, before, 'Rejected senders never reach the vault');
console.log('PASS stale / subframe / private / non-PDF / navigated viewers are rejected');

host['vault/highlight/create'] = (params) => ({
  document,
  highlight: { ...saved, id: 'h002', text: params.text, anchor: params.anchor },
});
const webAnchor = {
  kind: 'web',
  quote: { exact: 'quoted words' },
  position: { start: 1, end: 13 },
};
assert.equal(
  (await call({ type: 'highlightCreate', text: 'quoted words', anchor: webAnchor }, viewer)).code,
  'invalid_params',
);
const created = await call(
  {
    type: 'highlightCreate',
    text: 'quoted words',
    anchor: { ...anchor, extra: 1, quote: { ...anchor.quote, extra: 2 } },
    location: 'p. 3',
    title: 'A study',
  },
  viewer,
);
assert.equal(created.highlight.id, 'h002');
assert.equal(opened.length, 0, 'Plain highlights do not open the side panel');
const createParams = vaultCalls().at(-1).params;
assert.equal(createParams.kind, 'pdf');
assert.equal(createParams.url, 'https://papers.example.test/paper.pdf?v=2');
assert.equal(createParams.location, 'p. 3');
assert.deepEqual(createParams.anchor, anchor, 'Only contract fields of the PDF anchor are sent');
console.log('PASS create sends kind pdf, a cleaned pdf anchor and the page label');

const asked = new Promise((resolve) =>
  send(
    {
      type: 'highlightCreate',
      ask: true,
      text: 'quoted words',
      anchor,
      title: 'A study',
      location: 'p. 3',
      context: { before: 'Text before on page 3', after: 'and after.' },
    },
    viewer,
    resolve,
  ),
);
assert.deepEqual(opened, [{ tabId: 1 }], 'sidePanel.open runs synchronously in the gesture');
assert.equal((await asked).panelOpened, true);
const selection = messages.filter((m) => m.name === 'codex-selection').at(-1).value;
assert.deepEqual(selection.highlight, {
  documentId: document.id,
  highlightId: 'h002',
  kind: 'pdf',
});
assert.deepEqual(selection.context, { before: 'Text before on page 3', after: 'and after.' });
assert.equal(selection.text, 'quoted words');
assert.equal(selection.url, source);
assert.equal(selection.title, 'A study');
assert.equal(selection.locator.kind, 'pdf');
assert.equal(selection.locator.page, 3);
assert.deepEqual(selection.locator.anchor, anchor);
assert.equal(selection.location, 'p. 3');
console.log('PASS Ask AI opens the panel in-gesture and hands off highlight, context and locator');

opened.length = 0;
const existing = new Promise((resolve) =>
  send(
    {
      type: 'highlightAsk',
      documentId: document.id,
      highlightId: 'h001',
      context: { before: 'x', after: 'y' },
    },
    viewer,
    resolve,
  ),
);
assert.equal(opened.length, 1);
assert.equal((await existing).panelOpened, true);
assert.equal(
  vaultCalls().findLast((m) => m.method === 'vault/document/resolve').params.kind,
  'pdf',
);
const reopened = messages.filter((m) => m.name === 'codex-selection').at(-1).value;
assert.deepEqual(reopened.highlight, { documentId: document.id, highlightId: 'h001', kind: 'pdf' });
assert.equal(reopened.locator.kind, 'pdf');
assert.equal(reopened.locator.page, 3);
assert.equal(reopened.location, 'p. 3');
console.log('PASS asking about a saved PDF highlight reuses its vault record');

host['vault/document/resolve'] = () => ({
  document,
  highlights: [saved, { id: 'h003', text: 'loose words', location: 'p. 2', turnCount: 0 }],
});
await call({ type: 'highlightAsk', documentId: document.id, highlightId: 'h003' }, viewer);
const loose = messages.filter((m) => m.name === 'codex-selection').at(-1).value;
assert.equal(loose.highlight.kind, 'pdf', 'A record without an anchor is still a PDF quote');
assert.equal(loose.locator.kind, 'pdf');
assert.equal(loose.locator.page, undefined);
host['vault/document/resolve'] = () => ({ document, highlights: [saved] });
console.log('PASS a saved PDF highlight without an anchor is still handed off as pdf');

host['vault/highlight/delete'] = () => ({ ok: true });
assert.equal(
  (await call({ type: 'highlightDelete', documentId: 'paper-other', highlightId: 'h001' }, viewer))
    .code,
  'not_found',
);
assert.deepEqual(
  await call({ type: 'highlightDelete', documentId: document.id, highlightId: 'h001' }, viewer),
  { ok: true },
);
assert.deepEqual(vaultCalls().at(-1).params, { documentId: document.id, highlightId: 'h001' });
console.log("PASS delete is limited to highlights of the viewer's PDF");

host['vault/highlight/update'] = (params) => ({
  document,
  highlight: { ...saved, note: params.note },
});
const updates = () => vaultCalls().filter((m) => m.method === 'vault/highlight/update');
assert.equal(
  (
    await call(
      { type: 'highlightNote', documentId: 'paper-other', highlightId: 'h001', note: 'x' },
      viewer,
    )
  ).code,
  'not_found',
);
assert.equal(updates().length, 0);
const note = await call(
  { type: 'highlightNote', documentId: document.id, highlightId: 'h001', note: 'Mine' },
  viewer,
);
assert.equal(note.highlight.note, 'Mine');
assert.deepEqual(updates().at(-1).params, {
  documentId: document.id,
  highlightId: 'h001',
  note: 'Mine',
});
console.log("PASS notes are limited to highlights of the viewer's PDF");

await call(
  { type: 'highlightStatus', documentId: document.id, anchored: 1, unanchored: ['h009'] },
  viewer,
);
assert.deepEqual(messages.at(-1).value, {
  url: 'https://papers.example.test/paper.pdf?v=2',
  documentId: document.id,
  anchored: 1,
  unanchored: ['h009'],
});
console.log('PASS PDF anchoring status reaches the tab conversation');
