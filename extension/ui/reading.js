// Reading notes in the side panel: the save toggle and vault folder in a composer menu,
// and this page's highlights in the page drawer. Saving itself runs in the service worker.
export function createReading({ i18n, request, showError, selection, reload }) {
  const $ = (id) => document.getElementById(id);
  let state = null,
    revision = 0,
    // The highlight whose note is being edited: { documentId, id, draft, error, busy }.
    // Highlight IDs restart at h001 in every document, so the document is part of the key.
    editing = null;
  const number = (id) => Number.parseInt(String(id).slice(1), 10) || 0;

  async function refresh() {
    const current = ++revision;
    try {
      const value = await request('readingState');
      if (current !== revision) return;
      state = value;
    } catch (error) {
      console.warn('Reading notes unavailable', error);
      if (current !== revision) return;
      state = null;
    }
    render();
  }
  async function update(type, params) {
    revision++;
    state = await request(type, params);
    render();
  }

  // The attached quote's highlight is shown before sending; the service worker decides.
  function target() {
    const selected = selection()?.highlight;
    if (!state?.page || state.save.explicit === false) return { kind: 'off' };
    if (selected?.highlightId) return { kind: 'highlight', id: selected.highlightId };
    if (state.save.target === 'highlight')
      return { kind: 'highlight', id: state.binding.highlightId };
    return { kind: state.save.target };
  }

  function render() {
    const button = $('readingButton');
    button.hidden = !state;
    if (!state) {
      $('highlightSection').hidden = true;
      return;
    }
    const on = target();
    button.dataset.state = on.kind === 'off' ? 'off' : 'on';
    $('readingLabel').textContent =
      on.kind === 'highlight'
        ? i18n('readingLabelHighlight', number(on.id))
        : i18n(on.kind === 'document' ? 'readingLabelPage' : 'readingLabelOff');
    const toggle = $('readingSave');
    toggle.disabled = !state.page;
    toggle.checked = on.kind !== 'off';
    $('readingTarget').textContent = !state.page
      ? i18n('readingUnavailable')
      : on.kind === 'highlight'
        ? i18n('readingTargetHighlight', number(on.id))
        : i18n(on.kind === 'document' ? 'readingTargetDocument' : 'readingTargetOff');
    $('readingPath').textContent = state.vault?.path || i18n('readingFolderUnavailable');
    $('readingPath').title = state.vault?.path || '';
    $('readingChange').disabled = !state.vault;
    // Clipping saves a webpage's text in its vault folder; it needs a live web page.
    // In Tabgent's reader of the clipped copy, the live page is needed to clip again.
    const clippable =
      state.page?.kind === 'web' &&
      /^https?:/i.test(state.page.url || '') &&
      state.page.view !== 'clip';
    const clipped = Date.parse(state.clip?.clippedAt);
    $('readingClip').hidden = !clippable;
    $('readingClip').textContent = i18n(state.clip ? 'clipAgain' : 'clipPage');
    $('readingClip').title = Number.isNaN(clipped)
      ? ''
      : i18n('readingClipped', new Date(clipped).toLocaleString());
    $('readingClipSelection').hidden = !clippable || !selection()?.text;
    $('readingClipOpen').hidden = !clippable || !state.clip?.complete;
    renderHighlights();
  }

  function renderHighlights() {
    const list = $('highlightList');
    $('highlightSection').hidden = !state.page;
    // Refreshes arrive while the user types; the editor keeps its text and focus.
    const typing = document.activeElement?.closest?.('.highlight-note-form')
      ? document.activeElement
      : null;
    const caret = typing?.tagName === 'TEXTAREA' && [typing.selectionStart, typing.selectionEnd];
    // A draft never follows the panel to another document, even one with the same ID.
    if (
      editing &&
      (!state.document?.id ||
        state.document.id !== editing.documentId ||
        !state.highlights.some((h) => h.id === editing.id))
    )
      editing = null;
    list.replaceChildren();
    if (!state.highlights.length) {
      list.textContent = state.error ? i18n('readingError', state.error) : i18n('highlightsEmpty');
      return;
    }
    for (const highlight of state.highlights) {
      const entry = document.createElement('div');
      entry.className = 'highlight-entry';
      entry.dataset.highlightId = highlight.id;
      const quote = document.createElement('button');
      quote.type = 'button';
      quote.className = 'highlight-quote';
      quote.textContent = highlight.text;
      // A closed page keeps its highlights and notes, but has nothing to show them on.
      quote.title = i18n(
        state.page.closed
          ? 'highlightPageClosed'
          : highlight.anchored === false
            ? 'highlightUnanchoredHint'
            : 'highlightJump',
      );
      quote.disabled = highlight.anchored === false || !!state.page.closed;
      quote.onclick = async () => {
        try {
          const result = await request('readingJump', { highlightId: highlight.id });
          if (!result.found) showError(i18n('highlightUnanchoredHint'));
        } catch (error) {
          showError(error.message);
        }
      };
      const meta = document.createElement('small');
      meta.textContent = [
        i18n('readingLabelHighlight', number(highlight.id)),
        highlight.location,
        highlight.anchored === false ? i18n('highlightUnanchored') : '',
        highlight.turnCount ? i18n('highlightTurns', highlight.turnCount) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      meta.title = meta.textContent;
      if (highlight.anchored === false) entry.dataset.unanchored = 'true';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'highlight-open';
      open.textContent = i18n(highlight.turnCount ? 'highlightOpen' : 'highlightAsk');
      open.onclick = async () => {
        open.disabled = true;
        try {
          const result = await request('readingOpen', {
            documentId: state.document?.id,
            highlightId: highlight.id,
          });
          if (result.switched) reload();
        } catch (error) {
          showError(error.message);
        } finally {
          open.disabled = false;
        }
      };
      const note = document.createElement('button');
      note.type = 'button';
      note.className = 'highlight-note-button';
      note.textContent = i18n(highlight.note ? 'highlightNoteEdit' : 'highlightNoteAdd');
      note.setAttribute('aria-expanded', String(editing?.id === highlight.id));
      note.onclick = () => {
        editing =
          editing?.id === highlight.id
            ? null
            : { documentId: state.document?.id, id: highlight.id, draft: highlight.note };
        render();
        if (editing) list.querySelector('.highlight-note-form textarea')?.focus();
      };
      const actions = document.createElement('span');
      actions.className = 'highlight-actions';
      actions.append(note, open);
      entry.append(quote);
      if (highlight.note && editing?.id !== highlight.id) {
        const text = document.createElement('p');
        text.className = 'highlight-note';
        text.textContent = highlight.note;
        text.title = i18n('highlightNoteLabel');
        entry.append(text);
      }
      if (editing?.id === highlight.id) entry.append(noteForm(highlight));
      entry.append(meta, actions);
      list.append(entry);
    }
    if (caret) {
      const input = list.querySelector('.highlight-note-form textarea');
      input?.focus();
      input?.setSelectionRange(...caret);
    }
  }

  // An inline editor for the user's own note; an empty note removes it.
  function noteForm(highlight) {
    const form = document.createElement('form');
    form.className = 'highlight-note-form';
    const input = document.createElement('textarea');
    input.rows = 3;
    input.maxLength = 20000;
    input.value = editing.draft || '';
    input.placeholder = i18n('highlightNotePlaceholder');
    input.setAttribute('aria-label', i18n('highlightNoteLabel'));
    input.oninput = () => (editing.draft = input.value);
    const error = document.createElement('p');
    error.className = 'highlight-note-error';
    error.setAttribute('role', 'alert');
    error.hidden = !editing.error;
    error.textContent = editing.error || '';
    const row = document.createElement('div');
    row.className = 'highlight-note-actions';
    const hint = document.createElement('small');
    hint.textContent = i18n('highlightNoteHint');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = i18n('highlightNoteCancel');
    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = i18n('highlightNoteSave');
    save.disabled = cancel.disabled = !!editing.busy;
    row.append(hint, cancel, save);
    form.append(input, error, row);
    const close = () => {
      editing = null;
      render();
      $('highlightList')
        .querySelector(`[data-highlight-id="${highlight.id}"] .highlight-note-button`)
        ?.focus();
    };
    cancel.onclick = close;
    input.onkeydown = (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (editing?.busy) return;
      const target = editing;
      target.busy = true;
      target.error = '';
      render();
      try {
        await update('readingNote', {
          documentId: target.documentId,
          highlightId: highlight.id,
          note: input.value.trim(),
        });
        if (editing === target) close();
      } catch (failure) {
        target.busy = false;
        target.error = i18n('highlightNoteFailed', failure.message);
        if (editing === target) {
          render();
          $('highlightList').querySelector('.highlight-note-form textarea')?.focus();
        }
      }
    };
    return form;
  }

  $('readingSave').onchange = async (event) => {
    try {
      await update('readingSave', { enabled: event.target.checked });
    } catch (error) {
      showError(error.message);
      render();
    }
  };
  $('readingMenu').addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'open') return;
    $('readingFolderForm').hidden = true;
    $('readingError').hidden = true;
    void refresh();
  });
  $('readingChange').onclick = () => {
    $('readingFolderForm').hidden = false;
    $('readingPathInput').value = state?.vault?.path || '';
    $('readingPathInput').focus();
  };
  $('readingFolderCancel').onclick = () => {
    $('readingFolderForm').hidden = true;
    $('readingError').hidden = true;
  };
  // Clipping runs in the page; it asks there before replacing an earlier clip.
  async function clipPage(mode) {
    $('readingMenu').hidePopover();
    try {
      const result = await request('clipPage', { mode });
      if (result?.reason === 'unsupported') showError(i18n('clipUnsupported'));
    } catch (error) {
      showError(error.message);
    }
    void refresh();
  }
  $('readingClip').onclick = () => void clipPage('article');
  $('readingClipSelection').onclick = () => void clipPage('selection');
  // The clipped copy opens in Tabgent's reader, next to the page.
  $('readingClipOpen').onclick = async () => {
    $('readingMenu').hidePopover();
    try {
      await request('clipOpenView');
    } catch (error) {
      showError(error.message);
    }
  };
  // The library lists every document in the vault and opens it, or imports a file.
  $('readingLibrary').onclick = async () => {
    $('readingMenu').hidePopover();
    try {
      await request('openLibrary');
    } catch (error) {
      showError(error.message);
    }
  };
  $('readingFolderForm').onsubmit = async (event) => {
    event.preventDefault();
    const path = $('readingPathInput').value.trim();
    if (!path) return;
    $('readingError').hidden = true;
    try {
      await update('vaultConfigure', { path });
      $('readingFolderForm').hidden = true;
    } catch (error) {
      $('readingError').textContent = error.message;
      $('readingError').hidden = false;
    }
  };

  return {
    refresh,
    render: () => state && render(),
    saved(value) {
      if (value && !value.ok)
        showError(i18n(value.queued ? 'readingSaveQueued' : 'readingSaveFailed', value.message));
      void refresh();
    },
  };
}
