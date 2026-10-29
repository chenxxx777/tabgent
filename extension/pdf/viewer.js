import { paintAgentPointer } from '../agent-pointer.js';
import { t, loadTimeData } from '../i18n.js';
import { pdfSource, isLocalPdf, isFilePdf } from '../pdf-routing.js';
import { startHighlights } from './pdf-highlights.js';
import { pdfInfo } from './pdf-info.js';
const frame = document.querySelector('#viewer');
const status = document.querySelector('#status');
// A PDF opened from the computer (file://) is read from the file; the vault names it by hash.
// Its viewer runs only as the tab's page: a local HTML page cannot embed it to show a file.
const named = pdfSource(location.href);
const file = isFilePdf(named) && window.top === window;
const source = isFilePdf(named) && !file ? null : named;
// An imported PDF (urn:sha256:...) opens from its copy in the reading vault.
const local = isLocalPdf(source);
if (source && !local && !file) {
  const icon = new Image();
  icon.referrerPolicy = 'no-referrer';
  icon.onload = () => {
    document.querySelector('#favicon').href = icon.src;
  };
  icon.src = new URL('/favicon.ico', source).href;
}
const native = document.querySelector('#native');
native.textContent = t('pdfOpenNative');
// PDF.js spread modes: none, odd pages paired, even pages paired (cover alone).
const PDF_SETTINGS = 'pdfSettings';
const SPREAD = { none: 0, odd: 1, even: 2 };
const spreadButtons = [
  ['spreadNone', 'none', 'pdfSpreadSingle'],
  ['spreadOdd', 'odd', 'pdfSpreadOdd'],
  ['spreadEven', 'even', 'pdfSpreadEven'],
];
let pdfSpread = 'none';
let spreadChosen = false;
// The spread buttons are optional: viewer.js also runs on copies of the toolbar
// (file.html) that may lack one, and a missing button must not blank the page.
const spreadGroup = document.querySelector('#spread');
if (spreadGroup) spreadGroup.setAttribute('aria-label', t('pdfSpread'));
for (const [id, spread, key] of spreadButtons) {
  const button = document.getElementById(id);
  if (!button) continue;
  button.textContent = t(key);
  button.onclick = () => choosePdfSpread(spread);
}
function showSpread(spread) {
  pdfSpread = Object.hasOwn(SPREAD, spread) ? spread : 'none';
  for (const [id, name] of spreadButtons)
    document.getElementById(id)?.setAttribute('aria-pressed', String(name === pdfSpread));
}
function choosePdfSpread(spread) {
  spreadChosen = true;
  showSpread(spread);
  if (app?.pdfViewer) app.pdfViewer.spreadMode = SPREAD[pdfSpread];
  void chrome.storage.local.set({ [PDF_SETTINGS]: { spread: pdfSpread } });
}
function spreadFromMode(mode) {
  return mode === SPREAD.odd ? 'odd' : mode === SPREAD.even ? 'even' : 'none';
}
const spreadReady = chrome.storage.local.get(PDF_SETTINGS).then(({ [PDF_SETTINGS]: saved }) => {
  if (spreadChosen) return;
  if (saved?.spread === 'none' || saved?.spread === 'odd' || saved?.spread === 'even')
    showSpread(saved.spread);
});
frame.title = t('pdfFrameTitle');
// Chrome's viewer needs a web address; an imported PDF has none.
native.hidden = local;
if (!local) status.textContent = t('pdfLoading');
let app,
  port,
  last = '',
  selectionId,
  fileSha256 = null,
  ready = false;
