// Webpage reading layer: selection toolbar, saved highlights, and highlight actions.
// Highlights paint through the CSS Custom Highlight API; page markup is never wrapped.
(() => {
  if (globalThis.tabgentHighlightsInstalled || window.top !== window || !globalThis.CSS?.highlights)
    return;
  // A file from the computer gets the reading layer when Chrome shows it as a text document
  // (Markdown, plain text or HTML). A PDF there opens in Tabgent's viewer instead.
  if (
    location.protocol === 'file:' &&
    !/^(?:text\/|application\/(?:xhtml\+xml|xml|json)$)/.test(document.contentType)
  )
    return;
  globalThis.tabgentHighlightsInstalled = true;
  const anchors = globalThis.tabgentWebAnchor,
    notes = globalThis.tabgentHighlightNote;
  const t = (key, ...values) => chrome.i18n.getMessage(key, values.map(String)) || key;
  const shown = (error) => globalThis.tabgentExplainError?.(error, t) || t('errorGeneric');
  const paint = new Highlight(),
    focused = new Highlight();
  focused.priority = 1;
  CSS.highlights.set('tabgent-highlight', paint);
  CSS.highlights.set('tabgent-highlight-active', focused);
  const listeners = new AbortController(),
    signal = listeners.signal;
  const limit = 20000;
  let page = null,
    records = new Map(),
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
    returnFocus = null,
    pointerDown = false,
    lastInput = 'pointer',
    selectionTimer,
    toastTimer;

  // Tabgent's clipped-page reader sets this before loading the layer: the page's address,
  // the element that holds the text, its title and metadata, and the view anchors belong to.
  // On webpages it is unset.
  const view = globalThis.tabgentReadingView || null;
  const pageUrl = () => (view ? view.url : location.href.split('#')[0]);
  const pageTitle = () => (view ? view.title : document.title);
  const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
  const strip = (value) => value.replace(/[\s\u00ad\u200b-\u200d\ufeff]+/g, '');
  // Live DOM text of a range, including script/style text the index skips. Mutation passes
  // compare it with the value captured when the range was assigned, never with index text.
  const liveText = (range) => (range ? strip(range.toString()) : undefined);
  const index = () =>
    anchors.buildIndex(view?.root || document.body || document.documentElement, host);

  async function send(message) {
    let response;
    try {
      response = await chrome.runtime.sendMessage(message);
    } catch (error) {
      // The extension was reloaded or removed; this copy of the script is orphaned.
      if (!chrome.runtime?.id) teardown();
      throw error;
    }
    if (!response) throw Error('No response');
    if (response.error)
      throw Object.assign(Error(response.error), {
        code: response.code,
        ...(response.folder ? { folder: response.folder } : {}),
      });
    return response;
  }

  function pageMeta() {
    if (view) return view.meta || {};
    const content = (selector) =>
      document.querySelector(selector)?.getAttribute('content')?.trim() || '';
    return {
      author: content('meta[name="author"]') || content('meta[property="article:author"]'),
      siteName: content('meta[property="og:site_name"]'),
      publishedAt:
        content('meta[property="article:published_time"]') || content('meta[name="date"]'),
    };
  }
  // A human-readable location: the closest heading before the highlight.
  function sectionLabel(range) {
    let label = '';
    const headings = (view?.root || document).querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (const heading of [...headings].slice(0, 2000)) {
      if (range.comparePoint(heading, 0) > 0) break;
      label = heading.textContent.replace(/\s+/g, ' ').trim() || label;
    }
    return label.slice(0, 200);
  }

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
    button:disabled { opacity: 0.5; cursor: default; }
    .swatch { width: 10px; height: 10px; border-radius: 3px; background: rgb(255 214 102); }
    .toast { position: fixed; right: 16px; bottom: 16px; max-width: min(360px, calc(100vw - 32px));
      padding: 10px 12px; border-radius: 10px; background: #202124; color: #fff;
      font: 13px/1.4 system-ui, -apple-system, sans-serif; box-shadow: 0 6px 20px rgb(0 0 0 / 0.25); }`;

  function ensureUi() {
    if (host?.isConnected) return;
    host = document.createElement('tabgent-reader');
    // Inline !important styles keep page CSS from moving or revealing the host.
    for (const [name, value] of [
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
      host.style.setProperty(name, value, 'important');
    host.popover = 'manual';
    root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(styles + notes.styles);
    root.adoptedStyleSheets = [sheet];
    toolbar = bar(t('highlightToolbar'), [
      ['highlight', t('highlightAdd'), true],
      ['ask', t('highlightAsk')],
    ]);
    popover = bar(t('highlightActions'), [
      ['discuss', t('highlightAsk')],
      ['note', t('highlightNoteAdd')],
      ['delete', t('highlightDelete')],
    ]);
    // Clicking a highlight shows the user's note above its actions.
    notePreview = notes.preview(document, t);
    popover.classList.add('card');
    popover.prepend(notePreview);
    popover.setAttribute('aria-describedby', notePreview.id);
    noteEditor = notes.editor(document, t, { save: saveNote, close: closeEditor });
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.hidden = true;
    root.append(toolbar, popover, noteEditor.element, toast);
    document.documentElement.append(host);
  }
  function bar(label, actions) {
    const element = document.createElement('div');
    element.className = 'bar';
    element.setAttribute('role', 'toolbar');
    element.setAttribute('aria-label', label);
    element.hidden = true;
    for (const [action, text, swatch] of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = action;
      if (swatch) {
        const mark = document.createElement('span');
        mark.className = 'swatch';
        mark.setAttribute('aria-hidden', 'true');
        button.append(mark);
      }
      button.append(text);
      button.tabIndex = -1;
      element.append(button);
    }
    element.querySelector('button').tabIndex = 0;
    // Keep the page selection while the toolbar is clicked.
    element.addEventListener('pointerdown', (event) => event.preventDefault());
    element.addEventListener('mousedown', (event) => event.preventDefault());
    element.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button && !button.disabled) act(button.dataset.action);
    });
    element.addEventListener('keydown', (event) => barKeys(event, element));
    return element;
  }
  function syncHost() {
    const open = [toolbar, popover, noteEditor?.element, toast].some(
      (element) => element && !element.hidden,
    );
    if (!host?.isConnected) return;
    if (open && !host.matches(':popover-open')) host.showPopover();
    if (!open && host.matches(':popover-open')) host.hidePopover();
  }
  function place(element, rect) {
    element.hidden = false;
    syncHost();
    const width = element.offsetWidth,
      height = element.offsetHeight;
    let top = rect.bottom + 8;
    if (top + height > innerHeight - 8) top = rect.top - height - 8;
    element.style.top = `${clamp(top, 8, innerHeight - height - 8)}px`;
    element.style.left = `${clamp(rect.left + rect.width / 2 - width / 2, 8, innerWidth - width - 8)}px`;
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
  function hideToolbar() {
    if (toolbar) toolbar.hidden = true;
    draft = null;
    syncHost();
  }
  function hidePopover() {
    if (popover) popover.hidden = true;
    active = null;
    focused.clear();
    if (noteTarget?.range) focused.add(noteTarget.range);
    syncHost();
  }
  function leaveUi() {
    if (!inUi()) return;
    const target = returnFocus;
    returnFocus = null;
    if (target?.isConnected && target !== document.body) target.focus({ preventScroll: true });
    else root.activeElement.blur();
  }
  function dismiss() {
    const range = draft?.range;
    leaveUi();
    hideToolbar();
    hidePopover();
    // Escape keeps (or returns to) the same selection without reopening the toolbar.
    dismissed = range || null;
    if (range && getSelection()?.isCollapsed) getSelection().addRange(range);
  }
  const sameRange = (a, b) =>
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset;
  function barKeys(event, element) {
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
    else return;
    event.preventDefault();
    event.stopPropagation();
  }
  function enterUi(element) {
    returnFocus = document.activeElement;
    (element.querySelector('button[tabindex="0"]') || element.querySelector('button')).focus();
  }

  function editable(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return !!(
      element?.isContentEditable || element?.closest?.('input,textarea,select,[contenteditable]')
    );
  }
  function selectionRect(selection, range) {
    const rects = [...range.getClientRects()].filter((rect) => rect.width || rect.height);
    if (!rects.length) return range.getBoundingClientRect();
    const backward =
      selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
    return backward ? rects[0] : rects.at(-1);
  }
  function evaluateSelection() {
    if (inUi() || pointerDown) return;
    const selection = getSelection();
    if (!selection?.rangeCount) return hideToolbar();
    const range = selection.getRangeAt(0);
    if (selection.isCollapsed) {
      hideToolbar();
      // Caret browsing onto a highlight offers the same actions as a click.
      if (lastInput === 'keyboard') {
        const record = hitPoint(range.startContainer, range.startOffset);
        if (record) showPopover(record, firstRect(record.range));
      }
      return;
    }
    const text = selection.toString();
    if (dismissed && sameRange(dismissed, range)) return hideToolbar();
    dismissed = null;
    if (
      !text.trim() ||
      editable(range.commonAncestorContainer) ||
      editable(document.activeElement) ||
      !document.body?.contains(range.commonAncestorContainer)
    )
      return hideToolbar();
    hidePopover();
    ensureUi();
    draft = { range: range.cloneRange(), text };
    place(toolbar, selectionRect(selection, range));
  }
  function scheduleSelection(delay = 150) {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(evaluateSelection, delay);
  }

  function firstRect(range) {
    return (
      [...range.getClientRects()].find((rect) => rect.width && rect.height) ||
      range.getBoundingClientRect()
    );
  }
  function hitPoint(node, offset) {
    let found = null;
    for (const record of records.values()) {
      try {
        if (record.highlight && record.range?.isPointInRange(node, offset)) found = record;
      } catch {}
    }
    return found;
  }
  // Custom highlights receive no events: hit-test the caret, then confirm with line boxes.
  function hit(x, y) {
    const caret = document.caretPositionFromPoint?.(x, y);
    const legacy = caret ? null : document.caretRangeFromPoint?.(x, y);
    const node = caret ? caret.offsetNode : legacy?.startContainer;
    const offset = caret ? caret.offset : legacy?.startOffset;
    if (!node) return null;
    let found = null;
    for (const record of records.values()) {
      if (!record.highlight || !record.range) continue;
      try {
        if (!record.range.isPointInRange(node, offset)) continue;
      } catch {
        continue;
      }
      const rect = [...record.range.getClientRects()].find(
        (r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1,
      );
      if (rect) found = { record, rect };
    }
    return found;
  }
  function showPopover(record, rect) {
    ensureUi();
    hideToolbar();
    active = record;
    focused.clear();
    focused.add(record.range);
    const discuss = popover.querySelector('[data-action="discuss"]');
    discuss.textContent = record.highlight.turnCount > 0 ? t('highlightOpen') : t('highlightAsk');
    popover.querySelector('[data-action="note"]').textContent = t(
      record.highlight.note ? 'highlightNoteEdit' : 'highlightNoteAdd',
    );
    notePreview.show(record.highlight.note);
    place(popover, rect);
  }

  // The note editor opens where the highlight is and keeps focus until saved or closed.
  function openEditor(record) {
    if (!record.range) return;
    if (!inUi()) returnFocus = document.activeElement;
    closeEditor(true);
    hidePopover();
    noteTarget = record;
    focused.add(record.range);
    noteEditor.open({ note: record.highlight.note || '', text: record.highlight.text || '' });
    place(noteEditor.element, firstRect(record.range));
    noteEditor.focus();
  }
  function closeEditor(keepFocus = false) {
    if (!noteEditor?.visible) return;
    if (!keepFocus) leaveUi();
    noteEditor.hide();
    noteTarget = null;
    focused.clear();
    if (active?.range) focused.add(active.range);
    syncHost();
  }
  async function saveNote(note) {
    const record = noteTarget;
    if (!record?.highlight) return;
    const response = await send({
      type: 'highlightNote',
      documentId: page?.documentId,
      highlightId: record.highlight.id,
      note,
      title: pageTitle(),
    });
    if (response.highlight) record.highlight = response.highlight;
    closeEditor();
    notify(t(note ? 'highlightNoteSaved' : 'highlightNoteRemoved'));
  }

  function act(action) {
    if (action === 'highlight' || action === 'ask') return void create(action === 'ask');
    if (!active) return;
    if (action === 'discuss') return void discuss(active);
    if (action === 'note') return void openEditor(active);
    if (action === 'delete') return void remove(active);
  }
  function findRecord(start, end) {
    for (const record of records.values())
      if (record.highlight && record.start === start && record.end === end) return record;
    return null;
  }
  // Runs synchronously up to sendMessage so the click still counts as a user gesture.
  async function create(ask) {
    if (!draft) return;
    const { range, text } = draft;
    const textIndex = index();
    const anchor = anchors.describe(range, textIndex);
    leaveUi();
    hideToolbar();
    if (!anchor) return;
    const { start, end } = anchor.position;
    if (end - start > limit || text.length > limit * 2) return notify(t('highlightTooLong'));
    const existing = findRecord(start, end);
    if (existing) {
      getSelection()?.removeAllRanges();
      if (ask) await discuss(existing, textIndex);
      return;
    }
    const exactRange = textIndex.rangeFromOffsets(start, end);
    if (!exactRange) return;
    const url = page?.url;
    const request = send({
      type: 'highlightCreate',
      ask,
      text: text.trim().slice(0, limit),
      anchor,
      title: pageTitle(),
      meta: pageMeta(),
      location: sectionLabel(exactRange),
      ...(ask ? { context: anchors.context(textIndex, start, end) } : {}),
    });
    const pending = { id: `pending-${crypto.randomUUID()}`, range: exactRange, start, end };
    records.set(pending.id, pending);
    getSelection()?.removeAllRanges();
    repaint();
    try {
      const response = await request;
      records.delete(pending.id);
      if (response.highlight && page?.url === url) {
        // A write returns the saved document; its ID replaces any provisional one.
        if (response.document?.id) page.documentId = response.document.id;
        records.set(response.highlight.id, {
          highlight: response.highlight,
          range: exactRange,
          start,
          end,
          text: textIndex.text.slice(start, end),
          live: liveText(exactRange),
        });
        observe();
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
  async function discuss(record, textIndex = index()) {
    const offsets = record.range && textIndex.offsetsOfRange(record.range);
    const context = offsets
      ? anchors.context(textIndex, offsets.start, offsets.end)
      : { before: '', after: '' };
    const request = send({
      type: 'highlightAsk',
      documentId: page?.documentId,
      highlightId: record.highlight.id,
      title: pageTitle(),
      context,
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
        documentId: page?.documentId,
        highlightId: record.highlight.id,
        title: pageTitle(),
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

  function repaint() {
    paint.clear();
    for (const record of records.values())
      if (record.range && !record.range.collapsed) paint.add(record.range);
    focused.clear();
    for (const record of [active, noteTarget])
      if (record?.range && records.has(record.highlight?.id)) focused.add(record.range);
  }
  let reported = '';
  function report() {
    if (!page) return;
    const saved = [...records.values()].filter((record) => record.highlight);
    const unanchored = saved.filter((record) => !record.range).map((r) => r.highlight.id);
    const status = {
      type: 'highlightStatus',
      documentId: page.documentId,
      anchored: saved.length - unanchored.length,
      unanchored,
    };
    const key = JSON.stringify([page.url, status]);
    if (key === reported) return;
    reported = key;
    send(status).catch(() => {});
  }

  // Restores every saved highlight against one fresh text index.
  let lastPass = 0,
    lastCost = 0,
    retries = 0,
    passTimer = null,
    observer = null;
  function anchorAll() {
    const started = performance.now();
    const textIndex = index();
    for (const record of records.values()) {
      if (!record.highlight) continue;
      if (record.range && record.text !== undefined) {
        const offsets = textIndex.offsetsOfRange(record.range);
        if (offsets && textIndex.text.slice(offsets.start, offsets.end) === record.text) {
          Object.assign(record, offsets, { live: liveText(record.range) });
          continue;
        }
      }
      const match = anchors.resolve(record.highlight.anchor, textIndex, {
        view: view?.name || 'page',
      });
      record.range = match?.range || null;
      record.method = match?.method;
      record.start = match?.start;
      record.end = match?.end;
      record.text = match ? textIndex.text.slice(match.start, match.end) : undefined;
      record.live = liveText(record.range);
    }
    lastCost = performance.now() - started;
    lastPass = Date.now();
    if (active && !active.range) hidePopover();
    repaint();
    report();
  }
  // Late or replaced content triggers bounded re-anchoring, throttled by the last pass cost.
  function schedulePass() {
    if (passTimer) return;
    const interval = Math.max(1000, lastCost * 20) * (retries > 20 ? 5 : 1);
    passTimer = setTimeout(
      () => {
        passTimer = null;
        pass();
      },
      Math.max(400, lastPass + interval - Date.now()),
    );
  }
  function pass() {
    if (!page) return;
    if (pageUrl() !== page.url) return void load();
    const saved = [...records.values()].filter((record) => record.highlight);
    const broken = saved.some((record) => record.range && liveText(record.range) !== record.live);
    const missing = saved.some((record) => !record.range);
    if (!broken && (!missing || retries >= 100)) return;
    if (!broken) retries++;
    anchorAll();
  }
  function observe() {
    if (observer || !records.size) return;
    observer = new MutationObserver((mutations) => {
      if (mutations.every((m) => m.target === host || [...m.addedNodes].includes(host))) return;
      schedulePass();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  let loading = 0,
    loadAttempts = 0;
  async function load() {
    const url = pageUrl(),
      generation = ++loading;
    observer?.disconnect();
    observer = null;
    clearTimeout(passTimer);
    passTimer = null;
    retries = 0;
    page = { url, documentId: null };
    records = new Map();
    closeEditor();
    hideToolbar();
    hidePopover();
    repaint();
    let response;
    try {
      response = await send({ type: 'highlightResolve', title: pageTitle(), meta: pageMeta() });
    } catch (error) {
      // A connector that is starting may need a moment; a missing one does not retry.
      if (generation === loading && error.code !== 'host_missing' && ++loadAttempts <= 3)
        setTimeout(() => generation === loading && load(), 2000 * loadAttempts);
      return;
    }
    if (generation !== loading) return;
    if (pageUrl() !== url || response.url !== url) {
      if (++loadAttempts <= 3) setTimeout(() => generation === loading && load(), 500);
      return;
    }
    loadAttempts = 0;
    // An unsaved page has a provisional document (createdAt null) that may be renamed.
    page.documentId = response.document?.createdAt ? response.document.id : null;
    for (const highlight of response.highlights || [])
      if (highlight?.id && highlight.anchor) records.set(highlight.id, { highlight, range: null });
    anchorAll();
    observe();
  }
  function checkUrl() {
    if (page && pageUrl() !== page.url) void load();
  }

  function teardown() {
    listeners.abort();
    observer?.disconnect();
    clearTimeout(passTimer);
    CSS.highlights.delete('tabgent-highlight');
    CSS.highlights.delete('tabgent-highlight-active');
    host?.remove();
  }

  const options = { capture: true, signal };
  document.addEventListener(
    'pointerdown',
    (event) => {
      lastInput = 'pointer';
      if (event.composedPath().includes(host)) return;
      pointerDown = true;
      hidePopover();
      // A note with unsaved text stays open; Cancel or Escape discards it.
      if (!noteEditor?.changed) closeEditor();
    },
    options,
  );
  document.addEventListener(
    'pointerup',
    (event) => {
      pointerDown = false;
      if (!event.composedPath().includes(host)) scheduleSelection(10);
    },
    options,
  );
  document.addEventListener('pointercancel', () => (pointerDown = false), options);
  window.addEventListener('blur', () => (pointerDown = false), { signal });
  document.addEventListener('selectionchange', () => scheduleSelection(), { signal });
  document.addEventListener(
    'click',
    (event) => {
      if (
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.composedPath().includes(host) ||
        !getSelection()?.isCollapsed ||
        event.target.closest?.(
          'a[href],button,input,select,textarea,label,summary,[contenteditable],[role="button"],[role="link"]',
        )
      )
        return;
      const found = hit(event.clientX, event.clientY);
      if (found) showPopover(found.record, found.rect);
    },
    options,
  );
  window.addEventListener(
    'keydown',
    (event) => {
      lastInput = 'keyboard';
      if (event.target === host) return;
      const open = [toolbar, popover].find((element) => element && !element.hidden);
      if (!open) return;
      if (event.key === 'Escape') dismiss();
      else if (
        event.key === 'Tab' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !editable(document.activeElement)
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
  document.addEventListener('scroll', hideOnMove, { capture: true, passive: true, signal });
  window.addEventListener('resize', hideOnMove, { signal });
  window.addEventListener('popstate', checkUrl, { signal });
  globalThis.navigation?.addEventListener('currententrychange', checkUrl, { signal });
  // Saved discussion turns change a highlight's popover action (Ask AI / Open discussion).
  async function refresh() {
    const url = page?.url;
    if (!url) return;
    try {
      const response = await send({
        type: 'highlightResolve',
        title: pageTitle(),
        meta: pageMeta(),
      });
      if (page?.url !== url || response.url !== url) return;
      page.documentId ||= response.document?.createdAt ? response.document.id : null;
      for (const highlight of response.highlights || []) {
        const record = records.get(highlight.id);
        if (record?.highlight) record.highlight = highlight;
      }
    } catch {}
  }
  // Side panel actions arrive through the service worker, never from page scripts.
  let flash;
  function onExtensionMessage(message, sender, reply) {
    if (sender.id !== chrome.runtime.id || sender.tab || message?.type !== 'tabgentHighlight')
      return;
    if (message.action === 'refresh') return void refresh();
    const record = records.get(message.highlightId);
    if (message.action === 'context') {
      const textIndex = index();
      const offsets = record?.range && textIndex.offsetsOfRange(record.range);
      reply(offsets ? anchors.context(textIndex, offsets.start, offsets.end) : null);
    }
    if (message.action === 'jump') {
      if (!record?.range) return void reply({ found: false });
      const node = record.range.startContainer;
      (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
      clearTimeout(flash);
      focused.clear();
      focused.add(record.range);
      flash = setTimeout(repaint, 1600);
      reply({ found: true });
    }
  }
  chrome.runtime.onMessage.addListener(onExtensionMessage);
  signal.addEventListener('abort', () =>
    chrome.runtime.onMessage.removeListener(onExtensionMessage),
  );
  // A prerendered document is not the primary frame yet, so the worker would reject it.
  if (document.prerendering)
    document.addEventListener('prerenderingchange', () => void load(), { once: true, signal });
  else void load();
})();
