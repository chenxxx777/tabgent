// Reading conversations in the service worker: binds threads to vault documents and
// highlights, adds reading context to each message, and saves every completed turn.
// It runs here, not in the side panel, because the worker receives every app-server
// event for every session whether or not a view is open. The native host and its
// Codex processes stop with the worker's port, so the host would add no durability.
import { pageContextPrefix, readingContextPrefix } from './session-config.js';
import { selectionContextPrefix } from './ui/user-input.js';
import { documentUrl } from './vault-client.js';
import { isLocalFileUrl } from './local-files.js';
import { isSection } from './document-id.js';
import {
  appendParams,
  clip,
  documentTurnParams,
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
  clipSource = () => null,
  // A feed item shown in the reader and not saved yet becomes a vault document first.
  commitItem = async () => null,
  // A document's comment or tags changed: the library and readers of it show the change.
  notesChanged = () => {},
  filePdfDocument = () => undefined,
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
    // A PDF opened from the computer is named by its file hash once its viewer has read it;
    // fileUrl is the file's address, which the tab keeps across reloads.
    const file = filePdfDocument(tab);
    if (file !== undefined)
      return (
        file && {
          ...file,
          title: clip(page.title || tab.title || '', 500),
          fileUrl: documentUrl(pdfSource(tab.url)),
        }
      );
    const pdf = pdfSource(tab.url);
    // The clipped-page reader shows a webpage's clipped copy: its document is the page.
    const clipped = clipSource(tab.url);
    if (clipped)
      return {
        url: clipped,
        title: clip(page.title || tab.title || '', 500),
        kind: 'web',
        view: 'clip',
      };
    const url = documentUrl(pdf || page.url || tab.url || '');
    // An imported PDF is named by its file hash, like a book. A Markdown, text or HTML file from
    // the computer is named by its file:// URL, as a webpage by its address.
    if (
      !/^https?:/.test(url) &&
      !(pdf && /^urn:sha256:[0-9a-f]{64}$/.test(url)) &&
      !(!pdf && isLocalFileUrl(url))
    )
      return null;
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
    // A reloading local PDF viewer has not named its file yet: the tab still shows the
    // document remembered for that file.
    const known = s?.pageDocuments?.[tabId];
    if (
      !document &&
      known?.fileUrl &&
      filePdfDocument(tab) === null &&
      known.fileUrl === documentUrl(pdfSource(tab.url))
    )
      return known;
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
  // pageDocument call records the book the reader reports. A PDF from the computer is also
  // named by its hash; it is kept while the tab shows the same file.
  function navigated(s, tabId, url) {
    const known = s.pageDocuments?.[tabId];
    if (!known) return;
    const same =
      known.kind === 'epub'
        ? isEpubReaderUrl(url)
        : (known.fileUrl || known.url) === documentUrl(url);
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

  // Where a turn is saved: under the highlight its message quotes, else in the discussion of
  // the whole document (once the conversation is about it or it has notes), else nowhere.
  // A conversation follows one document and may discuss several of its highlights.
  function savingTarget(s, document, highlight, bound, exists) {
    if (!document || s.readingSave === false) return 'off';
    if (highlight?.highlightId) return 'highlight';
    return s.readingSave === true || bound || exists ? 'document' : 'off';
  }
  // s.reading: the document the conversation saves on (and the highlight it last asked
  // about). s.documentUrl: the document whose Ask AI the conversation takes, and
  // s.readingAt when it last did: a document's most recently used conversation continues.
  const boundTo = (s, document) =>
    s.reading && document && s.reading.url === document.url ? s.reading : null;
  const documentOf = (s) => s.documentUrl || s.reading?.url || null;
  function usedFor(s, url) {
    s.documentUrl = url;
    s.readingAt = Date.now();
  }

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
    // A question about a feed item saves the item first, so Codex can read its full text.
    if (current?.view === 'clip' && !current.closed)
      await commitItem(page.tabId, current.url).catch(() => null);
    // A quote saved as a highlight makes this message (and its turn) about that highlight,
    // whichever reader it came from. A message without one is about the whole document.
    const binding = highlightBinding(messageSelection(params), current || {});
    if (binding) s.reading = binding;
    // The conversation stays on its document while the companion page shows it.
    const bound = binding || boundTo(s, current);
    const document = bound
      ? { url: bound.url, title: bound.title || current?.title || '', kind: bound.kind }
      : current;
    const vaultValue = await vaultStatus();
    const resolved = vaultValue ? await resolveDocument(document) : null;
    const existing = resolved?.document?.createdAt ? resolved.document : null;
    const saving = savingTarget(s, document, binding, bound, !!existing);
    // A conversation that saves on a document is that document's conversation, which its
    // next Ask AI continues (focusHighlight).
    if (saving !== 'off') {
      if (!bound && existing)
        s.reading = {
          documentId: existing.id,
          highlightId: null,
          url: document.url,
          title: document.title,
          kind: document.kind,
        };
      usedFor(s, document.url);
    }
    // The user's own note on the message's highlight, read fresh for every message.
    const userNote = binding
      ? (resolved?.highlights || []).find((h) => h.id === binding.highlightId)?.note
      : '';
    // Earlier discussion of the highlight in other conversations, once per conversation.
    let notes = [];
    const noted = Array.isArray(s.readingNotes) ? s.readingNotes : [];
    const key = binding ? `${binding.documentId}/${binding.highlightId}` : null;
    if (key && vaultValue && !noted.includes(key)) {
      try {
        const discussion = await vault.request(
          'vault/discussion/get',
          { documentId: binding.documentId, highlightId: binding.highlightId },
          fast,
        );
        notes = earlierNotes(discussion.turns, s.threadId);
        s.readingNotes = [...noted, key].slice(-200);
      } catch {}
    }
    await persist();
    const part = readingContext({
      document: document && {
        ...document,
        id: binding ? binding.documentId : existing?.id,
        notes: clip(existing?.notesPath, 4096),
        // The user's own comment on the whole document and their tags for it.
        userComment: existing ? resolved?.comment : '',
        userTags: existing ? resolved?.tags : [],
        // The full text in the vault: an imported EPUB's or PDF's (a section per chapter
        // or page), or a clipped webpage's, whichever view the user reads.
        fullText:
          document.kind !== 'web' || resolved?.clip?.complete
            ? clip(existing?.fullTextPath, 4096)
            : '',
      },
      highlight: binding && {
        highlightId: binding.highlightId,
        location: binding.location,
        text: binding.text,
        attached: true,
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
    const bound =
      s.reading?.documentId === params.documentId && s.reading?.highlightId === params.highlightId;
    const result = await append(
      params,
      documentTurnParams(params, record, bound ? s.reading.text : ''),
    );
    const value = {
      ok: !result.error,
      queued: !!result.queued,
      highlightId: params.highlightId,
      message: result.error?.message || '',
      // The highlight was gone: the turn was saved on the document instead.
      ...(result.fallback ? { fallback: 'document' } : {}),
    };
    if (result.error?.code) value.code = result.error.code;
    if (typeof result.error?.folder === 'string' && result.error.folder)
      value.folder = result.error.folder;
    const savedUrl = result.document && documentUrl(result.document.url);
    if (
      result.document &&
      (result.fallback || !params.highlightId) &&
      (!s.reading || (s.reading.url === savedUrl && s.reading.documentId !== result.document.id))
    ) {
      // A page discussion keeps saving to the document it created (or created again).
      s.reading = {
        documentId: result.document.id,
        highlightId: null,
        url: savedUrl,
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

  // A turn whose highlight or document is no longer in the vault (deleted meanwhile) is
  // not lost: it is saved on the document instead (fallback, from documentTurnParams).
  async function append(params, fallback = null) {
    try {
      const result = await vault.request('vault/discussion/append', params);
      void flush();
      return { document: result.document };
    } catch (error) {
      if (error.code === 'not_found' && fallback)
        return { ...(await append(fallback)), fallback: true };
      if (permanent.has(error.code)) return { error };
      const entry = fallback ? { ...params, fallback } : params;
      const { [outboxKey]: queued = [] } = await chrome.storage.local.get(outboxKey);
      const key = (p) => p.threadId + '\n' + p.turnId;
      const next = [...queued.filter((p) => key(p) !== key(entry)), entry].slice(-outboxLimit);
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
        for (const entry of queued) {
          const { fallback, ...params } = entry;
          try {
            await vault.request('vault/discussion/append', params);
            done.add(entry);
          } catch (error) {
            if (error.code === 'not_found' && fallback)
              try {
                await vault.request('vault/discussion/append', fallback);
                done.add(entry);
                continue;
              } catch (retry) {
                error = retry;
              }
            if (permanent.has(error.code)) done.add(entry);
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

  // "Ask AI" and "Open discussion" on a highlight continue its document's conversation:
  // - a highlight already discussed opens the conversation that holds its latest turns,
  //   which the side panel shows (focusTurn);
  // - otherwise the view's conversation when it is about this document or still empty;
  // - otherwise the document's most recently used conversation, or the one its latest
  //   saved turn is in, or a new one.
  // "New conversation" in the side panel starts an empty one on the page's document
  // (started), which its next Ask AI uses.
  async function focusHighlight(selection, view) {
    await loaded;
    const ref = selectionHighlight(selection);
    if (!ref) {
      const error = Error('Invalid highlight');
      error.code = 'invalid_highlight';
      throw error;
    }
    const binding = highlightBinding(selection);
    let latest = null;
    try {
      const discussion = await vault.request('vault/discussion/get', ref, fast);
      latest = discussion.turns?.at(-1) || null;
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
    const open = (threadId) =>
      current.threadId === threadId
        ? current
        : [...sessions.values()].find((s) => s.threadId === threadId && !s.closedTab) ||
          newSession(current, view, owner, threadId);
    let target = current;
    if (latest?.threadId) target = open(latest.threadId);
    else if (documentOf(current) !== binding.url) {
      const recent = [...sessions.values()]
        .filter((s) => s !== current && !s.closedTab && documentOf(s) === binding.url)
        .sort((a, b) => (b.readingAt || 0) - (a.readingAt || 0))[0];
      const saved = recent ? null : await lastThread(binding);
      const empty = !current.hasUserInput && !current.turnPending;
      target = recent || (saved ? open(saved) : empty ? current : newSession(current, view, owner));
    }
    target.reading = binding;
    usedFor(target, binding.url);
    target.selection = selection;
    // The side panel scrolls to the highlight's latest turn in that conversation.
    target.focusTurn =
      latest?.threadId && target.threadId === latest.threadId
        ? { turnId: latest.turnId, at: Date.now() }
        : null;
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
    for (const port of target.ports) {
      event(port, 'codex-selection', target.selection);
      if (target.focusTurn) event(port, 'codex-focus-turn', target.focusTurn);
    }
    return { switched: target !== current, threadId: target.threadId || null };
  }
  // A conversation started with "New conversation" next to a document is that document's
  // most recently used one: its next Ask AI goes there.
  async function started(s, tabId) {
    const document = Number.isInteger(tabId) ? await pageDocument(tabId, {}, s) : null;
    if (document?.url) usedFor(s, document.url);
  }
  // The thread of the document's latest saved turn, to continue it after a restart.
  async function lastThread(binding) {
    try {
      const resolved = await vault.request(
        'vault/document/resolve',
        { url: binding.url, title: binding.title, kind: binding.kind },
        fast,
      );
      return resolved.lastThreadId || null;
    } catch {
      return null;
    }
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
    if (msg.type === 'readingTagList') return vault.request('vault/tags/list', {});
    if (msg.type === 'readingComment' || msg.type === 'readingTags') {
      // The page's document, or the one a draft was written for before the page changed.
      const current = msg.target ? null : await pageDocument(tabId, {}, source);
      const earlier = msg.target || (current?.url !== msg.page?.url && msg.page);
      const target = earlier ? draftTarget(earlier) : current;
      if (!target) throw Error('This page has no reading notes');
      // A feed item shown in the reader and not saved yet is saved first, as for a highlight.
      if (!earlier && target.view === 'clip' && !target.closed)
        await commitItem(tabId, target.url).catch(() => null);
      const params = { url: target.url, title: target.title, kind: target.kind };
      const strings = (value) =>
        (Array.isArray(value) ? value : [])
          .slice(0, 100)
          .filter((tag) => typeof tag === 'string')
          .map((tag) => tag.slice(0, 400));
      const result =
        msg.type === 'readingComment'
          ? await vault.request('vault/document/comment', {
              ...params,
              comment: String(msg.comment ?? '').slice(0, 20000),
              ...(typeof msg.base === 'string' ? { base: msg.base.slice(0, 2000000) } : {}),
            })
          : await vault.request('vault/document/tags', {
              ...params,
              add: strings(msg.add),
              remove: strings(msg.remove),
            });
      await notesChanged(result);
      return { ...(await state(source, tabId)), result };
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
          // Books and PDFs named by their hash (imported, or opened from the computer), and
          // a closed page's last known document; a clipped page's reader names its page.
          url:
            document.kind === 'epub' || document.url.startsWith('urn:') || !tab
              ? document.url
              : pdfSource(tab.url) || clipSource(tab.url) || tab.url,
          title: document.title,
          frameId: 0,
          documentId: frame?.documentId,
          tabId,
          locator: {
            kind: document.kind,
            ...(clipSource(tab?.url) ? { view: 'clip' } : {}),
            anchor: highlight.anchor || null,
            // The EPUB reader names the chapter Codex reads from the book's full text
            // instead of the reader tab.
            ...(isSection(context?.section) && resolved.document.fullTextPath
              ? { section: context.section, fullText: resolved.document.fullTextPath }
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

  // The document a side panel draft belongs to: one the panel showed before its page changed.
  function draftTarget(value) {
    const url = typeof value?.url === 'string' ? documentUrl(value.url) : '';
    if (!url || url.length > 16384 || !['web', 'pdf', 'epub'].includes(value.kind)) return null;
    return { url, title: clip(value.title, 500), kind: value.kind };
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
      document: existing && { id: existing.id, notesPath: existing.notesPath },
      // The user's comment on the whole document and its tags, read from its note.
      comment: existing && typeof resolved.comment === 'string' ? resolved.comment : '',
      tags: existing && Array.isArray(resolved.tags) ? resolved.tags : [],
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
      // A message without a quote is saved on the document; the panel shows a quote's
      // highlight itself while one is attached.
      save: {
        explicit: source.readingSave ?? null,
        target: savingTarget(source, document, null, bound, !!existing),
      },
      error: resolved?.error?.message || null,
      ...(resolved?.error?.code ? { errorCode: resolved.error.code } : {}),
      ...(typeof resolved?.error?.folder === 'string' && resolved.error.folder
        ? { errorFolder: resolved.error.folder }
        : {}),
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

  return {
    input,
    notification,
    resumed,
    focusHighlight,
    started,
    message,
    flush,
    navigated,
    keepPage,
  };
}
