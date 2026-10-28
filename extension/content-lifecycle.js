// One owner per document. DOM events also reach an orphan's isolated world after reload.
(() => {
  const replace = 'tabgent:replace-content';
  // Pages may also request teardown; they can already hide our UI, so this is acceptable.
  document.dispatchEvent(new Event(replace));
  const lifetime = new AbortController();
  const cleanups = new Set();
  let stopped = false,
    replaced = false,
    hintAttempted = false,
    hint,
    hintTimer;
  // Capture while extension APIs still work; an orphan must not call them again.
  let reloadHint = 'Tabgent was reloaded. Refresh this page to continue.',
    aliveResource = '';
  try {
    if (globalThis.chrome?.runtime?.id) {
      reloadHint = chrome.i18n?.getMessage('reloadHint') || reloadHint;
      aliveResource = chrome.runtime.getURL('icons/app-16.png');
    }
  } catch {}
  const globals = [
    'browserAgentSelectionInstalled',
    'tabgentLocalPdf',
    'tabgentWebAnchor',
    'tabgentExplainError',
    'tabgentHighlightNote',
    'tabgentHoverTranslate',
    'tabgentHighlightsInstalled',
  ];
  function stop() {
    if (stopped) return;
    stopped = true;
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {}
    }
    cleanups.clear();
  }
  function dispose() {
    replaced = true;
    stop();
    lifetime.abort();
    clearTimeout(hintTimer);
    hint?.remove();
    for (const key of globals) delete globalThis[key];
  }
  function check() {
    if (stopped) return false;
    try {
      if (globalThis.chrome?.runtime?.id) return true;
    } catch {}
    stop();
    return false;
  }
  async function showHint() {
    if (replaced || hintAttempted || !aliveResource) return;
    hintAttempted = true;
    // A missing context may mean disable/uninstall. Only a still-enabled extension can
    // serve this resource; bypass caches so a previously loaded icon is not proof of life.
    try {
      const response = await fetch(aliveResource, { cache: 'no-store' });
      if (!response.ok || replaced) return;
    } catch {
      return;
    }
    hint = document.createElement('tabgent-refresh-hint');
    const root = hint.attachShadow({ mode: 'closed' });
    const message = document.createElement('div');
    message.setAttribute('role', 'status');
    message.textContent = reloadHint;
    message.style.cssText =
      'position:fixed;right:16px;bottom:16px;padding:10px 14px;border-radius:10px;' +
      'background:#202124;color:white;font:14px/1.5 system-ui;box-shadow:0 4px 16px #0003';
    hint.style.cssText =
      'all:initial!important;position:fixed!important;z-index:2147483647!important';
    root.append(message);
    document.documentElement.append(hint);
    hintTimer = setTimeout(() => hint?.remove(), 4000);
  }
  document.addEventListener(replace, dispose, { once: true, signal: lifetime.signal });
  for (const type of ['selectionchange', 'pointerup', 'keyup'])
    document.addEventListener(
      type,
      () => {
        if (!check() && getSelection()?.toString().trim()) void showHint();
      },
      { capture: true, signal: lifetime.signal },
    );
  globalThis.tabgentContentLifecycle = {
    check,
    dispose,
    add(cleanup) {
      if (stopped) cleanup();
      else cleanups.add(cleanup);
    },
  };
})();
