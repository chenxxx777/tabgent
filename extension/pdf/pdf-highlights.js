// Reading layer for the PDF.js viewer: the Highlight / Comment / Ask AI toolbar for text selections,
// saved highlights painted on PDF.js text layers through the CSS Custom Highlight API, and
// actions on saved highlights. It mirrors the webpage layer (highlight-content.js). The PDF
// bytes and the PDF.js annotation storage are never touched, so savePdf exports only PDF.js
// edits and the native fallback never asks about unsaved changes.
import * as anchors from './pdf-anchor.js';
import { pdfInfo } from './pdf-info.js';
import '../user-error.js';
import '../highlight-note.js';

const notes = globalThis.tabgentHighlightNote;

const t = (key, ...values) => chrome.i18n.getMessage(key, values.map(String)) || key;
const shown = (error) => globalThis.tabgentExplainError?.(error, t) || t('errorGeneric');
const limit = 20000;
const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
const styles = `
  .bar { position: fixed; display: flex; gap: 2px; padding: 4px; border-radius: 10px;
    background: #202124; color: #fff; font: 500 13px/1.2 system-ui, -apple-system, sans-serif;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.08);
    user-select: none; -webkit-user-select: none; z-index: 1; }
  .bar[hidden], .toast[hidden] { display: none; }
  button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center;
    gap: 6px; padding: 6px 10px; border-radius: 7px; cursor: pointer; white-space: nowrap; }
  button:hover { background: rgb(255 255 255 / 0.14); }
  button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }
  .swatch { width: 10px; height: 10px; border-radius: 3px; background: rgb(255 214 102); }
  .toast { position: fixed; right: 16px; bottom: 16px; max-width: min(360px, calc(100vw - 32px));
    padding: 10px 12px; border-radius: 10px; background: #202124; color: #fff;
    font: 13px/1.4 system-ui, -apple-system, sans-serif; box-shadow: 0 6px 20px rgb(0 0 0 / 0.25); }`;

async function send(message) {
  // Called synchronously from clicks: sendMessage carries the gesture for sidePanel.open.
  const response = await chrome.runtime.sendMessage(message);
  if (!response) throw Error('No response');
  if (response.error)
    throw Object.assign(Error(response.error), {
      code: response.code,
      ...(response.folder ? { folder: response.folder } : {}),
    });
  return response;
}

