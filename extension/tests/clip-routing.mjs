// Clipping in the service worker, with the real vault module in a temporary folder and a
// scripted page: the worker injects the clipping files into the top frame only, asks the
// page before replacing a clip, falls back to the whole page when asked, refuses results
// from a page that navigated, bounds what the page returns, saves with vault/clip/save,
// and names the clipped text in the reading context. No Codex process or model is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { readingContextPrefix } from '../session-config.js';
import { cleanClip, CLIP_LIMIT } from '../clipper.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-clip-routing-'));
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

// The worker downloads a clip's images; this network answers only the fixture addresses.
Uint8Array.prototype.toBase64 ??= function () {
  return Buffer.from(this).toString('base64');
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(200).fill(7)]);
const fetched = [];
globalThis.fetch = async (url, options) => {
  fetched.push({ url, credentials: options?.credentials, referrerPolicy: options?.referrerPolicy });
  if (url === 'https://example.test/figure.png') return new Response(PNG);
  return new Response('Not found', { status: 404 });
};
const base = 'chrome-extension://test/';
const article = 'https://example.test/essays/autonomy';
const tabs = new Map([
  [1, { id: 1, windowId: 1, index: 0, url: article + '#top', title: 'On Autonomy' }],
  [
    2,
    { id: 2, windowId: 1, index: 1, url: base + 'pdf/viewer.html?url=https://example.test/a.pdf' },
  ],
  [3, { id: 3, windowId: 1, index: 2, url: 'https://example.test/private', incognito: true }],
  [4, { id: 4, windowId: 1, index: 3, url: 'https://example.test/short', title: 'Short' }],
]);
// The page's answers: what clipping returns, what the user chooses in the page prompt.
const page = { run: [], ask: [] };
const injected = [],
  notes = [],
  menus = [];
