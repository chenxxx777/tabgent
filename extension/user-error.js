// User-facing text for connector and extension errors. Loaded as a classic script and
// imported for the side effect. Callers pass chrome.i18n (or the panel's i18n) and show
// the result; they do not show error.message, which may be English or contain a path.
(() => {
  if (globalThis.tabgentExplainError) return;
  const CODES = {
    vault_unwritable: 'errorVaultUnwritable',
    disk_full: 'errorDiskFull',
    not_found: 'errorNotFound',
    invalid_params: 'errorInvalidParams',
    invalid_highlight: 'errorInvalidHighlight',
    io_error: 'errorIo',
    timeout: 'errorTimeout',
    disconnected: 'errorDisconnected',
    host_missing: 'errorHostMissing',
    internal_error: 'errorInternal',
    unknown_method: 'errorInternal',
  };
  // English phrases the connector used to return. Mapped when a code was dropped.
  const PHRASES = [
    [/invalid highlight/i, 'errorInvalidHighlight'],
    [/highlight not found/i, 'errorNotFound'],
    [/permission denied|cannot create the folder|cannot lock|read-only/i, 'errorVaultUnwritable'],
    [/no space left|disk is full/i, 'errorDiskFull'],
    [/timed out/i, 'errorTimeout'],
    [/native messaging host not found/i, 'errorHostMissing'],
    [/connector unavailable|connector disconnected/i, 'errorDisconnected'],
    [/vault error/i, 'errorInternal'],
  ];

  function folderName(error) {
    const name = error?.folder;
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.length > 180)
      return '';
    if (name.includes('..') || /[\\/\u0000-\u001f\u007f]/.test(name)) return '';
    return name;
  }

  function lookup(translate, key, ...args) {
    const text = args.length ? translate(key, ...args) : translate(key);
    return text && text !== key ? text : '';
  }

  function explainError(error, translate) {
    const t =
      translate ||
      ((key, ...args) => {
        const message = args.length
          ? chrome.i18n.getMessage(key, args.map(String))
          : chrome.i18n.getMessage(key);
        return message || key;
      });
    const value = typeof error === 'string' ? { message: error } : error || {};
    const code = typeof value.code === 'string' ? value.code : '';
    const key = CODES[code];
    if (key) {
      const folder = folderName(value);
      const named = folder ? lookup(t, key + 'Folder', folder) : '';
      if (named) return named;
      const text = lookup(t, key);
      if (text) return text;
    }
    const message = typeof value.message === 'string' ? value.message : '';
    for (const [pattern, phraseKey] of PHRASES)
      if (pattern.test(message)) {
        const text = lookup(t, phraseKey);
        if (text) return text;
      }
    if (!message || /[\\/\u0000-\u001f\u007f]/.test(message)) return lookup(t, 'errorGeneric');
    return message;
  }

  globalThis.tabgentExplainError = explainError;
})();
