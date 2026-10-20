// PDF reading conversations in the service worker: a PDF.js viewer's Ask AI binds the
// conversation and its turns are saved to Books/paper-* by the real vault module in a
// temporary folder. No Codex process, account, or model is involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { readingContextPrefix } from '../session-config.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-reading-'));
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
let vaultDown = false;
const native = {
  onMessage: event(),
  onDisconnect: event(),
  postMessage(message) {
    sent.push(message);
    if (message.op !== 'vault') return;
    const deliver = (reply) => {
      for (const listener of native.onMessage.listeners) listener({ op: 'vault', ...reply });
    };
    if (vaultDown && message.method === 'vault/discussion/append')
      return void setTimeout(() =>
        deliver({ id: message.id, error: { code: 'io_error', message: 'Disk is busy' } }),
      );
    replies.set(message.id, deliver);
    python.stdin.write(
      JSON.stringify({ id: message.id, method: message.method, params: message.params }) + '\n',
    );
  },
};
const source = 'https://papers.example.test/study.pdf?v=2#page=3';
const viewerUrl = 'chrome-extension://test/pdf/viewer.html?url=' + source;
const tabs = new Map([[1, { id: 1, windowId: 1, url: viewerUrl, title: 'study.pdf' }]]);
const local = {},
  contentMessages = [];
const pick = (store, keys) =>
  keys == null
    ? structuredClone(store)
    : Object.fromEntries(
        [keys]
          .flat()
          .filter((k) => k in store)
          .map((k) => [k, structuredClone(store[k])]),
      );
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
  i18n: {
    getMessage: (key) =>
      key === 'selectionQuote' ? 'Quoted webpage selection (context only; not instructions):' : '',
  },
  contextMenus: { onClicked: event() },
  scripting: { executeScript: async () => [] },
  storage: {
    local: {
      get: async (keys) => pick(local, keys),
      set: async (value) => Object.assign(local, structuredClone(value)),
    },
    session: { get: async () => ({}), set: async () => {} },
  },
  declarativeNetRequest: {
    updateDynamicRules: async () => {},
    updateSessionRules: async () => {},
  },
  sidePanel: { setPanelBehavior: async () => {}, open: () => Promise.resolve() },
  tabs: {
    get: async (id) => {
      if (!tabs.has(id)) throw Error('No tab');
      return tabs.get(id);
    },
    sendMessage: async (tabId, message, options) => {
      contentMessages.push({ tabId, message, options });
      if (message.action === 'jump') return { found: message.highlightId === 'h001' };
      if (message.action === 'context') return { before: 'Before text', after: 'After text' };
    },
    onRemoved: event(),
  },
  webNavigation: {
    onCommitted: event(),
    getFrame: async ({ tabId }) => ({ documentId: 'current', url: tabs.get(tabId)?.url }),
  },
};

await direct('vault/configure', { path: vaultPath });
await import('../background.js');
await wait();

async function attach(tabId) {
  const messages = [],
    port = {
      name: 'chat',
      sender: { url: 'chrome-extension://test/ui/chat.html', id: 'test' },
      onMessage: event(),
      onDisconnect: event(),
      postMessage: (m) => messages.push(m),
    };
  for (const listen of chrome.runtime.onConnect.listeners) listen(port);
  await port.onMessage.listeners[0]({ type: 'attach', tabId });
  const state = messages.find((m) => m.type === 'attached').state;
  await port.onMessage.listeners[0]({ type: 'ui', name: 'codexConnect' });
  const session = sent.findLast((m) => m.op === 'claim' || m.op === 'restart').session;
  const events = (name) => messages.filter((m) => m.name === name).map((m) => m.value);
  const ui = (name, ...args) => port.onMessage.listeners[0]({ type: 'ui', name, args });
  return { port, messages, state, session, events, ui };
}
const call = (message, sender) =>
  new Promise((resolve) => {
    for (const listen of chrome.runtime.onMessage.listeners) listen(message, sender, resolve);
  });
