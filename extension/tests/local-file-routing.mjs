// Files opened from the computer (file://) in the service worker, with the real vault module
// in a temporary folder: Markdown, text and HTML files are documents named by their file://
// URL, a PDF from the computer is named by the SHA-256 its viewer reports and is copied into
// the vault through that viewer only, and Agent's browser tools treat local tabs as read-only.
// No Codex process, account, model or real file is involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-local-files-'));
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
  '%PDF-1.4\n% Local file fixture: autonomy is endorsement.\n' + '0'.repeat(5000) + '\n%%EOF\n',
);
const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
const urn = 'urn:sha256:' + sha256;
const base = 'chrome-extension://test/';
const markdown = 'file:///Users/reader/Documents/notes.md';
const paper = 'file:///Users/reader/Documents/reading%20paper.pdf';
const fileViewer = base + 'pdf/file.html?url=' + paper + '#page=2';
const online = base + 'pdf/viewer.html?url=https://example.test/paper.pdf';
const tabs = new Map(
  [
    [5, markdown + '#intro', 'notes.md'],
    [6, fileViewer, 'reading paper.pdf'],
    [7, 'file:///Users/reader/Documents/', 'Index of /Users/reader/Documents/'],
    [8, 'https://example.test/article', 'Article'],
    [9, paper, 'reading paper.pdf'],
    [10, online, 'paper.pdf'],
    [11, 'file:///Users/reader/Documents/photo.png', 'photo.png'],
  ].map(([id, url, title], index) => [id, { id, windowId: 1, index, url, title }]),
);
tabs.set(12, { id: 12, windowId: 1, index: 9, url: markdown, title: 'notes.md', incognito: true });
let access = true;
const stored = { fileAccess: false },
  created = [],
  updates = [],
  scripts = [],
  styles = [],
  dynamicRules = [],
  sessionRules = [];
const frames = new Map([
  [5, [{ frameId: 0, parentFrameId: -1, documentId: 'notes-doc', url: markdown + '#intro' }]],
  [8, [{ frameId: 0, parentFrameId: -1, documentId: 'web-doc', url: tabs.get(8).url }]],
]);
frames.get(5).push({
  frameId: 3,
  parentFrameId: 0,
  documentId: 'inner-doc',
  url: 'file:///Users/reader/.ssh/config',
});
globalThis.chrome = {
  runtime: {
    id: 'test',
    getURL: (p) => base + p,
    onConnect: event(),
    onMessage: event(),
    onInstalled: event(),
    onStartup: event(),
    connectNative: () => native,
  },
  extension: { isAllowedFileSchemeAccess: async () => access },
  i18n: { getMessage: (key) => key },
  contextMenus: { onClicked: event(), removeAll: (done) => done(), create: () => {} },
  scripting: {
    executeScript: async ({ target, func, files, args }) => {
      scripts.push({ tabId: target.tabId, frameIds: target.frameIds, files });
      if (files) return [];
      const tab = tabs.get(target.tabId);
      if (!func.toString().includes('controls')) return [{ result: 'text/markdown' }];
      return [
        {
          result: {
            url: tab.url,
            title: tab.title,
            text: '# Reading notes\nAutonomy is endorsement.',
            controls: [],
            args,
          },
        },
      ];
    },
    insertCSS: async ({ target, files }) => styles.push({ tabId: target.tabId, files }),
  },
  storage: {
    local: {
      get: async (keys) => {
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
        return Object.fromEntries(list.filter((k) => k in stored).map((k) => [k, stored[k]]));
      },
      set: async (value) => Object.assign(stored, value),
    },
    session: { get: async () => ({}), set: async () => {} },
  },
  declarativeNetRequest: {
    updateDynamicRules: async ({ addRules }) => dynamicRules.push(...addRules),
    updateSessionRules: async ({ removeRuleIds, addRules = [] }) => {
      for (const id of removeRuleIds || []) {
        const at = sessionRules.findIndex((rule) => rule.id === id);
        if (at >= 0) sessionRules.splice(at, 1);
      }
      sessionRules.push(...addRules);
    },
    getSessionRules: async () => sessionRules,
  },
  sidePanel: { setPanelBehavior: async () => {}, open: () => Promise.resolve() },
  tabs: {
    get: async (id) => {
      if (!tabs.has(id)) throw Error('No tab');
      return tabs.get(id);
    },
    query: async (filter = {}) =>
      [...tabs.values()].filter(
        (tab) => !filter.url || (filter.url === 'file:///*' && tab.url.startsWith('file:///')),
      ),
    create: async (options) => (created.push(options), { id: 99, ...options }),
    update: async (id, value) => (updates.push([id, value]), { ...tabs.get(id), ...value }),
    sendMessage: async () => null,
    onRemoved: event(),
  },
  webNavigation: {
    onCommitted: event(),
    getFrame: async ({ tabId, frameId }) =>
      frames.get(tabId)?.find((frame) => frame.frameId === frameId) || null,
    getAllFrames: async ({ tabId }) => frames.get(tabId) || [],
  },
};

