// Library-only UI: the connector searches saved Markdown; feed inbox items stay in feeds.
import { t, loadTimeData } from '../i18n.js';

const $ = (id) => document.getElementById(id);
const TYPES = {
  title: 'libraryMatchTitle',
  author: 'libraryMatchAuthor',
  url: 'libraryMatchUrl',
  comment: 'libraryMatchComment',
  highlight: 'libraryMatchHighlight',
  body: 'libraryMatchBody',
  discussion: 'libraryMatchDiscussion',
};
const fields = [
  'libraryCategory',
  'libraryState',
  'libraryHasComments',
  'libraryHasHighlights',
  'libraryDiscussions',
];
const key = (tag) => tag.normalize('NFC').trim().replace(/^#+/, '').toLowerCase();

export function initLibrarySearch({
  send,
  positions,
  renderItem,
  explain,
  beforeRender,
  afterRender = () => {},
  // True while the list holds something a search would disturb (a comment being edited):
  // returning to the window does not search again then.
  busy = () => false,
}) {
  let version = 0,
    timer,
    tags = [],
    selected = [],
    items = [],
    total = 0;
  let visible = false;
  const query = () => ({
    query: $('libraryQuery').value.trim(),
    category: $('libraryCategory').value,
    state: $('libraryState').value,
    hasComments: $('libraryHasComments').checked,
    hasHighlights: $('libraryHasHighlights').checked,
    includeDiscussions: $('libraryDiscussions').checked,
    tags: [...selected],
  });
  function schedule() {
    ++version;
    clearTimeout(timer);
    activeFilters();
    timer = setTimeout(() => void run(), 180);
  }
  $('librarySearchForm').onsubmit = (event) => {
    event.preventDefault();
    schedule();
  };
  $('libraryQuery').oninput = schedule;
  for (const id of fields) $(id).onchange = schedule;
  $('libraryClear').onclick = () => {
    $('libraryQuery').value = '';
    $('libraryCategory').value = '';
    $('libraryState').value = '';
    for (const id of fields.slice(2)) $(id).checked = false;
    selected = [];
    renderTags();
    schedule();
    $('libraryQuery').focus();
  };
  $('libraryMore').onclick = () => void run(true);
  document.addEventListener('library-filter-tag', ({ detail }) => {
    if (typeof detail !== 'string' || !detail.trim()) return;
    if (!selected.some((tag) => key(tag) === key(detail))) selected.push(detail);
    renderTags();
    schedule();
  });
  // Returning from Obsidian updates the same query, including edits to tags and comments.
  addEventListener('focus', () => {
    if (visible && !busy()) schedule();
  });
  document.addEventListener('visibilitychange', () => {
    if (visible && !document.hidden && !busy()) schedule();
  });

  function renderTags() {
    const box = $('libraryTagChoices');
    box.replaceChildren();
    for (const tag of [...new Set([...tags, ...selected])]) {
      const label = document.createElement('label'),
        input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selected.some((value) => key(value) === key(tag));
      input.onchange = () => {
        selected = selected.filter((value) => key(value) !== key(tag));
        if (input.checked) selected.push(tag);
        schedule();
      };
      label.append(input, document.createTextNode(tag));
      box.append(label);
    }
    if (!box.childElementCount) box.textContent = t('libraryNoTags');
  }
  function chip(label, clear) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label + ' ×';
    button.setAttribute('aria-label', loadTimeData.getStringF('libraryRemoveFilter', label));
    button.onclick = () => {
      clear();
      renderTags();
      schedule();
    };
    $('libraryActiveFilters').append(button);
  }
  function activeFilters() {
    $('libraryActiveFilters').replaceChildren();
    if ($('libraryQuery').value.trim())
      chip($('libraryQuery').value.trim(), () => {
        $('libraryQuery').value = '';
      });
    for (const id of fields.slice(0, 2)) {
      const input = $(id);
      if (input.value)
        chip(input.selectedOptions[0].textContent, () => {
          input.value = '';
        });
    }
    for (const id of fields.slice(2)) {
      const input = $(id);
      if (input.checked)
        chip(input.parentElement.textContent.trim(), () => {
          input.checked = false;
        });
    }
    for (const tag of selected)
      chip('#' + tag, () => {
        selected = selected.filter((value) => value !== tag);
      });
    $('libraryClear').hidden = !$('libraryActiveFilters').childElementCount;
  }
  function matches(li, item) {
    if (!item.matches?.length) return;
    const base = li.querySelector('.item')?.getAttribute('href');
    const list = document.createElement('ul');
    list.className = 'libraryMatches';
    for (const match of item.matches) {
      const row = document.createElement('li'),
        link = document.createElement(base ? 'a' : 'span');
      link.className = 'libraryMatch';
      if (base) {
        const href = new URL(base, location.href);
        if (match.highlightId)
          href.hash = 'tabgent-highlight=' + encodeURIComponent(match.highlightId);
        link.href = href.href;
        if (href.protocol === 'file:')
          link.onclick = (event) => {
            event.preventDefault();
            void chrome.tabs.create({ url: link.href, active: !event.metaKey && !event.ctrlKey });
          };
      }
      const label = document.createElement('span'),
        text = document.createElement('span');
      label.className = 'matchType';
      label.textContent = t(TYPES[match.type] || 'libraryMatchBody');
      text.textContent = match.snippet;
      link.append(label, text);
      row.append(link);
      list.append(row);
    }
    li.append(list);
  }
  async function run(more = false) {
    clearTimeout(timer);
    const current = ++version,
      params = query(),
      offset = more ? items.length : 0;
    $('booksStatus').textContent = t('epubLoading');
    $('libraryMore').hidden = true;
    try {
      const [reply, seen] = await Promise.all([
        send({ type: 'librarySearch', ...params, offset }),
        positions(),
      ]);
      if (current !== version || !visible) return;
      items = more ? [...items, ...reply.documents] : reply.documents;
      total = reply.total;
      tags = reply.tags;
      renderTags();
      beforeRender();
      const list = $('books');
      list.replaceChildren();
      for (const item of items) {
        const li = renderItem(item, seen);
        matches(li, item);
        list.append(li);
      }
      $('booksStatus').textContent = total
        ? loadTimeData.getStringF('libraryResultCount', items.length, total)
        : t($('libraryActiveFilters').childElementCount ? 'libraryNoResults' : 'libraryEmpty');
      $('libraryMore').hidden = items.length >= total;
      afterRender();
    } catch (error) {
      if (current !== version || !visible) return;
      $('books').replaceChildren();
      $('booksStatus').textContent = loadTimeData.getStringF(
        'epubBooksUnavailable',
        explain(error),
      );
    }
  }
  return {
    show() {
      visible = true;
      activeFilters();
      return run();
    },
    hide() {
      visible = false;
      ++version;
      clearTimeout(timer);
    },
  };
}