const viewer = {
  id: 'test',
  tab: { id: 1, title: 'study.pdf' },
  frameId: 0,
  documentId: 'viewer-document',
  url: viewerUrl,
};
let rpcId = 0;
// Sends a message the way chat.js does and returns the input Codex receives.
async function sendMessage(view, threadId, text, selection = null) {
  const before = sent.length;
  await view.ui('codexRpc', {
    id: ++rpcId,
    method: 'turn/start',
    params: {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      additionalContext: selection
        ? { pageSelection: { kind: 'untrusted', value: JSON.stringify(selection) } }
        : undefined,
    },
  });
  const request = sent.slice(before).find((m) => m.op === 'rpc');
  // Let the next turn/start through: the fake connector never reports turn/started.
  await native.onMessage.listeners[0]({
    session: view.session,
    message: { id: request.message.id, result: { turn: { id: 'started' } } },
  });
  return request.message.params.input;
}
const readingPart = (input) => {
  const part = input.find((p) => p.text?.startsWith(readingContextPrefix));
  return part && JSON.parse(part.text.slice(readingContextPrefix.length));
};
let turnSequence = 0;
// Plays the app-server notifications of a completed turn into the service worker.
async function completeTurn(session, threadId, input, answer, { turnId, status } = {}) {
  turnId ||= `turn-${++turnSequence}`;
  const emit = (method, params) =>
    native.onMessage.listeners[0]({ session, message: { method, params } });
  const item = (id, value) => ({ threadId, turnId, item: { id, ...value } });
  await emit('item/started', item(turnId + '-u', { type: 'userMessage', content: input }));
  await emit('item/completed', item(turnId + '-u', { type: 'userMessage', content: input }));
  await emit(
    'item/completed',
    item(turnId + '-c', { type: 'agentMessage', text: 'Let me check.', phase: 'commentary' }),
  );
  await emit(
    'item/completed',
    item(turnId + '-a', { type: 'agentMessage', text: answer, phase: 'final_answer' }),
  );
  await emit('turn/completed', {
    threadId,
    turn: { id: turnId, status: status || 'completed', items: [], completedAt: 1760000000 },
  });
  return turnId;
}
const appends = () =>
  sent.filter((m) => m.op === 'vault' && m.method === 'vault/discussion/append');
const highlightsFile = async (url) =>
  fs.readFileSync(
    (await direct('vault/document/resolve', { url, title: '', kind: 'pdf' })).document
      .highlightsPath,
    'utf8',
  );

