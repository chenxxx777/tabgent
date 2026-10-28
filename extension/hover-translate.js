// Hover translation: when the selected text is English and the pointer rests on it, a small
// card beside the selection shows its Simplified Chinese translation from Codex, streamed as
// it arrives. Shared by the webpage reading layer (also in the clipped-page and feed reader),
// the PDF.js viewer and the EPUB reader. The card has its own closed shadow root on a
// top-layer popover host, like the selection toolbar, and never covers that toolbar.
// Loaded as a content script and imported by extension pages; it only sets a global.
(() => {
  if (globalThis.tabgentHoverTranslate) return;
  const lifecycle = globalThis.tabgentContentLifecycle;
  const LIMIT = 2000;
  const KEY = 'hoverTranslate';
  const DEFAULTS = Object.freeze({ enabled: true, delay: 1000 });
  const DELAYS = [500, 1000, 1500, 2000, 3000];
  const PORT = 'tabgent-translate';
  const LEAVE_MS = 300;
  const STALL_MS = 75000;

  const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
  const settingsOf = (value) => ({
    enabled: value?.enabled !== false,
    delay: Number.isFinite(value?.delay) ? clamp(Math.round(value.delay), 300, 5000) : 1000,
  });

  // A local rule, no language service: mostly Latin letters, nearly all of them unaccented,
  // and almost no Chinese, Japanese or Korean characters.
  function isEnglish(text) {
    const sample = String(text || '').slice(0, LIMIT);
    let letters = 0,
      latin = 0,
      ascii = 0,
      cjk = 0;
    for (const char of sample) {
      if (!/\p{L}/u.test(char)) continue;
      letters++;
      if (/[A-Za-z]/.test(char)) {
        ascii++;
        latin++;
      } else if (/\p{Script=Latin}/u.test(char)) latin++;
      else if (
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
      )
        cjk++;
    }
    if (letters < 2 || ascii < 2) return false;
    return cjk / letters < 0.05 && latin / letters >= 0.9 && ascii / latin >= 0.9;
  }

  // Selected text as Codex receives it: spaces collapsed, at most one blank line, and text
  // past the limit cut at a sentence or word boundary near it. joinLines (PDF text, where
  // every line ends with a break) makes single line breaks spaces and joins words split
  // by a line-end hyphen.
  function prepare(text, { joinLines = false } = {}) {
    const source = String(text || '');
    const raw = source.slice(0, LIMIT * 3);
    let clean = raw
      .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v\u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n');
    if (joinLines)
      clean = clean
        .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
        .replace(/(?<!\n)\n(?!\n)/g, ' ')
        .replace(/ {2,}/g, ' ');
    clean = clean.trim();
    let truncated = raw.length < source.length;
    if (clean.length > LIMIT) {
      truncated = true;
      let cut = clean.slice(0, LIMIT);
      const sentence = Math.max(
        ...['. ', '? ', '! ', '.\n', '?\n', '!\n', '\n\n'].map((end) => cut.lastIndexOf(end)),
      );
      if (sentence > LIMIT * 0.8) cut = cut.slice(0, sentence + 1);
      else if (cut.lastIndexOf(' ') > LIMIT * 0.9) cut = cut.slice(0, cut.lastIndexOf(' '));
      clean = cut.trim();
    }
    return { text: clean, truncated };
  }

  // A small least-recently-used cache of finished translations, by prepared text.
  function createCache(limit = 50) {
    const map = new Map();
    return {
      get(key) {
        if (!map.has(key)) return undefined;
        const value = map.get(key);
        map.delete(key);
        map.set(key, value);
        return value;
      },
      set(key, value) {
        map.delete(key);
        map.set(key, value);
        while (map.size > limit) map.delete(map.keys().next().value);
      },
      delete: (key) => map.delete(key),
      get size() {
        return map.size;
      },
    };
  }

  // The pointer must rest: a point on the selection starts the wait, a move of more than a
  // few pixels starts it again, and leaving the selection (null) stops it.
  function createDwell({ delay, fire, timers = globalThis, tolerance = 4 }) {
    let anchor = null,
      timer = null;
    function stop() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      anchor = null;
    }
    return {
      update(point) {
        if (!point) return stop();
        if (anchor && Math.hypot(point.x - anchor.x, point.y - anchor.y) <= tolerance) return;
        if (timer !== null) timers.clearTimeout(timer);
        anchor = { x: point.x, y: point.y };
        timer = timers.setTimeout(() => {
          timer = null;
          anchor = null;
          fire();
        }, delay());
      },
      stop,
      get waiting() {
        return timer !== null;
      },
    };
  }

  // Requests over one runtime port per document; the service worker relays them to the
  // connector. translate() returns a function that cancels the request.
  function createClient(
    connect = () => {
      if (lifecycle ? !lifecycle.check() : !globalThis.chrome?.runtime?.id)
        throw Error('Extension context invalidated');
      return chrome.runtime.connect({ name: PORT });
    },
  ) {
    let port = null,
      sequence = 0,
      suspended = false,
      destroyed = false;
    const pending = new Map();
    function finish() {
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) entry.onError?.({ code: 'disconnected' });
    }
    function close() {
      const previous = port;
      port = null;
      finish();
      try {
        previous?.disconnect();
      } catch {}
    }
    function open() {
      if (suspended || destroyed) throw Error('Translation client is inactive');
      if (port) return port;
      const opened = connect();
      opened.onMessage.addListener((message) => {
        const entry = pending.get(message?.id);
        if (!entry) return;
        if (typeof message.delta === 'string') return void entry.onDelta?.(message.delta);
        pending.delete(message.id);
        if (message.error) entry.onError?.(message.error);
        else entry.onDone?.(typeof message.text === 'string' ? message.text : '');
      });
      opened.onDisconnect.addListener(() => {
        void globalThis.chrome?.runtime?.lastError;
        if (port !== opened) return;
        port = null;
        finish();
      });
      port = opened;
      return port;
    }
    const client = {
      warm() {
        try {
          open().postMessage({ type: 'warm' });
        } catch {}
      },
      translate(text, handlers = {}) {
        const id = `t${++sequence}`;
        pending.set(id, handlers);
        try {
          open().postMessage({ type: 'translate', id, text });
        } catch {
          // The extension was reloaded: this copy of the page script is orphaned.
          pending.delete(id);
          handlers.onError?.({ code: 'disconnected' });
          return () => {};
        }
        return () => {
          if (!pending.delete(id)) return;
          try {
            port?.postMessage({ type: 'cancel', id });
          } catch {}
        };
      },
      get size() {
        return pending.size;
      },
      suspend() {
        suspended = true;
        close();
      },
      resume() {
        suspended = false;
        if (!destroyed) client.warm();
      },
      destroy() {
        destroyed = true;
        close();
      },
    };
    lifecycle?.add(() => client.destroy());
    return client;
  }

  const styles = `
    .card { position: fixed; box-sizing: border-box; width: max-content;
      max-width: min(380px, calc(100vw - 16px)); padding: 10px 12px 8px; border-radius: 10px;
      background: #202124; color: #fff; font: 400 14px/1.55 system-ui, -apple-system,
      "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; text-align: start;
      box-shadow: 0 6px 20px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.08); }
    .card[hidden], .card [hidden] { display: none; }
    .label { display: block; margin-bottom: 4px; color: #bdc1c6;
      font: 600 11px/1.4 system-ui, -apple-system, sans-serif; }
    .text { max-height: min(40vh, 320px); overflow: auto; white-space: pre-wrap;
      overflow-wrap: anywhere; }
    .card[data-status="loading"] .text { color: #bdc1c6; }
    .problem { color: #f28b82; overflow-wrap: anywhere; }
    .note { margin-top: 6px; color: #9aa0a6; font-size: 12px; line-height: 1.4; }
    .actions { display: flex; gap: 2px; margin: 6px -6px 0; }
    button { all: unset; box-sizing: border-box; padding: 4px 8px; border-radius: 7px;
      color: #8ab4f8; cursor: pointer; white-space: nowrap;
      font: 500 12px/1.3 system-ui, -apple-system, sans-serif; }
    button:hover { background: rgb(255 255 255 / 0.12); }
    button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }
    button:disabled { opacity: 0.45; cursor: default; background: none; }`;

  let shared = null;
  const sharedClient = () => (shared ||= createClient());

  // doc is the document that holds the card (and the toolbar to avoid). Selections may come
  // from frames inside it (EPUB chapters); their positions are moved into doc's viewport.
  function attach({
    doc = document,
    t,
    avoid = () => null,
    client = sharedClient(),
    storage = globalThis.chrome?.storage,
    cache = createCache(),
  }) {
    const win = doc.defaultView;
    const listeners = new AbortController(),
      signal = listeners.signal;
    let settings = { ...DEFAULTS },
      host = null,
      root,
      card,
      body,
      problem,
      note,
      copyButton,
      retryButton,
      current = null,
      shown = null,
      cancel = null,
      pointer = null,
      suppressed = null,
      leaveTimer = null,
      side = 'above',
      copiedTimer = null;
    const watched = new WeakSet();
    const dwell = createDwell({ delay: () => settings.delay, fire: open, timers: win });
    const usable = () => !signal.aborted && (!lifecycle || lifecycle.check());

    (usable() ? storage : null)?.local
      ?.get(KEY)
      .then((value) => {
        if (!usable()) return;
        settings = settingsOf(value?.[KEY]);
        if (!settings.enabled) forget();
      })
      .catch(() => {});
    const onSettings = (changes, area) => {
      if (!usable()) return;
      if (area !== 'local' || !changes[KEY]) return;
      settings = settingsOf(changes[KEY].newValue);
      if (!settings.enabled) forget();
    };
    if (usable()) storage?.onChanged?.addListener(onSettings);
    signal.addEventListener('abort', () => {
      try {
        storage?.onChanged?.removeListener(onSettings);
      } catch {}
    });
    win.addEventListener(
      'pagehide',
      () => {
        forget();
        client.suspend?.();
      },
      { signal },
    );
    win.addEventListener(
      'pageshow',
      (event) => {
        if (event.persisted && usable()) client.resume?.();
      },
      { signal },
    );

    function ensureCard() {
      if (host?.isConnected) return;
      host = doc.createElement('tabgent-translation');
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
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(styles);
      root.adoptedStyleSheets = [sheet];
      card = doc.createElement('div');
      card.className = 'card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', t('translateTitle'));
      card.hidden = true;
      const label = doc.createElement('span');
      label.className = 'label';
      label.textContent = t('translateTitle');
      body = doc.createElement('div');
      body.className = 'text';
      body.lang = 'zh-CN';
      body.setAttribute('aria-live', 'polite');
      problem = doc.createElement('div');
      problem.className = 'problem';
      problem.setAttribute('role', 'alert');
      note = doc.createElement('div');
      note.className = 'note';
      const actions = doc.createElement('div');
      actions.className = 'actions';
      copyButton = doc.createElement('button');
      copyButton.type = 'button';
      copyButton.dataset.action = 'translate-copy';
      copyButton.textContent = t('translateCopy');
      retryButton = doc.createElement('button');
      retryButton.type = 'button';
      retryButton.dataset.action = 'translate-retry';
      retryButton.textContent = t('translateRetry');
      actions.append(copyButton, retryButton);
      card.append(label, body, problem, note, actions);
      // Clicking the card keeps the page selection, so the card stays open.
      for (const type of ['pointerdown', 'mousedown'])
        card.addEventListener(type, (event) => event.preventDefault());
      copyButton.addEventListener('click', () => void copy());
      retryButton.addEventListener('click', () => {
        if (!shown || !current) return;
        cache.delete(current.key);
        request();
      });
      root.append(card);
      doc.documentElement.append(host);
    }

    // Selection rectangles, in doc's viewport.
    function offset(target) {
      let x = 0,
        y = 0;
      for (let view = target.defaultView; view && view.document !== doc; view = view.parent) {
        const frame = view.frameElement;
        if (!frame || view.parent === view) return null;
        const rect = frame.getBoundingClientRect();
        x += rect.left + frame.clientLeft;
        y += rect.top + frame.clientTop;
      }
      return { x, y };
    }
    // Pointer moves ask often; a large selection's rectangles are measured at most every 200 ms.
    let measured = null;
    function rects() {
      if (!current?.range) return [];
      const now = win.performance.now();
      if (measured?.range === current.range && now - measured.at < 200) return measured.value;
      const at = offset(current.doc);
      const value = !at
        ? []
        : [...current.range.getClientRects()]
            .filter((rect) => rect.width && rect.height)
            .map((rect) => ({
              left: rect.left + at.x,
              right: rect.right + at.x,
              top: rect.top + at.y,
              bottom: rect.bottom + at.y,
            }));
      measured = { range: current.range, at: now, value };
      return value;
    }
    const within = (rect, point, slack = 2) =>
      point.x >= rect.left - slack &&
      point.x <= rect.right + slack &&
      point.y >= rect.top - slack &&
      point.y <= rect.bottom + slack;
    const onSelection = (point) => !!point && rects().some((rect) => within(rect, point));
    const onCard = (point) =>
      !!point && !!shown && !card.hidden && within(card.getBoundingClientRect(), point, 0);

    function watch(target) {
      if (watched.has(target)) return;
      watched.add(target);
      const options = { capture: true, signal };
      target.addEventListener('pointermove', (event) => moved(event, target), options);
      target.addEventListener(
        'mouseout',
        (event) => {
          // The pointer left this document (the window, or an EPUB chapter's frame).
          if (event.relatedTarget) return;
          dwell.stop();
          if (shown) leaveSoon();
        },
        options,
      );
      target.addEventListener(
        'pointerdown',
        (event) => {
          if (host && event.composedPath().includes(host)) return;
          dwell.stop();
          close();
        },
        options,
      );
      target.addEventListener(
        'keydown',
        (event) => {
          if (event.key !== 'Escape' || !current) return;
          // Escape closes the card; this selection does not open it again.
          suppressed = current.key;
          dwell.stop();
          close();
        },
        options,
      );
      target.addEventListener(
        'scroll',
        (event) => {
          if (host && event.composedPath().includes(host)) return;
          dwell.stop();
          close();
        },
        { capture: true, passive: true, signal },
      );
      target.defaultView?.addEventListener(
        'resize',
        () => {
          dwell.stop();
          close();
        },
        { signal },
      );
    }

    function moved(event, target) {
      if (!usable()) return;
      if (event.pointerType === 'touch') return;
      const at = offset(target);
      if (!at) return;
      pointer = { x: event.clientX + at.x, y: event.clientY + at.y };
      // A held button is a selection being made, not a rest on it.
      if (event.buttons) return void dwell.stop();
      track();
    }
    function track() {
      if (!current || !pointer) return;
      if (shown) {
        if (onCard(pointer) || onSelection(pointer)) {
          win.clearTimeout(leaveTimer);
          leaveTimer = null;
        } else leaveSoon();
        return;
      }
      if (suppressed === current.key) return;
      dwell.update(onSelection(pointer) ? pointer : null);
    }
    // A short grace period lets the pointer cross the gap between the selection and the card.
    function leaveSoon() {
      if (leaveTimer) return;
      leaveTimer = win.setTimeout(() => {
        leaveTimer = null;
        close();
      }, LEAVE_MS);
    }

    function open() {
      if (!usable()) return;
      if (!current || shown || !settings.enabled || !onSelection(pointer)) return;
      ensureCard();
      shown = { key: current.key, output: '' };
      card.hidden = false;
      if (!host.matches(':popover-open')) host.showPopover();
      const cached = cache.get(current.key);
      if (cached !== undefined) render('done', cached);
      else request();
      place(true);
    }
    // Translate again works at any time: it drops the running request and starts over.
    function request() {
      cancel?.();
      cancel = null;
      const key = current.key;
      let output = '',
        settled = false,
        stall = null;
      shown.output = '';
      render('loading');
      place();
      // The connector stops a turn after 60 s and says so. If nothing at all comes back
      // (a stuck connector), the card stops waiting too, so the request can be retried.
      const quiet = () => {
        win.clearTimeout(stall);
        if (settled) return;
        stall = win.setTimeout(() => {
          end();
          if (cancel === end) cancel = null;
          if (shown?.key !== key) return;
          render('error', '', { code: 'timeout' });
          place();
        }, STALL_MS);
      };
      const settle = () => {
        settled = true;
        win.clearTimeout(stall);
        if (cancel === end) cancel = null;
      };
      const stop = client.translate(current.text, {
        onDelta(delta) {
          quiet();
          output += delta;
          if (shown?.key !== key) return;
          render('streaming', output);
          place();
        },
        onDone(text) {
          settle();
          const value = (text || output).trim();
          if (value) cache.set(key, value);
          if (shown?.key !== key) return;
          if (value) render('done', value);
          else render('error', '', { code: 'empty' });
          place();
        },
        onError(error) {
          settle();
          if (shown?.key !== key) return;
          render('error', '', error);
          place();
        },
      });
      function end() {
        settled = true;
        win.clearTimeout(stall);
        stop();
      }
      if (!settled) {
        cancel = end;
        quiet();
      }
    }
    function close() {
      win.clearTimeout(leaveTimer);
      leaveTimer = null;
      cancel?.();
      cancel = null;
      if (!shown) return;
      shown = null;
      card.hidden = true;
      if (host?.matches(':popover-open')) host.hidePopover();
    }
    function forget() {
      close();
      dwell.stop();
      current = null;
      suppressed = null;
    }

    function explain(error) {
      const key = {
        codex_missing: 'translateCodexMissing',
        signed_out: 'translateSignedOut',
        host_missing: 'translateHostMissing',
        disconnected: 'translateDisconnected',
        timeout: 'translateTimeout',
        empty: 'translateEmpty',
      }[error?.code];
      if (key) return t(key);
      return t('translateFailed', error?.message || error?.code || t('errorGeneric'));
    }
    function render(status, output = '', error = null) {
      card.dataset.status = status;
      shown.output = status === 'error' ? '' : output;
      body.hidden = status === 'error';
      body.textContent = status === 'loading' ? t('translateLoading') : output;
      problem.hidden = status !== 'error';
      problem.textContent = status === 'error' ? explain(error) : '';
      note.hidden = !current?.truncated;
      note.textContent = current?.truncated ? t('translateTruncated', LIMIT) : '';
      copyButton.disabled = !shown.output;
      copyButton.textContent = t('translateCopy');
    }

    // Above the selection when it fits, else below it (and below the toolbar there).
    function place(fresh = false) {
      if (!shown) return;
      const boxes = rects();
      if (!boxes.length) return;
      const box = {
        left: Math.min(...boxes.map((r) => r.left)),
        right: Math.max(...boxes.map((r) => r.right)),
        top: Math.min(...boxes.map((r) => r.top)),
        bottom: Math.max(...boxes.map((r) => r.bottom)),
      };
      const width = card.offsetWidth,
        height = card.offsetHeight,
        gap = 8;
      const left = clamp(
        (box.left + box.right) / 2 - width / 2,
        gap,
        Math.max(gap, win.innerWidth - width - gap),
      );
      const bar = avoid();
      const hits = (top) =>
        !!bar &&
        left < bar.right &&
        left + width > bar.left &&
        top < bar.bottom &&
        top + height > bar.top;
      let above = box.top - gap - height;
      if (hits(above)) above = bar.top - gap - height;
      let below = box.bottom + gap;
      if (hits(below)) below = bar.bottom + gap;
      const fitsAbove = above >= gap,
        fitsBelow = below + height <= win.innerHeight - gap;
      if (fresh) side = fitsAbove || !fitsBelow ? 'above' : 'below';
      else if (side === 'above' && !fitsAbove && fitsBelow) side = 'below';
      else if (side === 'below' && !fitsBelow && fitsAbove) side = 'above';
      const top = clamp(
        side === 'above' ? above : below,
        gap,
        Math.max(gap, win.innerHeight - height - gap),
      );
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
    }

    async function copy() {
      const value = shown?.output;
      if (!value) return;
      let copied = false;
      try {
        await win.navigator.clipboard.writeText(value);
        copied = true;
      } catch {
        // Pages without the clipboard API (plain HTTP): copy from a hidden text field,
        // then give the page its selection back.
        const selection = doc.getSelection();
        const saved = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        const field = doc.createElement('textarea');
        field.value = value;
        field.style.setProperty('position', 'fixed');
        field.style.setProperty('opacity', '0');
        root.append(field);
        field.select();
        try {
          copied = doc.execCommand('copy');
        } catch {}
        field.remove();
        if (saved) {
          selection.removeAllRanges();
          selection.addRange(saved);
        }
      }
      if (!shown) return;
      copyButton.textContent = t(copied ? 'translateCopied' : 'translateCopyFailed');
      win.clearTimeout(copiedTimer);
      copiedTimer = win.setTimeout(() => {
        if (copyButton) copyButton.textContent = t('translateCopy');
      }, 1500);
    }

    watch(doc);
    return {
      // The reading layer's current selection, { text, range, doc?, joinLines? }, or null.
      select(selection) {
        if (!usable()) return;
        if (!selection?.range || !settings.enabled) return void forget();
        const target = selection.doc || doc;
        const prepared = prepare(selection.text, { joinLines: !!selection.joinLines });
        if (current && current.key === prepared.text && current.doc === target) {
          current.range = selection.range;
          return;
        }
        forget();
        if (!prepared.text || !isEnglish(prepared.text)) return;
        current = { ...prepared, key: prepared.text, range: selection.range, doc: target };
        watch(target);
        client.warm();
        // The pointer often already rests on a selection made with it.
        if (pointer && !shown) track();
      },
      close,
      // Follows the pointer in a frame inside doc (an EPUB chapter) from the time it loads.
      watch,
      // True for events inside the card, which reading layers leave alone.
      owns: (event) => !!host && event.composedPath().includes(host),
      get open() {
        return !!shown;
      },
      destroy() {
        forget();
        win.clearTimeout(copiedTimer);
        listeners.abort();
        host?.remove();
      },
    };
  }

  globalThis.tabgentHoverTranslate = {
    LIMIT,
    KEY,
    DEFAULTS,
    DELAYS,
    PORT,
    isEnglish,
    prepare,
    settingsOf,
    createCache,
    createDwell,
    createClient,
    attach,
  };
})();
