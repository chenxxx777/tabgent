// The user's own note on a saved highlight, shared by the webpage and PDF.js reading layers:
// a preview for the highlight popover and a small editor. Both are built inside the layer's
// closed shadow root. Keys typed in the editor stay there, so page and PDF.js shortcuts
// never see them. Loaded as a content script and imported by the PDF.js viewer.
(() => {
  if (globalThis.tabgentHighlightNote) return;
  const limit = 20000;
  const styles = `
    .bar.card { flex-wrap: wrap; max-width: min(360px, calc(100vw - 16px)); }
    .note { flex: 1 0 100%; box-sizing: border-box; max-height: 8.6em; overflow: auto;
      margin: 2px 0 4px; padding: 6px 10px 8px; border-bottom: 1px solid rgb(255 255 255 / 0.16);
      font: 400 13px/1.45 system-ui, -apple-system, sans-serif; white-space: pre-wrap;
      overflow-wrap: anywhere; }
    .note[hidden], .editor[hidden], .editor .error[hidden] { display: none; }
    .note .label, .editor .label { display: block; margin-bottom: 2px; color: #bdc1c6;
      font: 600 11px/1.4 system-ui, -apple-system, sans-serif; }
    .editor { position: fixed; box-sizing: border-box; width: min(360px, calc(100vw - 16px));
      padding: 10px; border-radius: 10px; background: #202124; color: #fff;
      font: 13px/1.4 system-ui, -apple-system, sans-serif; z-index: 2;
      box-shadow: 0 6px 20px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(255 255 255 / 0.08); }
    .editor .quote { display: block; overflow: hidden; margin-bottom: 8px; color: #bdc1c6;
      white-space: nowrap; text-overflow: ellipsis; }
    .editor textarea { all: unset; box-sizing: border-box; display: block; width: 100%;
      min-height: 6.5em; max-height: 40vh; padding: 8px; border-radius: 7px; overflow: auto;
      background: #303134; color: #fff; white-space: pre-wrap; overflow-wrap: anywhere;
      font: 13px/1.45 system-ui, -apple-system, sans-serif; resize: vertical; }
    .editor textarea::placeholder { color: #9aa0a6; }
    .editor textarea:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 0; }
    .editor .row { display: flex; align-items: center; gap: 4px; margin-top: 8px; }
    .editor .hint { flex: 1; color: #9aa0a6; font-size: 12px; }
    .editor .error { margin-top: 6px; color: #f28b82; }
    .editor .save { background: #8ab4f8; color: #202124; }
    .editor .save:hover { background: #aecbfa; }`;

  // The popover's note text; hidden when the highlight has no note.
  function preview(doc, t) {
    const element = doc.createElement('div');
    element.className = 'note';
    element.id = 'tabgent-note-preview';
    element.hidden = true;
    const label = doc.createElement('span');
    label.className = 'label';
    label.textContent = t('highlightNoteLabel');
    const text = doc.createElement('span');
    element.append(label, text);
    return Object.assign(element, {
      show(note) {
        text.textContent = note || '';
        element.hidden = !note;
      },
    });
  }

  // save(note) returns a promise; Escape, Cancel or a rejected save keep the caller in charge.
  function editor(doc, t, { save, close }) {
    const element = doc.createElement('div');
    element.className = 'editor';
    element.setAttribute('role', 'dialog');
    element.hidden = true;
    const label = doc.createElement('span');
    label.className = 'label';
    label.id = 'tabgent-note-label';
    label.textContent = t('highlightNoteLabel');
    const quote = doc.createElement('span');
    quote.className = 'quote';
    const input = doc.createElement('textarea');
    input.maxLength = limit;
    input.rows = 4;
    input.placeholder = t('highlightNotePlaceholder');
    input.setAttribute('aria-labelledby', label.id);
    const error = doc.createElement('div');
    error.className = 'error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const hint = doc.createElement('span');
    hint.className = 'hint';
    hint.textContent = t('highlightNoteHint');
    const button = (text, className) => {
      const element = doc.createElement('button');
      element.type = 'button';
      element.className = className;
      element.textContent = text;
      return element;
    };
    const cancel = button(t('highlightNoteCancel'), 'cancel'),
      submit = button(t('highlightNoteSave'), 'save');
    const row = doc.createElement('div');
    row.className = 'row';
    row.append(hint, cancel, submit);
    element.append(label, quote, input, error, row);
    element.setAttribute('aria-labelledby', label.id);
    let initial = '',
      busy = false;
    async function commit() {
      if (busy) return;
      busy = true;
      submit.disabled = cancel.disabled = true;
      error.hidden = true;
      try {
        await save(input.value.trim());
      } catch (failure) {
        error.textContent = t(
          'highlightNoteFailed',
          globalThis.tabgentExplainError?.(failure, t) || t('errorGeneric'),
        );
        error.hidden = false;
        input.focus();
      } finally {
        busy = false;
        submit.disabled = cancel.disabled = false;
      }
    }
    cancel.addEventListener('click', () => close());
    submit.addEventListener('click', () => void commit());
    const focusable = [input, cancel, submit];
    element.addEventListener('keydown', (event) => {
      // Page and PDF.js shortcuts must not see what the user types.
      event.stopPropagation();
      // Enter and Escape also confirm or cancel an input method's composition.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void commit();
      } else if (event.key === 'Tab') {
        // Focus stays in the editor until it is saved or closed.
        const at = focusable.indexOf(element.getRootNode().activeElement);
        const next = (at + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
        event.preventDefault();
        focusable[next].focus();
      }
    });
    for (const name of ['keyup', 'keypress', 'input', 'beforeinput'])
      element.addEventListener(name, (event) => event.stopPropagation());
    return {
      element,
      open({ note = '', text = '' }) {
        initial = note;
        input.value = note;
        quote.textContent = text ? `“${text.replace(/\s+/g, ' ').trim()}”` : '';
        quote.hidden = !text;
        error.hidden = true;
        element.hidden = false;
      },
      focus() {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      },
      hide() {
        element.hidden = true;
      },
      // Unsaved text keeps the editor open when the user clicks elsewhere.
      get changed() {
        return !element.hidden && input.value.trim() !== initial.trim();
      },
      get visible() {
        return !element.hidden;
      },
    };
  }

  globalThis.tabgentHighlightNote = { limit, styles, preview, editor };
})();
