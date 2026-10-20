import '../vendor/foliate-js/view.js';
import { Overlayer } from '../vendor/foliate-js/overlayer.js';
import { localize, t, loadTimeData } from '../i18n.js';
import { openBook, label } from './book.js';
import * as epubAnchor from './anchor.js';
import * as library from './library.js';
import { pdfViewerUrl } from '../pdf-routing.js';
import { clipViewerUrl } from '../clip-routing.js';

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

// Library: every document in the vault, and EPUB or PDF files chosen or dropped here.

$('#choose').onclick = () => $('#file').click();
$('#file').onchange = () => {
  const file = $('#file').files[0];
  $('#file').value = ''; // Choosing the same file again still opens it.
  void openFile(file);
};
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
  status('');
  closeBook();
  history.replaceState(null, '', location.pathname);
  void showLibrary();
};

async function showLibrary() {
  document.title = t('libraryTitle');
  $('#bookTitle').textContent = t('libraryTitle');
  $('#start').hidden = false;
  const list = $('#books');
  list.replaceChildren();
  $('#booksStatus').textContent = t('epubLoading');
  try {
    const [{ documents }, seen] = await Promise.all([
      library.send({ type: 'libraryDocuments' }),
      library.positions(),
    ]);
    $('#booksStatus').textContent = documents.length ? '' : t('libraryEmpty');
    for (const item of documents) list.append(libraryItem(item, seen));
  } catch (error) {
    $('#booksStatus').textContent = loadTimeData.getStringF('epubBooksUnavailable', error.message);
  }
}

const LOCAL_PDF = /^urn:sha256:[0-9a-f]{64}$/;
const web = (url) => /^https?:\/\//i.test(url || '');
const host = (url) => {
  try {
    return web(url) ? new URL(url).hostname : '';
  } catch {
    return '';
  }
};
// Where a vault document opens: a webpage at its URL, or its clipped copy in Tabgent's
// reader (with the live page as a second link), a PDF in the PDF.js viewer (from the web,
// or from the vault copy of an imported file), and an EPUB in this reader.
function destination(item) {
  if (item.kind === 'web' && web(item.url) && item.clip?.complete)
    return { label: 'libraryKindClipped', href: clipViewerUrl(item.url), original: item.url };
  if (item.kind === 'web') return { label: 'libraryKindWeb', href: web(item.url) && item.url };
  if (item.kind === 'pdf' && LOCAL_PDF.test(item.url))
    return { label: 'libraryKindLocalPdf', href: item.source && pdfViewerUrl(item.url) };
  if (item.kind === 'pdf')
    return { label: 'libraryKindPdf', href: web(item.url) && pdfViewerUrl(item.url) };
  return {
    label: 'libraryKindEpub',
    href: item.source && '?book=' + encodeURIComponent(item.id),
  };
}
const dates = new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), { dateStyle: 'medium' });

function libraryItem(item, seen) {
  const { label, href, original } = destination(item);
  const li = document.createElement('li'),
    entry = document.createElement(href ? 'a' : 'div'),
    title = document.createElement('span'),
    meta = document.createElement('span');
  entry.className = 'item';
  entry.dataset.kind = item.kind;
  entry.dataset.document = item.id;
  if (href) entry.href = href;
  else entry.title = t('libraryNoCopy');
  title.className = 'title';
  title.textContent = item.title || t('epubUntitled');
  meta.className = 'meta';
  const updated = Date.parse(item.updatedAt);
  const read = item.kind === 'epub' && seen[item.source?.sha256]?.fraction;
  meta.textContent = [
    t(label),
    item.author,
    host(item.url),
    loadTimeData.getStringF('epubHighlightCount', item.highlightCount),
    Number.isNaN(updated) ? '' : loadTimeData.getStringF('libraryUpdated', dates.format(updated)),
    typeof read === 'number' ? loadTimeData.getStringF('epubReadPercent', percent(read)) : '',
    href ? '' : t('libraryNoCopy'),
  ]
    .filter(Boolean)
    .join(' · ');
  entry.append(title, meta);
  li.append(entry);
  if (original) {
    const link = document.createElement('a');
    link.className = 'original';
    link.href = original;
    link.textContent = `${t('clipOriginal')} ↗`;
    li.append(link);
  }
  return li;
}

// Each open (or a return to the library) supersedes the ones still loading, which stop
// at their next step so two books never share the reader state or an upload.
let opening = 0;

