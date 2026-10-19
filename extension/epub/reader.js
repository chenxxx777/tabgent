import '../vendor/foliate-js/view.js';
import { Overlayer } from '../vendor/foliate-js/overlayer.js';
import { localize, t, loadTimeData } from '../i18n.js';
import { openBook, label } from './book.js';
import * as epubAnchor from './anchor.js';
import * as library from './library.js';

const $ = (selector) => document.querySelector(selector);
const COLOR = 'rgb(255 200 60)';
const SETTINGS = 'epubSettings';
const state = {
  tabId: null,
  view: null,
  book: null,
  sha256: '',
  title: '',
  meta: {},
  documentId: null,
  source: null,
  highlights: new Map(), // id → { record, status: 'pending' | 'anchored' | 'unanchored', cfi }
  painted: new Map(), // painted CFI → highlight id
  selection: null,
  menuFor: null,
  settings: { fontSize: 100, flow: 'paginated' },
};

localize();
library.connect();
chrome.tabs.getCurrent().then((tab) => (state.tabId = tab?.id ?? null));

let toastTimer;
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  if (!element.matches(':popover-open')) element.showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.hidePopover(), 5000);
}
const failure = (key, error) => toast(loadTimeData.getStringF(key, error?.message || error));
const percent = (fraction) => `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
const status = (text) => ($('#status').textContent = text);

// Library: choose, drop or reopen a vault book.

$('#choose').onclick = () => $('#file').click();
$('#file').onchange = () => void openFile($('#file').files[0]);
addEventListener('dragover', (event) => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault();
  document.body.classList.add('dragging');
});
addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) document.body.classList.remove('dragging');
});
addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  void openFile(event.dataTransfer?.files?.[0]);
});
$('#library').onclick = () => {
  opening++;
  closeBook();
  history.replaceState(null, '', location.pathname);
  void showLibrary();
};

async function showLibrary() {
  document.title = t('epubReaderTitle');
  $('#bookTitle').textContent = t('epubReaderTitle');
  $('#start').hidden = false;
  const list = $('#books');
  list.replaceChildren();
  $('#booksStatus').textContent = t('epubLoading');
  try {
    const [{ books }, seen] = await Promise.all([
      library.send({ type: 'epubBooks' }),
      library.positions(),
    ]);
    $('#booksStatus').textContent = books.length ? '' : t('epubNoBooks');
    for (const book of books) {
      const item = document.createElement('li'),
        button = document.createElement('button'),
        title = document.createElement('span'),
        meta = document.createElement('span');
      title.className = 'title';
      title.textContent = book.title || t('epubUntitled');
      meta.className = 'meta';
      const read = seen[book.source.sha256]?.fraction;
      meta.textContent = [
        book.author,
        loadTimeData.getStringF('epubHighlightCount', book.highlightCount),
        typeof read === 'number' ? loadTimeData.getStringF('epubReadPercent', percent(read)) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      button.append(title, meta);
      button.onclick = () => location.assign('?book=' + encodeURIComponent(book.id));
      item.append(button);
      list.append(item);
    }
  } catch (error) {
    $('#booksStatus').textContent = loadTimeData.getStringF('epubBooksUnavailable', error.message);
  }
}

// Each open (or a return to the library) supersedes the ones still loading, which stop
// at their next step so two books never share the reader state or an upload.
let opening = 0;

async function openFile(file) {
  if (!file) return;
  const token = ++opening;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (token !== opening) return;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return toast(t('epubNotEpub'));
  const sha256 = await library.sha256Hex(bytes);
  if (token !== opening) return;
  closeBook();
  history.replaceState(null, '', location.pathname);
  if (!(await showBook(file, sha256, token))) return;
  void importIntoVault(bytes, file.name, sha256);
}

async function openFromVault(documentId) {
  const token = ++opening;
  status(loadTimeData.getStringF('epubLoadingVault', ''));
  try {
    const loaded = await library.loadBook(documentId, (fraction) =>
      status(loadTimeData.getStringF('epubLoadingVault', percent(fraction))),
    );
    if (token !== opening) return;
    // Known before the first chapter renders, so labels match the vault's chapter files.
    state.source = loaded.source;
    state.documentId = loaded.document.id;
    status('');
    await showBook(loaded.file, loaded.sha256, token);
  } catch (error) {
    if (token !== opening) return;
    status('');
    failure('epubOpenFailed', error);
    await showLibrary();
  }
}

async function importIntoVault(bytes, name, sha256) {
  const current = () => state.sha256 === sha256;
  if (!current()) return;
  status(loadTimeData.getStringF('epubSaving', '0%'));
  try {
    const result = await library.importBook({
      bytes,
      sha256,
      title: state.title,
      meta: state.meta,
      name,
      onProgress: (fraction) =>
        current() && status(loadTimeData.getStringF('epubSaving', percent(fraction))),
    });
    if (result.source && current()) {
      state.source = result.source;
      state.documentId = result.document.id;
      // The vault document ID names this book in the tab URL and its conversation history.
      history.replaceState(null, '', '?book=' + encodeURIComponent(result.document.id));
      status(t('epubSaved'));
      setTimeout(() => $('#status').textContent === t('epubSaved') && status(''), 4000);
    }
  } catch (error) {
    if (current()) status(loadTimeData.getStringF('epubSaveFailed', error.message));
  }
}

// Book view.

async function showBook(file, sha256, token) {
  status(t('epubLoading'));
  let book;
  try {
    book = await openBook(file);
  } catch (error) {
    if (token !== opening) return false;
    status('');
    failure('epubOpenFailed', error);
    return false;
  }
  if (token !== opening) return false;
  state.book = book;
  state.sha256 = sha256;
  state.title = label(book.metadata?.title) || file.name.replace(/\.epub$/i, '');
  const author = label(book.metadata?.author);
  state.meta = author ? { author } : {};
  document.title = state.title;
  $('#bookTitle').textContent = state.title;
  $('#start').hidden = true;
  $('#viewer').hidden = $('#footer').hidden = $('#reading').hidden = false;
  $('#contentsButton').disabled = false;
  const view = document.createElement('foliate-view');
  state.view = view;
  $('#book').replaceChildren(view);
  // A closed view can still finish loading; only the current view updates the reader.
  const on = (name, handler) =>
    view.addEventListener(name, (event) => state.view === view && handler(event));
  on('load', onSectionLoad);
  on('relocate', onRelocate);
  // foliate attaches the chapter's overlayer just after this event; paint a microtask later.
  on('create-overlay', ({ detail }) => queueMicrotask(() => paintSection(detail.index)));
  on('draw-annotation', ({ detail }) => detail.draw(Overlayer.highlight, { color: COLOR }));
  on('show-annotation', ({ detail }) => showHighlightMenu(detail));
  view.addEventListener('external-link', (event) => {
    event.preventDefault();
    const href = event.detail.a.getAttribute('href') || '';
    if (state.view === view && /^(?:https?|mailto):/i.test(href)) open(href, '_blank', 'noopener');
  });
  const highlights = loadHighlights(view);
  await view.open(book);
  if (state.view !== view) return false;
  applySettings();
  buildToc(book.toc || []);
  const saved = await library.position(sha256);
  await highlights;
  if (state.view !== view) return false;
  await view.init({ lastLocation: saved?.cfi, showTextStart: !saved?.cfi });
  if (state.view !== view) return false;
  status('');
  void verifyAll();
  return true;
}

function closeBook() {
  // The tab's conversation no longer shows this book's highlight status.
  if (state.sha256)
    void library.send({ type: 'epubHighlightStatus', sha256: null }).catch(() => {});
  hideToolbar();
  $('#highlightMenu').hidePopover?.();
  state.view?.close();
  state.view?.remove();
  Object.assign(state, {
    view: null,
    book: null,
    sha256: '',
    title: '',
    meta: {},
    documentId: null,
    source: null,
    selection: null,
  });
  state.highlights.clear();
  state.painted.clear();
  $('#viewer').hidden = $('#footer').hidden = $('#reading').hidden = $('#drawer').hidden = true;
  $('#contentsButton').disabled = true;
  $('#contentsButton').setAttribute('aria-expanded', 'false');
  $('#toc').replaceChildren();
  $('#highlightList').replaceChildren();
}

function applySettings() {
  const renderer = state.view?.renderer;
  const { fontSize, flow } = state.settings;
  $('#fontSize').textContent = `${fontSize}%`;
  $('#flow').textContent = t(flow === 'scrolled' ? 'epubPaginated' : 'epubScrolled');
  $('#prev').hidden = $('#next').hidden = flow === 'scrolled';
  if (!renderer) return;
  renderer.setAttribute('flow', flow);
  renderer.setAttribute('margin', '36px');
  renderer.setAttribute('gap', '6%');
  renderer.setAttribute('max-inline-size', '720px');
  renderer.setAttribute('max-column-count', '2');
  renderer.setStyles?.(`
    html { color-scheme: light; font-size: ${fontSize}% !important; }
    body { font-size: 1rem !important; }
    p, li, blockquote, dd { line-height: 1.6; }
    pre { white-space: pre-wrap !important; }
    a:link { color: #2457a6; }
  `);
}
chrome.storage.local.get(SETTINGS).then(({ [SETTINGS]: saved }) => {
  if (saved?.fontSize >= 70 && saved.fontSize <= 200) state.settings.fontSize = saved.fontSize;
  if (saved?.flow === 'scrolled') state.settings.flow = 'scrolled';
  applySettings();
});
function changeSettings(change) {
  Object.assign(state.settings, change);
  applySettings();
  void chrome.storage.local.set({ [SETTINGS]: state.settings });
}
$('#smaller').onclick = () =>
  changeSettings({ fontSize: Math.max(70, state.settings.fontSize - 10) });
$('#larger').onclick = () =>
  changeSettings({ fontSize: Math.min(200, state.settings.fontSize + 10) });
$('#flow').onclick = () =>
  changeSettings({ flow: state.settings.flow === 'scrolled' ? 'paginated' : 'scrolled' });
$('#prev').onclick = () => state.view?.goLeft();
$('#next').onclick = () => state.view?.goRight();
$('#progress').oninput = () => state.view?.goToFraction(Number($('#progress').value));

function onKey(event) {
  if (!state.view || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey)
    return;
  if (event.key === 'Tab' && !event.target?.closest?.('.floating')) {
    // Tab moves from a selection in the book to its toolbar or highlight menu.
    const open = document.querySelector('.floating:popover-open button');
    if (open) {
      event.preventDefault();
      return void open.focus();
    }
  }
  if (event.target?.closest?.('input, textarea, [contenteditable], #drawer, .floating')) return;
  if (event.key === 'Escape') return void hideFloating();
  const paged = state.settings.flow !== 'scrolled';
  if (event.key === 'ArrowLeft' || (paged && event.key === 'PageUp')) state.view.goLeft();
  else if (event.key === 'ArrowRight' || (paged && event.key === 'PageDown')) state.view.goRight();
  else return;
  event.preventDefault();
}
addEventListener('keydown', onKey);
for (const menu of document.querySelectorAll('.floating'))
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideFloating();
  });

// Table of contents and highlight list.

$('#contentsButton').onclick = () => {
  const open = $('#drawer').hidden;
  $('#drawer').hidden = !open;
  $('#contentsButton').setAttribute('aria-expanded', String(open));
};
for (const [tab, panel] of [
  ['#tocTab', '#toc'],
  ['#highlightsTab', '#highlightList'],
])
  $(tab).onclick = () => {
    for (const other of ['#tocTab', '#highlightsTab'])
      $(other).setAttribute('aria-selected', String(other === tab));
    $('#toc').hidden = panel !== '#toc';
    $('#highlightList').hidden = panel !== '#highlightList';
  };

function buildToc(items, parent = $('#toc')) {
  for (const item of items) {
    const li = document.createElement('li'),
      button = document.createElement('button');
    button.textContent = item.label?.trim() || t('epubUntitled');
    button.dataset.href = item.href || '';
    button.disabled = !item.href;
    button.onclick = () => void state.view?.goTo(item.href);
    li.append(button);
    if (item.subitems?.length) {
      const ol = document.createElement('ol');
      buildToc(item.subitems, ol);
      li.append(ol);
    }
    parent.append(li);
  }
}

// The chapter is the spine document: its title comes from the vault's chapter list, the
// table of contents, or its first heading, so labels match chapters/NN-<title>.md.
function chapterOf(index, doc) {
  const href = state.book.sections[index]?.id || '';
  const stored = state.source?.chapters?.find((chapter) => chapter.href === href);
  const flat = (items) => items.flatMap((item) => [item, ...flat(item.subitems || [])]);
  const toc = flat(state.book.toc || []).find((item) => item.href?.split('#')[0] === href);
  const heading = doc?.querySelector('h1, h2, h3')?.textContent;
  const title =
    stored?.title ||
    toc?.label?.trim() ||
    heading?.replace(/\s+/g, ' ').trim() ||
    loadTimeData.getStringF('epubSection', index + 1);
  return { href, title: title.slice(0, 300), index };
}
const chapterFile = (href) =>
  state.source?.chapters?.find((chapter) => chapter.href === href)?.file || '';
// The absolute path of a chapter's Markdown file, as the service worker builds for Ask AI.
const chapterPath = (href) => {
  const file = chapterFile(href);
  return file && state.source?.chaptersPath
    ? state.source.chaptersPath + file.slice('chapters'.length)
    : '';
};

function renderHighlightList() {
  const list = $('#highlightList');
  list.replaceChildren();
  if (!state.highlights.size) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.style.padding = '8px';
    empty.textContent = t('epubNoHighlights');
    list.append(empty);
    return;
  }
  for (const [id, entry] of state.highlights) {
    const li = document.createElement('li'),
      button = document.createElement('button'),
      quote = document.createElement('span'),
      meta = document.createElement('span');
    li.className = entry.status;
    quote.className = 'quote';
    quote.textContent = entry.record.text;
    meta.className = 'meta';
    meta.textContent = entry.record.location || '';
    if (entry.status === 'unanchored') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = ' · ' + t('epubUnanchored');
      meta.append(badge);
    }
    button.append(quote, meta);
    button.onclick = () => {
      if (entry.status === 'unanchored') return toast(t('epubUnanchoredHint'));
      void state.view?.goTo(entry.cfi || entry.record.anchor.cfi);
    };
    button.dataset.highlight = id;
    li.append(button);
    list.append(li);
  }
}

function onRelocate({ detail }) {
  const { fraction = 0, tocItem, cfi, section } = detail;
  $('#progress').value = String(fraction);
  $('#percent').textContent = percent(fraction);
  const index = section?.current;
  $('#location').textContent =
    tocItem?.label?.trim() || (Number.isInteger(index) ? chapterOf(index).title : '');
  for (const button of $('#toc').querySelectorAll('button'))
    button.setAttribute('aria-current', String(!!tocItem && button.dataset.href === tocItem.href));
  // foliate repeats relocate for layout passes; only a real move dismisses the toolbar.
  if (cfi === onRelocate.cfi) return;
  onRelocate.cfi = cfi;
  hideFloating();
  clearTimeout(onRelocate.timer);
  onRelocate.timer = setTimeout(
    () => state.sha256 && library.savePosition(state.sha256, { cfi, fraction }),
    400,
  );
}

// Highlights: restore, paint, create and act on them.

async function loadHighlights(view) {
  try {
    const result = await library.send({
      type: 'epubResolve',
      sha256: state.sha256,
      title: state.title,
      meta: state.meta,
    });
    if (state.view !== view) return;
    if (result.document?.createdAt) state.documentId = result.document.id;
    for (const record of result.highlights)
      state.highlights.set(record.id, { record, status: 'pending', cfi: null });
  } catch (error) {
    if (error.code !== 'host_missing') console.warn(error);
  }
  renderHighlightList();
}

const belongsTo = (record, index) => {
  const href = record.anchor?.chapter?.href;
  if (href) return href === state.book.sections[index]?.id;
  try {
    return state.view.resolveCFI(record.anchor.cfi).index === index;
  } catch {
    return false;
  }
};

function locate(doc, index, record) {
  return epubAnchor.resolve(doc, record.anchor, {
    rangeOfCfi: (cfi) => {
      const resolved = state.view.resolveCFI(cfi);
      return resolved.index === index ? resolved.anchor(doc) : null;
    },
  });
}

function paintSection(index) {
  const content = state.view?.renderer.getContents().find((item) => item.index === index);
  if (!content?.doc) return;
  for (const [id, entry] of state.highlights) {
    if (!belongsTo(entry.record, index)) continue;
    const found = locate(content.doc, index, entry.record);
    if (!found) {
      entry.status = 'unanchored';
      continue;
    }
    entry.status = 'anchored';
    entry.cfi =
      found.method === 'cfi' ? entry.record.anchor.cfi : state.view.getCFI(index, found.range);
    state.painted.set(entry.cfi, id);
    void state.view.addAnnotation({ value: entry.cfi });
  }
  renderHighlightList();
  reportStatus();
}

// Chapters that are not displayed are checked from their source documents for the list.
async function verifyAll() {
  const view = state.view;
  const pending = [...state.highlights.values()].filter((entry) => entry.status === 'pending');
  for (const [index, section] of state.book.sections.entries()) {
    const entries = pending.filter((entry) => belongsTo(entry.record, index));
    if (!entries.length || !section.createDocument) continue;
    let doc;
    try {
      doc = await section.createDocument();
    } catch {
      continue;
    }
    if (view !== state.view || doc.querySelector('parsererror')) continue;
    for (const entry of entries)
      if (entry.status === 'pending')
        entry.status = locate(doc, index, entry.record) ? 'anchored' : 'unanchored';
  }
  if (view !== state.view) return;
  renderHighlightList();
  reportStatus();
}

function reportStatus() {
  const entries = [...state.highlights.entries()];
  void library
    .send({
      type: 'epubHighlightStatus',
      sha256: state.sha256,
      title: state.title,
      documentId: state.documentId,
      anchored: entries.filter(([, entry]) => entry.status === 'anchored').length,
      unanchored: entries.filter(([, entry]) => entry.status === 'unanchored').map(([id]) => id),
    })
    .catch(() => {});
}

function onSectionLoad({ detail: { doc, index } }) {
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => captureSelection(doc, index), 150);
  };
  doc.addEventListener('selectionchange', schedule);
  doc.addEventListener('pointerup', schedule);
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('pointerdown', () => $('#highlightMenu').hidePopover());
}

let selectionId = null;
function captureSelection(doc, index) {
  const selection = doc.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) {
    hideToolbar();
    if (selectionId && doc.hasFocus())
      void library.send({ type: 'pageSelectionCleared', selectionId }).catch(() => {});
    selectionId = null;
    return;
  }
  const described = epubAnchor.describe(doc, selection.getRangeAt(0), {
    cfiOf: (range) => state.view.getCFI(index, range),
    chapter: chapterOf(index, doc),
  });
  if (!described) return hideToolbar();
  if (
    state.selection?.anchor.cfi === described.anchor.cfi &&
    $('#toolbar').matches(':popover-open')
  )
    return;
  state.selection = { ...described, index, text: described.anchor.quote.exact };
  place($('#toolbar'), doc, described.range);
  // Like PDF.js selections, the quote is offered to the tab's conversation.
  selectionId = crypto.randomUUID();
  const text = state.selection.text;
  void library
    .send({
      type: 'pageSelection',
      text: text.slice(0, 20000),
      truncated: text.length > 20000,
      title: state.title,
      selectionId,
      locator: {
        kind: 'epub',
        anchor: described.anchor,
        documentId: state.documentId,
        ...(chapterPath(described.anchor.chapter.href)
          ? { chapterFile: chapterPath(described.anchor.chapter.href) }
          : {}),
        capturedAt: new Date().toISOString(),
      },
    })
    .catch(() => {});
}

function place(element, doc, range) {
  const frame = doc.defaultView.frameElement?.getBoundingClientRect();
  const rect = range.getBoundingClientRect();
  if (!frame) return;
  if (!element.matches(':popover-open')) element.showPopover();
  const width = element.offsetWidth,
    height = element.offsetHeight;
  const left = frame.left + rect.left + rect.width / 2 - width / 2;
  let top = frame.top + rect.top - height - 8;
  if (top < 50) top = frame.top + rect.bottom + 8;
  element.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, left))}px`;
  element.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, top))}px`;
}
function hideToolbar() {
  if ($('#toolbar').matches(':popover-open')) $('#toolbar').hidePopover();
}
function hideFloating() {
  hideToolbar();
  if ($('#highlightMenu').matches(':popover-open')) $('#highlightMenu').hidePopover();
}

// Chrome allows sidePanel.open() only synchronously inside the click.
function openPanel() {
  if (state.tabId == null) return void toast(t('highlightOpenPanel'));
  chrome.sidePanel.open({ tabId: state.tabId }).catch(() => toast(t('highlightOpenPanel')));
}

async function createHighlight(ask) {
  const selected = state.selection;
  if (!selected) return;
  if (selected.text.length > 20000) return toast(t('highlightTooLong'));
  if (ask) openPanel();
  hideToolbar();
  const view = state.view;
  try {
    const reply = await library.send({
      type: 'epubHighlightCreate',
      ask,
      sha256: state.sha256,
      title: state.title,
      meta: state.meta,
      text: selected.text,
      anchor: selected.anchor,
      context: selected.context,
      chapterFile: chapterFile(selected.anchor.chapter.href),
    });
    if (reply.vaultError) toast(loadTimeData.getStringF('highlightSaveFailed', reply.vaultError));
    if (!reply.highlight || view !== state.view) return;
    state.documentId = reply.document.id;
    const record = reply.highlight;
    state.highlights.set(record.id, { record, status: 'anchored', cfi: record.anchor.cfi });
    state.painted.set(record.anchor.cfi, record.id);
    void state.view.addAnnotation({ value: record.anchor.cfi });
    state.view.deselect();
    renderHighlightList();
    reportStatus();
  } catch (error) {
    failure(ask ? 'highlightAskFailed' : 'highlightSaveFailed', error);
  }
}
$('#highlightAdd').onclick = () => void createHighlight(false);
$('#highlightAsk').onclick = () => void createHighlight(true);

function showHighlightMenu({ value, index, range }) {
  const id = state.painted.get(value);
  const entry = id && state.highlights.get(id);
  if (!entry) return;
  hideToolbar();
  const doc = state.view.renderer.getContents().find((item) => item.index === index)?.doc;
  if (!doc) return;
  const text = epubAnchor.chapterIndex(doc);
  const offsets = text.offsetsOfRange(range);
  state.menuFor = {
    id,
    context: offsets
      ? globalThis.tabgentWebAnchor.context(text, offsets.start, offsets.end)
      : { before: '', after: '' },
  };
  $('#menuAsk').textContent = t(entry.record.turnCount ? 'highlightOpen' : 'highlightAsk');
  place($('#highlightMenu'), doc, range);
}

$('#menuAsk').onclick = async () => {
  const target = state.menuFor;
  const entry = target && state.highlights.get(target.id);
  if (!entry) return;
  openPanel();
  $('#highlightMenu').hidePopover();
  try {
    await library.send({
      type: 'epubHighlightAsk',
      sha256: state.sha256,
      title: state.title,
      meta: state.meta,
      documentId: state.documentId,
      highlightId: target.id,
      context: target.context,
      chapterFile: chapterFile(entry.record.anchor?.chapter?.href),
    });
  } catch (error) {
    failure('highlightAskFailed', error);
  }
};
$('#menuDelete').onclick = async () => {
  const target = state.menuFor;
  const entry = target && state.highlights.get(target.id);
  if (!entry) return;
  $('#highlightMenu').hidePopover();
  try {
    await library.send({
      type: 'epubHighlightDelete',
      sha256: state.sha256,
      title: state.title,
      meta: state.meta,
      documentId: state.documentId,
      highlightId: target.id,
    });
    if (!state.highlights.delete(target.id)) return;
    if (entry.cfi) {
      state.painted.delete(entry.cfi);
      void state.view.deleteAnnotation({ value: entry.cfi });
    }
    renderHighlightList();
    reportStatus();
  } catch (error) {
    failure('highlightDeleteFailed', error);
  }
};

const book = new URLSearchParams(location.search).get('book');
if (book) void openFromVault(book);
else void showLibrary();