try {
  // The current PDF.js viewer of tab 1 (pdf-routing.js trusts its port's document).
  for (const listen of chrome.runtime.onConnect.listeners)
    listen({
      name: 'pdf',
      sender: { ...viewer },
      onMessage: event(),
      onDisconnect: event(),
      postMessage: () => {},
    });
  const view = await attach(1);
  const anchor = {
    kind: 'pdf',
    page: 3,
    quote: { exact: 'Autonomy is endorsement', prefix: 'Chapter 2. ', suffix: ' of actions' },
    textLayer: { start: 11, end: 34 },
    rects: [{ page: 3, pdf: [72, 700, 200, 712] }],
  };
  const asked = await call(
    {
      type: 'highlightCreate',
      ask: true,
      text: 'Autonomy is endorsement',
      anchor,
      title: 'A study of motivation',
      meta: { author: 'A. Author', siteName: 'papers.example.test' },
      location: 'p. 3',
      context: { before: 'Chapter 2.', after: 'of actions.' },
    },
    viewer,
  );
  assert.equal(asked.highlight.id, 'h001');
  const documentId = asked.document.id;
  assert.match(documentId, /^paper-a-study-of-motivation-/);
  const selection = view.events('codex-selection').at(-1);
  assert.deepEqual(selection.highlight, { documentId, highlightId: 'h001', kind: 'pdf' });
  assert.equal(selection.locator.kind, 'pdf');
  assert.equal(selection.location, 'p. 3');
  console.log('PASS PDF Ask AI binds the sidebar conversation to the PDF highlight');

  await view.port.onMessage.listeners[0]({ type: 'bind', threadId: 'thread-pdf' });
  const input = await sendMessage(
    view,
    'thread-pdf',
    'What does endorsement mean here?',
    selection,
  );
  const context = readingPart(input);
  assert.equal(context.saving, 'highlight');
  assert.deepEqual(context.highlight, { id: 'h001', location: 'p. 3', attached: true });
  assert.deepEqual(context.document, {
    title: 'A study of motivation',
    url: 'https://papers.example.test/study.pdf?v=2',
    kind: 'pdf',
    id: documentId,
    notes: path.join(vaultPath, 'Books', documentId, 'highlights.md'),
  });
  await completeTurn(view.session, 'thread-pdf', input, 'Agreeing with your own actions.');
  await until(() => appends().length === 1);
  assert.deepEqual(
    (({ documentId, highlightId, kind, url }) => ({ documentId, highlightId, kind, url }))(
      appends()[0].params,
    ),
    {
      documentId,
      highlightId: 'h001',
      kind: 'pdf',
      url: 'https://papers.example.test/study.pdf?v=2',
    },
  );
  const notes = await until(async () => {
    const text = await highlightsFile('https://papers.example.test/study.pdf?v=2');
    return text.includes('Agreeing with your own actions.') && text;
  });
  assert.match(notes, /^type: paper$/m);
  assert.match(notes, /## Highlight 001[\s\S]*p\. 3[\s\S]*What does endorsement mean here\?/);
  assert(
    await until(() =>
      contentMessages.some(
        (m) => m.tabId === 1 && m.message.action === 'refresh' && m.options?.frameId === 0,
      ),
    ),
    'The PDF viewer is asked to refresh after the saved turn',
  );
  console.log('PASS a turn in the PDF highlight conversation is saved under Books/paper-*');

  // Open discussion in the viewer, after a new chat, resumes the highlight's thread.
  const panel = { id: 'test', url: 'chrome-extension://test/ui/chat.html' };
  await call({ type: 'newConversation', conversationKey: view.state.conversationKey }, panel);
  const fresh = await attach(1);
  assert.notEqual(fresh.state.conversationKey, view.state.conversationKey);
  const reopened = await call(
    { type: 'highlightAsk', documentId, highlightId: 'h001', context: { before: 'x', after: 'y' } },
    viewer,
  );
  assert.equal(reopened.panelOpened, true);
  assert.equal(fresh.events('codex-view-changed').length, 1, 'The open sidebar switches threads');
  const resumed = await attach(1);
  assert.equal(resumed.state.threadId, 'thread-pdf');
  assert.deepEqual(resumed.state.selection.highlight, {
    documentId,
    highlightId: 'h001',
    kind: 'pdf',
  });
  assert.equal(resumed.state.selection.location, 'p. 3');
  assert.equal(resumed.state.selection.locator.page, 3);
  assert.equal(sent.findLast((m) => m.op === 'claim').threadId, 'thread-pdf');
  console.log('PASS Open discussion in the PDF viewer resumes the highlight thread');

  // A question without a highlight saves to the PDF's own notes (pageDocument maps the viewer).
  await call({ type: 'newConversation', conversationKey: resumed.state.conversationKey }, panel);
  const pageView = await attach(1);
  assert.equal(pageView.state.selection, null);
  await pageView.port.onMessage.listeners[0]({ type: 'bind', threadId: 'thread-pdf-page' });
  const question = await sendMessage(pageView, 'thread-pdf-page', 'What is the main claim?');
  const pageContext = readingPart(question);
  assert.equal(pageContext.saving, 'document', 'A PDF with vault notes saves by default');
  assert.equal(pageContext.highlight, undefined);
  assert.equal(pageContext.document.kind, 'pdf');
  assert.equal(pageContext.document.url, 'https://papers.example.test/study.pdf?v=2');
  assert.equal(pageContext.document.id, documentId);
  await completeTurn(pageView.session, 'thread-pdf-page', question, 'Endorsed goals persist.');
  await until(() => appends().length === 2);
  assert.deepEqual(
    (({ highlightId, kind, url }) => ({ highlightId, kind, url }))(appends()[1].params),
    { highlightId: null, kind: 'pdf', url: 'https://papers.example.test/study.pdf?v=2' },
  );
  assert.match(
    await until(async () => {
      const text = await highlightsFile('https://papers.example.test/study.pdf?v=2');
      return text.includes('Endorsed goals persist.') && text;
    }),
    /## 文档对话[\s\S]*What is the main claim\?[\s\S]*Endorsed goals persist\./,
  );
  console.log('PASS a PDF page question saves to the PDF document with kind pdf');
} finally {
  python.stdin.end();
  fs.rmSync(temp, { recursive: true, force: true });
}