// onDocument runs whenever the PDF has a saved vault document (notes or a saved turn).
export async function startHighlights({ app, frame, source, name, onDocument }) {
  const win = frame.contentWindow,
    doc = frame.contentDocument;
  if (!win.CSS?.highlights || !win.Highlight) return;
  const { title, meta } = await pdfInfo(app.pdfDocument, source, name);
  const normalizeText = win.pdfjsLib?.normalizeUnicode || ((value) => value);
  const paint = new win.Highlight(),
    focused = new win.Highlight();
  focused.priority = 1;
  win.CSS.highlights.set('tabgent-highlight', paint);
  win.CSS.highlights.set('tabgent-highlight-active', focused);
  // The webpage highlight colors; the PDF.js page CSP (style-src 'self') blocks inline styles.
  const sheet = doc.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = chrome.runtime.getURL('highlight.css');
  doc.head.append(sheet);

  let records = new Map(),
    documentId = null,
    host,
    root,
    toolbar,
    popover,
    notePreview,
    noteEditor,
    toast,
    draft = null,
    dismissed = null,
    active = null,
    noteTarget = null,
    pendingComment = null,
    returnFocus = null,
    pointerDown = false,
    selectionTimer,
    toastTimer,
    repaintTimer,
    flashing = null,
    flashTimer;

  // Page text as getTextContent reports it, with the text layer's own parameters.
  const known = new Map(),
    loading = new Map();
  function pageText(page) {
    if (!loading.has(page))
      loading.set(
        page,
        app.pdfDocument
          .getPage(page)
          .then((p) => p.getTextContent({ includeMarkedContent: true, disableNormalization: true }))
          .then(({ items }) => {
            const text = anchors.pageText(items);
            known.set(page, text);
            return text;
          })
          .catch(() => {
            loading.delete(page);
            return '';
          }),
      );
    return loading.get(page);
  }
  const pages = {
    get count() {
      return app.pagesCount;
    },
    text: pageText,
  };
  // Ask AI sends from the click, so the text of neighboring pages is loaded in advance.
  function prefetch(segments) {
    if (!segments?.length) return;
    for (let page = segments[0].page - 1; page <= segments.at(-1).page + 1; page++)
      if (page >= 1 && page <= app.pagesCount) void pageText(page);
  }
  // A rendered, attached text layer (PDF.js appends endOfContent once rendering finishes).
  function layerOf(page) {
    const layer = app.pdfViewer.getPageView(page - 1)?.textLayer?.div;
    return layer?.isConnected && layer.querySelector('.endOfContent') ? layer : null;
  }
  function textOf(page) {
    if (known.has(page)) return known.get(page);
    const layer = layerOf(page);
    return layer ? anchors.layerIndex(layer).text : '';
  }
  const label = (page, endPage) =>
    endPage > page ? t('pdfPagesLabel', page, endPage) : t('pdfPageLabel', page);
  function contextOf(segments) {
    if (!segments?.length) return { before: '', after: '' };
    const first = segments[0],
      last = segments.at(-1);
    return anchors.context(
      `${textOf(first.page - 1)} ${textOf(first.page).slice(0, first.start)}`,
      `${textOf(last.page).slice(last.end)} ${textOf(last.page + 1)}`,
    );
  }

  // Painting: each segment becomes a range in its page's live text layer.
  function rangeFor(index, { page, start, end }) {
    const canonical = known.get(page);
    if (canonical !== undefined && canonical !== index.text) {
      // The live layer differs from getTextContent (unexpected): take the nearest same text.
      const wanted = canonical.slice(start, end);
      let best = -1;
      for (let at = index.text.indexOf(wanted); at !== -1; at = index.text.indexOf(wanted, at + 1))
        if (best < 0 || Math.abs(at - start) < Math.abs(best - start)) best = at;
      if (best < 0) return null;
      [start, end] = [best, best + wanted.length];
    }
    return index.rangeFromOffsets(start, end);
  }
  function repaint() {
    clearTimeout(repaintTimer);
    const indexes = new Map();
    paint.clear();
    for (const record of records.values()) {
      record.ranges = [];
      for (const segment of record.segments || []) {
        if (!indexes.has(segment.page)) {
          const layer = layerOf(segment.page);
          indexes.set(segment.page, layer && anchors.layerIndex(layer));
        }
        const index = indexes.get(segment.page),
          range = index && rangeFor(index, segment);
        if (range) {
          record.ranges.push(range);
          paint.add(range);
        }
      }
    }
    if (active && !(records.get(active.highlight.id) === active && active.ranges.length))
      hidePopover();
    else refocus();
  }
  const scheduleRepaint = () => {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(repaint, 60);
  };

  function ensureUi() {
    if (host?.isConnected) return;
    host = doc.createElement('tabgent-reader');
    for (const [property, value] of [
      ['all', 'initial'],
      ['position', 'fixed'],
      ['inset', '0 auto auto 0'],
      ['width', '0'],
      ['height', '0'],
      ['margin', '0'],
      ['padding', '0'],
      ['border', '0'],
      ['background', 'transparent'],
      ['overflow', 'visible'],
      ['z-index', '2147483647'],
    ])
      host.style.setProperty(property, value, 'important');
    host.popover = 'manual';
    root = host.attachShadow({ mode: 'closed' });
    const css = new win.CSSStyleSheet();
    css.replaceSync(styles + notes.styles);
    root.adoptedStyleSheets = [css];
    toolbar = bar(t('highlightToolbar'), [
      ['highlight', t('highlightAdd'), true],
      ['comment', t('highlightNoteAdd')],
      ['ask', t('highlightAsk')],
    ]);
    popover = bar(t('highlightActions'), [
      ['discuss', t('highlightAsk')],
      ['note', t('highlightNoteAdd')],
      ['delete', t('highlightDelete')],
    ]);
    // Clicking a highlight shows its comment above the actions.
    notePreview = notes.preview(doc, t);
    popover.classList.add('card');
    popover.prepend(notePreview);
    popover.setAttribute('aria-describedby', notePreview.id);
    noteEditor = notes.editor(doc, t, { save: saveNote, close: closeEditor });
    toast = doc.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.hidden = true;
    root.append(toolbar, popover, noteEditor.element, toast);
    doc.documentElement.append(host);
  }
  function bar(name, actions) {
    const element = doc.createElement('div');
    element.className = 'bar';
    element.setAttribute('role', 'toolbar');
    element.setAttribute('aria-label', name);
    element.hidden = true;
    for (const [action, text, swatch] of actions) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.dataset.action = action;
      if (swatch) {
        const mark = doc.createElement('span');
        mark.className = 'swatch';
        mark.setAttribute('aria-hidden', 'true');
        button.append(mark);
      }
      button.append(text);
      button.tabIndex = -1;
      element.append(button);
    }
    element.querySelector('button').tabIndex = 0;
    // Keep the PDF selection while the toolbar is clicked.
    element.addEventListener('pointerdown', (event) => event.preventDefault());
    element.addEventListener('mousedown', (event) => event.preventDefault());
    element.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) act(button.dataset.action);
    });
    element.addEventListener('keydown', (event) => barKeys(event, element));
    return element;
  }
  function syncHost() {
    if (!host?.isConnected) return;
    const open = [toolbar, popover, noteEditor.element, toast].some((element) => !element.hidden);
    if (open && !host.matches(':popover-open')) host.showPopover();
    if (!open && host.matches(':popover-open')) host.hidePopover();
  }
  function place(element, rect) {
    element.hidden = false;
    syncHost();
    const width = element.offsetWidth,
      height = element.offsetHeight;
    let top = rect.bottom + 8;
    if (top + height > win.innerHeight - 8) top = rect.top - height - 8;
    element.style.top = `${clamp(top, 8, win.innerHeight - height - 8)}px`;
    element.style.left = `${clamp(rect.left + rect.width / 2 - width / 2, 8, win.innerWidth - width - 8)}px`;
  }
  function notify(message) {
    ensureUi();
    toast.textContent = message;
    toast.hidden = false;
    syncHost();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
      syncHost();
    }, 6000);
  }
  const inUi = () => !!root?.activeElement;
  // A new selection or highlight starts at the first action, not the last one focused.
  function resetTabs(element) {
    if (!element) return;
    for (const button of element.querySelectorAll('button')) button.tabIndex = -1;
    const first = element.querySelector('button');
    if (first) first.tabIndex = 0;
  }
  function hideToolbar() {
    if (toolbar) toolbar.hidden = true;
    resetTabs(toolbar);
    draft = null;
    syncHost();
  }
  function hidePopover() {
    resetTabs(popover);
    if (popover) popover.hidden = true;
    active = null;
    refocus();
    syncHost();
  }
  // The stronger color marks the popover's highlight, the one whose note is being edited,
  // and one just shown by a jump.
  function refocus() {
    focused.clear();
    for (const record of [flashing, active, noteTarget])
      if (record && records.get(record.highlight.id) === record)
        for (const range of record.ranges) focused.add(range);
  }
  function leaveUi() {
    if (!inUi()) return;
    const target = returnFocus;
    returnFocus = null;
    if (target?.isConnected && target !== doc.body) target.focus({ preventScroll: true });
    else root.activeElement.blur();
  }
  function dismiss() {
    const range = draft?.range;
    leaveUi();
    hideToolbar();
    hidePopover();
    // Escape keeps the selection without reopening the toolbar for it.
    dismissed = range || null;
    if (range && doc.getSelection()?.isCollapsed) doc.getSelection().addRange(range);
  }
  const sameRange = (a, b) =>
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset;
  function barKeys(event, element) {
    if (event.isComposing || event.keyCode === 229) return;
    const buttons = [...element.querySelectorAll('button')];
    const at = buttons.indexOf(root.activeElement);
    const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (move || event.key === 'Home' || event.key === 'End') {
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (at + move + buttons.length) % buttons.length;
      for (const button of buttons) button.tabIndex = -1;
      buttons[next].tabIndex = 0;
      buttons[next].focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') dismiss();
    else {
      // PDF.js reads Space as page down when focus is not in a visible button.
      if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
  function enterUi(element) {
    returnFocus = doc.activeElement;
    (element.querySelector('button[tabindex="0"]') || element.querySelector('button')).focus();
  }

  // Rendered text layers the selection touches, in page order.
  function selectedLayers(range) {
    const found = [];
    for (const div of doc.querySelectorAll('#viewer .page')) {
      const layer = div.querySelector('.textLayer');
      if (layer && range.intersectsNode(layer))
        found.push({ page: Number(div.dataset.pageNumber), layer });
    }
    return found;
  }
  function selectionRect(selection, range) {
    const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height);
    if (!rects.length) return range.getBoundingClientRect();
    const backward =
      selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
    return backward ? rects[0] : rects.at(-1);
  }
  const editing = () => app.pdfViewer.annotationEditorMode > 0;
  function editable(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return !!(
      element?.isContentEditable || element?.closest?.('input,textarea,select,[contenteditable]')
    );
  }
  function evaluateSelection() {
    if (inUi() || pointerDown) return;
    const selection = doc.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return hideToolbar();
    const range = selection.getRangeAt(0);
    if (dismissed && sameRange(dismissed, range)) return hideToolbar();
    dismissed = null;
    const inLayer = (node) =>
      !!(node.nodeType === 1 ? node : node.parentElement)?.closest('.textLayer');
    if (
      editing() ||
      !selection.toString().trim() ||
      !(inLayer(range.startContainer) || inLayer(range.endContainer))
    )
      return hideToolbar();
    hidePopover();
    ensureUi();
    draft = { range: range.cloneRange() };
    place(toolbar, selectionRect(selection, range));
    const layers = selectedLayers(range);
    if (layers.length) prefetch([layers[0], layers.at(-1)]);
  }
  function scheduleSelection(delay = 150) {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(evaluateSelection, delay);
  }

  // PDF user-space rects of the highlighted text, merged per line.
  function rectsOf(segments, indexes) {
    const rects = [];
    for (const segment of segments) {
      const view = app.pdfViewer.getPageView(segment.page - 1),
        range = indexes.get(segment.page)?.rangeFromOffsets(segment.start, segment.end);
      const div = view?.div;
      if (!range || !div) continue;
      // Viewport coordinates start inside the page border.
      const bounds = div.getBoundingClientRect(),
        left = bounds.left + div.clientLeft,
        top = bounds.top + div.clientTop;
      for (const r of [...range.getClientRects()].slice(0, 1000)) {
        if (!r.width || !r.height) continue;
        rects.push({
          page: segment.page,
          pdf: [
            ...view.viewport.convertToPdfPoint(r.left - left, r.top - top),
            ...view.viewport.convertToPdfPoint(r.right - left, r.bottom - top),
          ],
        });
      }
    }
    return anchors.mergeRects(rects);
  }
  // Synchronous: the toolbar click's user gesture must still be active when it sends.
  function describeSelection(range) {
    const layers = selectedLayers(range);
    if (!layers.length || layers.some((l, i) => i && l.page !== layers[i - 1].page + 1))
      return null;
    const indexes = new Map(layers.map(({ page, layer }) => [page, anchors.layerIndex(layer)]));
    const first = layers[0],
      last = layers.at(-1);
    const firstIndex = indexes.get(first.page),
      lastIndex = indexes.get(last.page);
    const start = first.layer.contains(range.startContainer)
      ? firstIndex.pointToOffset(range.startContainer, range.startOffset)
      : 0;
    const end = last.layer.contains(range.endContainer)
      ? lastIndex.pointToOffset(range.endContainer, range.endOffset)
      : lastIndex.text.length;
    if (start < 0 || end < 0) return null;
    const texts = layers.map(({ page }) => indexes.get(page).text);
    const described = anchors.describe(texts, first.page, start, end);
    if (!described) return null;
    const { anchor, segments } = described;
    if (anchor.quote.exact.length > limit) return { tooLong: true };
    anchor.rects = rectsOf(segments, indexes);
    prefetch(segments);
    return {
      anchor,
      segments,
      text: normalizeText(anchor.quote.exact),
      location: label(anchor.page, anchor.endPage || anchor.page),
    };
  }

  function act(action) {
    if (action === 'highlight' || action === 'ask') return void create(action === 'ask');
    if (action === 'comment') return void beginComment();
    if (!active) return;
    if (action === 'discuss') return void discuss(active);
    if (action === 'note') return void openEditor(active);
    if (action === 'delete') return void remove(active);
  }
  // The comment editor opens where the highlight is and keeps focus until saved or closed.
  function openEditor(record) {
    const rect = record.ranges?.[0]?.getBoundingClientRect();
    if (!rect) return;
    if (!inUi()) returnFocus = doc.activeElement;
    closeEditor(true);
    hidePopover();
    noteTarget = record;
    refocus();
    noteEditor.open({ note: record.highlight.note || '', text: record.highlight.text || '' });
    place(noteEditor.element, rect);
    noteEditor.focus();
  }
  function closeEditor(keepFocus = false) {
    pendingComment = null;
    if (!noteEditor?.visible) return;
    if (!keepFocus) leaveUi();
    noteEditor.hide();
    noteTarget = null;
    refocus();
    syncHost();
  }
  async function saveNote(note) {
    if (pendingComment) return saveComment(note);
    const record = noteTarget;
    if (!record?.highlight) return;
    // Nothing to remove: an empty comment on a highlight that has none is a cancel.
    if (!note && !record.highlight.note) {
      closeEditor();
      notify(t('highlightCommentEmpty'));
      return;
    }
    const response = await send({
      type: 'highlightNote',
      documentId,
      highlightId: record.highlight.id,
      note,
      title,
    });
    if (response.highlight) record.highlight = response.highlight;
    closeEditor();
    notify(t(note ? 'highlightNoteSaved' : 'highlightNoteRemoved'));
  }
  // One write stores the highlight and its comment. Cancel and an empty comment save nothing.
  // A pending comment is not stored as noteTarget: refocus reads record.highlight.id.
  async function saveComment(note) {
    const pending = pendingComment;
    if (!pending) return;
    if (!note) {
      closeEditor();
      notify(t('highlightCommentEmpty'));
      return;
    }
    const response = await send({
      type: 'highlightCreate',
      text: pending.text,
      anchor: pending.anchor,
      title,
      meta,
      location: pending.location,
      note,
    });
    if (!response.highlight)
      throw Object.assign(new Error(response.vaultError || 'The highlight could not be saved'), {
        code: response.code,
        ...(response.folder ? { folder: response.folder } : {}),
      });
    if (response.document?.id) documentId = response.document.id;
    if (response.document?.createdAt) onDocument?.();
    const id = response.highlight.id;
    const current = records.get(id);
    if (current?.highlight) current.highlight = response.highlight;
    else
      records.set(id, {
        highlight: response.highlight,
        segments: pending.segments,
        ranges: [],
        resolved: true,
      });
    doc.getSelection()?.removeAllRanges();
    closeEditor();
    notify(t('highlightNoteSaved'));
    repaint();
    report();
  }
  const sameSegments = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Comment does not paint a highlight until save. A passage already highlighted opens its editor.
  function beginComment() {
    if (!draft) return;
    const described = describeSelection(draft.range);
    const range = draft.range;
    const rect =
      [...range.getClientRects()].find((item) => item.width || item.height) ||
      range.getBoundingClientRect();
    if (!described) return hideToolbar();
    if (described.tooLong) {
      hideToolbar();
      return notify(t('highlightTooLong'));
    }
    const existing = [...records.values()].find(
      (record) => record.highlight && sameSegments(record.segments, described.segments),
    );
    if (existing) {
      doc.getSelection()?.removeAllRanges();
      hideToolbar();
      return openEditor(existing);
    }
    if (!inUi()) returnFocus = doc.activeElement;
    closeEditor(true);
    hidePopover();
    hideToolbar();
    pendingComment = described;
    noteEditor.open({ note: '', text: described.text, creating: true });
    place(noteEditor.element, rect);
    noteEditor.focus();
  }
  async function create(ask) {
    if (!draft) return;
    const described = describeSelection(draft.range);
    leaveUi();
    hideToolbar();
    if (!described) return;
    if (described.tooLong) return notify(t('highlightTooLong'));
    const { anchor, segments, text, location } = described;
    const existing = [...records.values()].find(
      (record) => record.highlight && sameSegments(record.segments, segments),
    );
    if (existing) {
      doc.getSelection()?.removeAllRanges();
      if (ask) await discuss(existing);
      return;
    }
    const request = send({
      type: 'highlightCreate',
      ask,
      text,
      anchor,
      title,
      meta,
      location,
      ...(ask ? { context: contextOf(segments) } : {}),
    });
    const pending = { id: `pending-${crypto.randomUUID()}`, segments, ranges: [] };
    records.set(pending.id, pending);
    doc.getSelection()?.removeAllRanges();
    repaint();
    try {
      const response = await request;
      records.delete(pending.id);
      if (response.highlight) {
        // A write returns the saved document; its ID replaces any provisional one.
        if (response.document?.id) documentId = response.document.id;
        if (response.document?.createdAt) onDocument?.();
        records.set(response.highlight.id, {
          highlight: response.highlight,
          segments,
          ranges: [],
          resolved: true,
        });
      }
      if (response.vaultError)
        notify(
          t(
            'highlightSaveFailed',
            shown({ code: response.code, message: response.vaultError, folder: response.folder }),
          ),
        );
      else if (ask && response.panelOpened === false) notify(t('highlightOpenPanel'));
    } catch (error) {
      records.delete(pending.id);
      notify(t(ask ? 'highlightAskFailed' : 'highlightSaveFailed', shown(error)));
    }
    repaint();
    report();
  }
  async function discuss(record) {
    const request = send({
      type: 'highlightAsk',
      documentId,
      highlightId: record.highlight.id,
      title,
      context: contextOf(record.segments),
    });
    leaveUi();
    hidePopover();
    try {
      const response = await request;
      if (response.panelOpened === false) notify(t('highlightOpenPanel'));
    } catch (error) {
      notify(t('highlightAskFailed', shown(error)));
    }
  }
  async function remove(record) {
    leaveUi();
    hidePopover();
    try {
      await send({
        type: 'highlightDelete',
        documentId,
        highlightId: record.highlight.id,
        title,
      });
    } catch (error) {
      // Already deleted elsewhere (another tab or the vault itself).
      if (error.code !== 'not_found') return void notify(t('highlightDeleteFailed', shown(error)));
    }
    records.delete(record.highlight.id);
    if (noteTarget === record) closeEditor();
    repaint();
    report();
  }

  function hit(x, y) {
    let found = null;
    for (const record of records.values()) {
      if (!record.highlight) continue;
      for (const range of record.ranges || []) {
        const rect = [...range.getClientRects()].find(
          (r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1,
        );
        if (rect) found = { record, rect };
      }
    }
    return found;
  }
  function showPopover(record, rect) {
    ensureUi();
    hideToolbar();
    active = record;
    refocus();
    popover.querySelector('[data-action="discuss"]').textContent =
      record.highlight.turnCount > 0 ? t('highlightOpen') : t('highlightAsk');
    popover.querySelector('[data-action="note"]').textContent = t(
      record.highlight.note ? 'highlightNoteEdit' : 'highlightNoteAdd',
    );
    notePreview.show(record.highlight.note);
    place(popover, rect);
  }

  let reported = '',
    restoring = 0;
  // Saved highlights still being restored are not reported as unanchored.
  function report() {
    if (restoring) return;
    const saved = [...records.values()].filter((record) => record.highlight);
    const unanchored = saved.filter((record) => !record.segments).map((r) => r.highlight.id);
    const status = {
      type: 'highlightStatus',
      documentId,
      anchored: saved.length - unanchored.length,
      unanchored,
    };
    const key = JSON.stringify(status);
    if (key === reported) return;
    reported = key;
    send(status).catch(() => {});
  }

  // Unconfident anchors stay unpainted and are reported as unanchored.
  async function anchorAll() {
    restoring++;
    try {
      for (const record of [...records.values()]) {
        if (!record.highlight || record.resolved) continue;
        const match = await anchors.resolve(record.highlight.anchor, pages).catch(() => null);
        record.segments = match?.segments || null;
        record.method = match?.method;
        record.resolved = true;
        prefetch(record.segments);
        scheduleRepaint();
      }
    } finally {
      restoring--;
    }
    repaint();
    report();
  }
  let attempts = 0;
  async function load() {
    let response;
    try {
      response = await send({ type: 'highlightResolve', title, meta });
    } catch (error) {
      // A connector that is starting may need a moment; a missing one does not retry.
      if (error.code !== 'host_missing' && ++attempts <= 3) setTimeout(load, 2000 * attempts);
      return;
    }
    attempts = 0;
    // An unsaved document has a provisional ID (createdAt null) that may still change.
    documentId = response.document?.createdAt ? response.document.id : null;
    if (documentId) onDocument?.();
    // A refresh keeps restored highlights (and an open popover) whose anchor is unchanged.
    const previous = records;
    records = new Map();
    for (const highlight of response.highlights || []) {
      if (!highlight?.id || !highlight.anchor) continue;
      const old = previous.get(highlight.id);
      records.set(
        highlight.id,
        old?.resolved && JSON.stringify(old.highlight.anchor) === JSON.stringify(highlight.anchor)
          ? Object.assign(old, { highlight })
          : { highlight, segments: null, ranges: [] },
      );
    }
    for (const [id, record] of previous) if (!record.highlight) records.set(id, record);
    await anchorAll();
    const target = /^#tabgent-highlight=(h\d{3,9})$/.exec(location.hash)?.[1];
    const record = target && records.get(target);
    if (record?.segments?.length) void reveal(record);
  }

  // The service worker asks about this viewer's highlights (reading-companion.js): reload
  // after a saved turn, nearby text for a discussion, and showing one in the document.
  async function reveal(record) {
    if (!record.ranges?.length) {
      app.pdfViewer.scrollPageIntoView({ pageNumber: record.segments[0].page });
      for (let i = 0; i < 60 && !record.ranges?.length; i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const node = record.ranges?.[0]?.startContainer;
    if (!node) return;
    (node.nodeType === 1 ? node : node.parentElement)?.scrollIntoView({
      block: 'center',
      behavior: 'smooth',
    });
    clearTimeout(flashTimer);
    flashing = record;
    repaint();
    flashTimer = setTimeout(() => {
      flashing = null;
      repaint();
    }, 1600);
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      sender.url !== chrome.runtime.getURL('background.js') ||
      message?.type !== 'tabgentHighlight'
    )
      return;
    if (message.action === 'refresh') return void load();
    const record = records.get(message.highlightId);
    if (message.action === 'context') reply(record?.segments ? contextOf(record.segments) : null);
    if (message.action === 'jump') {
      if (!record?.segments) return void reply({ found: false });
      void reveal(record);
      reply({ found: true });
    }
  });

  const options = { capture: true };
  doc.addEventListener(
    'pointerdown',
    (event) => {
      if (event.composedPath().includes(host)) return;
      pointerDown = true;
      hidePopover();
      // A note with unsaved text stays open; Cancel or Escape discards it.
      if (!noteEditor?.changed) closeEditor();
    },
    options,
  );
  doc.addEventListener(
    'pointerup',
    (event) => {
      pointerDown = false;
      if (!event.composedPath().includes(host)) scheduleSelection(10);
    },
    options,
  );
  doc.addEventListener('pointercancel', () => (pointerDown = false), options);
  win.addEventListener('blur', () => (pointerDown = false));
  doc.addEventListener('selectionchange', () => scheduleSelection());
  doc.addEventListener(
    'click',
    (event) => {
      if (
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        editing() ||
        event.composedPath().includes(host) ||
        !doc.getSelection()?.isCollapsed ||
        event.target.closest?.('a[href],button,input,select,textarea,[contenteditable]')
      )
        return;
      const found = hit(event.clientX, event.clientY);
      if (found) showPopover(found.record, found.rect);
    },
    options,
  );
  win.addEventListener(
    'keydown',
    (event) => {
      if (event.target === host) return;
      const open = [toolbar, popover].find((element) => element && !element.hidden);
      if (!open) return;
      // Escape also reaches PDF.js, for example to close the find bar.
      if (event.key === 'Escape') dismiss();
      else if (
        event.key === 'Tab' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !editable(doc.activeElement)
      ) {
        // The visible toolbar is the next stop after the selection.
        event.preventDefault();
        event.stopPropagation();
        enterUi(open);
      }
    },
    options,
  );
  const hideOnMove = () => {
    if (inUi()) return;
    hideToolbar();
    hidePopover();
    if (!noteEditor?.changed) closeEditor();
  };
  doc.addEventListener('scroll', hideOnMove, { capture: true, passive: true });
  win.addEventListener('resize', hideOnMove);
  for (const name of ['scalechanging', 'rotationchanging']) app.eventBus.on(name, hideOnMove);
  // Text layers are attached once rendered, removed with far-away pages, and split into
  // new text nodes by find-bar matches.
  app.eventBus.on('textlayerrendered', () => records.size && scheduleRepaint());
  new win.MutationObserver((mutations) => {
    if (
      records.size &&
      mutations.some((m) =>
        (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest('.textLayer'),
      )
    )
      scheduleRepaint();
  }).observe(doc.getElementById('viewer'), { childList: true, subtree: true, characterData: true });
  await load();
}
