// The user's comment on a whole document and its tags: one control shared by the clipped
// page and feed item reader, the side panel beside a page and the library. It only builds
// DOM nodes (no HTML strings), so it also runs under the reader's Trusted Types policy. The
// page that uses it saves through its own messages (save, tags, tagList).
//
// Tags save at once; the comment is a draft until saved (⌘/Ctrl Enter), and Esc or Cancel
// drops it. dirty() tells the page whether a draft would be lost.

// What tags are matched by, as the connector's tag_key: NFC, trimmed, without a leading #,
// ignoring case.
export function tagKey(tag) {
  return String(tag).normalize('NFC').trim().replace(/^#+/, '').trim().toLowerCase();
}
// A tag the user typed, as the connector stores it (spaces become -).
export function cleanTag(value) {
  return String(value).normalize('NFC').trim().replace(/^#+/, '').trim().split(/\s+/).join('-');
}

// Existing tags for what the user typed: those whose key starts with it first, then those
// that contain it, each by use count; without the document's own tags.
export function suggestTags(all, typed, own = []) {
  const key = tagKey(typed);
  const mine = new Set(own.map(tagKey));
  const found = (all || [])
    .filter((tag) => !mine.has(tagKey(tag.name)) && tagKey(tag.name).includes(key))
    .sort(
      (a, b) =>
        tagKey(b.name).startsWith(key) - tagKey(a.name).startsWith(key) ||
        b.count - a.count ||
        tagKey(a.name).localeCompare(tagKey(b.name)),
    );
  return key ? found : found.slice(0, 20);
}

let unique = 0;

export function createDocumentNotes({
  t,
  save,
  tags,
  tagList,
  onTag,
  onError,
  // Called before the comment editor opens; false keeps it closed (the library allows one
  // editor at a time and asks before another one's draft is dropped).
  beforeEdit,
  compact = false,
}) {
  const id = `document-notes-${++unique}`;
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };
  const root = make('div', 'document-notes' + (compact ? ' compact' : ''));
  const tagRow = make('div', 'dn-tags');
  tagRow.setAttribute('role', 'group');
  tagRow.setAttribute('aria-label', t('docNotesTags'));
  const chips = make('span', 'dn-chips');
  const add = make('button', 'dn-tag-add', t('docNotesTagAdd'));
  add.type = 'button';
  const field = make('span', 'dn-tag-field');
  field.hidden = true;
  const input = make('input', 'dn-tag-input');
  input.type = 'text';
  input.maxLength = 100;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = t('docNotesTagInput');
  input.setAttribute('aria-label', t('docNotesTagInput'));
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id + '-options');
  const options = make('ul', 'dn-options');
  options.id = id + '-options';
  options.setAttribute('role', 'listbox');
  options.hidden = true;
  field.append(input, options);
  tagRow.append(chips, add, field);
  const commentBox = make('div', 'dn-comment');
  root.append(tagRow, commentBox);

  let value = { comment: '', tags: [] },
    editable = true,
    // The comment editor: { base, text, busy, error } while open.
    editing = null,
    known = null,
    suggestions = [],
    active = 0,
    busyTags = false;

  function fail(key, error) {
    onError?.(t(key, error?.message || String(error)), error);
  }

  function renderTags() {
    chips.replaceChildren();
    for (const tag of value.tags) {
      const chip = make('span', 'dn-tag');
      const name = make(onTag ? 'button' : 'span', 'dn-tag-name', tag);
      if (onTag) {
        name.type = 'button';
        name.title = t('docNotesTagFilter', tag);
        name.onclick = () => onTag(tag);
      }
      chip.append(name);
      if (editable) {
        const remove = make('button', 'dn-tag-remove', '×');
        remove.type = 'button';
        remove.title = t('docNotesTagRemove', tag);
        remove.setAttribute('aria-label', t('docNotesTagRemove', tag));
        remove.disabled = busyTags;
        remove.onclick = () => void changeTags({ remove: [tag] });
        chip.append(remove);
      }
      chips.append(chip);
    }
    add.hidden = !editable || !field.hidden;
    showEmpty();
  }
  // Nothing to show yet: a list may then show only the buttons, on hover or focus.
  function showEmpty() {
    root.classList.toggle(
      'empty',
      !value.tags.length && !value.comment && !editing && field.hidden,
    );
  }

  async function changeTags(change) {
    if (busyTags) return;
    busyTags = true;
    renderTags();
    try {
      const result = await tags(change);
      value.tags = result?.tags || value.tags;
      if (known && change.add)
        for (const name of change.add)
          if (!known.some((tag) => tagKey(tag.name) === tagKey(name)))
            known.push({ name, count: 1 });
    } catch (error) {
      fail('docNotesTagFailed', error);
    } finally {
      busyTags = false;
      renderTags();
    }
  }

  function closeField() {
    field.hidden = true;
    options.hidden = true;
    input.value = '';
    input.setAttribute('aria-expanded', 'false');
    renderTags();
  }
  async function openField() {
    field.hidden = false;
    renderTags();
    input.focus();
    showOptions();
    try {
      known = (await tagList()) || [];
    } catch {
      known = known || [];
    }
    if (!field.hidden) showOptions();
  }
  function showOptions() {
    const typed = input.value;
    const key = tagKey(typed);
    suggestions = suggestTags(known || [], typed, value.tags).map((tag) => ({
      name: tag.name,
      label: t('docNotesTagCount', tag.name, String(tag.count)),
    }));
    const exact = (known || []).some((tag) => tagKey(tag.name) === key);
    const own = value.tags.some((tag) => tagKey(tag) === key);
    if (key && !exact && !own)
      suggestions.push({ name: cleanTag(typed), label: t('docNotesTagCreate', cleanTag(typed)) });
    active = Math.min(active, Math.max(0, suggestions.length - 1));
    options.replaceChildren();
    suggestions.forEach((option, index) => {
      const item = make('li', 'dn-option', option.label);
      item.id = `${id}-option-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === active));
      // mousedown keeps the focus in the field, which would otherwise close first.
      item.onmousedown = (event) => event.preventDefault();
      item.onclick = () => pick(option);
      options.append(item);
    });
    options.hidden = !suggestions.length;
    input.setAttribute('aria-expanded', String(!options.hidden));
    if (suggestions.length) input.setAttribute('aria-activedescendant', `${id}-option-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }
  function pick(option) {
    if (!option?.name) return;
    input.value = '';
    active = 0;
    void changeTags({ add: [option.name] }).then(() => !field.hidden && showOptions());
  }
  add.onclick = () => void openField();
  input.oninput = () => {
    active = 0;
    showOptions();
  };
  input.onkeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!suggestions.length) return;
      active =
        (active + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      showOptions();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (input.value.trim()) pick(suggestions[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeField();
      add.focus();
    } else if (event.key === 'Backspace' && !input.value && value.tags.length && !busyTags) {
      event.preventDefault();
      void changeTags({ remove: [value.tags.at(-1)] });
    }
  };
  input.onblur = () => setTimeout(() => document.activeElement !== input && closeField(), 150);

  function renderComment() {
    commentBox.replaceChildren();
    showEmpty();
    if (!editing) {
      if (value.comment) {
        const text = make('p', 'dn-comment-text', value.comment);
        text.title = t('docNotesComment');
        commentBox.append(text);
      }
      if (editable) {
        const open = make(
          'button',
          'dn-comment-open',
          t(value.comment ? 'docNotesCommentEdit' : 'docNotesCommentAdd'),
        );
        open.type = 'button';
        open.onclick = () => {
          if (beforeEdit?.() === false) return;
          editing = { base: value.comment, text: value.comment, busy: false, error: '' };
          renderComment();
          const area = commentBox.querySelector('textarea');
          area.focus();
          area.setSelectionRange(area.value.length, area.value.length);
        };
        commentBox.append(open);
      }
      return;
    }
    const form = make('form', 'dn-comment-form');
    const label = make('label', 'dn-comment-label', t('docNotesComment'));
    const area = make('textarea');
    area.id = id + '-comment';
    label.htmlFor = area.id;
    area.rows = compact ? 3 : 5;
    area.maxLength = 20000;
    area.value = editing.text;
    area.placeholder = t('docNotesCommentPlaceholder');
    area.oninput = () => (editing.text = area.value);
    const error = make('p', 'dn-error', editing.error);
    error.setAttribute('role', 'alert');
    error.hidden = !editing.error;
    const row = make('div', 'dn-row');
    const hint = make('small', '', t('highlightNoteHint'));
    const cancel = make('button', '', t('highlightNoteCancel'));
    cancel.type = 'button';
    const submit = make('button', 'dn-save', t('highlightNoteSave'));
    submit.type = 'submit';
    cancel.disabled = submit.disabled = editing.busy;
    row.append(hint, cancel, submit);
    form.append(label, area, error, row);
    commentBox.append(form);
    const close = () => {
      editing = null;
      renderComment();
      commentBox.querySelector('.dn-comment-open')?.focus();
    };
    cancel.onclick = close;
    area.onkeydown = (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const target = editing;
      if (!target || target.busy) return;
      target.busy = true;
      target.error = '';
      renderComment();
      try {
        const result = await save({ comment: target.text.trim(), base: target.base });
        if (result) {
          value.comment = result.comment ?? target.text.trim();
          if (Array.isArray(result.tags)) value.tags = result.tags;
          if (result.kept) onError?.(t('docNotesKept'));
        }
        if (editing === target) close();
        renderTags();
      } catch (failure) {
        target.busy = false;
        target.error = t('docNotesCommentFailed', failure?.message || String(failure));
        if (editing === target) {
          renderComment();
          commentBox.querySelector('textarea')?.focus();
        }
      }
    };
  }

  return {
    element: root,
    // Shows a document's comment and tags. An open editor keeps its draft.
    set(next, options = {}) {
      value = {
        comment: typeof next?.comment === 'string' ? next.comment : '',
        tags: Array.isArray(next?.tags) ? [...next.tags] : [],
      };
      editable = options.editable !== false;
      if (!editable) editing = null;
      renderTags();
      if (!editing) renderComment();
    },
    dirty: () => !!editing && editing.text.trim() !== (editing.base || '').trim(),
    draft: () => editing && { text: editing.text, base: editing.base },
    discard() {
      editing = null;
      renderComment();
    },
    // Opens the editor with a draft (the side panel's draft for another document).
    edit(draft) {
      editing = { base: draft.base, text: draft.text, busy: false, error: '' };
      renderComment();
    },
    save: () => commentBox.querySelector('form')?.requestSubmit(),
  };
}
