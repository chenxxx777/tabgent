// PDF highlights in real Chromium with the source extension and source connector.
// A temporary profile, HOME, and CODEX_HOME isolate the browser, vault, and Codex state;
// no account, model, or personal ReadingVault is used. The PDF is generated fixture text.
// Codex is replaced by a fixture app-server that replays a completed turn per message.
const assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  { execSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  { chromium } = require(root + '/node_modules/playwright');
const { textPdf } = require(root + '/extension/tests/fixtures/text-pdf.cjs');
const extension = path.join(root, 'extension');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}
const fixture = textPdf(
  [
    ['Chapter 1. Slow reading', 'Careful readers return to difficult passages.'],
    [
      'Chapter 2. Motivation',
      "Autonomy is the endorsement of one's own actions.",
      'It does not mean independence from other people.',
      'Readers who endorse a goal persist for longer.',
    ],
    ['Chapter 3. Practice', 'Short daily sessions build a durable habit.'],
  ],
  { title: 'Reading Companion Fixture', author: 'Fixture Author' },
);

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-pdf-highlights-'));
  const profile = path.join(temp, 'profile');
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/pdf');
    response.end(fixture);
  });
  let context,
    passed = false;
  try {
    // Chrome reads <user-data-dir>/NativeMessagingHosts, so nothing is installed globally.
    const key = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).key;
    const id = [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')]
      .slice(0, 32)
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join('');
    const host = path.join(temp, 'connector');
    const home = path.join(temp, 'home');
    fs.mkdirSync(path.join(home, 'codex'), { recursive: true });
    const python = process.env.PYTHON || execSync('command -v python3').toString().trim();
    const codex = path.join(temp, 'codex');
    fs.writeFileSync(
      codex,
      `#!/bin/sh\nexec '${python}' '${path.join(extension, 'tests/fixtures/app-server-replay.py')}' "$@"\n`,
      { mode: 0o700 },
    );
    // The real host.py, with Codex discovery pointed at the fixture app-server.
    const start =
      'import sys; native, codex = sys.argv[1:3]; del sys.argv[1:3]; sys.path.insert(0, native); ' +
      'import host; host.executable = lambda: codex; host.main()';
    fs.writeFileSync(
      host,
      `#!/bin/sh\nexport HOME='${home}' CODEX_HOME='${home}/codex'\nexec '${python}' -c '${start}' '${path.join(extension, 'native')}' '${codex}' "$@" 2>>'${temp}/host.err'\n`,
      { mode: 0o700 },
    );
    fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'NativeMessagingHosts/com.tabgent.codex.json'),
      JSON.stringify({
        name: 'com.tabgent.codex',
        description: 'Tabgent connector for PDF highlight tests',
        path: host,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
    const books = path.join(home, 'ReadingVault/Books');
    const docs = () =>
      fs.existsSync(books)
        ? fs.readdirSync(books).map((name) => ({
            name,
            anchors: JSON.parse(fs.readFileSync(path.join(books, name, 'anchors.json'), 'utf8')),
            markdown: fs.readFileSync(path.join(books, name, 'highlights.md'), 'utf8'),
          }))
        : [];
    const saved = () => docs().reduce((n, d) => n + d.anchors.highlights.length, 0);
    const turns = (count) =>
      until(() => {
        const [doc] = docs();
        return doc?.anchors.turns.length === count && doc;
      }, 15000);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/papers/companion.pdf?edition=1`;
    async function launch() {
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        viewport: { width: 1100, height: 900 },
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
          '--remote-debugging-port=0',
        ],
      });
      const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
      // PDF responses are redirected to PDF.js once the extension registers its rule.
      assert(
        await until(() =>
          worker.evaluate(
            async () => (await chrome.declarativeNetRequest.getDynamicRules()).length,
          ),
        ),
      );
      return worker;
    }
    // Evaluates in the side panel (chat.html) over CDP, awaiting promises.
    async function sidePanel() {
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      const target = await until(async () =>
        (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) =>
          t.url.endsWith('/ui/chat.html'),
        ),
      );
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
      let sequence = 0;
      const evaluate = async (expression) => {
        const id = ++sequence;
        const reply = new Promise((resolve) => {
          const listen = (e) => {
            const message = JSON.parse(e.data);
            if (message.id !== id) return;
            socket.removeEventListener('message', listen);
            resolve(message);
          };
          socket.addEventListener('message', listen);
        });
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { returnByValue: true, awaitPromise: true, expression },
          }),
        );
        return (await reply).result?.result?.value;
      };
      evaluate.close = () => socket.close();
      return evaluate;
    }
    // Types a message in the composer and sends it once the conversation is ready.
    const send = (text) =>
      until(() =>
        panel(`(() => {
          const prompt = document.getElementById('prompt'), button = document.getElementById('send');
          prompt.value = ${JSON.stringify(text)};
          prompt.dispatchEvent(new Event('input'));
          if (button.disabled) return false;
          button.click();
          return true;
        })()`),
      );
    const messagesText = () => panel(`document.getElementById('messages').innerText`);
    const conversation = (threadId) =>
      worker.evaluate(async (threadId) => {
        const { conversations = [] } = await chrome.storage.session.get('conversations');
        return conversations.map(([, s]) => s).find((s) => s.threadId === threadId) || null;
      }, threadId);
    const panels = (worker) =>
      worker.evaluate(
        async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length,
      );
    let page, pdf;
    async function open(hash = '#page=2') {
      page = await context.newPage();
      await page.goto(url + hash);
      await page.waitForURL('**/pdf/viewer.html?**');
      await page.frameLocator('#viewer').locator('.textLayer span').first().waitFor();
      pdf = page.frames().find((f) => f.url().includes('/vendor/pdfjs/web/viewer.html'));
      await pdf.evaluate(() => {
        PDFViewerApplication.page = 2;
      });
      await pdf
        .locator('.page[data-page-number="2"] .textLayer .endOfContent')
        .waitFor({ state: 'attached' });
      await wait(1000);
    }
    const painted = () =>
      pdf.evaluate(() => [...(CSS.highlights.get('tabgent-highlight') || [])].map(String).sort());
    async function textPoint(needle) {
      const box = await pdf.evaluate((needle) => {
        const layer = document.querySelector('.page[data-page-number="2"] .textLayer');
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode,
            at = node.data.indexOf(needle);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          const r = range.getBoundingClientRect();
          return { left: r.left, right: r.right, y: r.top + r.height / 2 };
        }
      }, needle);
      const frame = await page.locator('#viewer').boundingBox();
      return { left: frame.x + box.left, right: frame.x + box.right, y: frame.y + box.y };
    }
    async function drag(needle) {
      const box = await textPoint(needle);
      await page.mouse.move(box.left + 1, box.y);
      await page.mouse.down();
      await page.mouse.move(box.right - 1, box.y, { steps: 8 });
      await page.mouse.up();
      await wait(300);
    }
    // CDP sees the toolbar inside the viewer frame's closed shadow root; scripts cannot.
    async function press(action) {
      const client = await page.context().newCDPSession(page);
      const { root: document } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      let target = null;
      (function walk(node) {
        const attributes = node.attributes || [];
        const at = attributes.indexOf('data-action');
        if (at >= 0 && attributes[at + 1] === action) target = node.backendNodeId;
        for (const child of [
          ...(node.children || []),
          ...(node.shadowRoots || []),
          ...(node.contentDocument ? [node.contentDocument] : []),
        ])
          walk(child);
      })(document);
      const { model } = await client.send('DOM.getBoxModel', { backendNodeId: target });
      const { outerHTML } = await client.send('DOM.getOuterHTML', { backendNodeId: target });
      await client.detach();
      await page.mouse.click(
        (model.border[0] + model.border[4]) / 2,
        (model.border[1] + model.border[5]) / 2,
      );
      return outerHTML;
    }
    // The reading layer's closed shadow root inside the PDF.js frame, as Markup.
    async function layerHtml() {
      const client = await page.context().newCDPSession(page);
      const { root: document } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      let shadow = null;
      (function walk(node) {
        if (node.localName === 'tabgent-reader') shadow = node.shadowRoots?.[0];
        for (const child of [
          ...(node.children || []),
          ...(node.shadowRoots || []),
          ...(node.contentDocument ? [node.contentDocument] : []),
        ])
          walk(child);
      })(document);
      const { outerHTML } = await client.send('DOM.getOuterHTML', {
        backendNodeId: shadow.backendNodeId,
      });
      await client.detach();
      return outerHTML;
    }

    let worker = await launch();
    await open();
    assert.equal(docs().length, 0, 'Opening a PDF writes nothing');
    const first = "endorsement of one's own actions";
    await drag(first);
    await press('highlight');
    assert(await until(() => saved() === 1));
    const [doc] = docs();
    assert.match(doc.name, /^paper-reading-companion-fixture-[0-9a-f]{8}$/);
    assert.equal(doc.anchors.document.kind, 'pdf');
    assert.equal(doc.anchors.document.url, url);
    assert.equal(doc.anchors.document.title, 'Reading Companion Fixture');
    const [highlight] = doc.anchors.highlights;
    assert.equal(highlight.text, first);
    assert.match(highlight.location, /^(p\. 2|第 2 页)$/);
    assert.equal(highlight.anchor.kind, 'pdf');
    assert.equal(highlight.anchor.page, 2);
    assert.equal(highlight.anchor.quote.exact, first);
    assert.equal(highlight.anchor.rects[0].page, 2);
    assert.match(doc.markdown, /^type: paper$/m);
    assert.match(doc.markdown, /^author: "Fixture Author"$/m);
    assert(doc.markdown.includes(`> ${first}`), doc.markdown);
    assert(doc.markdown.includes(highlight.location), doc.markdown);
    assert.deepEqual(await until(async () => (await painted()).length && painted()), [first]);
    assert.equal(
      await pdf.evaluate(() => PDFViewerApplication.pdfDocument.annotationStorage.size),
      0,
    );
    console.log('PASS Highlight in PDF.js writes Books/paper-*/ files through the real connector');

    assert.equal(await panels(worker), 0);
    const second = 'independence from other people';
    await drag(second);
    await press('ask');
    assert(await until(() => saved() === 2));
    assert.equal(
      await until(async () => (await panels(worker)) === 1, 5000),
      true,
      'The side panel opens from the click inside the PDF.js frame',
    );
    const selection = await until(() =>
      worker.evaluate(async () => {
        const { conversations = [] } = await chrome.storage.session.get('conversations');
        return conversations.map(([, s]) => s.selection).find((s) => s?.highlight) || null;
      }),
    );
    assert.equal(selection.text, second);
    assert.equal(selection.highlight.documentId, doc.name);
    assert.equal(selection.highlight.highlightId, 'h002');
    assert.equal(selection.locator.kind, 'pdf');
    assert.equal(selection.locator.page, 2);
    assert.equal(selection.locator.anchor.quote.exact, second);
    assert.match(selection.context.before, /own actions\. It does not mean $/);
    assert.match(selection.context.after, /^\. Readers who endorse a goal/);
    let panel = await sidePanel();
    const quote = await until(() =>
      panel(
        `document.getElementById('selection')?.hidden === false && document.getElementById('selectionText').textContent`,
      ),
    );
    assert.equal(quote, second);
    console.log('PASS Ask AI opens the side panel in-gesture and hands off the PDF payload');
    // The conversation is bound to the new PDF highlight (reading-companion.js).
    assert.match(
      await until(() => panel(`document.getElementById('readingLabel')?.textContent || ''`)),
      /^(Highlight 2|高亮 2)$/,
    );
    const question = 'Why is autonomy not independence?';
    assert(await send(question), 'The composer sends once the conversation is ready');
    const answered = await turns(1);
    const [turn] = answered.anchors.turns;
    assert.equal(turn.highlightId, 'h002');
    assert.equal(turn.user, question);
    assert.equal(turn.assistant, 'Fixture answer 1.');
    assert.match(
      answered.markdown,
      /## Highlight 002[\s\S]*Why is autonomy not independence\?[\s\S]*Fixture answer 1\./,
    );
    const bound = (await conversation(turn.threadId))?.reading;
    assert.equal(bound?.highlightId, 'h002');
    assert.equal(bound?.kind, 'pdf');
    assert.equal(bound?.url, url);
    console.log('PASS a turn in the PDF highlight conversation is saved under Books/paper-*');
    const request = (type, params = {}) =>
      panel(
        `import('/bridge.js').then((m) => m.readingRequest(${JSON.stringify(type)}, ${JSON.stringify(params)})).catch((e) => ({ error: e.message }))`,
      );
    const state = await request('readingState');
    assert.equal(state.page.kind, 'pdf');
    assert.equal(state.page.url, url);
    assert.equal(state.document.id, doc.name);
    assert.deepEqual(
      state.highlights.map((h) => [h.id, h.anchored !== false]),
      [
        ['h001', true],
        ['h002', true],
      ],
    );
    console.log('PASS the PDF quote binds the conversation; the drawer lists the PDF highlights');
    await pdf.evaluate(() => {
      PDFViewerApplication.page = 3;
    });
    await wait(500);
    assert.deepEqual(await request('readingJump', { highlightId: 'h001' }), { found: true });
    assert.equal(await until(() => pdf.evaluate(() => PDFViewerApplication.page === 2)), true);
    const opened = await request('readingOpen', { documentId: doc.name, highlightId: 'h001' });
    assert(!opened?.error, JSON.stringify(opened));
    const reopened = await until(() =>
      worker.evaluate(async () => {
        const { conversations = [] } = await chrome.storage.session.get('conversations');
        return (
          conversations
            .map(([, s]) => s.selection)
            .find((s) => s?.highlight?.highlightId === 'h001') || null
        );
      }),
    );
    assert.equal(reopened.text, first);
    assert.equal(reopened.locator.kind, 'pdf');
    assert.match(reopened.context.before, /Motivation Autonomy is the $/);
    assert.match(reopened.context.after, /^\. It does not mean independence/);
    panel.close();
    console.log('PASS the drawer jumps into the PDF and reopens a highlight with its page context');

    await context.close();
    worker = await launch();
    await open('');
    assert.deepEqual(await until(async () => (await painted()).length === 2 && painted()), [
      first,
      second,
    ]);
    console.log('PASS restart restores PDF highlights');

    // The user's own note on h002, added from the popover, survives a reload.
    const note = '我的看法: autonomy is endorsement, not isolation.';
    const target = await textPoint('independence');
    await page.mouse.click(target.left + 4, target.y);
    await wait(300);
    await press('note');
    await page.keyboard.type(note);
    await page.keyboard.press('Control+Enter');
    assert(await until(() => docs()[0].anchors.highlights[1].note === note));
    assert.match(
      docs()[0].markdown,
      /## Highlight 002[\s\S]*<!-- tabgent:note h002 start -->\n\n### 笔记\n\n我的看法: autonomy is endorsement, not isolation\.\n\n<!-- tabgent:note h002 end -->\n\n### 对话/,
    );
    await page.close();
    await open('');
    await until(async () => (await painted()).length === 2);
    const reloaded = await textPoint('independence');
    await page.mouse.click(reloaded.left + 4, reloaded.y);
    await wait(300);
    assert((await layerHtml()).includes(`<span>${note}</span>`), 'The note shows on click');
    console.log('PASS a PDF highlight note is saved from the popover and shown after a reload');

    const discussed = await textPoint('independence');
    await page.mouse.click(discussed.left + 4, discussed.y);
    await wait(300);
    assert.match(await press('discuss'), /Open discussion|查看讨论/);
    assert.equal(await until(async () => (await panels(worker)) === 1, 5000), true);
    panel = await sidePanel();
    const history = await until(async () => {
      const text = await messagesText();
      return text?.includes(question) && text.includes('Fixture answer 1.') && text;
    });
    assert(history, 'The reopened thread shows its earlier turn');
    const resumed = await until(() => conversation(turn.threadId));
    assert.equal(resumed.selection.highlight.highlightId, 'h002');
    assert.equal(resumed.selection.highlight.kind, 'pdf');
    assert.equal(resumed.selection.text, second);
    assert.match(resumed.selection.location, /^(p\. 2|第 2 页)$/);
    const followup = 'Give an example.';
    assert(await send(followup));
    const continued = await turns(2);
    assert.deepEqual(
      continued.anchors.turns.map((t) => [t.threadId, t.highlightId]),
      [
        [turn.threadId, 'h002'],
        [turn.threadId, 'h002'],
      ],
    );
    assert.match(
      continued.markdown,
      /## Highlight 002[\s\S]*Why is autonomy[\s\S]*Give an example\.[\s\S]*Fixture answer 2\./,
    );
    console.log('PASS Open discussion after a restart reopens the same thread and keeps saving');
    // Through the real connector, the message about h002 carried the note as the user's.
    const stored = JSON.parse(fs.readFileSync(path.join(home, 'codex/fixture-threads.json')));
    const sentInput = stored[turn.threadId].at(-1).items[0].content;
    const prefix = 'Reading context for this message';
    const readingPart = sentInput.find((part) => part.text?.startsWith(prefix));
    const reading = JSON.parse(readingPart.text.slice(readingPart.text.indexOf('\n') + 1));
    assert.equal(reading.highlight.id, 'h002');
    assert.equal(reading.highlight.userNote, note);
    console.log("PASS the follow-up's reading context carries the user's note to Codex");

    // A new conversation on the PDF saves page questions to the PDF's document notes.
    await panel(`document.getElementById('newConversation').click()`);
    assert.match(
      await until(async () =>
        (await panel(`document.body.classList.contains('empty')`))
          ? panel(`document.getElementById('readingLabel').textContent`)
          : '',
      ),
      /^(Page notes|页面笔记)$/,
    );
    const pageQuestion = 'What is the main claim of this paper?';
    assert(await send(pageQuestion));
    const noted = await turns(3);
    const pageTurn = noted.anchors.turns[2];
    assert.equal(pageTurn.highlightId, null);
    assert.notEqual(pageTurn.threadId, turn.threadId);
    assert.match(
      noted.markdown,
      /## 文档对话[\s\S]*What is the main claim of this paper\?[\s\S]*Fixture answer 1\./,
    );
    panel.close();
    console.log('PASS a page question in the PDF viewer saves to the PDF document');

    const hit = await textPoint('endorsement');
    await page.mouse.click(hit.left + 4, hit.y);
    await wait(300);
    await press('delete');
    assert(await until(() => !docs()[0].markdown.includes(`> ${first}`)));
    assert.deepEqual(
      docs()[0].anchors.highlights.map((h) => h.id),
      ['h002'],
    );
    assert.deepEqual(await until(async () => (await painted()).length === 1 && painted()), [
      second,
    ]);
    console.log('PASS delete removes the PDF highlight record and Markdown');
    passed = true;
  } finally {
    await context?.close().catch(() => {});
    server.close();
    const errors = fs.existsSync(temp + '/host.err') && fs.readFileSync(temp + '/host.err', 'utf8');
    if (errors && !passed) console.error(errors.slice(-2000));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
