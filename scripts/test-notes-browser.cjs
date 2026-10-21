// Document comments and tags in real Chromium with the source extension and the real
// connector: in the library, in the clipped-page reader and in the side panel beside it. A
// temporary profile, HOME and CODEX_HOME isolate the browser, the vault and Codex state, and
// Codex is the fixture app-server: no account, model or personal vault (~/Tabgent,
// ~/ReadingVault) is used. Every page is generated fixture text served from 127.0.0.1.
const assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  fs = require('node:fs'),
  http = require('node:http'),
  os = require('node:os'),
  path = require('node:path'),
  { execSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'),
  { chromium } = require(root + '/node_modules/playwright');
const extension = path.join(root, 'extension');
const shots = process.env.NOTES_SHOTS;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) {
    const value = await check();
    if (value) return value;
  }
  return null;
}
const html = (title, text) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${text}</p></body></html>`;

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabgent-notes-'));
  const profile = path.join(temp, 'profile'),
    home = path.join(temp, 'home'),
    codexHome = path.join(home, 'codex'),
    vault = path.join(home, 'Tabgent');
  const personal = ['ReadingVault', 'Tabgent'].map((name) => path.join(os.homedir(), name));
  const personalState = () =>
    personal.map((dir) => (fs.existsSync(dir) ? fs.statSync(dir).mtimeMs : null)).join();
  const personalBefore = personalState();
  fs.mkdirSync(codexHome, { recursive: true });
  const python = process.env.PYTHON || execSync('command -v python3').toString().trim();
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url.startsWith('/articles/fresh'))
      return void response.end(html('Fresh Page', 'A page nobody saved yet.'));
    response.end(html('Fixture', 'Fixture text.'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const urls = {
    tagged: origin + '/articles/autonomy',
    clipped: origin + '/articles/clipped',
    other: origin + '/articles/other',
    fresh: origin + '/articles/fresh',
  };
  const anchor = (exact) => ({ kind: 'web', quote: { exact, prefix: '', suffix: '' } });
  let context,
    passed = false;
  try {
    // A highlighted page tagged AI学习, a clipped page without highlights, and another
    // highlighted page tagged 其他.
    const seed = spawnSync(
      python,
      [
        '-c',
        `import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import vault