const documentId = (tabId) => `document-${tabId}`;
globalThis.chrome = {
  alarms: {
    onAlarm: event(),
    get: async () => null,
    create: async () => {},
    clear: async () => true,
  },
  runtime: {
    id: 'test',
    getURL: (p) => base + p,
    onConnect: event(),
    onMessage: event(),
    onInstalled: event(),
    onStartup: event(),
    connectNative: () => native,
  },
  i18n: {
    getMessage: (key, values) => (values?.length ? `${key}(${values.join('|')})` : key),
  },
  contextMenus: { onClicked: event(), removeAll: (done) => done(), create: (m) => menus.push(m) },
  commands: { onCommand: event() },
  scripting: {
    executeScript: async ({ target, files, func, args }) => {
      injected.push({ target, files, func: func && String(func), args });
      const frame = { frameId: 0, documentId: documentId(target.tabId) };
      if (files) return [{ ...frame, result: null }];
      const kind = /\.ask\(/.test(String(func)) ? 'ask' : /\.run\(/.test(String(func)) ? 'run' : '';
      if (!kind) return (notes.push(args[0]), [{ ...frame, result: undefined }]);
      const next = page[kind].shift();
      const value = typeof next === 'function' ? next(args[0]) : next;
      return [
        {
          ...frame,
          ...(value?.documentId ? { documentId: value.documentId } : {}),
          result: value?.result ?? value,
        },
      ];
    },
  },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
  declarativeNetRequest: { updateDynamicRules: async () => {}, updateSessionRules: async () => {} },
  sidePanel: { setPanelBehavior: async () => {}, open: () => Promise.resolve() },
  tabs: {
    get: async (id) => {
      if (!tabs.has(id)) throw Error('No tab');
      return tabs.get(id);
    },
    create: async () => ({ id: 9 }),
    update: async () => {},
    sendMessage: async () => null,
    onRemoved: event(),
  },
  webNavigation: {
    onCommitted: event(),
    getFrame: async ({ tabId }) =>
      /^https?:/.test(tabs.get(tabId)?.url)
        ? { documentId: documentId(tabId), url: tabs.get(tabId).url }
        : null,
  },
};

await direct('vault/configure', { path: vaultPath });
await import('../background.js');
await wait();
const call = (message, sender) =>
  new Promise((resolve) => {
    for (const listen of chrome.runtime.onMessage.listeners) listen(message, sender, resolve);
  });
const vaultCalls = (method) => sent.filter((m) => m.op === 'vault' && m.method === method);
async function attach(tabId) {
  const messages = [],
    port = {
      name: 'chat',
      sender: { url: base + 'ui/chat.html', id: 'test' },
      onMessage: event(),
      onDisconnect: event(),
      postMessage: (m) => messages.push(m),
    };
  for (const listen of chrome.runtime.onConnect.listeners) listen(port);
  await port.onMessage.listeners[0]({ type: 'attach', tabId });
  const state = messages.find((m) => m.type === 'attached').state;
  await port.onMessage.listeners[0]({ type: 'ui', name: 'codexConnect' });
  const events = (name) => messages.filter((m) => m.name === name).map((m) => m.value);
  const ui = (name, ...args) => port.onMessage.listeners[0]({ type: 'ui', name, args });
  return { port, messages, state, events, ui };
}
const panel = { id: 'test', url: base + 'ui/chat.html' };
const TOKEN = 'c'.repeat(32);
const result = (fields = {}) => ({
  ok: true,
  mode: 'article',
  extractor: 'defuddle',
  title: 'On Autonomy',
  byline: 'Fixture Author',
  siteName: 'Fixture Essays',
  publishedAt: '2026-10-01',
  language: 'en',
  direction: 'ltr',
  excerpt: 'About autonomy.',
  html: '<p>Autonomy is the endorsement of one&#39;s own actions.</p>',
  markdown: `Autonomy is the endorsement of one's own actions.\n\n![Figure](tabgent-image-${TOKEN}-0)\n\n![Gone](tabgent-image-${TOKEN}-2)`,
  images: [
    { url: 'https://example.test/figure.png', alt: 'Figure' },
    { url: 'javascript:x' },
    { url: 'https://cdn.example.test/gone.png' },
  ],
  imageToken: TOKEN,
  words: 8,
  chars: 45,
  truncated: false,
  posts: 0,
  tooLittle: false,
  hasSelection: false,
  ...fields,
});

try {
  const view = await attach(1);
  // Attaching injects the selection script; only clipping injections are checked below.
  await wait();
  injected.length = 0;
  const clip = (tabId, mode) =>
    call(
      {
        type: 'clipPage',
        conversationKey: view.state.conversationKey,
        companionTabId: tabId,
        mode,
      },
      panel,
    );

  // The toolbar button and webpages offer clipping; the selection item stays on its own.
  chrome.runtime.onInstalled.listeners[0]();
  assert.deepEqual(
    menus.map(({ id, contexts, documentUrlPatterns }) => [id, contexts, documentUrlPatterns]),
    [
      ['quote-selection', ['selection'], undefined],
      ['open-epub-reader', ['action'], undefined],
      ['clip-page', ['action'], undefined],
      ['clip-page-context', ['page'], ['http://*/*', 'https://*/*']],
    ],
  );
  console.log('PASS clipping is in the toolbar and page menus, not the selection menu');

  // Only top-level HTTP(S) pages outside incognito are clipped; nothing is injected otherwise.
  assert.deepEqual(await clip(2), { ok: false, reason: 'unsupported' });
  assert.deepEqual(await clip(3), { ok: false, reason: 'unsupported' });
  assert.equal(injected.length, 0);
  // Web pages cannot ask the worker to clip.
  const web = { id: 'test', tab: { id: 1 }, frameId: 0, url: article };
  assert.match((await call({ type: 'clipPage', companionTabId: 1 }, web)).error, /Invalid sender/);
  console.log('PASS clipping refuses PDFs, incognito tabs and requests from web pages');

  // A first clip: the files go into the top frame, the page's text into the vault.
  page.run.push(result());
  const first = await clip(1);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(injected[0].target, { tabId: 1, frameIds: [0] });
  assert.deepEqual(injected[0].files, [
    'vendor/defuddle/defuddle.js',
    'vendor/turndown/turndown.js',
    'vendor/dompurify/purify.umd.js',
    'clip/sanitize-config.js',
    'clip/clip-content.js',
  ]);
  assert(injected.every((entry) => entry.target.frameIds?.[0] === 0));
  const run = injected.find((entry) => /\.run\(/.test(entry.func));
  assert.deepEqual(run.args, [{ mode: 'article', url: article + '#top' }]);
  const save = vaultCalls('vault/clip/save').at(-1).params;
  assert.equal(save.url, article, 'The document URL drops the fragment');
  assert.equal(save.origin.pageUrl, article + '#top');
  assert.deepEqual(save.meta, {
    author: 'Fixture Author',
    siteName: 'Fixture Essays',
    publishedAt: '2026-10-01',
  });
  // The page's image is downloaded and saved; one that fails stays linked online.
  const png = crypto.createHash('sha256').update(PNG).digest('hex');
  assert.deepEqual(save.assets, [
    { sha256: png, ext: 'png', size: PNG.length, source: 'https://example.test/figure.png' },
  ]);
  assert.deepEqual(save.images, {
    found: 2,
    saved: 1,
    remote: 1,
    failed: [{ source: 'https://cdn.example.test/gone.png', reason: 'http_404' }],
  });
  assert.deepEqual(
    fetched.map(({ url, credentials, referrerPolicy }) => [url, credentials, referrerPolicy]),
    [
      ['https://example.test/figure.png', 'include', 'no-referrer'],
      ['https://cdn.example.test/gone.png', 'include', 'no-referrer'],
    ],
  );
  assert(vaultCalls('vault/clip/asset').length >= 2, 'The image is uploaded before the save');
  assert.equal(save.replace, undefined);
  const folder = first.document.folder;
  const markdown = fs.readFileSync(path.join(folder, 'article.md'), 'utf8');
  assert.match(markdown, /endorsement of one's/);
  assert.match(markdown, new RegExp(`!\\[Figure\\]\\(assets/${png.slice(0, 16)}\\.png\\)`));
  assert.match(markdown, /!\[Gone\]\(https:\/\/cdn\.example\.test\/gone\.png\)/);
  assert.doesNotMatch(markdown, /tabgent-image-/);
  assert.deepEqual(
    fs.readFileSync(path.join(folder, 'assets', `${png.slice(0, 16)}.png`)),
    Buffer.from(PNG),
  );
  assert.deepEqual(
    notes.map((note) => note.text),
    [
      'clipSaving',
      'clipSavingImages(1|2)',
      'clipSavingImages(2|2)',
      'clipSaved(On Autonomy|8) clipImagesSaved(1) clipImagesFailed(1)',
    ],
  );
  await wait();
  assert(view.events('codex-reading-changed').length, 'The side panel refreshes');
  const state = await call(
    { type: 'readingState', conversationKey: view.state.conversationKey, companionTabId: 1 },
    panel,
  );
  assert.equal(state.page.kind, 'web');
  assert.equal(state.clip.complete, true);
  assert.equal(state.clip.clippedAt, first.clip.clippedAt);
  console.log('PASS a clip saves the page text into its vault document');

  // The reading context names the clipped text for questions about the page.
  await view.port.onMessage.listeners[0]({ type: 'bind', threadId: 'thread-clip' });
  const before = sent.length;
  await view.ui('codexRpc', {
    id: 1,
    method: 'turn/start',
    params: {
      threadId: 'thread-clip',
      input: [{ type: 'text', text: 'Summarize the argument.', text_elements: [] }],
    },
  });
  const input = sent.slice(before).find((m) => m.op === 'rpc').message.params.input;
  const reading = JSON.parse(
    input
      .find((p) => p.text?.startsWith(readingContextPrefix))
      .text.slice(readingContextPrefix.length),
  );
  assert.equal(reading.document.article, path.join(folder, 'article.md'));
  console.log('PASS the reading context names article.md');

  // Clipping again asks first: Cancel writes nothing, Replace replaces that clip.
  page.ask.push((options) => {
    assert.deepEqual(options, { kind: 'replace', clippedAt: first.clip.clippedAt });
    return 'cancel';
  });
  const saves = vaultCalls('vault/clip/save').length;
  assert.deepEqual(await clip(1), { ok: false, reason: 'cancelled' });
  assert.equal(vaultCalls('vault/clip/save').length, saves);
  page.ask.push('replace');
  page.run.push(result({ markdown: 'A second version.', html: '<p>A second version.</p>' }));
  const second = await clip(1);
  assert.equal(second.ok, true);
  const replaced = vaultCalls('vault/clip/save').at(-1).params;
  assert.equal(replaced.replace, true);
  assert.equal(replaced.expected, first.clip.clippedAt);
  assert.match(fs.readFileSync(path.join(folder, 'article.md'), 'utf8'), /A second version/);
  console.log('PASS clipping a page again asks before replacing its clip');

  // Too little text: the user picks the whole page, which is clipped instead.
  page.run.push(result({ tooLittle: true, hasSelection: true, markdown: 'Few words.' }));
  page.ask.push((options) => {
    assert.deepEqual(options, { kind: 'tooLittle', hasSelection: true });
    return 'page';
  });
  page.run.push((options) => {
    assert.equal(options.mode, 'page');
    return result({ mode: 'page', markdown: 'The whole page text.', html: '<p>Whole.</p>' });
  });
  const whole = await clip(4);
  assert.equal(whole.ok, true);
  assert.equal(vaultCalls('vault/clip/save').at(-1).params.origin.method, 'page');
  // Cancelling that prompt saves nothing.
  page.ask.push('replace'); // The short page now has a clip; replace it...
  page.run.push(result({ tooLittle: true }));
  page.ask.push('cancel'); // ...but then cancel the fallback.
  const count = vaultCalls('vault/clip/save').length;
  assert.deepEqual(await clip(4), { ok: false, reason: 'cancelled' });
  assert.equal(vaultCalls('vault/clip/save').length, count);
  console.log('PASS a short page falls back to the whole page when the user chooses it');

  // A page that navigated during clipping, a refused page and an invalid result save nothing.
  page.ask.push('replace');
  page.run.push({ documentId: 'another-document', result: result() });
  assert.deepEqual(await clip(1), { ok: false, reason: 'navigated' });
  page.ask.push('replace');
  page.run.push({ ok: false, reason: 'x-not-post' });
  assert.deepEqual(await clip(1), { ok: false, reason: 'x-not-post' });
  assert.equal(notes.at(-1).text, 'clipXOpenPost');
  assert.equal(notes.at(-1).tone, 'error');
  page.ask.push('replace');
  page.run.push(result({ html: 'x'.repeat(CLIP_LIMIT.html + 1) }));
  assert.deepEqual(await clip(1), { ok: false, reason: 'invalid' });
  assert.equal(vaultCalls('vault/clip/save').length, count);
  // A single-page app that moves to another address while the prompt is open: the clip
  // is not saved under the old address, and the page says why.
  page.ask.push(() => {
    tabs.set(1, { ...tabs.get(1), url: article + '/next-post' });
    return 'replace';
  });
  assert.deepEqual(await clip(1), { ok: false, reason: 'navigated' });
  assert.equal(vaultCalls('vault/clip/save').length, count);
  assert.deepEqual(notes.at(-1), { text: 'clipNavigated', tone: 'error' });
  tabs.set(1, { ...tabs.get(1), url: article + '#top' });
  console.log('PASS navigated, refused and oversized clips save nothing');

  // A selection clip checks the page still selects the quote attached in the conversation.
  const live = {
    id: 'test',
    tab: tabs.get(1),
    frameId: 0,
    documentId: documentId(1),
    url: article,
  };
  await call(
    { type: 'pageSelection', text: 'own actions', title: 'On Autonomy', selectionId: 's1' },
    live,
  );
  page.ask.push('replace');
  page.run.push((options) => {
    assert.deepEqual(options, {
      mode: 'selection',
      url: article + '#top',
      expected: 'own actions',
    });
    return result({ mode: 'selection' });
  });
  assert.equal((await clip(1, 'selection')).ok, true);
  assert.equal(vaultCalls('vault/clip/save').at(-1).params.origin.method, 'selection');
  console.log('PASS a selection clip is checked against the attached quote');

  // The worker reshapes what the page returns.
  assert.equal(cleanClip({ ...result(), ok: 'yes' }), null);
  assert.equal(cleanClip(result({ markdown: ' ' })), null);
  const clean = cleanClip(
    result({ mode: 'everything', words: -3, direction: 'sideways', title: 't'.repeat(900) }),
  );
  assert.equal(clean.method, 'article');
  assert.equal(clean.words, 0);
  assert.equal(clean.direction, 'ltr');
  assert.equal(clean.title.length, 500);
  assert.deepEqual(clean.images, [
    { url: 'https://example.test/figure.png' },
    { url: '' },
    { url: 'https://cdn.example.test/gone.png' },
  ]);
  assert.equal(cleanClip(result({ imageToken: 'page-chosen' })).imageToken, '');
  console.log('PASS page results are bounded and reshaped');

  // The keyboard shortcut clips the active tab.
  const injections = injected.length;
  page.ask.push('cancel');
  chrome.commands.onCommand.listeners[0]('clip-page', tabs.get(1));
  for (let i = 0; i < 100 && injected.length === injections; i++) await wait();
  assert(injected.length > injections, 'The shortcut injects the clipping script');
  await wait(50);
  console.log('PASS the keyboard shortcut clips the page');
} finally {
  python.stdin.end();
  fs.rmSync(temp, { recursive: true, force: true });
}
