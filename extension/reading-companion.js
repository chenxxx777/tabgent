// Reading conversations in the service worker: binds threads to vault documents and
// highlights, adds reading context to each message, and saves every completed turn.
// It runs here, not in the side panel, because the worker receives every app-server
// event for every session whether or not a view is open. The native host and its
// Codex processes stop with the worker's port, so the host would add no durability.
import { pageContextPrefix, readingContextPrefix } from './session-config.js';
import { selectionContextPrefix } from './ui/user-input.js';
import { documentUrl } from './vault-client.js';
import {
  appendParams,
  clip,
  earlierNotes,
  highlightBinding,
  readingContext,
  readingTurn,
  recordedBinding,
  selectionHighlight,
  threadBinding,
} from './reading.js';

const fast = { timeout: 3000 };
const outboxKey = 'readingOutbox';
const outboxLimit = 100;
// Retrying cannot fix these: the request itself or its target is invalid.
const permanent = new Set(['invalid_params', 'not_found', 'unknown_method']);

export function createReadingCompanion({
  sessions,
  sidebarViews,
  agentViews,
  agentCompanions,
  highlightStatus,
  getSession,
  loaded,
  persist,
  event,
  vault,
  pdfSource,
  epubDocument = () => undefined,
  isEpubReaderUrl = () => false,
  tabMessage = (tabId, message) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
}) {
  const turns = new Map();
  let status = null,
    flushing = null;

  // Cached, including failure, so a missing or outdated connector costs one short
  // timeout now and then rather than one per message. Bindings never depend on it.
  async function vaultStatus(refresh = false) {
    if (!refresh && status && Date.now() - status.at < (status.value ? 60000 : 20000))
      return status.value;
    let value = null;
    try {
      value = await vault.request('vault/status', {}, fast);
    } catch {}
    status = { value, at: Date.now() };
    return value;
  }

  // The readable document behind a tab. The EPUB reader names its book by file hash.
  function tabDocument(tab, page = {}) {
    if (tab.incognito) return null;
    const book = epubDocument(tab);
    if (book !== undefined)
      return book && { ...book, title: clip(book.title || page.title || tab.title || '', 500) };
    const pdf = pdfSource(tab.url);
    const url = documentUrl(pdf || page.url || tab.url || '');
    // An imported PDF is named by its file hash, like a book.
    if (!/^https?:/.test(url) && !(pdf && /^urn:sha256:[0-9a-f]{64}$/.test(url))) return null;
    return { url, title: clip(page.title || tab.title || '', 500), kind: pdf ? 'pdf' : 'web' };
  }
  // The document a conversation's companion tab shows. Each one seen is remembered on the
  // session, so after the tab closes its Agent views keep the document: they still bind to
  // and save on it, and the closed page cannot be mistaken for another one.
  async function pageDocument(tabId, page = {}, s = null) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      const known = s?.pageDocuments?.[tabId];
      return known ? { ...known, closed: true } : null;
    }
    const document = tabDocument(tab, page);
    if (s && JSON.stringify(s.pageDocuments?.[tabId] ?? null) !== JSON.stringify(document)) {
      s.pageDocuments ||= {};
      if (document) s.pageDocuments[tabId] = document;
      else delete s.pageDocuments[tabId];
      await persist();
    }
    return document;
  }
  // A companion tab that navigates away no longer shows the document remembered for it.
  // The EPUB reader's address names the reader, not the book (a book's URL is its hash):
  // while the tab stays in the reader, such as on a reload, the book is kept, and the next
  // pageDocument call records the book the reader reports.
  function navigated(s, tabId, url) {
    const known = s.pageDocuments?.[tabId];
    if (!known) return;
    const same = known.kind === 'epub' ? isEpubReaderUrl(url) : known.url === documentUrl(url);
    if (!same) delete s.pageDocuments[tabId];
  }
  // A session opened in a view starts with what its source knows of the view's page, the
  // only record of that page once it has closed.
  function keepPage(target, source, tabId) {
    for (const key of ['pageUrls', 'pageDocuments']) {
      const known = source[key]?.[tabId];
      if (known && !target[key]?.[tabId]) (target[key] ||= {})[tabId] = structuredClone(known);
    }
  }
  const resolveDocument = (document) =>
    document
      ? vault
          .request(
            'vault/document/resolve',
            { url: document.url, title: document.title, kind: document.kind },
            fast,
          )
          .catch(() => null)
      : null;

  // What a conversation saves on its page: its highlight, the page discussion, or nothing.
  function savingTarget(s, document, bound, exists) {
    if (!document || s.readingSave === false) return 'off';
    if (bound?.highlightId) return 'highlight';
    return s.readingSave === true || bound || exists ? 'document' : 'off';
  }
  const boundTo = (s, document) =>
    s.reading && document && s.reading.url === document.url ? s.reading : null;

  function messageSelection(params) {
    const parse = (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };
    const value = params.additionalContext?.pageSelection?.value;
    if (typeof value === 'string') return parse(value);
    const part = (params.input || []).find(
      (p) => p.type === 'text' && p.text?.startsWith(selectionContextPrefix),
    );
    return part ? parse(part.text.slice(selectionContextPrefix.length)) : null;
  }

  // turn/start, turn/steer and thread/queue/add: adds the reading context part.
  async function input(s, params, page) {
    const parts = [...(params.input || [])];
    const recorded = parts.find(
      (p) => p.type === 'text' && p.text?.startsWith(readingContextPrefix),
    );
    if (recorded) {
      // Edited and forked messages keep their original record and binding.
      if (!s.reading) {
        const { reading } = readingTurn([{ type: 'userMessage', content: [recorded] }]);
        s.reading = recordedBinding(reading) || undefined;
        await persist();
      }
      return parts;
    }
    const current = Number.isInteger(page?.tabId) ? await pageDocument(page.tabId, page, s) : null;
    // A quote saved as a highlight binds the conversation, whichever reader it came from.
    const binding = highlightBinding(messageSelection(params), current || {});
    if (binding) {
      if (s.reading?.highlightId !== binding.highlightId) delete s.readingNotes;
      s.reading = binding;
    }
    // Follow-ups keep the binding while the companion page shows the same document.
    const bound = binding || boundTo(s, current);
    const document = bound
      ? { url: bound.url, title: bound.title || current?.title || '', kind: bound.kind }
      : current;
    const vaultValue = await vaultStatus();
    const resolved = vaultValue ? await resolveDocument(document) : null;
    const existing = resolved?.document?.createdAt ? resolved.document : null;
    const saving = savingTarget(s, document, bound, !!existing);
    // The user's own note on the bound highlight, read fresh for every message.
    const userNote = bound?.highlightId
      ? (resolved?.highlights || []).find((h) => h.id === bound.highlightId)?.note
      : '';
    let notes = [];
    const key = bound?.highlightId ? `${bound.documentId}/${bound.highlightId}` : null;
    if (key && vaultValue && s.readingNotes !== key) {
      try {
        const discussion = await vault.request(
          'vault/discussion/get',
          { documentId: bound.documentId, highlightId: bound.highlightId },
          fast,
        );
        notes = earlierNotes(discussion.turns, s.threadId);
        s.readingNotes = key;
      } catch {}
    }
    await persist();
    const part = readingContext({
      document: document && {
        ...document,
        id: bound?.highlightId ? bound.documentId : existing?.id,
        notes: existing?.highlightsPath,
        // An imported EPUB's text, one Markdown file per chapter (chapters/NN-<title>.md).
        chapters: document.kind === 'epub' && existing?.folder ? existing.folder + '/chapters' : '',
        // An imported PDF's text, one Markdown file per page with text (pages/NNN.md).
        pages:
          document.kind === 'pdf' && document.url.startsWith('urn:sha256:') && existing?.folder
            ? existing.folder + '/pages'
            : '',
        // A clipped webpage's full text (article.md), whichever view the user reads.
        article:
          document.kind === 'web' && existing && resolved?.clip?.complete
            ? clip(resolved.clip.articlePath, 4096)
            : '',
      },
      highlight: bound?.highlightId && {
        highlightId: bound.highlightId,
        location: bound.location,
        text: bound.text,
        attached: !!binding,
        userNote,
      },
      notes,
      vault: vaultValue,
      saving,
    });
    const at = parts.findIndex((p) => p.type === 'text' && p.text?.startsWith(pageContextPrefix));
    parts.splice(at + 1, 0, part);
    for (const port of s.ports) event(port, 'codex-reading-changed');
    return parts;
  }

  // Collects each turn's messages, then saves it on turn/completed.
  function notification(s, message) {
    const p = message.params || {};
    if (
      ['item/started', 'item/completed'].includes(message.method) &&
      ['userMessage', 'agentMessage'].includes(p.item?.type) &&
      p.turnId
    ) {
      const key = s.id + '\n' + p.turnId;
      if (!turns.has(key)) {
        turns.set(key, new Map());
        // Interrupted connections never complete their turns; keep the map bounded.
        if (turns.size > 200) turns.delete(turns.keys().next().value);
      }
      turns.get(key).set(p.item.id, p.item);
      return;
    }
    if (message.method !== 'turn/completed' || !p.turn?.id) return;
    const key = s.id + '\n' + p.turn.id;
    const collected = turns.get(key) || new Map();
    turns.delete(key);
    for (const item of p.turn.items || [])
      if (!collected.has(item.id)) collected.set(item.id, item);
    void save(s, p.threadId || s.threadId, p.turn, [...collected.values()]).catch(console.warn);
  }

  async function save(s, threadId, turn, items) {
    const record = readingTurn(items, chrome.i18n?.getMessage('selectionQuote') || '');
    if (s.readingSave === false) return;
    const params = appendParams(record, threadId, turn);
    if (!params) return;
    const result = await append(params);
    const value = {
      ok: !result.error,
      queued: !!result.queued,
      highlightId: params.highlightId,
      message: result.error?.message || '',
    };
    if (result.document && !params.highlightId && !s.reading?.highlightId) {
      // A page discussion keeps saving to the document it created.
      s.reading = {
        documentId: result.document.id,
        highlightId: null,
        url: documentUrl(result.document.url),
        title: result.document.title,
        kind: result.document.kind,
      };
      await persist();
    }
    for (const port of s.ports) event(port, 'codex-reading-saved', value);
    if (!result.error && Number.isInteger(record.page?.tabId))
      tabMessage(record.page.tabId, { type: 'tabgentHighlight', action: 'refresh' }).catch(
        () => {},
      );
  }

  async function append(params) {
    try {
      const result = await vault.request('vault/discussion/append', params);
      void flush();
      return { document: result.document };
    } catch (error) {
      if (permanent.has(error.code)) return { error };
      const { [outboxKey]: queued = [] } = await chrome.storage.local.get(outboxKey);
      const key = (p) => p.threadId + '\n' + p.turnId;
      const next = [...queued.filter((p) => key(p) !== key(params)), params].slice(-outboxLimit);
      await chrome.storage.local.set({ [outboxKey]: next });
      return { error, queued: true };
    }
  }

  // Failed saves wait in extension storage and retry; appends are idempotent per turn.
  function flush() {
    flushing ||= (async () => {
      try {
        const { [outboxKey]: queued = [] } = await chrome.storage.local.get(outboxKey);
        const done = new Set();
        for (const params of queued) {
          try {
            await vault.request('vault/discussion/append', params);
            done.add(params);
          } catch (error) {
            if (permanent.has(error.code)) done.add(params);
            else break;
          }
        }
        if (!done.size) return;
        const { [outboxKey]: latest = [] } = await chrome.storage.local.get(outboxKey);
        const finished = new Set([...done].map((p) => p.threadId + '\n' + p.turnId));
        await chrome.storage.local.set({
          [outboxKey]: latest.filter((p) => !finished.has(p.threadId + '\n' + p.turnId)),
        });
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  const newSession = (current, view, owner, threadId) => {
    const id = crypto.randomUUID();
    const session = {
      id,
      key: id,
      tabId: owner,
      threadId: threadId || undefined,
      hasUserInput: !!threadId,
      scope: current.scope,
      settings: current.settings,
      viewOnly: !!view.agentTabId,
      draft: '',
      ports: new Set(),
    };
    keepPage(session, current, view.tabId);
    sessions.set(id, session);
    return session;
  };

  // "Ask AI" and "Open discussion" on a highlight. A highlight with saved turns reopens
  // its latest thread; a new one gets its own thread unless the current one is empty.
  async function focusHighlight(selection, view) {
    await loaded;
    const ref = selectionHighlight(selection);
    if (!ref) throw Error('Invalid highlight');
    let latest = null;
    try {
      const discussion = await vault.request('vault/discussion/get', ref, fast);
      latest = discussion.turns?.at(-1)?.threadId || null;
    } catch {}
    const current = view.agentTabId
      ? sessions.get(agentViews.get(view.agentTabId))
      : await getSession(view.tabId);
    if (!current) throw Error('Conversation not found');
    // A new session belongs to an open tab: an Agent view whose page closed owns it.
    const owner =
      view.agentTabId && !(await chrome.tabs.get(view.tabId).catch(() => null))
        ? view.agentTabId
        : view.tabId;
    const same =
      current.reading?.documentId === ref.documentId &&
      current.reading?.highlightId === ref.highlightId;
    let target = current;
    if (latest && current.threadId !== latest)
      target =
        [...sessions.values()].find((s) => s.threadId === latest && !s.closedTab) ||
        newSession(current, view, owner, latest);
    else if (!latest && !same && (current.hasUserInput || current.turnPending))
      target = newSession(current, view, owner);
    if (target.reading?.highlightId !== ref.highlightId) delete target.readingNotes;
    target.reading = highlightBinding(selection);
    target.selection = selection;
    if (target !== current) {
      keepPage(target, current, view.tabId);
      if (view.agentTabId) agentViews.set(view.agentTabId, target.key);
      else sidebarViews.set(view.tabId, target.key);
    }
    await persist();
    if (target !== current && !view.agentTabId)
      for (const port of current.ports)
        if (!port.sender?.tab && port.companionTabId === view.tabId)
          event(port, 'codex-view-changed');
    for (const port of target.ports) event(port, 'codex-selection', target.selection);
    return { switched: target !== current, threadId: target.threadId || null };
  }

  // Side panel requests, scoped to the conversation and companion tab of the sender view.
  async function message(msg, sender) {
    await loaded;
    const source = sessions.get(msg.conversationKey);
    if (!source) throw Error('Conversation not found');
    const agentTabId = sender.tab && agentViews.has(sender.tab.id) ? sender.tab.id : null;
    const tabId = sender.tab
      ? (agentCompanions.get(sender.tab.id) ?? source.tabId)
      : (msg.companionTabId ?? source.tabId);
    if (msg.type === 'readingSave') {
      source.readingSave = !!msg.enabled;
      await persist();
      for (const port of source.ports) event(port, 'codex-reading-changed');
      return state(source, tabId);
    }
    if (msg.type === 'vaultConfigure') {
      const value = await vault.request('vault/configure', {
        path: String(msg.path || '').slice(0, 4096),
      });
      status = { value, at: Date.now() };
      return state(source, tabId);
    }
    if (msg.type === 'readingJump') {
      const result = await tabMessage(tabId, {
        type: 'tabgentHighlight',
        action: 'jump',
        highlightId: String(msg.highlightId),
      }).catch(() => null);
      return { found: !!result?.found };
    }
    if (msg.type === 'readingNote') {
      if (typeof msg.note !== 'string') throw Error('Invalid note');
      const { resolved, highlight } = await pageHighlight(source, tabId, msg);
      await vault.request('vault/highlight/update', {
        documentId: resolved.document.id,
        highlightId: highlight.id,
        note: msg.note.slice(0, 20000),
      });
      // The page's highlight actions show the new note; other views of the tab update.
      tabMessage(tabId, { type: 'tabgentHighlight', action: 'refresh' }).catch(() => {});
      for (const s of sessions.values())
        if (s.tabId === tabId) for (const port of s.ports) event(port, 'codex-reading-changed');
      return state(source, tabId);
    }
    if (msg.type === 'readingOpen') {
      const { document, resolved, highlight } = await pageHighlight(source, tabId, msg);
      const [frame, context] = await Promise.all([
        chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null),
        tabMessage(tabId, {
          type: 'tabgentHighlight',
          action: 'context',
          highlightId: highlight.id,
        }).catch(() => null),
      ]);
      // A closed page offers no live address or nearby text; the vault record names it.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      return focusHighlight(
        {
          selectionId: crypto.randomUUID(),
          id: crypto.randomUUID(),
          text: clip(highlight.text, 20000),
          truncated: false,
          url: document.kind === 'epub' || !tab ? document.url : pdfSource(tab.url) || tab.url,
          title: document.title,
          frameId: 0,
          documentId: frame?.documentId,
          tabId,
          locator: {
            kind: document.kind,
            anchor: highlight.anchor || null,
            // The EPUB reader names the chapter file Codex reads instead of the reader tab.
            ...(/^chapters\/[^/\\]+\.md$/.test(context?.chapterFile || '')
              ? { chapterFile: `${resolved.document.folder}/${context.chapterFile}` }
              : {}),
            capturedAt: new Date().toISOString(),
          },
          location: clip(highlight.location, 200),
          highlight: { documentId: resolved.document.id, highlightId: highlight.id },
          context: {
            before: clip(context?.before, 2000),
            after: clip(context?.after, 2000),
          },
        },
        { tabId, agentTabId },
      );
    }
    return state(source, tabId);
  }

  // A saved highlight of the document the tab shows, checked against the vault record.
  async function pageHighlight(source, tabId, msg) {
    const document = await pageDocument(tabId, {}, source);
    const resolved = document
      ? await vault.request('vault/document/resolve', {
          url: document.url,
          title: document.title,
          kind: document.kind,
        })
      : null;
    const highlight =
      resolved?.document?.id === msg.documentId &&
      (resolved.highlights || []).find((h) => h.id === msg.highlightId);
    if (!highlight) throw Error('Highlight not found on this page');
    return { document, resolved, highlight };
  }

  async function state(source, tabId) {
    const document = await pageDocument(tabId, {}, source);
    const [vaultValue, resolved] = await Promise.all([
      vaultStatus(true),
      document
        ? vault
            .request('vault/document/resolve', {
              url: document.url,
              title: document.title,
              kind: document.kind,
            })
            .catch((error) => ({ error }))
        : null,
    ]);
    const existing = resolved?.document?.createdAt ? resolved.document : null;
    const anchoring = highlightStatus.get(tabId);
    const known = !!existing && anchoring?.documentId === existing.id;
    const unanchored = new Set(known ? anchoring.unanchored : []);
    const bound = boundTo(source, document);
    return {
      vault: vaultValue,
      page: document,
      document: existing && { id: existing.id, highlightsPath: existing.highlightsPath },
      // The page's clipped text in the vault, for the reading notes menu.
      clip:
        existing && resolved?.clip?.clippedAt
          ? { clippedAt: resolved.clip.clippedAt, complete: !!resolved.clip.complete }
          : null,
      highlights: (resolved?.highlights || []).map((h) => ({
        id: h.id,
        text: clip(h.text, 400),
        location: h.location || '',
        note: typeof h.note === 'string' ? h.note : '',
        turnCount: h.turnCount || 0,
        anchored: known ? !unanchored.has(h.id) : null,
      })),
      binding: bound && {
        documentId: bound.documentId,
        highlightId: bound.highlightId,
        text: clip(bound.text, 300),
      },
      save: {
        explicit: source.readingSave ?? null,
        target: savingTarget(source, document, bound, !!existing),
      },
      error: resolved?.error?.message || null,
    };
  }

  // A resumed thread recovers its binding from its last reading context part.
  async function resumed(s, thread) {
    if (s.reading || !thread) return;
    const binding = threadBinding(thread);
    if (!binding) return;
    s.reading = binding;
    await persist();
    for (const port of s.ports) event(port, 'codex-reading-changed');
  }

  return { input, notification, resumed, focusHighlight, message, flush, navigated, keepPage };
}