await direct('vault/configure', { path: vaultPath });
const helpers = await import('../local-files.js');
const routing = await import('../pdf-routing.js');
const { browserTool, context } = await import('../browser-tools.js');
await import('../background.js');
await until(() => stored.fileAccess === true);
const call = (message, sender) =>
  new Promise((resolve) => {
    let answered = false;
    for (const listen of chrome.runtime.onMessage.listeners)
      if (listen(message, sender, (value) => !answered && ((answered = true), resolve(value))))
        return;
    // No listener answers asynchronously: the message is ignored.
    setTimeout(() => !answered && resolve(undefined), 50);
  });
const connect = (port) => {
  for (const listen of chrome.runtime.onConnect.listeners) listen(port);
};
const vaultCalls = (method) =>
  sent.filter((m) => m.op === 'vault' && (!method || m.method === method));
const commit = async (detail) => {
  for (const listen of chrome.webNavigation.onCommitted.listeners) await listen(detail);
};

try {
  // Local file URLs: files, never directory listings or other hosts.
  const { isLocalFileUrl, isReadableFileUrl } = helpers;
  for (const yes of [markdown, markdown + '#intro', paper, 'file:///notes.TXT'])
    assert(isLocalFileUrl(yes), yes);
  for (const no of [
    'file:///Users/reader/Documents/',
    'file:///',
    'file://server/share/notes.md',
    'https://example.test/notes.md',
    'notes.md',
    null,
  ])
    assert(!isLocalFileUrl(no), String(no));
  for (const yes of [
    markdown,
    paper,
    'file:///a/b.HTML',
    'file:///a/b.txt',
    'file:///a/b.markdown',
  ])
    assert(isReadableFileUrl(yes), yes);
  assert(!isReadableFileUrl('file:///a/photo.png'));
  console.log('PASS local file URLs exclude directory listings and remote hosts');

  // The local PDF viewer: its own entry page, never viewer.html, and a file:// source only.
  const { pdfSource, pdfViewerUrl, isFilePdf, filePdfDocument, pdfTab } = routing;
  assert.equal(pdfSource(fileViewer), paper + '#page=2');
  assert.equal(pdfViewerUrl(paper), base + 'pdf/file.html?url=' + paper);
  assert.equal(
    pdfViewerUrl('https://example.test/a.pdf'),
    base + 'pdf/viewer.html?url=https://example.test/a.pdf',
  );
  assert(isFilePdf(paper) && !isFilePdf(urn) && !isFilePdf('https://example.test/a.pdf'));
  for (const bad of [
    'https://example.test/a.pdf',
    urn,
    'file:///Users/reader/Documents/',
    'file://server/a.pdf',
    'javascript:alert(1)',
  ])
    assert.equal(pdfSource(base + 'pdf/file.html?url=' + bad), null, bad);
  assert.equal(pdfSource(base + 'pdf/viewer.html?url=' + paper), null);
  assert.deepEqual(pdfTab(tabs.get(6)), {
    ...tabs.get(6),
    url: paper + '#page=2',
    contentType: 'application/pdf',
    viewer: 'pdfjs',
  });
  // Chrome matches the redirect regex case-insensitively, as here.
  const rule = dynamicRules.find((r) => r.id === 900002);
  assert.equal(rule.action.redirect.regexSubstitution, base + 'pdf/file.html?url=\\0');
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
  const pattern = new RegExp(rule.condition.regexFilter, 'i');
  for (const yes of [paper, paper + '#page=3', 'file:///a/B.PDF', 'file:///a/b.pdf?x=1'])
    assert(pattern.test(yes), yes);
  for (const no of ['file:///a/b.pdf/', 'file:///a/b.pdfx', 'https://x.test/b.pdf', 'file:///a/b'])
    assert(!pattern.test(no), no);
  console.log('PASS file.html shows only file:// PDFs; the redirect rule matches .pdf files');

  // A Markdown file is a document named by its file:// URL, from its top frame only.
  const page = {
    id: 'test',
    tab: { id: 5, title: 'notes.md' },
    frameId: 0,
    documentId: 'notes-doc',
    url: markdown + '#intro',
  };
  const resolved = await call({ type: 'highlightResolve', title: 'notes.md' }, page);
  assert.equal(resolved.url, markdown, JSON.stringify(resolved));
  assert.deepEqual(vaultCalls('vault/document/resolve').at(-1).params, {
    url: markdown,
    title: 'notes.md',
    kind: 'web',
    meta: {},
  });
  const before = vaultCalls().length;
  for (const sender of [
    { ...page, frameId: 3, url: 'file:///Users/reader/.ssh/config' },
    { ...page, documentId: 'previous' },
    { ...page, url: 'file:///Users/reader/Documents/' },
    { ...page, url: 'file://server/share/notes.md' },
    { ...page, tab: { id: 5, incognito: true } },
  ])
    assert((await call({ type: 'highlightResolve' }, sender)).error, JSON.stringify(sender));
  assert.equal(vaultCalls().length, before, 'Rejected senders never reach the vault');
  const anchor = {
    kind: 'web',
    quote: { exact: 'Autonomy is endorsement', prefix: 'notes ', suffix: '.' },
    position: { start: 16, end: 39 },
  };
  const created1 = await call(
    { type: 'highlightCreate', text: 'Autonomy is endorsement', anchor, title: 'notes.md' },
    page,
  );
  assert.equal(created1.document.url, markdown);
  assert.match(created1.document.id, /^article-notes-md-[0-9a-f]{8}$/);
  console.log('PASS a Markdown file is a vault document named by its file:// URL; frames refused');

  // Selections: the top frame of a local file only.
  const selection = {
    type: 'pageSelection',
    text: 'Autonomy',
    title: 'notes.md',
    selectionId: 's1',
  };
  assert.deepEqual(await call(selection, page), {});
  assert.match(
    (await call(selection, { ...page, frameId: 3, url: 'file:///Users/reader/.ssh/config' })).error,
    /Invalid selection/,
  );
  assert.match(
    (await call(selection, { ...page, url: 'file:///Users/reader/Documents/' })).error,
    /Invalid selection/,
  );
  console.log('PASS selections from local files come from their top frame only');

  // The PDF viewer of a file names it by the SHA-256 it reports on its own port.
  const viewer = {
    id: 'test',
    tab: { id: 6, title: 'reading paper.pdf' },
    frameId: 0,
    documentId: 'viewer-document',
    url: fileViewer,
  };
  const port = {
    name: 'pdf',
    sender: { ...viewer },
    onMessage: event(),
    onDisconnect: event(),
    postMessage: () => {},
  };
  connect(port);
  assert.equal(filePdfDocument(tabs.get(6)), null, 'Unknown until the viewer reads the file');
  assert.equal(filePdfDocument(tabs.get(10)), undefined);
  const pending = call({ type: 'highlightResolve', title: 'Local Paper' }, viewer);
  await wait(100);
  for (const listen of port.onMessage.listeners) listen({ type: 'document', sha256: 'nope' });
  assert.equal(filePdfDocument(tabs.get(6)), null, 'An invalid hash is ignored');
  for (const listen of port.onMessage.listeners) listen({ type: 'document', sha256 });
  assert.deepEqual(filePdfDocument(tabs.get(6)), { url: urn, kind: 'pdf' });
  assert.equal((await pending).url, urn);
  assert.deepEqual(vaultCalls('vault/document/resolve').at(-1).params, {
    url: urn,
    title: 'Local Paper',
    kind: 'pdf',
    meta: {},
  });
  // An online viewer cannot claim a file identity.
  const onlinePort = {
    name: 'pdf',
    sender: { ...viewer, tab: { id: 10 }, documentId: 'online-viewer', url: online },
    onMessage: event(),
    onDisconnect: event(),
    postMessage: () => {},
  };
  connect(onlinePort);
  for (const listen of onlinePort.onMessage.listeners) listen({ type: 'document', sha256 });
  assert.equal(filePdfDocument(tabs.get(10)), undefined);
  const pdfAnchor = {
    kind: 'pdf',
    page: 2,
    quote: { exact: 'endorsement', prefix: 'is ', suffix: '.' },
  };
  const highlighted = await call(
    {
      type: 'highlightCreate',
      ask: true,
      text: 'endorsement',
      anchor: pdfAnchor,
      title: 'Local Paper',
      location: 'p. 2',
    },
    viewer,
  );
  assert.equal(highlighted.document.url, urn);
  assert.equal(highlighted.document.kind, 'pdf');
  console.log('PASS a local PDF is named by the hash its viewer reports, never by its path');

  // Its viewer copies it into the vault; the document comes from the announced hash.
  const save = (offset, bytes, sender = viewer) =>
    call(
      {
        type: 'pdfFileSave',
        title: 'Local Paper',
        meta: { author: 'Fixture Author' },
        name: 'reading paper.pdf',
        size: pdf.length,
        offset,
        data: bytes.toString('base64'),
        url: 'urn:sha256:' + 'f'.repeat(64),
        sha256: 'f'.repeat(64),
      },
      sender,
    );
  const saves = () => vaultCalls('vault/source/save').length;
  const refusedBefore = saves();
  for (const [sender, error] of [
    [{ ...viewer, documentId: 'previous-viewer' }, /Stale PDF viewer/],
    [{ ...viewer, frameId: 1 }, /Invalid PDF viewer sender/],
    [{ ...viewer, tab: { id: 10 }, url: online }, /Invalid PDF viewer sender/],
    [page, /Invalid PDF viewer sender/],
  ])
    assert.match((await save(0, Buffer.alloc(0), sender)).error, error);
  assert.equal(saves(), refusedBefore, 'Refused copies never reach the vault');
  assert.equal((await save(0, Buffer.alloc(0))).received, 0);
  await save(0, pdf.subarray(0, 3000));
  const copied = await save(3000, pdf.subarray(3000));
  assert.equal(copied.complete, true, JSON.stringify(copied));
  assert.deepEqual(
    (({ url, sha256: hash, kind }) => ({ url, sha256: hash, kind }))(
      vaultCalls('vault/source/save').at(-1).params,
    ),
    { url: urn, sha256, kind: 'pdf' },
  );
  const folder = path.join(vaultPath, 'Books', highlighted.document.id);
  assert.deepEqual(fs.readFileSync(path.join(folder, 'original.pdf')), pdf);
  // A local PDF's viewer does not read the vault copy: it reads the file.
  assert.match(
    (await call({ type: 'pdfLocalRead', offset: 0 }, viewer)).error,
    /Invalid PDF viewer sender/,
  );
  console.log('PASS the viewer copies the local PDF into the vault under its hash');

  // Page conversations save to the same documents.
  const messages = [],
    chat = {
      name: 'chat',
      sender: { url: base + 'ui/chat.html', id: 'test' },
      onMessage: event(),
      onDisconnect: event(),
      postMessage: (m) => messages.push(m),
    };
  connect(chat);
  await chat.onMessage.listeners[0]({ type: 'attach', tabId: 5 });
  const conversationKey = messages.find((m) => m.type === 'attached').state.conversationKey;
  const state = (companionTabId) =>
    call(
      { type: 'readingState', conversationKey, companionTabId },
      { id: 'test', url: base + 'ui/chat.html' },
    );
  assert.deepEqual((await state(5)).page, { url: markdown, title: 'notes.md', kind: 'web' });
  assert.deepEqual((await state(6)).page, {
    url: urn,
    kind: 'pdf',
    title: 'reading paper.pdf',
    fileUrl: paper,
  });
  assert.equal((await state(7)).page, null, 'A directory listing is not a document');
  console.log('PASS page conversations on local files save to their vault documents');

  // Chrome's own viewer for a local PDF hands over to file.html unless the user chose it.
  const native = { id: 'test', tab: { id: 9 }, frameId: 0, documentId: 'native', url: paper };
  assert.deepEqual(await call({ type: 'localPdfOpen' }, native), {
    url: base + 'pdf/file.html?url=' + paper,
  });
  assert.equal(await call({ type: 'localPdfOpen' }, { ...native, frameId: 2 }), undefined);
  assert.equal(
    await call({ type: 'localPdfOpen' }, { ...native, url: 'https://example.test/a.pdf' }),
    undefined,
  );
  assert.deepEqual(await call({ type: 'pdfFallback' }, viewer), {});
  assert.deepEqual(sessionRules.at(-1).condition, {
    tabIds: [6],
    resourceTypes: ['main_frame'],
    urlFilter: '|' + paper + '|',
  });
  assert.deepEqual(updates.at(-1), [6, { url: paper + '#page=2' }]);
  assert.deepEqual(await call({ type: 'localPdfOpen' }, { ...native, tab: { id: 6 } }), {});
  console.log('PASS Chrome viewer hands a local PDF to Tabgent viewer unless the user chose it');

  // Agent: local tabs are listed and readable, read-only, and never opened by Agent.
  const session = { tabId: 5, scope: 'window' };
  const listed = (await browserTool(session, { action: 'tabs', tabId: 5 })).map((t) => t.url);
  assert.deepEqual(listed, [
    markdown + '#intro',
    paper + '#page=2',
    'https://example.test/article',
    paper,
    'https://example.test/paper.pdf',
    'file:///Users/reader/Documents/photo.png',
  ]);
  for (const action of ['navigate', 'open'])
    await assert.rejects(
      browserTool(session, { action, tabId: 5, url: paper }),
      /Only HTTP\(S\) URLs/,
    );
  for (const [action, tabId] of [
    ['click', 5],
    ['type', 5],
    ['press', 6],
    ['drag', 9],
    ['select', 5],
    ['saveResource', 5],
  ])
    await assert.rejects(
      browserTool(session, { action, tabId, x: 1, y: 1, text: 'x', key: 'Enter' }),
      /read-only for Agent/,
      action,
    );
  await assert.rejects(browserTool(session, { action: 'read', tabId: 7 }), /outside the selected/);
  await assert.rejects(browserTool(session, { action: 'read', tabId: 12 }), /outside the selected/);
  const read = await browserTool(session, { action: 'read', tabId: 5 });
  assert.equal(read.url, markdown + '#intro');
  assert.match(read.text, /Autonomy is endorsement/);
  assert.deepEqual(read.frames, [
    { frameId: 3, parentFrameId: 0, url: 'file:///Users/reader/.ssh/config', unavailable: true },
  ]);
  assert.equal(
    scripts.filter((s) => s.tabId === 5 && s.frameIds?.includes(3)).length,
    0,
    'Frames inside a local file are never read',
  );
  assert.equal((await context({ tabId: 5, scope: 'window' })).fileAccess, undefined);
  access = false;
  assert.equal((await context({ tabId: 5, scope: 'window' })).fileAccess, false);
  assert.equal((await context({ tabId: 8, scope: 'window' })).fileAccess, undefined);
  console.log('PASS Agent lists and reads local tabs, but they are read-only and never opened');

  // Without file access, the first readable file opens the explanation, once.
  created.length = 0;
  await commit({ tabId: 5, frameId: 0, url: markdown });
  await commit({ tabId: 9, frameId: 0, url: paper });
  await commit({ tabId: 11, frameId: 0, url: 'file:///Users/reader/Documents/photo.png' });
  const prompts = created.filter((c) => c.url === base + 'file-access.html');
  assert.deepEqual(prompts, [{ url: base + 'file-access.html', windowId: 1, index: 1 }]);
  assert.equal(stored.fileAccessPrompted, true);
  await commit({ tabId: 7, frameId: 0, url: 'file:///Users/reader/Documents/' });
  assert.equal(created.length, 1);
  // The side panel's reminder opens Tabgent's page in chrome://extensions.
  await chat.onMessage.listeners[0]({ type: 'ui', name: 'openFileAccess', args: [] });
  assert.deepEqual(created.at(-1), {
    url: 'chrome://extensions/?id=test',
    windowId: 1,
    index: 1,
  });
  console.log('PASS without file access the explanation opens once; the reminder opens settings');

  // When access was off before, the files already open start working (startup above).
  const adopted = scripts.filter((s) => s.files).map((s) => [s.tabId, s.files.join()]);
  for (const tabId of [5, 9, 11])
    for (const files of [
      'local-pdf.js',
      'selection-content.js',
      'web-anchor.js,highlight-note.js,highlight-content.js',
    ])
      assert(
        adopted.some(([id, f]) => id === tabId && f === files),
        `${tabId} ${files}`,
      );
  assert(!adopted.some(([id]) => [6, 7, 8, 10, 12].includes(id)), JSON.stringify(adopted));
  assert(styles.some((s) => s.tabId === 5 && s.files.join() === 'highlight.css'));
  // On browser startup, PDFs that loaded before the redirect rule switch over.
  access = true;
  scripts.length = 0;
  for (const listen of chrome.runtime.onStartup.listeners) listen();
  await until(() => scripts.length === 3);
  assert.deepEqual(
    scripts.map((s) => [s.tabId, s.files.join()]),
    [
      [5, 'local-pdf.js'],
      [9, 'local-pdf.js'],
      [11, 'local-pdf.js'],
    ],
  );
  console.log('PASS open local files are picked up when access turns on and at browser startup');

  // A view whose companion page closes keeps that page, as for webpages: a local file keeps
  // its file:// address and document, a local PDF its file and urn:sha256 document, also
  // after its viewer reloaded. These views stand for Agent tabs, which outlive the page.
  const view = async (tabId) => {
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
    const conversationKey = messages.find((m) => m.type === 'attached').state.conversationKey;
    return {
      state: () =>
        call(
          { type: 'readingState', conversationKey, companionTabId: tabId },
          { id: 'test', url: base + 'ui/chat.html' },
        ),
      context: async () => {
        await port.onMessage.listeners[0]({ type: 'ui', name: 'codexContext', args: [] });
        return messages.filter((m) => m.name === 'codex-context').at(-1).value;
      },
    };
  };
  const notes = await view(5);
  await notes.state();
  await commit({ tabId: 5, frameId: 0, url: markdown });
  const pdfView = await view(6);
  const remembered = (await pdfView.state()).page;
  assert.equal(remembered.url, urn);
  // A reload of the viewer commits file.html again: the same file keeps its document, also
  // while the reloaded viewer has not named the file yet.
  await commit({ tabId: 6, frameId: 0, url: fileViewer });
  for (const listen of port.onDisconnect.listeners) listen();
  assert.equal(filePdfDocument(tabs.get(6)), null);
  assert.deepEqual((await pdfView.state()).page, remembered);
  tabs.delete(5);
  tabs.delete(6);
  assert.deepEqual((await notes.state()).page, {
    url: markdown,
    title: 'notes.md',
    kind: 'web',
    closed: true,
  });
  assert.deepEqual((await notes.context()).page, {
    id: 5,
    url: markdown,
    title: 'notes.md',
    closed: true,
  });
  assert.deepEqual((await pdfView.state()).page, { ...remembered, closed: true });
  assert.deepEqual((await pdfView.context()).page, {
    id: 6,
    url: paper + '#page=2',
    title: 'reading paper.pdf',
    closed: true,
  });
  // A viewer that moves on to another file forgets the document of the first one.
  tabs.set(13, { id: 13, windowId: 1, index: 10, url: fileViewer, title: 'reading paper.pdf' });
  const other = {
    name: 'pdf',
    sender: { ...viewer, tab: { id: 13 }, documentId: 'viewer-13', url: fileViewer },
    onMessage: event(),
    onDisconnect: event(),
    postMessage: () => {},
  };
  connect(other);
  for (const listen of other.onMessage.listeners) listen({ type: 'document', sha256 });
  const moved = await view(13);
  assert.equal((await moved.state()).page.url, urn);
  await commit({
    tabId: 13,
    frameId: 0,
    url: base + 'pdf/file.html?url=file:///Users/reader/Documents/other.pdf',
  });
  tabs.delete(13);
  assert.equal((await moved.state()).page, null);
  console.log('PASS a closed local page keeps its file address and document for its views');
} finally {
  python.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}
