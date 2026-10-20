import assert from 'node:assert/strict';
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
  sidePanel: {
    setPanelBehavior: async () => {},
    open: (options) => {
      opened.push(options);
      return Promise.resolve();
    },
  },
  tabs: {
    get: async (id) => ({ id, windowId: 1, url: 'https://example.test/article' }),
    onRemoved: event(),
  },
  webNavigation: {
    onCommitted: event(),
    getFrame: async ({ frameId }) => (frameId === 0 ? { documentId: 'current' } : null),
  },
};
await import('../background.js');
await new Promise((r) => setTimeout(r, 0));
const messages = [],
  port = {
    name: 'chat',
    sender: { url: 'chrome-extension://test/ui/chat.html', id: 'test' },
    onMessage: event(),
    onDisconnect: event(),
    postMessage: (m) => messages.push(m),
  };
chrome.runtime.onConnect.listeners[0](port);
await port.onMessage.listeners[0]({ type: 'attach', tabId: 1 });
const listener = chrome.runtime.onMessage.listeners[0];
const call = (m, s) => new Promise((resolve) => listener(m, s, resolve));
const page = {
  id: 'test',
  tab: { id: 1, title: 'Article' },
  frameId: 0,
  documentId: 'current',
  url: 'https://example.test/article?id=7#section-2',
};
const vaultCalls = () => sent.filter((m) => m.op === 'vault');
const anchor = {
  kind: 'web',
  quote: { exact: 'quoted words', prefix: 'before ', suffix: ' after' },
  position: { start: 10, end: 22 },
  dom: {
    start: { path: 'html:nth-child(1)', offset: 0 },
    end: { path: 'html:nth-child(1)', offset: 1 },
  },
};
const document = {
  id: 'article-example-1a2b',
  kind: 'web',
  title: 'Article',
  createdAt: '2026-10-20T10:00:00+08:00',
};
const saved = { id: 'h001', text: 'quoted words', anchor, turnCount: 0 };

host['vault/document/resolve'] = () => ({ document, highlights: [saved] });
const resolved = await call(
  { type: 'highlightResolve', title: 'Article', meta: { author: 'A', ignored: 'x' } },
  page,
);
assert.equal(resolved.url, 'https://example.test/article?id=7');
assert.deepEqual(resolved.highlights, [saved]);
assert.deepEqual(vaultCalls().at(-1).params, {
  url: 'https://example.test/article?id=7',
  title: 'Article',
  kind: 'web',
  meta: { author: 'A' },
});
assert(
  !sent.some((m) => ['claim', 'rpc'].includes(m.op)),
  'Vault calls never claim a Codex session',
);
console.log('PASS resolve uses sender URL without fragment and needs no Codex session');

const before = vaultCalls().length;
for (const sender of [
  { ...page, frameId: 4 },
  { ...page, tab: { id: 1, incognito: true } },
  { ...page, url: 'chrome-extension://other/page.html' },
  { ...page, documentId: 'previous' },
  { ...page, tab: undefined },
])
  assert((await call({ type: 'highlightResolve' }, sender)).error);
assert.equal(vaultCalls().length, before, 'Rejected senders never reach the vault');
console.log('PASS subframe / private / non-web / stale / tabless senders rejected');

host['vault/highlight/create'] = (params) => ({
  document,
  highlight: { ...saved, id: 'h002', text: params.text, anchor: params.anchor },
});
const created = await call(
  {
    type: 'highlightCreate',
    text: 'quoted words',
    anchor: { ...anchor, extra: 1 },
    location: 'Intro',
  },
  page,
);
assert.equal(created.highlight.id, 'h002');
assert.equal(created.panelOpened, undefined);
assert.equal(opened.length, 0, 'Plain highlights do not open the side panel');
const createParams = vaultCalls().at(-1).params;
assert.equal(createParams.anchor.extra, undefined);
assert.equal(createParams.location, 'Intro');
assert.equal(createParams.kind, 'web');
assert((await call({ type: 'highlightCreate', text: 'x', anchor: { kind: 'pdf' } }, page)).error);
console.log('PASS create sends a cleaned web anchor and does not open the side panel');

