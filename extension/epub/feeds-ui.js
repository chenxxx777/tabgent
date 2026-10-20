// The library's Subscriptions tab: add feeds (by feed or website address, or from OPML),
// manage them, and list their items. The service worker fetches every address; this page
// only reads fetched pages with DOMParser (an inert document) to find their feeds.
import { t, loadTimeData } from '../i18n.js';
import { clipViewerUrl } from '../clip-routing.js';

const $ = (selector) => document.querySelector(selector);
const FEED_TYPES =
  /^(application\/(rss|atom)\+xml|application\/feed\+json|application\/(rdf\+)?xml|text\/xml|application\/json)$/;
const COMMON_PATHS = ['/feed', '/rss', '/rss.xml', '/atom.xml', '/feed.xml', '/index.xml'];
const INTERVALS = [30, 60, 180, 360, 720, 1440];
const PAGE = 50;

// Feeds a web page declares with <link rel="alternate">, resolved against the page address.
export function discoverFeeds(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let base = pageUrl;
  try {
    const declared = doc.querySelector('base[href]')?.getAttribute('href');
    if (declared) base = new URL(declared, pageUrl).href;
  } catch {}
  const found = [];
  for (const link of doc.querySelectorAll('link[rel~="alternate" i][href]')) {
    const type = (link.getAttribute('type') || '').split(';')[0].trim().toLowerCase();
    if (!FEED_TYPES.test(type)) continue;
    let url;
    try {
      url = new URL(link.getAttribute('href'), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = '';
    if (found.some((feed) => feed.url === url.href)) continue;
    found.push({
      url: url.href,
      title: (link.getAttribute('title') || '').trim().slice(0, 200),
      type,
    });
  }
  return found.slice(0, 20);
}

export function initFeeds({ send, toast, destination }) {
  const state = {
    sources: [],
    sourceId: null,
    view: 'unread',
    offset: 0,
    paused: false,
    shown: false,
  };
  const language = chrome.i18n.getUILanguage();
  const relativeFormat = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const dates = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });
  const status = (text) => ($('#feedStatus').textContent = text || '');
  const message = (error) => error?.message || String(error);

  function relative(value) {
    const at = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isNaN(at)) return '';
    const seconds = (at - Date.now()) / 1000;
    for (const [unit, size] of [
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
    ])
      if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
    return relativeFormat.format(0, 'minute');
  }
  function duration(minutes) {
    const hours = minutes >= 60 && minutes % 60 === 0;
    return new Intl.NumberFormat(language, {
      style: 'unit',
      unit: hours ? 'hour' : 'minute',
      unitDisplay: 'long',
    }).format(hours ? minutes / 60 : minutes);
  }
  const element = (tag, properties = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), properties);
    node.append(...children.filter((child) => child != null && child !== ''));
    return node;
  };

  // Adding: a feed address is previewed; a website address is searched for its feeds.
  $('#feedAddForm').onsubmit = (event) => {
    event.preventDefault();
    void add($('#feedUrl').value);
  };
  async function add(value) {
    const found = $('#feedFound');
    found.hidden = true;
    found.replaceChildren();
    if (!value.trim()) return;
    $('#feedAdd').disabled = true;
    status(t('feedsChecking'));
    try {
      const probed = await send({ type: 'feedsProbe', url: value });
      if (probed.kind === 'feed') return void preview(probed);
      let candidates = discoverFeeds(probed.html, probed.url);
      if (candidates.length === 1) return void preview(await probeFeed(candidates[0].url));
      if (!candidates.length) {
        const origin = new URL(probed.url).origin;
        for (const path of COMMON_PATHS) {
          const result = await probeFeed(origin + path).catch(() => null);
          if (result) return void preview(result);
        }
        return status(t('feedsNotFound'));
      }
      status('');
      found.hidden = false;
      found.append(
        element('p', { textContent: loadTimeData.getStringF('feedsFound', candidates.length) }),
        element(
          'ul',
          {},
          ...candidates.map((candidate) =>
            element(
              'li',
              {},
              element('button', {
                textContent: candidate.title || candidate.url,
                title: candidate.url,
                onclick: async () => {
                  status(t('feedsChecking'));
                  try {
                    preview(await probeFeed(candidate.url));
                  } catch (error) {
                    status(loadTimeData.getStringF('feedsAddFailed', message(error)));
                  }
                },
              }),
              element('span', { className: 'meta', textContent: candidate.type }),
            ),
          ),
        ),
      );
    } catch (error) {
      status(loadTimeData.getStringF('feedsAddFailed', message(error)));
    } finally {
      $('#feedAdd').disabled = false;
    }
  }
  async function probeFeed(url) {
    const result = await send({ type: 'feedsProbe', url });
    if (result.kind !== 'feed') throw Error(t('feedsNotFound'));
    return result;
  }
  function preview({ url, preview }) {
    status('');
    const found = $('#feedFound');
    found.replaceChildren();
    found.hidden = false;
    const known = state.sources.find((source) => source.url === url);
    const subscribe = element('button', {
      className: 'primary',
      textContent: known ? t('feedsSubscribed') : t('feedsSubscribe'),
      disabled: !!known,
      onclick: async () => {
        subscribe.disabled = true;
        status(t('feedsChecking'));
        try {
          const result = await send({ type: 'feedsSubscribe', url, title: preview.title });
          found.hidden = true;
          $('#feedUrl').value = '';
          status(
            loadTimeData.getStringF(
              'feedsSubscribedNew',
              result.source.title || result.source.url,
              result.new,
            ),
          );
          state.sourceId = result.source.id;
          await load();
        } catch (error) {
          subscribe.disabled = false;
          status(loadTimeData.getStringF('feedsAddFailed', message(error)));
        }
      },
    });
    found.append(
      element('p', { className: 'title', textContent: preview.title || url }),
      element('p', {
        className: 'meta',
        textContent: [url, loadTimeData.getStringF('feedsItemCount', preview.count)].join(' · '),
      }),
      element(
        'ul',
        {},
        ...preview.items.map((item) =>
          element('li', { textContent: item.title || t('epubUntitled') }),
        ),
      ),
      subscribe,
    );
  }

  // OPML: the connector reads the file with the same hardened parser as feeds.
  $('#feedImport').onclick = () => $('#feedOpml').click();
  $('#feedOpml').onchange = () => {
    const file = $('#feedOpml').files[0];
    $('#feedOpml').value = '';
    if (file) void importFile(file);
  };
  async function importFile(file) {
    const found = $('#feedFound');
    found.replaceChildren();
    found.hidden = true;
    try {
      if (file.size > 2 * 1024 * 1024) throw Error(t('feedsOpmlTooLarge'));
      const { outlines } = await send({ type: 'feedsOpmlParse', text: await file.text() });
      if (!outlines.length) return status(t('feedsOpmlEmpty'));
      const known = new Set(state.sources.map((source) => source.url));
      const boxes = outlines.map((outline) => {
        const box = element('input', { type: 'checkbox', checked: !known.has(outline.url) });
        box.disabled = known.has(outline.url);
        return box;
      });
      const already = outlines.filter((outline) => known.has(outline.url)).length;
      const confirm = element('button', {
        className: 'primary',
        textContent: loadTimeData.getStringF(
          'feedsImportPreview',
          outlines.length - already,
          already,
        ),
        onclick: async () => {
          const chosen = outlines.filter(
            (_, index) => boxes[index].checked && !boxes[index].disabled,
          );
          confirm.disabled = true;
          try {
            const result = await send({ type: 'feedsImport', outlines: chosen });
            found.hidden = true;
            status(loadTimeData.getStringF('feedsImported', result.created));
            await load();
          } catch (error) {
            confirm.disabled = false;
            status(loadTimeData.getStringF('feedsAddFailed', message(error)));
          }
        },
      });
      found.append(
        element(
          'ul',
          { className: 'outlines' },
          ...outlines.map((outline, index) =>
            element(
              'li',
              {},
              element(
                'label',
                {},
                boxes[index],
                ' ',
                outline.title || outline.url,
                known.has(outline.url) ? ` (${t('feedsSubscribed')})` : '',
              ),
              element('span', {
                className: 'meta',
                textContent: [outline.category, outline.url].filter(Boolean).join(' · '),
              }),
            ),
          ),
        ),
        confirm,
      );
      found.hidden = false;
      status('');
    } catch (error) {
      status(loadTimeData.getStringF('feedsAddFailed', message(error)));
    }
  }
  $('#feedExport').onclick = async () => {
    try {
      const { text } = await send({ type: 'feedsOpmlExport' });
      const link = element('a', {
        href: URL.createObjectURL(new Blob([text], { type: 'text/x-opml' })),
        download: 'tabgent-subscriptions.opml',
      });
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    } catch (error) {
      toast(loadTimeData.getStringF('feedsAddFailed', message(error)));
    }
  };
  $('#feedRefreshAll').onclick = () => void refresh();
  async function refresh(sourceId) {
    status(t('feedsRefreshing'));
    try {
      const result = await send({ type: 'feedsRefresh', ...(sourceId ? { sourceId } : {}) });
      status(loadTimeData.getStringF('feedsRefreshed', result.checked, result.new));
    } catch (error) {
      status(loadTimeData.getStringF('feedsAddFailed', message(error)));
    }
    await load();
  }
  $('#feedPauseAll').onchange = async () => {
    const paused = $('#feedPauseAll').checked;
    await send({ type: 'feedsPause', paused });
    state.paused = paused;
  };
  for (const button of document.querySelectorAll('#feedViews [data-view]'))
    button.onclick = () => setView(button.dataset.view);
  function setView(view) {
    state.view = view;
    for (const button of document.querySelectorAll('#feedViews [data-view]'))
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    $('#feedMarkAll').hidden = view !== 'unread';
    void loadItems();
  }
  $('#feedMarkAll').onclick = async () => {
    const count = state.sourceId
      ? state.sources.find((source) => source.id === state.sourceId)?.unread || 0
      : state.sources.reduce((sum, source) => sum + source.unread, 0);
    if (!count) return;
    if (count > 20 && !confirm(loadTimeData.getStringF('feedsMarkAllConfirm', count))) return;
    await send({ type: 'feedsMarkAll', ...(state.sourceId ? { sourceId: state.sourceId } : {}) });
    await load();
  };
  $('#feedMore').onclick = () => void loadItems(true);

  // Subscriptions, with their state and settings.
  function sourceStatus(source) {
    if (source.settings.paused) return t('feedsPaused');
    if (source.status === 'gone') return t('feedsGone');
    if (source.status === 'refused') return t('feedsRefused');
    if (source.failures)
      return loadTimeData.getStringF('feedsFailed', source.lastError, relative(source.nextFetchAt));
    return source.lastFetchAt
      ? loadTimeData.getStringF('feedsUpdated', relative(source.lastFetchAt))
      : t('feedsNotChecked');
  }
  function sourceItem(source) {
    const select = element(
      'button',
      {
        className: 'name',
        title: source.url,
        onclick: () => choose(source.id),
      },
      element('span', { textContent: source.title || source.url }),
      source.unread
        ? element('span', { className: 'count', textContent: String(source.unread) })
        : null,
    );
    select.setAttribute('aria-pressed', String(state.sourceId === source.id));
    const failing = source.failures || source.status !== 'active';
    const actions = element(
      'div',
      { className: 'actions' },
      element('button', {
        textContent: failing ? t('feedsRetry') : t('feedsRefresh'),
        onclick: async () => {
          if (failing) await send({ type: 'feedsUpdate', sourceId: source.id, retry: true });
          await refresh(source.id);
        },
      }),
      settings(source),
    );
    return element(
      'li',
      { className: failing ? 'source failing' : 'source' },
      select,
      element('span', { className: 'meta', textContent: sourceStatus(source) }),
      actions,
    );
  }
  function settings(source) {
    const title = element('input', { type: 'text', value: source.title, maxLength: 500 });
    const category = element('input', { type: 'text', value: source.category, maxLength: 200 });
    const interval = element(
      'select',
      {},
      element('option', { value: '', textContent: t('feedsIntervalAuto') }),
      ...INTERVALS.map((minutes) =>
        element('option', { value: String(minutes), textContent: duration(minutes) }),
      ),
    );
    interval.value = source.settings.interval ? String(source.settings.interval) : '';
    const fullText = element(
      'select',
      {},
      ...['auto', 'always', 'never'].map((mode) =>
        element('option', {
          value: mode,
          textContent: t('feedsFullText' + mode[0].toUpperCase() + mode.slice(1)),
        }),
      ),
    );
    fullText.value = source.settings.fullText || 'auto';
    const images = element('input', {
      type: 'checkbox',
      checked: source.settings.images !== false,
    });
    const paused = element('input', { type: 'checkbox', checked: !!source.settings.paused });
    const save = element('button', {
      className: 'primary',
      textContent: t('feedsSave'),
      onclick: async () => {
        try {
          await send({
            type: 'feedsUpdate',
            sourceId: source.id,
            title: title.value,
            category: category.value,
            settings: {
              interval: interval.value ? Number(interval.value) : null,
              paused: paused.checked,
              fullText: fullText.value,
              images: images.checked,
            },
          });
          await load();
        } catch (error) {
          toast(loadTimeData.getStringF('feedsAddFailed', message(error)));
        }
      },
    });
    const remove = element('button', {
      className: 'danger',
      textContent: t('feedsUnsubscribe'),
      onclick: async () => {
        const name = source.title || source.url;
        if (
          !confirm(
            `${loadTimeData.getStringF('feedsUnsubscribeConfirm', name)}\n${t('feedsUnsubscribeKeeps')}`,
          )
        )
          return;
        await send({ type: 'feedsUnsubscribe', sourceId: source.id });
        if (state.sourceId === source.id) state.sourceId = null;
        await load();
      },
    });
    const field = (label, control) =>
      element('label', {}, element('span', { textContent: t(label) }), control);
    return element(
      'details',
      {},
      element('summary', { textContent: t('feedsSettings') }),
      element(
        'div',
        { className: 'settings' },
        field('feedsName', title),
        field('feedsCategory', category),
        field('feedsInterval', interval),
        field('feedsFullTextMode', fullText),
        element('label', { className: 'check' }, images, ' ', t('feedsImages')),
        element('label', { className: 'check' }, paused, ' ', t('feedsPause')),
        element('p', { className: 'meta', textContent: source.url }),
        element('div', { className: 'row' }, remove, save),
      ),
    );
  }
  function choose(sourceId) {
    state.sourceId = sourceId;
    renderSources();
    void loadItems();
  }
  function renderSources() {
    const total = state.sources.reduce((sum, source) => sum + source.unread, 0);
    const all = element(
      'button',
      { className: 'name', onclick: () => choose(null) },
      element('span', { textContent: t('feedsAll') }),
      total ? element('span', { className: 'count', textContent: String(total) }) : null,
    );
    all.setAttribute('aria-pressed', String(!state.sourceId));
    const list = [element('li', { className: 'source all' }, all)];
    let category = null;
    for (const source of state.sources) {
      if (source.category && source.category !== category)
        list.push(element('li', { className: 'category', textContent: source.category }));
      category = source.category;
      list.push(sourceItem(source));
    }
    $('#feedSources').replaceChildren(...list);
  }

  // The inbox: items newest first, one per address. An item opens in Tabgent's reader in this
  // tab; its page opens by its address without tracking parameters.
  async function loadItems(more = false) {
    state.offset = more ? state.offset + PAGE : 0;
    const list = $('#feedItems');
    if (!more) list.replaceChildren();
    try {
      const { items, total } = await send({
        type: 'feedsList',
        view: state.view,
        limit: PAGE,
        offset: state.offset,
        ...(state.sourceId ? { sourceId: state.sourceId } : {}),
      });
      for (const item of items) list.append(feedItem(item));
      $('#feedMore').hidden = state.offset + items.length >= total;
      $('#feedItemsStatus').textContent = list.children.length
        ? ''
        : t(state.sources.length ? 'feedsEmpty' : 'feedsNone');
    } catch (error) {
      $('#feedItemsStatus').textContent = loadTimeData.getStringF('feedsAddFailed', message(error));
    }
  }
  const web = (value) => /^https?:\/\//i.test(value || '');
  // Where an entry opens: a feed item, or a saved webpage with its clip, in the reader; other
  // documents where the library opens them.
  function opens(item) {
    if (item.kind === 'item' || (item.documentKind === 'web' && item.clip))
      return clipViewerUrl(item.url);
    return (
      destination?.({
        kind: item.documentKind,
        url: item.url,
        id: item.documentId,
        clip: null,
        source: true,
      })?.href || ''
    );
  }
  async function mark(item, change) {
    try {
      // A saved item's later or archive state is its document's.
      if (item.saved && change.state)
        await send({
          type: 'feedsDocumentState',
          url: item.url,
          state: change.state === 'inbox' ? null : change.state,
        });
      else if (!item.saved) await send({ type: 'feedsMark', urls: [item.url], ...change });
      await load();
    } catch (error) {
      toast(loadTimeData.getStringF('feedsAddFailed', message(error)));
    }
  }
  const actions = {
    read: (item) => !item.saved && mark(item, { read: !item.read }),
    later: (item) => mark(item, { state: item.state === 'later' ? 'inbox' : 'later' }),
    archive: (item) => mark(item, { state: item.state === 'archive' ? 'inbox' : 'archive' }),
    original: (item) =>
      web(item.link) &&
      window.open(item.url && web(item.url) ? item.url : item.link, '_blank', 'noopener'),
    open: (item) => {
      const href = opens(item);
      if (href) location.href = href;
    },
  };
  const rows = new WeakMap();
  function feedItem(item) {
    const href = opens(item);
    const title = element(href ? 'a' : 'span', {
      className: 'title',
      textContent: item.title || t('epubUntitled'),
    });
    if (href) title.href = href;
    const published = Date.parse(item.publishedAt || item.firstSeenAt);
    const button = (key, label, pressed) => {
      const node = element('button', {
        textContent: t(label),
        onclick: () => void actions[key](item),
      });
      if (pressed !== undefined) node.setAttribute('aria-pressed', String(pressed));
      return node;
    };
    const row = element(
      'li',
      { className: `feed-item${item.read ? '' : ' unread'}`, tabIndex: -1 },
      title,
      element('span', {
        className: 'meta',
        textContent: [
          item.saved ? t('feedsSaved') : '',
          item.sources.length ? loadTimeData.getStringF('feedsFrom', item.sources.join(', ')) : '',
          item.author,
          Number.isNaN(published) ? '' : dates.format(published),
        ]
          .filter(Boolean)
          .join(' · '),
      }),
      item.summary ? element('p', { className: 'summary', textContent: item.summary }) : null,
      element(
        'div',
        { className: 'actions' },
        item.saved ? null : button('read', item.read ? 'feedsMarkUnread' : 'feedsMarkRead'),
        button('later', 'feedsLater', item.state === 'later'),
        button('archive', 'feedsArchive', item.state === 'archive'),
        web(item.link) ? button('original', 'clipOriginal') : null,
      ),
    );
    rows.set(row, item);
    return row;
  }
  // Keys in the list: j/k move, Enter or o opens, m read, l later, e archive, v original page.
  const KEYS = { m: 'read', l: 'later', e: 'archive', v: 'original', o: 'open', Enter: 'open' };
  addEventListener('keydown', (event) => {
    if (!state.shown || $('#feedsPanel').hidden || event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target?.closest?.('input, textarea, select, [contenteditable], details, dialog'))
      return;
    const list = [...$('#feedItems').children];
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    if (event.key === 'j' || event.key === 'k') {
      const next = list[Math.max(0, Math.min(list.length - 1, at + (event.key === 'j' ? 1 : -1)))];
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    } else if (KEYS[event.key] && at >= 0) {
      if (event.key === 'Enter' && event.target !== list[at]) return;
      void actions[KEYS[event.key]](rows.get(list[at]));
    } else return;
    event.preventDefault();
  });

  async function load() {
    try {
      const result = await send({ type: 'feedsSources' });
      state.sources = result.sources;
      state.paused = result.paused;
      $('#feedPauseAll').checked = result.paused;
      if (state.sourceId && !state.sources.some((source) => source.id === state.sourceId))
        state.sourceId = null;
      renderSources();
      await loadItems();
    } catch (error) {
      status(loadTimeData.getStringF('epubBooksUnavailable', message(error)));
    }
  }

  // A scheduled check in the service worker changed the subscriptions.
  let reload;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.feedsChangedAt || !state.shown) return;
    clearTimeout(reload);
    reload = setTimeout(() => void load(), 300);
  });

  return {
    show() {
      state.shown = true;
      return load();
    },
    hide() {
      state.shown = false;
    },
    importFile,
  };
}
