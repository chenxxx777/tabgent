// An Agent tab after its source page closes, in real Chromium with the source extension
// and the real connector: a webpage and an imported PDF, each with a highlight discussion
// continued in its Agent tab. A temporary profile, HOME and CODEX_HOME isolate the browser,
// the vault and Codex state; Codex is the fixture app-server and pages are served locally,
// so no account, model, network or personal vault is used.
const assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  { vaultDocuments } = require('./vault-files.cjs'),
  { execSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  { chromium } = require(root + '/node_modules/playwright');
const { textPdf } = require(root + '/extension/tests/fixtures/text-pdf.cjs');
const extension = path.join(root, 'extension');
const shots = process.env.AGENT_TAB_SHOTS;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}
const article = `<!doctype html><html><head><title>Closing Article</title>
<style>body { font: 20px/1.6 Georgia, serif; max-width: 640px; margin: 40px auto }</style>
</head><body><h1>Spaced practice</h1>
<p id="a">Spacing study sessions over days helps memory more than one long session.</p>
<p id="b">Retrieval practice makes the memory durable.</p></body></html>`;
const zhArticle = `<!doctype html><html><head><meta charset="utf-8"><title>耳夹式无线耳机体验</title>
<style>body { font: 20px/1.6 Georgia, serif; max-width: 640px; margin: 40px auto }</style>
</head><body><h1>耳夹式无线耳机体验</h1>
<p id="a">耳夹式无线耳机体验比入耳式更轻，适合长时间通勤。</p></body></html>`;
const paper = textPdf(
  [
    ['Page one of the closing paper.'],
    ['Masked attention keeps the decoder from seeing later words.', 'This is page two.'],
  ],
  { title: 'Closing Paper', author: 'Fixture Author' },
);

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-agent-tab-'));
  const profile = path.join(temp, 'profile'),
    home = path.join(temp, 'home'),
    codexHome = path.join(home, 'codex'),
    vault = path.join(home, 'Tabgent');
  // The personal vault is never touched: its state is the same before and after.
  const personal = ['ReadingVault', 'Tabgent'].map((name) => path.join(os.homedir(), name));
  const personalState = () =>
    personal.map((dir) => (fs.existsSync(dir) ? fs.statSync(dir).mtimeMs : null)).join();
  const personalBefore = personalState();
  const paperFile = path.join(temp, 'closing-paper.pdf');
  fs.writeFileSync(paperFile, paper);
  fs.mkdirSync(codexHome, { recursive: true });
  const python = process.env.PYTHON || execSync('command -v python3').toString().trim();
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end((request.url || '').startsWith('/zh/') ? zhArticle : article);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const articleUrl = `http://127.0.0.1:${server.address().port}/articles/spacing`;
  let context,
    passed = false;
  try {
    const key = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).key;
    const id = [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex')]
      .slice(0, 32)
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join('');
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
    const connector = path.join(temp, 'connector');
    fs.writeFileSync(
      connector,
      `#!/bin/sh\nexport HOME='${home}' CODEX_HOME='${codexHome}'\nexec '${python}' -c '${start}' '${path.join(extension, 'native')}' '${codex}' "$@" 2>>'${temp}/host.err'\n`,
      { mode: 0o700 },
    );
    // Chrome reads <user-data-dir>/NativeMessagingHosts, so nothing is installed globally.
    fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'NativeMessagingHosts/com.tabgent.codex.json'),
      JSON.stringify({
        name: 'com.tabgent.codex',
        description: 'Tabgent connector for Agent tab tests',
        path: connector,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
    const libraryUrl = `chrome-extension://${id}/epub/reader.html`;
    const logs = [];
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium',
      viewport: { width: 1100, height: 900 },
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        '--remote-debugging-port=0',
        '--use-mock-keychain',
      ],
    });
    context.on('page', (opened) => {
      opened.on('console', (message) => logs.push(message.text()));
      opened.on('pageerror', (error) => logs.push('pageerror: ' + error.message));
    });
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    // Strings follow the browser's UI language (macOS ignores --lang), so compare by key.
    const message = (key, ...args) =>
      worker.evaluate(([key, args]) => chrome.i18n.getMessage(key, args), [key, args]);

    // The webpage reading layer and the PDF.js toolbar live in closed shadow roots, which
    // CDP pierces; page scripts cannot. The PDF.js page is a frame of the viewer.
    let page, pdf;
    async function press(action) {
      const client = await page.context().newCDPSession(page);
      const target = await until(async () => {
        const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
        let found = null;
        (function walk(node) {
          const attributes = node.attributes || [];
          const at = attributes.indexOf('data-action');
          if (at >= 0 && attributes[at + 1] === action) found = node.backendNodeId;
          for (const child of [
            ...(node.children || []),
            ...(node.shadowRoots || []),
            ...(node.contentDocument ? [node.contentDocument] : []),
          ])
            walk(child);
        })(root);
        return found;
      }, 5000);
      assert(target, `The ${action} button is shown`);
      const { model } = await client.send('DOM.getBoxModel', { backendNodeId: target });
      await client.detach();
      await page.mouse.click(
        (model.border[0] + model.border[4]) / 2,
        (model.border[1] + model.border[5]) / 2,
      );
    }
    // Drags across the text in the page, or in the PDF.js frame when one is open.
    async function drag(needle) {
      const frame = pdf || page;
      const box = await frame.evaluate((needle) => {
        const walker = document.createTreeWalker(
          document.querySelector('.page[data-page-number="2"] .textLayer') || document.body,
          NodeFilter.SHOW_TEXT,
        );
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
      const offset = pdf ? await page.locator('#viewer').boundingBox() : { x: 0, y: 0 };
      await page.mouse.move(offset.x + box.left + 1, offset.y + box.y);
      await page.mouse.down();
      await page.mouse.move(offset.x + box.right - 1, offset.y + box.y, { steps: 8 });
      await page.mouse.up();
      await wait(300);
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
    // Documents' record folders of a kind: Articles (webpages) or Books (PDFs and books).
    const folder = (kind) => {
      const dir = path.join(vault, '.tabgent/documents');
      const prefixes = kind === 'Articles' ? ['article-'] : ['paper-', 'book-'];
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
            .map((name) => path.join(dir, name))
        : [];
    };
    const docOf = (dir) => vaultDocuments(vault).find((doc) => doc.id === path.basename(dir));
    const anchors = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'anchors.json'), 'utf8'));
    const threads = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(codexHome, 'fixture-threads.json'), 'utf8'));
      } catch {
        return {};
      }
    };
    // The browser and reading context parts of a thread's latest user message.
    function lastContexts(threadId) {
      const turn = threads()[threadId].at(-1);
      const parts = turn.items.find((item) => item.type === 'userMessage').content;
      const part = (prefix) =>
        JSON.parse(parts.find((p) => p.text?.startsWith(prefix)).text.replace(/^[^\n]*\n/, ''));
      return {
        status: turn.status,
        page: part('Browser context for this message'),
        reading: part('Reading context for this message'),
      };
    }

    // Asks in the side panel: the reading layer handed it the highlight as a quote.
    async function askInPanel(panel, question) {
      assert(
        await until(() =>
          panel(`(() => {
            const prompt = document.getElementById('prompt'), button = document.getElementById('send');
            if (document.getElementById('connection').dataset.state !== 'ready') return false;
            if (document.getElementById('selection').hidden) return false;
            prompt.value = ${JSON.stringify(question)};
            prompt.dispatchEvent(new Event('input'));
            if (button.disabled) return false;
            button.click();
            return true;
          })()`),
        ),
        'The side panel sends the question',
      );
    }
    // Opens the side panel's conversation in a new Agent tab.
    async function openAgentTab(panel) {
      const opened = context.waitForEvent('page');
      await panel(`document.getElementById('openAgent').click()`);
      const agent = await opened;
      await agent.waitForURL('**/ui/chat.html');
      assert(await ready(agent), 'The Agent tab connects');
      return agent;
    }
    const ready = (agent) =>
      until(() =>
        agent.evaluate(() => document.getElementById('connection').dataset.state === 'ready'),
      );
    const transcript = (agent) =>
      agent.evaluate(() => document.getElementById('messages').innerText);
    // Sends from the Agent tab and waits for the answer; the connection must stay up.
    async function ask(agent, text, answer, { steer = false } = {}) {
      await agent.fill('#prompt', text);
      await agent.press('#prompt', steer ? 'Control+Enter' : 'Enter');
      if (!answer) return;
      const shown = await until(async () => answer.test(await transcript(agent)));
      assert(shown, `No answer ${answer} for "${text}":\n${await transcript(agent)}`);
      await expectConnected(agent);
    }
    async function expectConnected(agent) {
      assert.equal(
        await agent.evaluate(() => document.getElementById('connection').dataset.state),
        'ready',
      );
      const text = await transcript(agent);
      assert.doesNotMatch(text, /No tab with id/);
      assert(!text.includes(await message('disconnected')), text);
    }
    const busy = (agent) => agent.evaluate(() => document.body.classList.contains('busy'));
    // Closing the final Agent tab closes the session as before; the thread stays reopenable.
    async function closeLastAgentTab(agent, threadId) {
      await agent.close();
      const closed = await until(() =>
        worker.evaluate(async (threadId) => {
          const { conversations = [], closedViews = [] } = await chrome.storage.session.get([
            'conversations',
            'closedViews',
          ]);
          return (
            !conversations.some(([, s]) => s.threadId === threadId) &&
            closedViews.some(([id]) => id === threadId)
          );
        }, threadId),
      );
      assert(closed, 'The session closes with its final view');
    }

    // --- A webpage: a highlight discussion continues in its Agent tab after the page closes.
    page = await context.newPage();
    await page.goto(articleUrl);
    await wait(1500);
    await drag('helps memory');
    await press('ask');
    const articleFolder = await until(() => folder('Articles')[0]);
    assert(articleFolder, 'Ask AI saves the highlight');
    let panel = await sidePanel();
    await askInPanel(panel, 'Why does spacing help?');
    assert(await until(() => anchors(articleFolder).turns.length === 1), 'The first turn saves');
    const [webTurn] = anchors(articleFolder).turns;
    assert.equal(webTurn.highlightId, 'h001');
    const webThread = webTurn.threadId;
    let agent = await openAgentTab(panel);
    assert.match(await transcript(agent), /Fixture answer 1\./);
    panel.close();
    await page.close();
    // The composer shows the page as closed; the conversation stays connected.
    const closedTitle = await message('pageClosedContext', 'Closing Article');
    assert(
      await until(async () => (await agent.textContent('#contextText')) === closedTitle),
      await agent.textContent('#contextText'),
    );
    await expectConnected(agent);
    await ask(agent, 'Only search my reading notes.', /Fixture answer 2\./);
    let saved = anchors(articleFolder).turns;
    assert.equal(saved.length, 2, 'The follow-up is saved');
    // Without a quote it is about the whole page: saved in its discussion, same thread.
    assert.deepEqual(
      [saved[1].highlightId, saved[1].threadId, saved[1].user],
      [null, webThread, 'Only search my reading notes.'],
    );
    let contexts = lastContexts(webThread);
    assert.equal(contexts.page.closed, true);
    assert.equal(contexts.page.url, articleUrl);
    assert.equal(contexts.reading.saving, 'document');
    assert.equal(contexts.reading.highlight, undefined);
    console.log('PASS webpage: the Agent tab keeps asking and saving after its page closes');
    if (shots) await agent.screenshot({ path: path.join(shots, 'web-after-close.png') });

    // A browser action on the closed page fails clearly, inside the turn.
    await ask(agent, '[browser-read] Read the page.', /browser failed: Tab \d+ was closed/);
    console.log('PASS webpage: reading the closed page is a clear tool error');

    // A reload attaches again; Steer and Stop reach the running turn.
    await agent.reload();
    assert(await ready(agent), 'The Agent tab reconnects after a reload');
    assert(await until(async () => (await agent.textContent('#contextText')) === closedTitle));
    await ask(agent, '[hold] Compare the two paragraphs.');
    assert(await until(() => busy(agent)), 'The held turn runs');
    await ask(agent, 'Use my notes only.', /Fixture answer \d+ \(steered\)\./, { steer: true });
    assert(await until(async () => !(await busy(agent))));
    contexts = lastContexts(webThread);
    assert.equal(contexts.status, 'completed');
    assert.equal(contexts.page.closed, true);
    await ask(agent, '[hold] Stop this one.');
    assert(await until(() => busy(agent)), 'The second held turn runs');
    await agent.click('#stop');
    assert(await until(async () => !(await busy(agent))), 'Stop ends the turn');
    assert.equal(lastContexts(webThread).status, 'interrupted');
    await expectConnected(agent);
    console.log('PASS webpage: reload, Steer and Stop work after the page closed');

    // Page conversations keep the page's last address; its highlight list stays.
    await agent.click('#historyToggle');
    assert(await until(async () => (await agent.textContent('#historyUrl')) === articleUrl));
    assert(
      await until(() =>
        agent.evaluate(() => !!document.querySelector('.history-entry[aria-current="true"]')),
      ),
      'The current conversation is listed',
    );
    const quote = await until(() =>
      agent.evaluate(() => {
        const button = document.querySelector('#highlightList .highlight-quote');
        return button && { disabled: button.disabled, title: button.title };
      }),
    );
    assert.deepEqual(quote, { disabled: true, title: await message('highlightPageClosed') });
    saved = anchors(articleFolder).turns;
    assert(saved.every((turn) => turn.threadId === webThread));
    assert.equal(saved[0].highlightId, 'h001');
    await closeLastAgentTab(agent, webThread);
    console.log('PASS webpage: history and highlights remain; the final Agent tab closes it');

    // A Chinese title keeps the Ask AI turn on that highlight (h001), not the document.
    const zhUrl = `http://127.0.0.1:${server.address().port}/zh/earbuds`;
    const beforeArticles = new Set(folder('Articles'));
    page = await context.newPage();
    await page.goto(zhUrl);
    await wait(1500);
    await drag('耳夹式');
    await press('ask');
    const zhFolder = await until(() => folder('Articles').find((dir) => !beforeArticles.has(dir)));
    assert(zhFolder, 'Ask AI saves the Chinese-titled highlight');
    assert.match(path.basename(zhFolder), /^article-耳夹式无线耳机体验-[0-9a-f]{8}$/);
    panel = await sidePanel();
    await askInPanel(panel, '这副耳机适合通勤吗？');
    assert(await until(() => anchors(zhFolder).turns.length === 1), 'The Chinese turn saves');
    assert.equal(anchors(zhFolder).turns[0].highlightId, 'h001');
    panel.close();
    await page.close();
    console.log('PASS Chinese title: Ask AI binds the turn to h001');

    // --- An imported PDF: the same after its viewer tab closes, reading its vault pages.
    page = await context.newPage();
    await page.goto(libraryUrl);
    await page.waitForSelector('#start:not([hidden])');
    await page.setInputFiles('#file', paperFile);
    await page.waitForURL('**/pdf/viewer.html?**');
    await page.frameLocator('#viewer').locator('.textLayer span').first().waitFor();
    pdf = page.frames().find((f) => f.url().includes('/vendor/pdfjs/web/viewer.html'));
    await pdf.evaluate(() => {
      PDFViewerApplication.page = 2;
    });
    await pdf
      .locator('.page[data-page-number="2"] .textLayer .endOfContent')
      .waitFor({ state: 'attached' });
    await wait(800);
    const paperFolder = await until(() =>
      folder('Books').find((dir) => path.basename(dir).startsWith('paper-closing-paper-')),
    );
    assert(paperFolder, 'The PDF is imported');
    assert(
      await until(() => docOf(paperFolder)?.fullText.includes('<!-- tabgent:page 2 -->')),
      'Its page text is saved',
    );
    await drag('Masked attention');
    await press('ask');
    assert(await until(() => anchors(paperFolder).highlights.length === 1));
    panel = await sidePanel();
    await askInPanel(panel, 'What does masking do?');
    assert(await until(() => anchors(paperFolder).turns.length === 1), 'The first turn saves');
    const pdfThread = anchors(paperFolder).turns[0].threadId;
    agent = await openAgentTab(panel);
    panel.close();
    await page.close();
    pdf = null;
    assert(
      await until(
        async () =>
          (await agent.textContent('#contextText')) ===
          (await message('pageClosedContext', 'closing-paper.pdf')),
      ),
      await agent.textContent('#contextText'),
    );
    await ask(
      agent,
      '[vault-read:002] The viewer is closed: read page 2 from the vault only.',
      /reading_vault ok: .*Masked attention keeps the decoder/s,
    );
    saved = anchors(paperFolder).turns;
    assert.equal(saved.length, 2, 'The follow-up is saved to the imported PDF');
    assert.deepEqual([saved[1].highlightId, saved[1].threadId], [null, pdfThread]);
    contexts = lastContexts(pdfThread);
    assert.equal(contexts.page.closed, true);
    assert.match(contexts.page.url, /^urn:sha256:[0-9a-f]{64}/);
    assert.equal(contexts.reading.saving, 'document');
    assert.equal(contexts.reading.document.fullText, docOf(paperFolder).fullTextPath);
    assert.match(
      docOf(paperFolder).discussions,
      /The viewer is closed: read page 2 from the vault only\./,
    );
    console.log('PASS imported PDF: the Agent tab reads the vault pages and saves after closing');
    if (shots) await agent.screenshot({ path: path.join(shots, 'pdf-after-close.png') });
    await ask(agent, '[browser-read] Read the viewer.', /browser failed: Tab \d+ was closed/);
    await closeLastAgentTab(agent, pdfThread);
    console.log('PASS imported PDF: reading the closed viewer fails clearly; the session closes');

    if (shots) fs.writeFileSync(path.join(shots, 'console.txt'), logs.join('\n'));
    assert(!logs.some((line) => line.startsWith('pageerror')), logs.join('\n'));
    assert.equal(personalState(), personalBefore, 'The personal vault was not touched');
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
