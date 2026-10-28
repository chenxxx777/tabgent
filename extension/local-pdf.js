// Chrome's own viewer shows a PDF from the computer that Tabgent's redirect did not catch:
// one opened while Chrome was starting, before extension rules applied, or a PDF whose name
// does not end in .pdf. Tabgent's viewer replaces it in the same tab, without a history
// entry, unless the user chose Chrome's viewer for this tab.
(() => {
  if (globalThis.tabgentLocalPdf || window !== top || document.contentType !== 'application/pdf')
    return;
  globalThis.tabgentLocalPdf = true;
  const lifecycle = globalThis.tabgentContentLifecycle;
  if (lifecycle ? !lifecycle.check() : !globalThis.chrome?.runtime?.id) return;
  const from = location.href;
  try {
    chrome.runtime
      .sendMessage({ type: 'localPdfOpen' })
      .then((reply) => {
        if ((!lifecycle || lifecycle.check()) && reply?.url && location.href === from)
          location.replace(reply.url);
      })
      .catch(() => {});
  } catch {}
})();