async function openFile(file) {
  if (!file) return;
  // An EPUB is a ZIP archive; a PDF has %PDF- in its first 1024 bytes. Other files are
  // refused without cancelling a book still opening.
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (head[0] !== 0x50 || head[1] !== 0x4b) {
    if (new TextDecoder('latin1').decode(head).includes('%PDF-')) return openPdf(file);
    return toast(t('libraryNotSupported'));
  }
  const token = ++opening;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (token !== opening) return;
  const sha256 = await library.sha256Hex(bytes);
  if (token !== opening) return;
  closeBook();
  history.replaceState(null, '', location.pathname);
  if (!(await showBook(file, sha256, token))) return;
  void importIntoVault(bytes, file.name, sha256);
}

// A PDF is copied into the vault, named by its SHA-256, and then opened in the PDF.js
// viewer from that copy, so it reopens later from this library without the file.
const PDF_LIMIT = 100 * 1024 * 1024; // The vault's limit for imported originals.
async function openPdf(file) {
  if (file.size > PDF_LIMIT) return toast(t('libraryTooLarge'));
  const token = ++opening;
  status(t('epubLoading'));
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = await library.sha256Hex(bytes);
    const url = 'urn:sha256:' + sha256;
    const { title, meta } = await library.pdfDetails(bytes, file.name, url);
    if (token !== opening) return;
    status(loadTimeData.getStringF('epubSaving', '0%'));
    await library.importBook({
      bytes,
      sha256,
      title,
      meta,
      name: file.name,
      kind: 'pdf',
      onProgress: (fraction) =>
        token === opening && status(loadTimeData.getStringF('epubSaving', percent(fraction))),
    });
    if (token !== opening) return;
    status('');
    location.assign(pdfViewerUrl(url));
  } catch (error) {
    if (token !== opening) return;
    status('');
    failure('libraryPdfFailed', error);
  }
}
async function openFromVault(documentId) {
  const token = ++opening;
  status(loadTimeData.getStringF('epubLoadingVault', ''));
  try {
    const loaded = await library.loadBook(
      documentId,
      (fraction) =>
        token === opening && status(loadTimeData.getStringF('epubLoadingVault', percent(fraction))),
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
  library.announce({ sha256, title: state.title });
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
  library.announce(null);
  // The tab's conversation no longer shows this book's highlight status.
  if (state.sha256)
    void library.send({ type: 'epubHighlightStatus', sha256: null }).catch(() => {});
  hideToolbar();
  $('#highlightMenu').hidePopover?.();
  closeNote(); // A note belongs to the book being closed.
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
    // Tab moves from a selection in the book to its toolbar, highlight menu or note.
    const open = document.querySelector(
      '#noteEditor:popover-open textarea, .floating:popover-open button',
    );
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
    if (event.key === 'Escape' && !event.isComposing) hideFloating();
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
    button.append(quote);
    if (entry.record.note) {
      const note = document.createElement('span');
      note.className = 'note';
      note.textContent = entry.record.note;
      button.append(note);
    }
    button.append(meta);
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
  doc.addEventListener('pointerdown', () => {
    $('#highlightMenu').hidePopover();
    if (!noteChanged()) closeNote();
  });
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
  // A note with unsaved text stays open; Cancel or Escape discards it.
  if (!noteChanged()) closeNote();
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
    doc,
    range,
    context: offsets
      ? globalThis.tabgentWebAnchor.context(text, offsets.start, offsets.end)
      : { before: '', after: '' },
  };
  $('#menuAsk').textContent = t(entry.record.turnCount ? 'highlightOpen' : 'highlightAsk');
  // The user's own note shows above the actions.
  $('#menuNote').hidden = !entry.record.note;
  $('#menuNoteText').textContent = entry.record.note || '';
  $('#menuNoteEdit').textContent = t(entry.record.note ? 'highlightNoteEdit' : 'highlightNoteAdd');
  place($('#highlightMenu'), doc, range);
}

// The note editor: opens at the highlight and keeps focus until saved or closed.
let noteFor = null;
const noteChanged = () =>
  !!noteFor && $('#noteText').value.trim() !== (noteFor.initial || '').trim();
function openNote(target) {
  const entry = state.highlights.get(target.id);
  if (!entry) return;
  $('#highlightMenu').hidePopover();
  noteFor = {
    id: target.id,
    initial: entry.record.note || '',
    returnFocus: document.activeElement,
  };
  $('#noteText').value = entry.record.note || '';
  $('#noteQuote').textContent = `“${entry.record.text.replace(/\s+/g, ' ').trim()}”`;
  $('#noteError').hidden = true;
  place($('#noteEditor'), target.doc, target.range);
  $('#noteText').focus();
  $('#noteText').setSelectionRange($('#noteText').value.length, $('#noteText').value.length);
}
function closeNote() {
  if (!noteFor) return;
  const { returnFocus } = noteFor;
  noteFor = null;
  if ($('#noteEditor').matches(':popover-open')) $('#noteEditor').hidePopover();
  // The menu button that opened the editor is hidden now.
  if (
    returnFocus?.isConnected &&
    returnFocus !== document.body &&
    !returnFocus.closest('.floating')
  )
    returnFocus.focus();
  else if (document.activeElement?.closest('#noteEditor')) document.activeElement.blur();
}
async function saveNote() {
  const target = noteFor;
  if (!target || $('#noteSave').disabled) return;
  const note = $('#noteText').value.trim();
  $('#noteSave').disabled = $('#noteCancel').disabled = true;
  $('#noteError').hidden = true;
  try {
    const reply = await library.send({
      type: 'epubHighlightNote',
      sha256: state.sha256,
      title: state.title,
      meta: state.meta,
      documentId: state.documentId,
      highlightId: target.id,
      note,
    });
    const entry = state.highlights.get(target.id);
    if (entry && reply.highlight) entry.record = reply.highlight;
    if (noteFor === target) closeNote();
    renderHighlightList();
    toast(t(note ? 'highlightNoteSaved' : 'highlightNoteRemoved'));
  } catch (error) {
    $('#noteError').textContent = loadTimeData.getStringF('highlightNoteFailed', error.message);
    $('#noteError').hidden = false;
    $('#noteText').focus();
  } finally {
    $('#noteSave').disabled = $('#noteCancel').disabled = false;
  }
}
$('#menuNoteEdit').onclick = () => state.menuFor && openNote(state.menuFor);
$('#noteSave').onclick = () => void saveNote();
$('#noteCancel').onclick = () => closeNote();
$('#noteEditor').addEventListener('keydown', (event) => {
  // Enter and Escape also confirm or cancel an input method's composition.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeNote();
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void saveNote();
  } else if (event.key === 'Tab') {
    // Focus stays in the editor until it is saved or closed.
    const order = [$('#noteText'), $('#noteCancel'), $('#noteSave')];
    const at = order.indexOf(document.activeElement);
    event.preventDefault();
    order[(at + (event.shiftKey ? -1 : 1) + order.length) % order.length].focus();
  }
});

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
    if (noteFor?.id === target.id) closeNote();
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

