// Reading notes in the side panel: the save toggle and vault folder in a composer menu,
// and this page's highlights in the page drawer. Saving itself runs in the service worker.
export function createReading({ i18n, request, showError, selection, reload }) {
  const $ = (id) => document.getElementById(id);
  let state = null,
    revision = 0;
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
    renderHighlights();
  }

  function renderHighlights() {
    const list = $('highlightList');
    $('highlightSection').hidden = !state.page;
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
      quote.title = i18n(
        highlight.anchored === false ? 'highlightUnanchoredHint' : 'highlightJump',
      );
      quote.disabled = highlight.anchored === false;
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
      entry.append(quote, meta, open);
      list.append(entry);
    }
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