async function fallback() {
  if (local) return;
  if (app?.pdfDocument?.annotationStorage.size && !confirm(t('pdfDirty'))) return;
  const result = await chrome.runtime.sendMessage({ type: 'pdfFallback' });
  if (result?.error) status.textContent = result.error;
}
native.onclick = fallback;
const timer = setTimeout(() => {
  if (!ready) void fallback();
}, 30000);
// The vault copy is read in chunks by the service worker, which accepts the request only
// from this viewer's registered port, and is checked against the SHA-256 in its address.
async function loadLocal() {
  connect();
  const digest = source.slice('urn:sha256:'.length, 'urn:sha256:'.length + 64);
  const parts = [];
  let offset = 0,
    reply;
  status.textContent = loadTimeData.getStringF('epubLoadingVault', '');
  do {
    reply = await viewerRequest({ type: 'pdfLocalRead', offset, length: 2 * 1024 * 1024 });
    const bytes = Uint8Array.fromBase64(reply.data);
    if (!bytes.length && !reply.eof) throw Error('The vault returned no data');
    parts.push(bytes);
    offset += bytes.length;
    const done = Math.round((100 * offset) / Math.max(1, reply.source.size));
    status.textContent = loadTimeData.getStringF('epubLoadingVault', `${done}%`);
  } while (!reply.eof);
  const data = new Uint8Array(await new Blob(parts).arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  if ([...hash].map((b) => b.toString(16).padStart(2, '0')).join('') !== digest)
    throw Error('The stored PDF does not match its checksum');
  return { data, name: reply.source.name || 'document.pdf' };
}
async function viewerRequest(message) {
  for (let attempt = 0; ; attempt++) {
    const reply = await chrome.runtime.sendMessage(message);
    // The service worker may not have registered this viewer's port yet.
    if (reply?.error === 'Stale PDF viewer' && attempt < 20) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      continue;
    }
    if (!reply || reply.error) throw Error(reply?.error || 'No response');
    return reply;
  }
}
const CHUNK = 2 * 1024 * 1024;
const hex = async (data) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
// A PDF from the computer: Chrome lets this page read the file while the user allows Tabgent
// access to file URLs. Its SHA-256 is its vault identity, announced on the viewer's port.
async function loadFile() {
  const response = await fetch(source.split('#')[0]);
  if (!response.ok) throw Error(`The file could not be read (${response.status})`);
  const data = new Uint8Array(await response.arrayBuffer());
  fileSha256 = await hex(data);
  if (port) port.postMessage({ type: 'document', sha256: fileSha256 });
  else connect();
  const name = decodeURIComponent(new URL(source).pathname.split('/').pop()) || 'document.pdf';
  // The vault keeps originals up to 100 MB; a larger PDF keeps its notes without a copy, so
  // its bytes go to PDF.js without keeping a second copy.
  return { data, name, copy: data.byteLength <= 100 * 1024 * 1024 };
}
const localFile = local ? loadLocal() : file ? loadFile() : null;
localFile?.catch(() => {}); // Reported when the PDF.js frame asks for the document.
// A PDF from the computer is copied into the vault once it has notes (its first highlight or
// saved conversation), so the library can reopen it and Codex can read its pages after the
// file moves. Opening it alone writes nothing. The highlight is saved first and never waits
// for the copy; the connector reads the page text in the background after it. A failure
// keeps the notes, is shown in the document (problem), and is tried again next time.
let copying = null;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function copyToVault(problem) {
  if (!file || copying) return;
  copying = (async () => {
    const { data, name, copy } = await localFile;
    if (!copy) return;
    const { title, meta } = await pdfInfo(app.pdfDocument, source, name);
    const base = { type: 'pdfFileSave', title, meta, name, size: data.byteLength };
    let reply = await viewerRequest({ ...base, offset: 0, data: '' });
    while (!reply.complete) {
      const offset = reply.received;
      reply = await viewerRequest({
        ...base,
        offset,
        data: data.subarray(offset, offset + CHUNK).toBase64(),
      });
      if (!reply.complete && reply.received <= offset) throw Error('The vault stopped the copy');
    }
    // Page text that cannot be read while this viewer is open is reported once.
    const reading = !!reply.source?.textPending;
    for (let wait = 2000, end = Date.now() + 5 * 60000; reply.source?.textPending;) {
      if (Date.now() > end) return;
      await pause(wait);
      wait = Math.min(wait * 1.5, 15000);
      reply = await viewerRequest({ ...base, offset: 0, data: '' });
    }
    if (reading && reply.source?.pageError)
      problem?.(reply.source.textRetry ? 'pdfTextRetry' : 'pdfTextFailed', {
        message: reply.source.pageError,
      });
  })().catch((error) => {
    copying = null;
    console.warn('The PDF was not copied into the reading vault', error);
    problem?.('pdfCopyFailed', error);
  });
}
function connect() {
  port = chrome.runtime.connect({ name: 'pdf' });
  // A restarted service worker learns the file's identity again.
  if (fileSha256) port.postMessage({ type: 'document', sha256: fileSha256 });
  port.onMessage.addListener(async ({ id, args }) => {
    try {
      const result =
        args.action === 'pointer'
          ? (paintAgentPointer(args.x, args.y, args.pressed), { success: true })
          : await operate(args);
      port.postMessage({ id, result });
    } catch (e) {
      port.postMessage({ id, error: e.message });
    }
  });
  port.onDisconnect.addListener(() => setTimeout(connect, 1000));
}
function capture() {
  const doc = frame.contentDocument,
    selection = doc.getSelection();
  const text = selection?.toString() || '';
  if (!text.trim() || selection.isCollapsed) {
    if (last && doc.hasFocus()) {
      chrome.runtime.sendMessage({ type: 'pageSelectionCleared', selectionId }).catch(() => {});
      last = '';
    }
    return;
  }
  const range = selection.getRangeAt(0);
  const element = range.startContainer.parentElement;
  const page = element?.closest('.page');
  if (!element?.closest('.textLayer') || !page) return;
  const number = Number(page.dataset.pageNumber);
  const pages = [...doc.querySelectorAll('.page')].map((el) => ({
    page: Number(el.dataset.pageNumber),
    bounds: el.getBoundingClientRect(),
  }));
  const rects = [...range.getClientRects()].slice(0, 100).flatMap((r) => {
    const owner = pages.find(
      ({ bounds }) => r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1,
    );
    if (!owner) return [];
    const { page, bounds } = owner;
    const view = app.pdfViewer.getPageView(page - 1);
    return [
      {
        page,
        x: r.x - bounds.x,
        y: r.y - bounds.y,
        width: r.width,
        height: r.height,
        pdf: [
          ...view.viewport.convertToPdfPoint(r.left - bounds.left, r.top - bounds.top),
          ...view.viewport.convertToPdfPoint(r.right - bounds.left, r.bottom - bounds.top),
        ],
      },
    ];
  });
  const key = JSON.stringify([number, text, rects]);
  if (key === last) return;
  last = key;
  selectionId = crypto.randomUUID();
  chrome.runtime
    .sendMessage({
      type: 'pageSelection',
      text: text.slice(0, 20000),
      truncated: text.length > 20000,
      title: document.title,
      selectionId,
      locator: {
        kind: 'pdf',
        page: number,
        rects,
        coordinateSpace: 'PDF page points and page-local CSS pixels',
        capturedAt: new Date().toISOString(),
      },
    })
    .catch(() => {});
}
async function operate(args) {
  if (!ready) throw Error('PDF is still loading');
  const pageNumber = args.page ?? (args.action === 'read' ? 1 : app.page);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > app.pagesCount)
    throw Error('PDF page out of range');
  if (args.action === 'read') {
    const page = await app.pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('');
    const offset = Math.max(0, args.offset || 0);
    return {
      contentType: 'application/pdf',
      viewer: 'pdfjs',
      url: source,
      title: document.title,
      page: pageNumber,
      pages: app.pagesCount,
      text: text.slice(offset, offset + 30000),
      offset,
      nextOffset: offset + 30000 < text.length ? offset + 30000 : null,
      // A PDF from the computer is read-only for Agent apart from these viewer actions.
      actions: [
        'selectText',
        'highlight',
        'savePdf',
        'screenshot',
        'scroll',
        ...(file ? [] : ['click', 'press']),
      ],
    };
  }
  if (args.action === 'savePdf') {
    await app.downloadOrSave();
    return { success: true };
  }
  if (!['selectText', 'highlight'].includes(args.action)) throw Error('Unsupported PDF action');
  if (typeof args.text !== 'string' || !args.text.trim()) throw Error('Text is required');
  app.pdfViewer.scrollPageIntoView({ pageNumber });
  const view = app.pdfViewer.getPageView(pageNumber - 1);
  let layer;
  for (let i = 0; i < 100; i++) {
    // PDF.js populates spans before attaching the layer and may replace it
    // during rendering. Only select from the current, attached layer.
    layer = view.textLayer?.div;
    if (frame.contentDocument.contains(layer) && layer.querySelector('span')) break;
    layer = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!layer) throw Error('PDF text layer unavailable');
  const walker = frame.contentDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const points = [],
    characters = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    for (let i = 0; i < node.length; i++) {
      if (/\s/.test(node.data[i])) continue;
      characters.push(node.data[i]);
      points.push({ node, offset: i });
    }
  }
  const needle = args.text.replace(/\s/g, '');
  const haystack = characters.join('');
  const occurrence = args.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1) throw Error('Invalid occurrence');
  let start = -1;
  for (let i = 0; i < occurrence; i++) {
    start = haystack.indexOf(needle, start + 1);
    if (start < 0) throw Error('Text not found on this PDF page');
  }
  const from = points[start],
    to = points[start + needle.length - 1];
  const range = frame.contentDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset + 1);
  const selection = frame.contentWindow.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  if (!selection.rangeCount || selection.isCollapsed) throw Error('PDF text selection failed');
  from.node.parentElement.scrollIntoView({ block: 'center' });
  capture();
  if (args.action === 'highlight')
    app.eventBus.dispatch('editingaction', { source: window, name: 'highlightSelection' });
  return { success: true, page: pageNumber, text: args.text, occurrence };
}
document.addEventListener('webviewerloaded', async (event) => {
  if (event.detail.source !== frame.contentWindow) return;
  const win = frame.contentWindow;
  const options = win.PDFViewerApplicationOptions;
  options.setAll({
    defaultUrl: '',
    enableScripting: false,
    isEvalSupported: false,
    disablePreferences: true,
    externalLinkTarget: 2,
    locale: 'en-US',
    enableComment: true,
    // Tabgent's selection toolbar (Highlight / Comment / Ask AI) replaces the PDF.js floating button;
    // the PDF.js highlight tool still annotates the PDF for savePdf.
    enableHighlightFloatingButton: false,
    enableAltTextModelDownload: false,
  });
  app = win.PDFViewerApplication;
  let name;
  try {
    await app.initializedPromise;
    await spreadReady;
    // Open on one page. Applying a spread while PDF.js is still measuring the
    // viewer freezes the page, and a stored per-file spread would do that here.
    options.set('spreadModeOnLoad', SPREAD.none);
    if (local || file) {
      const loaded = await localFile;
      name = loaded.name;
      // The file name names downloads made from the viewer. PDF.js takes the buffer it is
      // given; a file from the computer keeps its bytes for the vault copy.
      await app.open({ data: loaded.copy ? loaded.data.slice() : loaded.data, filename: name });
    } else {
      // The original URL is validated by the wrapper, not the generic demo viewer.
      await app.open({ url: source, withCredentials: true });
      name = decodeURIComponent(new URL(source).pathname.split('/').pop()) || 'PDF';
    }
    ready = true;
    clearTimeout(timer);
    status.textContent = '';
    // Ignore the single-page open. documentinit runs after setInitialView; apply the
    // remembered choice on the next frame, once that layout pass has measured the page.
    let spreadSettled = false;
    app.eventBus.on('spreadmodechanged', ({ mode }) => {
      if (!spreadSettled) return;
      const next = spreadFromMode(mode);
      if (next === pdfSpread) return;
      spreadChosen = true;
      showSpread(next);
      void chrome.storage.local.set({ [PDF_SETTINGS]: { spread: pdfSpread } });
    });
    app.eventBus.on('documentinit', () => {
      requestAnimationFrame(() => {
        spreadSettled = true;
        if (app.pdfViewer.spreadMode !== SPREAD[pdfSpread])
          app.pdfViewer.spreadMode = SPREAD[pdfSpread];
      });
    });
    document.title = name;
    document.querySelector('#title').textContent = name;
    const doc = frame.contentDocument;
    doc.addEventListener('selectionchange', () => setTimeout(capture, 120));
    doc.addEventListener('pointerup', capture);
    // A document switch would invalidate the source tab binding. Open PDFs via Chrome instead.
    for (const id of ['openFile', 'secondaryOpenFile']) doc.getElementById(id)?.remove();
    doc.addEventListener(
      'drop',
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
    doc.addEventListener(
      'keydown',
      (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
    if (!port) connect();
    startHighlights({
      app,
      frame,
      source,
      name,
      ...(file ? { onDocument: copyToVault } : {}),
    }).catch((e) => console.warn(e));
  } catch (error) {
    clearTimeout(timer);
    if (local)
      return void (status.textContent = loadTimeData.getStringF(
        'pdfLocalFailed',
        globalThis.tabgentExplainError?.(error, (key, ...args) =>
          args.length ? loadTimeData.getStringF(key, ...args) : t(key),
        ) || t('errorGeneric'),
      ));
    status.textContent = t('pdfFailed');
    await fallback();
  }
});
if (source) frame.src = '../vendor/pdfjs/web/viewer.html?file=' + new URL(source).hash;
else {
  clearTimeout(timer);
  status.textContent = t('pdfInvalid');
  native.disabled = true;
}