// The side panel's highlight list jumps to a highlight or asks for its nearby text.
library.handleCommands(async (command) => {
  if (command?.type !== 'tabgentHighlight') throw Error('Unknown command');
  if (command.action === 'refresh') return void (await refreshHighlights());
  const entry = state.highlights.get(command.highlightId);
  if (!entry || !state.view) return { found: false };
  const href = entry.record.anchor?.chapter?.href || '';
  if (command.action === 'jump') {
    if (entry.status === 'unanchored') return { found: false };
    await state.view.goTo(entry.cfi || entry.record.anchor.cfi);
    return { found: true };
  }
  if (command.action !== 'context') throw Error('Unknown command');
  const index = state.book.sections.findIndex((section) => section.id === href);
  if (index < 0) return { before: '', after: '', chapterFile: chapterFile(href) };
  const shown = state.view.renderer.getContents().find((item) => item.index === index)?.doc;
  const doc = shown || (await state.book.sections[index].createDocument());
  const found = locate(doc, index, entry.record);
  return { ...(found?.context || { before: '', after: '' }), chapterFile: chapterFile(href) };
});

// Saved notes and turns change what a highlight shows; anchors and painting stay as they are.
async function refreshHighlights() {
  const view = state.view;
  if (!view || !state.sha256) return;
  const result = await library.send({
    type: 'epubResolve',
    sha256: state.sha256,
    title: state.title,
    meta: state.meta,
  });
  if (state.view !== view) return;
  for (const record of result.highlights || []) {
    const entry = state.highlights.get(record.id);
    if (entry) entry.record = record;
  }
  renderHighlightList();
}

const book = new URLSearchParams(location.search).get('book');
if (book) void openFromVault(book);
else void showLibrary();