settings = Path(sys.argv[2])
for method, params in json.loads(sys.argv[3]):
    reply = vault.handle(settings, method, params)
    assert "result" in reply, reply`,
        path.join(extension, 'native'),
        path.join(codexHome, 'projects/tabgent/vault.json'),
        JSON.stringify([
          [
            'vault/highlight/create',
            {
              url: urls.tagged,
              title: 'On Autonomy',
              kind: 'web',
              text: 'endorsement',
              anchor: anchor('endorsement'),
            },
          ],
          [
            'vault/document/tags',
            { url: urls.tagged, title: 'On Autonomy', kind: 'web', add: ['AI学习'] },
          ],
          [
            'vault/clip/save',
            {
              url: urls.clipped,
              title: 'Clipped Essay',
              kind: 'web',
              markdown: 'Two methods compared, in a clipped essay.',
              html: '<p>Two methods compared, in a clipped essay.</p>',
              origin: { method: 'article', pageUrl: urls.clipped },
            },
          ],
          [
            'vault/highlight/create',
            {
              url: urls.other,
              title: 'Other Notes',
              kind: 'web',
              text: 'other',
              anchor: anchor('other'),
            },
          ],
          [
            'vault/document/tags',
            { url: urls.other, title: 'Other Notes', kind: 'web', add: ['其他'] },
          ],
        ]),
      ],
      { env: { ...process.env, HOME: home } },
    );
    assert.equal(seed.status, 0, String(seed.stderr));
    const notes = {
      tagged: path.join(vault, 'Articles/On Autonomy.md'),
      clipped: path.join(vault, 'Articles/Clipped Essay.md'),
      other: path.join(vault, 'Articles/Other Notes.md'),
      fresh: path.join(vault, 'Articles/Fresh Page.md'),
    };
    const read = (name) => (fs.existsSync(notes[name]) ? fs.readFileSync(notes[name], 'utf8') : '');
    const front = (name) => read(name).split('\n---\n')[0] + '\n';
    const commentOf = (name) =>
      /<!-- tabgent:comment document start -->\n## 全文评论\n\n([\s\S]*?)\n<!-- tabgent:comment document end -->/.exec(
        read(name),
      )?.[1] ?? null;

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
    const start =
      'import sys; native, codex = sys.argv[1:3]; del sys.argv[1:3]; sys.path.insert(0, native); ' +
      'import host; host.executable = lambda: codex; host.main()';
    const connector = path.join(temp, 'connector');
    fs.writeFileSync(
      connector,
      `#!/bin/sh\nexport HOME='${home}' CODEX_HOME='${codexHome}'\nexec '${python}' -c '${start}' '${path.join(extension, 'native')}' '${codex}' "$@" 2>>'${temp}/host.err'\n`,
      { mode: 0o700 },
    );
    fs.mkdirSync(path.join(profile, 'NativeMessagingHosts'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'NativeMessagingHosts/com.tabgent.codex.json'),
      JSON.stringify({
        name: 'com.tabgent.codex',
        description: 'Tabgent connector for comment and tag tests',
        path: connector,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${id}/`],
      }),
    );
    const libraryUrl = `chrome-extension://${id}/epub/reader.html`;
    const readerUrl = (url) => `chrome-extension://${id}/clip/reader.html?url=${url}`;
    const logs = [];
    // One headless Chrome for Testing (Playwright's new headless mode, with a mock keychain).
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      channel: 'chromium',
      viewport: { width: 1100, height: 900 },
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
    const message = (key, ...args) =>
      worker.evaluate(([key, args]) => chrome.i18n.getMessage(key, args), [key, args]);
    // Dialogs the page must show, in order: each is checked, then accepted or dismissed.
    const dialogs = [];
    const expectDialog = (check, accept = true) => dialogs.push({ check, accept });
    const onDialog = async (dialog) => {
      const next = dialogs.shift();
      assert(next, `Unexpected dialog: ${dialog.message()}`);
      await next.check(dialog.message());
      await (next.accept ? dialog.accept() : dialog.dismiss());
    };

    const page = await context.newPage();
    page.on('dialog', onDialog);
    await page.goto(libraryUrl);
    await page.waitForSelector('#start:not([hidden])');
    assert(await until(async () => (await page.$$('#books li')).length === 3));
    const row = (title) =>
      page.locator('#books li', { has: page.locator('.title', { hasText: title }) });
    const chips = (title) => row(title).locator('.dn-tag-name').allTextContents();
    assert.deepEqual(await chips('On Autonomy'), ['AI学习']);
    assert.deepEqual(await chips('Other Notes'), ['其他']);
    assert.deepEqual(await chips('Clipped Essay'), []);
    console.log('PASS the library shows each document’s tags');

    // A comment on the clipped page, which has no highlights: saved to its note.
    const comment = '保存这篇是为了比较两种方法。\n\n第二种方法的适用条件还要验证。';
    const clipped = row('Clipped Essay');
    // Without tags or a comment, a row shows its buttons on hover.
    assert.equal(await clipped.locator('.dn-comment-open').isVisible(), false);
    await clipped.hover();
    await clipped.locator('.dn-comment-open').click();
    await clipped.locator('textarea').fill(comment);
    await clipped.locator('textarea').press('Control+Enter');
    assert(await until(() => commentOf('clipped') === comment), read('clipped'));
    const markdown = read('clipped');
    assert(
      markdown.indexOf('tabgent:metadata document end') <
        markdown.indexOf('tabgent:comment document start') &&
        markdown.indexOf('tabgent:comment document end') < markdown.indexOf('## 高亮'),
      markdown,
    );
    assert(!markdown.includes('tabgent:highlight '), 'Still no highlights');
    await page.reload();
    await page.waitForSelector('#books li .dn-comment-text');
    assert.equal(await row('Clipped Essay').locator('.dn-comment-text').textContent(), comment);
    console.log('PASS a comment on a document without highlights is in its note after a reload');

    // Tags with suggestions from the vault's tags; a new tag; Backspace removes the last.
    await row('Clipped Essay').locator('.dn-tag-add').click();
    const input = row('Clipped Essay').locator('.dn-tag-input');
    await input.fill('ai');
    const option = row('Clipped Essay').locator('.dn-option').first();
    await option.waitFor();
    assert.equal(await option.textContent(), await message('docNotesTagCount', 'AI学习', '1'));
    await input.press('Enter');
    assert(await until(async () => (await chips('Clipped Essay')).join() === 'AI学习'));
    assert(await until(() => front('clipped').includes('tags:\n  - AI学习')), front('clipped'));
    await input.fill('新标签');
    assert.equal(
      await row('Clipped Essay').locator('.dn-option').last().textContent(),
      await message('docNotesTagCreate', '新标签'),
    );
    await input.press('Enter');
    assert(await until(() => front('clipped').includes('tags:\n  - AI学习\n  - 新标签')));
    await input.press('Backspace');
    assert(await until(() => !front('clipped').includes('新标签')), front('clipped'));
    assert.deepEqual(await chips('Clipped Essay'), ['AI学习']);
    await input.press('Escape');
    console.log('PASS tags are added with suggestions, created and removed');

    // A tag chip filters the library.
    await row('On Autonomy').locator('.dn-tag-name').click();
    const visible = () =>
      page.$$eval('#books li:not([hidden]) .title', (titles) => titles.map((t) => t.textContent));
    assert(await until(async () => (await visible()).length === 2));
    assert.deepEqual((await visible()).sort(), ['Clipped Essay', 'On Autonomy']);
    assert.equal(
      await page.textContent('#tagFilterLabel'),
      await message('libraryTagFilter', 'AI学习'),
    );
    await page.click('#tagFilterClear');
    assert.equal((await visible()).length, 3);
    if (shots) await page.screenshot({ path: path.join(shots, 'library.png') });
    console.log('PASS clicking a tag shows only the documents with it');

    // A draft is not dropped silently when another document's comment opens.
    await row('On Autonomy').locator('.dn-comment-open').click();
    await row('On Autonomy').locator('textarea').fill('未保存的草稿');
    const discard = await message('docNotesDiscardConfirm', 'On Autonomy');
    expectDialog((text) => assert.equal(text, discard), false);
    await row('Other Notes').locator('.dn-comment-open').click();
    assert.equal(await row('On Autonomy').locator('textarea').inputValue(), '未保存的草稿');
    assert.equal(await row('Other Notes').locator('textarea').count(), 0);
    await row('On Autonomy').locator('textarea').press('Escape');
    assert.equal(await row('On Autonomy').locator('textarea').count(), 0);
    assert.equal(commentOf('tagged'), null, 'Escape saves nothing');
    console.log('PASS switching documents asks before a draft is dropped; Escape cancels');

    // Tag management: rename, merge into an existing tag (its spelling), delete.
    await page.click('#tagsManage');
    if (shots) {
      await wait(500);
      await page.screenshot({ path: path.join(shots, 'tags.png') });
    }
    const tagRow = (name) => page.locator(`#tagManagerList li[data-tag="${name}"]`);
    await tagRow('AI学习').waitFor();
    assert.equal(
      await tagRow('AI学习').locator('.count').textContent(),
      await message('tagsManageCount', '2'),
    );
    const rename = async (from, to, check) => {
      await tagRow(from)
        .locator('button', { hasText: await message('tagsRename') })
        .click();
      await page.fill('#tagManagerList .rename input', to);
      expectDialog(check);
      await page.press('#tagManagerList .rename input', 'Enter');
    };
    const renamed = await message('tagsRenameConfirm', '其他', '杂项', '1');
    await rename('其他', '杂项', (text) => assert.equal(text, renamed));
    assert(
      await until(() => front('other').includes('  - 杂项') && !front('other').includes('其他')),
    );
    await tagRow('杂项').waitFor();
    const merged = await message('tagsMergeConfirm', '杂项', 'AI学习', '1');
    await rename('杂项', 'ai学习', (text) => assert.equal(text, merged));
    assert(await until(() => front('other').includes('tags:\n  - AI学习\n')), front('other'));
    await until(
      async () =>
        (await tagRow('AI学习').locator('.count').textContent()) ===
        (await message('tagsManageCount', '3')),
    );
    const deleted = await message('tagsDeleteConfirm', 'AI学习', '3');
    expectDialog((text) => assert.equal(text, deleted));
    await tagRow('AI学习')
      .locator('button', { hasText: await message('tagsDelete') })
      .click();
    assert(
      await until(() =>
        ['tagged', 'clipped', 'other'].every((name) => !front(name).includes('tags:')),
      ),
    );
    await page.click('#tagManagerClose');
    assert(await until(async () => (await page.$$('#books .dn-tag')).length === 0));
    assert.equal((await visible()).length, 3, 'Deleting a tag keeps the documents');
    assert.equal(commentOf('clipped'), comment);
    console.log('PASS tags are renamed, merged and deleted in every note');

    // The clipped page's reader shows and edits the same comment and tags, under the title.
    const reader = await context.newPage();
    reader.on('dialog', onDialog);
    await reader.goto(readerUrl(urls.clipped));
    await reader.waitForSelector('#documentNotes:not([hidden]) .dn-comment-text');
    assert.equal(await reader.textContent('#documentNotes .dn-comment-text'), comment);
    await reader.click('#documentNotes .dn-comment-open');
    await reader.fill('#documentNotes textarea', '在阅读视图里改过。');
    await reader.press('#documentNotes textarea', 'Control+Enter');
    assert(await until(() => commentOf('clipped') === '在阅读视图里改过。'), read('clipped'));
    await reader.click('#documentNotes .dn-tag-add');
    await reader.fill('#documentNotes .dn-tag-input', '读后');
    await reader.press('#documentNotes .dn-tag-input', 'Enter');
    assert(await until(() => front('clipped').includes('tags:\n  - 读后')));
    // The library shows the change without a reload.
    assert(await until(async () => (await chips('Clipped Essay')).join() === '读后'));
    assert(
      await until(
        async () =>
          (await row('Clipped Essay').locator('.dn-comment-text').textContent()) ===
          '在阅读视图里改过。',
      ),
    );
    if (shots) await reader.screenshot({ path: path.join(shots, 'reader.png') });
    console.log('PASS the reader edits the same comment and tags; the library follows');

    // The side panel beside the reader: the same document, edited there too.
    const tabId = await reader.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    await reader.evaluate((tabId) => {
      const button = document.createElement('button');
      button.id = 'testPanel';
      button.textContent = 'panel';
      button.onclick = () => chrome.sidePanel.open({ tabId });
      document.body.prepend(button);
    }, tabId);
    await reader.click('#testPanel');
    const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const target = await until(async () =>
      (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) =>
        t.url.endsWith('/ui/chat.html'),
      ),
    );
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    let sequence = 0;
    const panel = async (expression) => {
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
    const panelComment = () =>
      panel(`document.querySelector('#documentNotes .dn-comment-text')?.textContent || ''`);
    assert(await until(async () => (await panelComment()) === '在阅读视图里改过。'));
    assert.equal(
      await panel(
        `[...document.querySelectorAll('#documentNotes .dn-tag-name')].map((t) => t.textContent).join()`,
      ),
      '读后',
    );
    const edit = (text, submit) =>
      panel(`(() => {
        document.querySelector('#documentNotes .dn-comment-open')?.click();
        const area = document.querySelector('#documentNotes textarea');
        if (!area) return false;
        area.value = ${JSON.stringify(text)};
        area.dispatchEvent(new Event('input'));
        if (${submit}) area.closest('form').requestSubmit();
        return true;
      })()`);
    assert(await edit('侧栏里写的评论。', true));
    assert(await until(() => commentOf('clipped') === '侧栏里写的评论。'), read('clipped'));
    // The reader beside it follows.
    assert(
      await until(
        async () =>
          (await reader.textContent('#documentNotes .dn-comment-text')) === '侧栏里写的评论。',
      ),
    );
    console.log('PASS the side panel edits the same comment; the reader follows');

    // A draft in the side panel survives the page changing, and saves to its own document.
    assert(await edit('侧栏草稿，还没保存。', false));
    await reader.goto(libraryUrl);
    const draftText = await message('docNotesUnsaved', 'Clipped Essay');
    assert(
      await until(
        async () =>
          (
            await panel(
              `document.getElementById('documentNotesDraft').hidden ? '' : document.getElementById('documentNotesDraft').textContent`,
            )
          ).startsWith(draftText),
        15000,
      ),
    );
    assert.equal(commentOf('clipped'), '侧栏里写的评论。');
    await panel(`document.querySelector('#documentNotesDraft button').click()`);
    assert(await until(() => commentOf('clipped') === '侧栏草稿，还没保存。'), read('clipped'));
    assert(
      await until(
        async () => (await panel(`document.getElementById('documentNotesDraft').hidden`)) === true,
      ),
    );
    console.log('PASS a side panel draft is kept when the page changes and saved to its document');

    // A page that is not saved: its first comment creates its document, without highlights.
    await reader.goto(urls.fresh);
    assert(
      await until(
        async () =>
          (await panel(
            `!!document.querySelector('#documentNotes .dn-comment-open') && !document.querySelector('#documentNotes .dn-comment-text')`,
          )) === true,
        15000,
      ),
    );
    assert(await edit('还没剪藏也能写。', true));
    assert(await until(() => commentOf('fresh') === '还没剪藏也能写。'), read('fresh'));
    const record = fs
      .readdirSync(path.join(vault, '.tabgent/documents'))
      .find((name) => name.startsWith('article-fresh-page-'));
    const anchors = JSON.parse(
      fs.readFileSync(path.join(vault, '.tabgent/documents', record, 'anchors.json'), 'utf8'),
    );
    assert.deepEqual(anchors.highlights, []);
    assert.equal(anchors.document.comment.text, '还没剪藏也能写。');
    console.log('PASS a first comment on an unsaved page creates its document');
    socket.close();

    assert.equal(dialogs.length, 0, 'Every expected dialog was shown');
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