// "Ask AI": the side panel must open before the handler's first await.
const asked = new Promise((resolve) =>
  listener(
    {
      type: 'highlightCreate',
      ask: true,
      text: 'quoted words',
      anchor,
      title: 'Article',
      context: { before: 'b'.repeat(3000), after: 'after text' },
    },
    page,
    resolve,
  ),
);
assert.deepEqual(opened, [{ tabId: 1 }], 'sidePanel.open runs synchronously in the gesture');
const askResult = await asked;
assert.equal(askResult.panelOpened, true);
const selection = messages.filter((m) => m.name === 'codex-selection').at(-1).value;
assert.deepEqual(selection.highlight, {
  documentId: document.id,
  highlightId: 'h002',
  kind: 'web',
});
assert.equal(selection.context.before.length, 2000);
assert.equal(selection.context.after, 'after text');
assert.equal(selection.text, 'quoted words');
assert.equal(selection.url, page.url);
assert.equal(selection.locator.anchor.quote.exact, 'quoted words');
console.log('PASS Ask AI opens the panel in-gesture and hands off highlight + context');

host['vault/highlight/create'] = () => {
  throw { code: 'vault_unwritable', message: 'Read-only vault' };
};
const degraded = await call(
  { type: 'highlightCreate', ask: true, text: 'quoted words', anchor },
  page,
);
assert.equal(degraded.code, 'vault_unwritable');
assert.equal(degraded.highlight, null);
assert.equal(messages.filter((m) => m.name === 'codex-selection').at(-1).value.highlight, null);
const failed = await call({ type: 'highlightCreate', text: 'quoted words', anchor }, page);
assert.equal(failed.code, 'vault_unwritable');
console.log('PASS vault failure still hands the selection to Codex; plain highlight reports it');

host['vault/highlight/delete'] = () => ({ ok: true });
const foreign = await call(
  { type: 'highlightDelete', documentId: 'article-other', highlightId: 'h001' },
  page,
);
assert.equal(foreign.code, 'not_found');
assert(!vaultCalls().some((m) => m.method === 'vault/highlight/delete'));
assert.deepEqual(
  await call({ type: 'highlightDelete', documentId: document.id, highlightId: 'h001' }, page),
  { ok: true },
);
assert.deepEqual(vaultCalls().at(-1).params, { documentId: document.id, highlightId: 'h001' });
console.log("PASS delete is limited to highlights of the sender's page");

opened.length = 0;
const existing = new Promise((resolve) =>
  listener(
    {
      type: 'highlightAsk',
      documentId: document.id,
      highlightId: 'h001',
      context: { before: 'x', after: 'y' },
    },
    page,
    resolve,
  ),
);
assert.equal(opened.length, 1);
assert.equal((await existing).panelOpened, true);
const reopened = messages.filter((m) => m.name === 'codex-selection').at(-1).value;
assert.deepEqual(reopened.highlight, { documentId: document.id, highlightId: 'h001', kind: 'web' });
assert.equal(reopened.text, saved.text, 'Existing highlight text comes from the vault record');
console.log('PASS asking about a saved highlight reuses its vault record');

await call(
  { type: 'highlightStatus', documentId: document.id, anchored: 1, unanchored: ['h009'] },
  page,
);
assert.deepEqual(messages.at(-1), {
  type: 'event',
  name: 'codex-highlight-status',
  value: {
    url: 'https://example.test/article?id=7',
    documentId: document.id,
    anchored: 1,
    unanchored: ['h009'],
  },
});
console.log('PASS anchoring status reaches the tab conversation');

delete host['vault/document/resolve'];
const pending = call({ type: 'highlightResolve' }, page);
await new Promise((r) => setTimeout(r, 0));
chrome.runtime.lastError = { message: 'Native host has exited.' };
native.onDisconnect.listeners[0]();
assert.deepEqual(await pending, { error: 'Native host has exited.', code: 'disconnected' });
console.log('PASS connector disconnect rejects in-flight vault requests');

// Chrome keeps the load-time sender.url after history.pushState; the frame URL is current.
host['vault/document/resolve'] = () => ({ document: null, highlights: [] });
chrome.webNavigation.getFrame = async () => ({
  documentId: 'current',
  url: 'https://example.test/next?page=2#top',
});
const spa = await call({ type: 'highlightResolve' }, page);
assert.equal(spa.url, 'https://example.test/next?page=2');
assert.equal(vaultCalls().at(-1).params.url, 'https://example.test/next?page=2');
console.log('PASS SPA navigation resolves the current frame URL, not the stale sender URL');
