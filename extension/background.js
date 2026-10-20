import { cleanAnnotations } from './ui/annotations.js';
import { createUrlHistory } from './url-history.js';
import {
  startPdfRouting,
  pdfSource,
  isLocalPdf,
  isFilePdf,
  filePdfUrl,
  filePdfDocument,
  isCurrentPdfSender,
} from './pdf-routing.js';
import { isLocalFileUrl, startLocalFiles, fileAccessSettingsUrl } from './local-files.js';
import {
  registerEpubPort,
  isEpubReaderUrl,
  isCurrentEpubSender,
  openEpubReader,
  epubDocument,
  epubCommand,
} from './epub-routing.js';
import { tool, instructions, pageContextPrefix } from './session-config.js';
import { browserTool, context } from './browser-tools.js';
import {
  VaultError,
  createVaultClient,
  cleanWebAnchor,
  cleanPdfAnchor,
  cleanPageMeta,
  documentUrl,
  bookUrl,
  cleanEpubAnchor,
} from './vault-client.js';
import { createReadingCompanion } from './reading-companion.js';
import { createClipper } from './clipper.js';
import {
  registerClipPort,
  clipSource,
  clipViewerUrl,
  isCurrentClipSender,
} from './clip-routing.js';
import { createFeeds, feedMessages } from './feeds.js';
startPdfRouting();
// The page a tab shows: a PDF viewer's PDF, a clipped-page reader's page, or its own URL.
const pageAddress = (url) => pdfSource(url) || clipSource(url) || url;
const sessions = new Map(),
  requests = new Map(),
  chunks = new Map();
// Native Chrome owns sidebar visibility and toolbar toggling.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.warn);
const urlHistory = createUrlHistory(chrome.storage.local);
const sidebarViews = new Map(),
  agentCompanions = new Map();
const agentViews = new Map(),
  closedViews = new Map(),
  openingThreads = new Map();
let native,
  sequence = 1000;
const vault = createVaultClient(connect);
// Vault methods follow the shared contract; they never claim or wait for a Codex session.
const vaultRequest = (method, params) => vault.request(method, params);
// Subscriptions are checked on a schedule; the listener is registered at startup, as MV3 needs.
const feeds = createFeeds({
  request: (method, params, options) => vault.request(method, params, options),
});
chrome.alarms.onAlarm.addListener((alarm) => void feeds.onAlarm(alarm));
chrome.runtime.onStartup.addListener(() => void feeds.start().catch(console.warn));
const highlightStatus = new Map();
const loaded = chrome.storage.session
  .get(['conversations', 'agentViews', 'closedViews', 'sidebarViews', 'agentCompanions'])
  .then(
    ({
      conversations = [],
      agentViews: views = [],
      closedViews: closed = [],
      sidebarViews: sidebars = [],
      agentCompanions: companions = [],
    }) => {
      for (const [key, value] of conversations)
        sessions.set(key, {
          ...value,
          ports: new Set(),
          turnPending: false,
          questions: [],
          pendingQuestions: [],
        });
      for (const [tabId, key] of views) agentViews.set(tabId, key);
      for (const [tabId, id] of companions) agentCompanions.set(tabId, id);
      for (const [tabId, key] of sidebars) sidebarViews.set(tabId, key);
      for (const [id, view] of closed) closedViews.set(id, view);
    },
  );
const persist = () =>
  chrome.storage.session.set({
    agentViews: [...agentViews],
    sidebarViews: [...sidebarViews],
    agentCompanions: [...agentCompanions],
    closedViews: [...closedViews],
    conversations: [...sessions].map(
      ([key, { ports, turnPending, questions, pendingQuestions, ...s }]) => [key, s],
    ),
  });
const event = (port, name, value) => {
  try {
    port.postMessage({ type: 'event', name, value });
  } catch {}
};
const broadcast = (s, message) => {
  for (const port of s.ports) event(port, 'codex-message', message);
};
// Highlight and document conversations saved to the ReadingVault (reading-companion.js).
const reading = createReadingCompanion({
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
  clipSource,
  filePdfDocument,
  epubDocument,
  isEpubReaderUrl,
  // Highlight commands reach webpage content scripts or the EPUB reader page.
  tabMessage: async (tabId, message) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return epubDocument(tab) !== undefined
      ? epubCommand(tabId, message)
      : chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  },
});
// Clipping a page saves its text into the page's vault document (clipper.js); views of the
// tab refresh their reading notes menu.
const clipper = createClipper({
  vault,
  changed: async (tabId) => {
    await loaded;
    for (const s of sessions.values())
      if (s.tabId === tabId) for (const p of s.ports) event(p, 'codex-reading-changed');
  },
});
const readingMessages = new Set([
  'readingState',
  'readingSave',
  'readingJump',
  'readingOpen',
  'readingNote',
  'vaultConfigure',
]);
async function getSession(tabId) {
  await loaded;
  const key = sidebarViews.get(tabId) ?? (agentViews.has(tabId) ? `sidebar:${tabId}` : tabId);
  let s = sessions.get(key);
  if (!s) {
    const [, { composerDefaults }] = await Promise.all([
      chrome.tabs.get(tabId),
      chrome.storage.local.get('composerDefaults'),
    ]);
    // Another view may have created this session while Chrome resolved the tab.
    if (sessions.has(key)) return sessions.get(key);
    s = {
      tabId,
      id: crypto.randomUUID(),
      scope: 'window',
      key,
      draft: '',
      settings: composerDefaults ? { ...composerDefaults } : undefined,
      ports: new Set(),
    };
    sessions.set(key, s);
    await persist();
  }
  return s;
}
// Closing a companion page does not end the Agent views that show its conversation. They
// keep the page's last known address, marked closed; the reading companion keeps its
// document (s.pageDocuments), and sessions created from such a view belong to its own tab.
const openTab = async (tabId, fallback) =>
  tabId != null && (await chrome.tabs.get(tabId).catch(() => null)) ? tabId : fallback;
function closedPage(s, tabId) {
  const document = s.pageDocuments?.[tabId];
  return { url: s.pageUrls?.[tabId] || document?.url || '', title: document?.title || '' };
}
// The browser context sent with each message from a view.
async function companionPage(s, port) {
  const tab = await chrome.tabs.get(port.companionTabId).catch(() => null);
  if (tab)
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      url: pageAddress(tab.url),
      title: tab.title || '',
      // Tabgent's reader of the page's clipped copy, not the live page.
      ...(clipSource(tab.url) ? { viewer: 'clip' } : {}),
    };
  const view = await chrome.tabs.get(port.sender.tab?.id ?? s.tabId).catch(() => null);
  return {
    tabId: port.companionTabId,
    windowId: view?.windowId,
    ...closedPage(s, port.companionTabId),
    closed: true,
  };
}
// The page shown in a view's composer.
async function viewContext(s, port) {
  if (await chrome.tabs.get(port.companionTabId).catch(() => null))
    return context({ ...s, tabId: port.companionTabId });
  const page = closedPage(s, port.companionTabId);
  return {
    scope: s.scope,
    page: page.url && !s.noCompanion ? { id: port.companionTabId, ...page, closed: true } : null,
  };
}
async function historyUrl(s) {
  const tab = await chrome.tabs.get(s.tabId).catch(() => null);
  if (tab?.incognito) return '';
  const url = (tab?.url && pageAddress(tab.url)) || tab?.pendingUrl;
  if (url && !url.startsWith(chrome.runtime.getURL('ui/chat.html'))) return url;
  return '';
}
function hasUserInput(thread) {
  return thread?.turns?.some((turn) =>
    turn.items?.some(
      (item) =>
        item.type === 'userMessage' &&
        !(item.content || []).some((part) =>
          part.text?.startsWith('Browser conversation lineage (context only; no reply required).'),
        ),
    ),
  );
}
async function verifyHistory(session, threadId) {
  try {
    const result = await new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(Error('History unavailable'));
      }, 10000);
      requests.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      connect().postMessage({
        op: 'rpc',
        session: session.id,
        message: { id, method: 'thread/read', params: { threadId, includeTurns: true } },
      });
    });
    return !!hasUserInput(result.thread);
  } catch (e) {
    if (
      /no rollout found|thread not found|not materialized yet|includeTurns is unavailable before first user message/i.test(
        e.message,
      )
    )
      return false;
    throw e;
  }
}
async function recordHistory(s, url) {
  const urls = url ? [url] : (await urlHistory.get(s.threadId))?.urls || [];
  for (const page of urls) await urlHistory.record(s, page);
}
// Navigation targets identify webpage links; new-tab and clone actions stay roots.
async function trackChild(tabId, parent) {
  if (!parent || tabId === parent.tabId || agentViews.has(tabId)) return;
  return linkSession(await getSession(tabId), parent);
}
async function linkSession(child, parent) {
  if (child === parent || child.parent) return;
  const source = await chrome.tabs.get(parent.tabId).catch(() => ({}));
  child.parent = {
    key: parent.key,
    threadId: parent.threadId,
    source: {
      tabId: parent.tabId,
      url: source.url || '',
      title: source.title || '',
    },
  };
  await persist();
  connect().postMessage({ op: 'claim', session: parent.id, threadId: parent.threadId });
  connect().postMessage({ op: 'claim', session: child.id, threadId: child.threadId });
  void linkChildren().catch(console.warn);
}
let linking;
async function linkChildren() {
  if (linking) return linking;
  linking = (async () => {
    for (const child of sessions.values()) {
      const parent = child.parent;
      if (!parent || child.linkRecorded || !child.threadId) continue;
      parent.threadId ||= sessions.get(parent.key)?.threadId;
      if (!parent.threadId || parent.threadId === child.threadId) continue;
      const destination = await chrome.tabs.get(child.tabId).catch(() => ({}));
      await new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          requests.delete(id);
          reject(Error('Conversation lineage could not be recorded; retry the message'));
        }, 30000);
        requests.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        connect().postMessage({
          op: 'rpc',
          session: child.id,
          message: {
            id,
            method: 'bridge/thread/link',
            params: {
              parentThreadId: parent.threadId,
              childThreadId: child.threadId,
              source: {
                ...parent.source,
                destination: { title: destination.title || '', url: destination.url || '' },
              },
            },
          },
        });
      });
      child.linkRecorded = true;
      for (const [key, session] of sessions) {
        if (
          session.closedTab &&
          (!session.parent || session.linkRecorded) &&
          ![...sessions.values()].some((value) => value.parent?.key === key && !value.linkRecorded)
        ) {
          native?.postMessage({ op: 'close', session: session.id });
          sessions.delete(key);
        }
      }
      await persist();
    }
  })();
  try {
    await linking;
  } finally {
    linking = null;
  }
}
chrome.webNavigation.onCreatedNavigationTarget?.addListener(async ({ sourceTabId, tabId }) => {
  await loaded;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.incognito) return;
  const parent = agentViews.has(sourceTabId)
    ? sessions.get(agentViews.get(sourceTabId))
    : await getSession(sourceTabId);
  await trackChild(tabId, parent).catch(console.warn);
});
function connect() {
  if (native) return native;
  native = chrome.runtime.connectNative('com.tabgent.codex');
  native.onMessage.addListener((message) => void receive(message));
  native.onDisconnect.addListener(() => {
    const message = chrome.runtime.lastError?.message || '';
    native = null;
    for (const r of requests.values()) r.reject?.(Error('Codex disconnected'));
    requests.clear();
    vault.disconnect(message);
    const missing = /native messaging host not found/i.test(message);
    for (const s of sessions.values()) {
      s.turnPending = false;
      broadcast(
        s,
        missing
          ? { method: 'bridge/helperMissing' }
          : { method: 'bridge/error', params: { messageKey: 'helperLaunchFailed' } },
      );
    }
  });
  native.postMessage({
    op: 'warm',
    config: { developerInstructions: instructions, dynamicTools: [tool] },
  });
  return native;
}
async function receive(message) {
  if (message.op === 'chunk') {
    if (message.count > 256) return;
    let c = chunks.get(message.id);
    if (!c) {
      c = [];
      chunks.set(message.id, c);
      setTimeout(() => chunks.delete(message.id), 30000);
    }
    c[message.index] = message.data;
    if (c.filter((x) => x !== undefined).length !== message.count) return;
    chunks.delete(message.id);
    message = JSON.parse(c.join(''));
  }
  if (vault.receive(message)) return;
  const s = [...sessions.values()].find((s) => s.id === message.session);
  if (!s) return;
  const m = message.message;
  if (m.method === 'bridge/ready' && m.params?.threadId) {
    s.threadId = m.params.threadId;
    void recordHistory(s).catch(console.warn);
    await persist();
    void linkChildren().catch(console.warn);
  }
  if (m.method === 'bridge/authChanged') s.restart = true;
  if (m.method === 'item/tool/call') {
    let result;
    try {
      if (m.params.tool !== 'browser') throw Error('Unsupported tool');
      const args =
        typeof m.params.arguments === 'string'
          ? JSON.parse(m.params.arguments)
          : m.params.arguments;
      // The message's tab anchors scope; once it has closed, the conversation's own tab does.
      const anchor = await openTab(s.toolTabId, s.tabId);
      const value = await browserTool(
        { ...s, tabId: anchor },
        args,
        (params) =>
          new Promise((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => {
              requests.delete(id);
              reject(Error('PDF read timed out'));
            }, 30000);
            requests.set(id, {
              resolve: (value) => {
                clearTimeout(timer);
                resolve(value);
              },
              reject: (error) => {
                clearTimeout(timer);
                reject(error);
              },
            });
            connect().postMessage({
              op: 'rpc',
              session: s.id,
              message: { id, method: 'bridge/pdf/read', params },
            });
          }),
      );
      if (args.action === 'open' && value?.id) await trackChild(value.id, s);
      result = {
        success: true,
        contentItems: value?.data
          ? [
              {
                type: 'inputText',
                text: JSON.stringify({
                  ...value,
                  data: undefined,
                  coordinateSelector: '@point(x,y)',
                }),
              },
              { type: 'inputImage', imageUrl: 'data:image/png;base64,' + value.data },
            ]
          : [{ type: 'inputText', text: JSON.stringify(value) }],
      };
    } catch (e) {
      result = { success: false, contentItems: [{ type: 'inputText', text: e.message }] };
    }
    native?.postMessage({ op: 'rpc', session: s.id, message: { id: m.id, result } });
    return;
  }
  if (m.id !== undefined && !m.method) {
    const r = requests.get(m.id);
    if (r) {
      requests.delete(m.id);
      if (r.resolve) {
        if (m.error) r.reject(Error(m.error.message));
        else r.resolve(m.result);
        return;
      }
      if (!m.error && r.toolTabId != null) s.toolTabId = r.toolTabId;
      if (['turn/start', 'thread/queue/start'].includes(r.method) && m.error) s.turnPending = false;
      if (
        !m.error &&
        (['turn/start', 'thread/queue/start', 'turn/steer', 'thread/queue/add'].includes(
          r.method,
        ) ||
          hasUserInput(m.result?.thread))
      ) {
        s.hasUserInput = true;
        await recordHistory(s, r.pageUrl);
        for (const turn of m.result?.thread?.turns || [])
          for (const item of turn.items || [])
            if (item.type === 'userMessage')
              for (const part of item.content || [])
                if (part.text?.startsWith(pageContextPrefix)) {
                  try {
                    const page = JSON.parse(part.text.slice(pageContextPrefix.length));
                    if (typeof page.url === 'string') await recordHistory(s, page.url);
                  } catch {}
                }
        await persist();
        for (const port of s.ports) event(port, 'codex-history-changed');
      }
      if (r.method === 'thread/resume' && !m.error) await reading.resumed(s, m.result?.thread);
      if (r.method === 'bridge/thread/forkMessage' && m.result?.thread?.id) {
        s.messageForks ||= [];
        s.messageForks.push(m.result.thread.id);
        await persist();
      }
      if (r.method === 'bridge/thread/relations' && m.result) {
        const entries = [...(m.result.parents || []), ...(m.result.children || [])];
        s.relatedThreads = entries.map((entry) => entry.threadId);
        await persist();
        await Promise.all(
          entries.map(async (entry) => {
            const owner = [...sessions.values()].find((value) => value.threadId === entry.threadId);
            const page = owner && (await chrome.tabs.get(owner.tabId).catch(() => null));
            entry.title = owner?.title || entry.title;
            entry.pageTitle = page?.title || entry.pageTitle;
            entry.url = page?.url || entry.url;
          }),
        );
      }
      event(r.port, 'codex-message', { ...m, id: r.id });
    }
    return;
  }
  if (m.id !== undefined && m.method) {
    s.pendingQuestions ||= [];
    if (!s.pendingQuestions.includes(m.id)) s.pendingQuestions.push(m.id);
    s.questions = [...(s.questions || []).filter((q) => q.id !== m.id), m];
  }
  if (m.method === 'item/started' && m.params?.item?.type === 'userMessage') {
    const page = m.params.item.content?.find(
      (p) => p.type === 'text' && p.text?.startsWith(pageContextPrefix),
    );
    if (page) {
      try {
        const id = JSON.parse(page.text.slice(pageContextPrefix.length)).tabId;
        if (Number.isInteger(id)) s.toolTabId = id;
      } catch {}
    }
  }
  if (m.method === 'turn/started') s.turnPending = true;
  if (m.method === 'turn/completed' || m.method === 'bridge/closed') s.turnPending = false;
  reading.notification(s, m);
  broadcast(s, m);
}
chrome.runtime.onConnect.addListener((port) => {
  // The clipped-page reader registers itself; it carries no commands.
  if (port.name === 'clip') return void registerClipPort(port);
  if (port.name === 'pdf' || port.name === 'epub') {
    if (port.name === 'epub' && !registerEpubPort(port)) return;
    void (async () => {
      await loaded;
      const current =
        port.name === 'pdf'
          ? await isCurrentPdfSender(port.sender)
          : isCurrentEpubSender(port.sender);
      if (!current) return;
      for (const s of sessions.values()) {
        if (
          s.tabId !== port.sender.tab.id ||
          !s.selection ||
          s.selection.documentId === port.sender.documentId
        )
          continue;
        s.selection = null;
        for (const p of s.ports) event(p, 'codex-selection', null);
      }
      await persist();
    })();
    return;
  }
  if (port.name !== 'chat') return;
  let session;
  port.onMessage.addListener(async (msg) => {
    try {
      if (msg.type === 'attach') {
        if (
          port.sender.id !== chrome.runtime.id ||
          !port.sender.url?.startsWith(chrome.runtime.getURL(''))
        )
          throw Error('Invalid sender');
        if (port.sender.frameId > 0) throw Error('Invalid frame');
        await loaded;
        const s =
          port.sender.tab && agentViews.has(port.sender.tab.id)
            ? sessions.get(agentViews.get(port.sender.tab.id))
            : await getSession(msg.tabId);
        if (!s) throw Error('Conversation not found');
        if (
          port.sender.tab &&
          port.sender.tab.id !== s.key &&
          agentViews.get(port.sender.tab.id) !== s.key
        )
          throw Error('Invalid owner');
        await chrome.tabs.get(s.tabId);
        const viewTabId = port.sender.tab?.id ?? msg.tabId;
        await chrome.tabs.get(viewTabId);
        session = s;
        port.companionTabId = port.sender.tab
          ? (agentCompanions.get(port.sender.tab.id) ?? s.tabId)
          : msg.tabId;
        s.ports.add(port);
        port.postMessage({
          type: 'attached',
          state: {
            threadId: s.threadId,
            companionTabId: port.companionTabId,
            draft: s.draft,
            scope: s.scope,
            settings: s.settings,
            conversationKey: s.key,
            windowId: (await chrome.tabs.get(viewTabId)).windowId,
            selection: s.selection?.tabId === port.companionTabId ? s.selection : null,
            annotations: s.annotations || [],
            highlightStatus: highlightStatus.get(port.companionTabId) || null,
            attachments: s.attachments || [],
            questions: s.questions || [],
          },
        });
        chrome.scripting
          .executeScript({
            target: { tabId: port.companionTabId, allFrames: true },
            files: ['selection-content.js'],
          })
          .catch(() => {});
        // A highlight may have switched this sidebar's conversation while it attached.
        if (!port.sender.tab && (sidebarViews.get(msg.tabId) ?? s.key) !== s.key)
          event(port, 'codex-view-changed');
        return;
      }
      const s = session;
      if (!s) return;
      if (msg.type === 'draft') {
        s.draft = msg.text;
        for (const p of s.ports) if (p !== port) event(p, 'codex-draft', s.draft);
        await persist();
        return;
      }
      if (msg.type === 'bind') {
        s.threadId = msg.threadId;
        await recordHistory(s);
        for (const p of s.ports) if (p !== port) event(p, 'codex-thread', s.threadId);
        await persist();
        void linkChildren().catch(console.warn);
        return;
      }
      if (msg.type !== 'ui') return;
      const [arg] = msg.args || [];
      if (msg.name === 'codexConnect') {
        connect().postMessage({
          op: s.restart ? 'restart' : 'claim',
          session: s.id,
          threadId: s.threadId,
        });
        s.restart = false;
      }
      if (msg.name === 'codexRpc') {
        const m = { ...arg, params: { ...arg.params } };
        let messageTabId, messagePageUrl;
        if (['turn/start', 'turn/steer', 'thread/queue/add'].includes(m.method)) {
          const input = [...(m.params.input || [])];
          let page = input.find((p) => p.type === 'text' && p.text?.startsWith(pageContextPrefix));
          if (!page) {
            page = {
              type: 'text',
              text: pageContextPrefix + JSON.stringify(await companionPage(s, port)),
            };
            input.unshift(page);
          }
          const messagePage = JSON.parse(page.text.slice(pageContextPrefix.length));
          messagePageUrl = messagePage.url;
          s.pageUrls ||= {};
          if (messagePageUrl) s.pageUrls[messagePage.tabId] = messagePageUrl;
          m.params.input = await reading
            .input(s, { ...m.params, input }, messagePage)
            .catch(() => input);
          if (m.method !== 'thread/queue/add')
            messageTabId = JSON.parse(page.text.slice(pageContextPrefix.length)).tabId;
        }
        if (m.method === 'thread/queue/start')
          messageTabId = m.params.browserTabId ?? port.companionTabId;
        delete m.params.browserTabId;
        if (['turn/start', 'thread/queue/start', 'turn/steer'].includes(m.method))
          await linkChildren();
        if (m.id !== undefined && !m.method) {
          if (!s.pendingQuestions?.includes(m.id)) return;
          s.pendingQuestions = s.pendingQuestions.filter((id) => id !== m.id);
          s.questions = (s.questions || []).filter((q) => q.id !== m.id);
          for (const p of s.ports) event(p, 'codex-question-answered', m.id);
        }
        if (['turn/start', 'thread/queue/start'].includes(m.method)) {
          if (s.turnPending) {
            event(port, 'codex-message', {
              id: m.id,
              error: { message: chrome.i18n.getMessage('conversationBusy') },
            });
            return;
          }
          s.turnPending = true;
        }
        if (m.id !== undefined && m.method) {
          const id = ++sequence;
          requests.set(id, {
            port,
            id: m.id,
            method: m.method,
            tabId: port.companionTabId,
            toolTabId: messageTabId,
            pageUrl: messagePageUrl,
          });
          m.id = id;
        }
        connect().postMessage({ op: 'rpc', session: s.id, message: m });
      }
      if (msg.name === 'codexAttachments' && Array.isArray(arg) && arg.length <= 10) {
        const attachments = arg.map((a) => ({
          name: String(a.name).slice(0, 300),
          path: String(a.path).slice(0, 2000),
          image: !!a.image,
        }));
        if (JSON.stringify(attachments) !== JSON.stringify(s.attachments || [])) {
          s.attachments = attachments;
          for (const p of s.ports) if (p !== port) event(p, 'codex-attachments', attachments);
          await persist();
        }
      }
      if (msg.name === 'codexSetAnnotations') {
        s.annotations = cleanAnnotations(arg);
        for (const p of s.ports) if (p !== port) event(p, 'codex-annotations', s.annotations);
        await persist();
      }
      if (msg.name === 'codexClearSelection' && s.selection?.id === arg) {
        s.selection = null;
        await persist();
        for (const p of s.ports) event(p, 'codex-selection', null);
      }
      if (msg.name === 'codexSettings') {
        s.settings = {
          model: String(arg.model || '').slice(0, 200),
          effort: String(arg.effort || '').slice(0, 30),
          mode: arg.mode === 'plan' ? 'plan' : 'default',
          permissionMode: ['ask', 'auto', 'full'].includes(arg.permissionMode)
            ? arg.permissionMode
            : 'ask',
        };
        const { model, effort, permissionMode } = s.settings;
        await chrome.storage.local.set({ composerDefaults: { model, effort, permissionMode } });
        await persist();
        for (const p of s.ports) if (p !== port) event(p, 'codex-settings', arg);
      }
      if (msg.name === 'codexScope') {
        s.scope = arg === 'browser' ? 'browser' : 'window';
        for (const p of s.ports) if (p !== port) event(p, 'codex-scope', s.scope);
        await persist();
      }
      if (msg.name === 'codexContext') event(port, 'codex-context', await viewContext(s, port));
      if (msg.name === 'codexCheckAuth') {
        connect().postMessage({ op: 'checkAuth', session: s.id });
      }
      if (msg.name === 'helperHelp')
        await chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
      // The side panel's reminder on a file Tabgent cannot read yet.
      if (msg.name === 'openFileAccess') {
        const tab = await chrome.tabs.get(port.companionTabId).catch(() => null);
        await chrome.tabs.create({
          url: fileAccessSettingsUrl(),
          ...(tab ? { windowId: tab.windowId, index: tab.index + 1 } : {}),
        });
      }
      if (msg.name === 'codexOpenSetupUrl') {
        const u = new URL(arg);
        if (
          u.protocol === 'https:' &&
          ['auth.openai.com', 'chatgpt.com', 'learn.chatgpt.com', 'openai.com'].includes(u.hostname)
        )
          await chrome.tabs.create({ url: u.href });
      }
      if (msg.name === 'title') {
        const changed = s.title !== arg;
        s.title = arg;
        if (changed) await recordHistory(s);
        for (const p of s.ports) event(p, 'codex-title', arg);
        if (changed) {
          await persist();
          for (const owner of sessions.values())
            broadcast(owner, { method: 'bridge/lineageChanged' });
        }
      }
    } catch (e) {
      if (!session) port.postMessage({ type: 'attachError', message: e.message });
      if (session)
        event(port, 'codex-message', { method: 'bridge/error', params: { message: e.message } });
    }
  });
  port.onDisconnect.addListener(() => {
    session?.ports.delete(port);
    for (const [id, request] of requests) if (request.port === port) requests.delete(id);
  });
});
async function openAgentTab(session, windowId, companionTabId = session.tabId) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId });
  if (session.tabId == null) {
    session.tabId = tab.id;
    session.noCompanion = true;
  }
  agentViews.set(tab.id, session.key);
  agentCompanions.set(tab.id, companionTabId ?? session.tabId);
  await persist();
  await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL('ui/chat.html'), active: true });
  return { tabId: tab.id };
}
const highlightMessages = new Set([
  'highlightResolve',
  'highlightCreate',
  'highlightDelete',
  'highlightAsk',
  'highlightNote',
  'highlightStatus',
]);
const pageText = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
// The user's own note on a saved highlight; the side panel's highlight list shows it too.
async function updateNote(tabId, documentId, highlightId, note) {
  if (typeof note !== 'string') throw new VaultError('invalid_params', 'Invalid note');
  const result = await vaultRequest('vault/highlight/update', {
    documentId,
    highlightId,
    note: note.slice(0, 20000),
  });
  await loaded;
  for (const s of sessions.values())
    if (s.tabId === tabId) for (const p of s.ports) event(p, 'codex-reading-changed');
  return { highlight: result.highlight || null };
}
// Highlights belong to top-level HTTP(S) documents and files from the computer (file://, not
// a directory listing) named by Chrome's sender metadata, or to the current PDF.js viewer,
// whose document is the original PDF URL, or the file's hash for a PDF from the computer.
async function highlightMessage(msg, sender) {
  const pdf = pdfSource(sender.url);
  // Tabgent's reader of a clipped page: its document is the page.
  const clipped = !pdf && clipSource(sender.url);
  if (
    !sender.tab ||
    sender.tab.incognito ||
    sender.frameId !== 0 ||
    (!pdf && !clipped && !/^https?:/.test(sender.url || '') && !isLocalFileUrl(sender.url))
  )
    throw Error('Invalid highlight sender');
  const tabId = sender.tab.id;
  // Chrome honours the page click's user gesture only until this handler first awaits.
  const panel =
    msg.type === 'highlightAsk' || (msg.type === 'highlightCreate' && msg.ask)
      ? chrome.sidePanel.open({ tabId }).then(
          () => true,
          () => false,
        )
      : null;
  let pageUrl = pdf || clipped;
  if (pdf) {
    // Chrome hides extension documents from webNavigation.getFrame.
    if (!(await isCurrentPdfSender(sender))) throw Error('Stale PDF viewer');
    // A PDF from the computer is named by the hash of the bytes its viewer read.
    if (isFilePdf(pdf)) pageUrl = await filePdfUrl(tabId);
  } else if (clipped) {
    if (!(await isCurrentClipSender(sender))) throw Error('Stale clipped page reader');
  } else {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!frame || (sender.documentId && frame.documentId !== sender.documentId))
      throw Error('Stale page');
    // sender.url keeps the load-time URL; the frame URL follows same-document (SPA) navigation.
    pageUrl =
      /^https?:/.test(frame.url || '') || isLocalFileUrl(frame.url) ? frame.url : sender.url;
  }
  const url = documentUrl(pageUrl),
    kind = pdf ? 'pdf' : 'web';
  // PDF quotes name their page; webpages keep handOffSelection's default locator.
  const locator = (anchor) =>
    pdf
      ? { kind: 'pdf', anchor, ...(anchor ? { page: anchor.page } : {}) }
      : clipped
        ? { kind: 'web', view: 'clip', anchor }
        : null;
  const title = pageText(msg.title, 500) || pageText(sender.tab.title, 500);
  const meta = cleanPageMeta(msg.meta);
  const context = {
    before: pageText(msg.context?.before, 2000),
    after: pageText(msg.context?.after, 2000),
  };
  if (msg.type === 'highlightResolve') {
    const result = await vaultRequest('vault/document/resolve', { url, title, kind, meta });
    return { url, document: result.document || null, highlights: result.highlights || [] };
  }
  if (msg.type === 'highlightStatus') {
    await loaded;
    const status = {
      url,
      documentId: pageText(msg.documentId, 300) || null,
      anchored: Number.isInteger(msg.anchored) ? msg.anchored : 0,
      unanchored: (Array.isArray(msg.unanchored) ? msg.unanchored : [])
        .slice(0, 1000)
        .map((id) => pageText(id, 100)),
    };
    highlightStatus.set(tabId, status);
    for (const s of sessions.values())
      if (s.tabId === tabId) for (const p of s.ports) event(p, 'codex-highlight-status', status);
    return {};
  }
  if (msg.type === 'highlightCreate') {
    const anchor = pdf
        ? cleanPdfAnchor(msg.anchor)
        : cleanWebAnchor(msg.anchor, { view: clipped ? 'clip' : 'page' }),
      text = pageText(msg.text, 20000);
    if (!anchor || !text.trim()) throw new VaultError('invalid_params', 'Invalid highlight');
    const location = pageText(msg.location, 200).trim();
    let created = {},
      failure = null;
    try {
      created = await vaultRequest('vault/highlight/create', {
        url,
        title,
        kind,
        meta,
        text,
        anchor,
        ...(location ? { location } : {}),
      });
    } catch (error) {
      if (!msg.ask) throw error;
      failure = error;
    }
    const highlight = created.highlight || null,
      document = created.document || null;
    if (msg.ask)
      await handOffSelection(sender, {
        url: pageUrl,
        text,
        title,
        anchor,
        context,
        location,
        highlight:
          highlight && document
            ? { documentId: document.id, highlightId: highlight.id, kind }
            : null,
        locator: locator(anchor),
      });
    return {
      url,
      document,
      highlight,
      ...(panel ? { panelOpened: await panel } : {}),
      ...(failure ? { vaultError: failure.message, code: failure.code } : {}),
    };
  }
  // Existing highlights are checked against the vault record for this page's URL.
  const resolved = await vaultRequest('vault/document/resolve', { url, title, kind });
  const highlight =
    resolved.document?.id === msg.documentId &&
    (resolved.highlights || []).find((h) => h.id === msg.highlightId);
  if (!highlight) throw new VaultError('not_found', 'Highlight not found on this page');
  if (msg.type === 'highlightDelete') {
    await vaultRequest('vault/highlight/delete', {
      documentId: resolved.document.id,
      highlightId: highlight.id,
    });
    return { ok: true };
  }
  if (msg.type === 'highlightNote')
    return updateNote(tabId, resolved.document.id, highlight.id, msg.note);
  await handOffSelection(sender, {
    url: pageUrl,
    text: pageText(highlight.text, 20000) || pageText(highlight.anchor?.quote?.exact, 20000),
    title,
    anchor: highlight.anchor || null,
    context,
    location: pageText(highlight.location, 200),
    highlight: { documentId: resolved.document.id, highlightId: highlight.id, kind },
    locator: locator(highlight.anchor || null),
  });
  return { panelOpened: await panel };
}
// "Ask AI" reuses the page-selection quote flow, extended with the highlight and nearby text.
// A saved highlight opens its own conversation (reading-companion.js). Readers other than
// webpages pass their own locator (kind, anchor and reader details).
async function handOffSelection(
  sender,
  { url, text, title, anchor, context, location, highlight, locator },
) {
  const selection = {
    selectionId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    text,
    truncated: text.length >= 20000,
    url,
    title,
    frameId: sender.frameId,
    documentId: sender.documentId,
    tabId: sender.tab.id,
    locator: { kind: 'web', anchor, ...locator, capturedAt: new Date().toISOString() },
    location: location || '',
    highlight,
    context,
  };
  if (highlight) return reading.focusHighlight(selection, { tabId: sender.tab.id });
  await getSession(sender.tab.id);
  for (const s of sessions.values()) {
    if (s.tabId !== sender.tab.id) continue;
    s.selection = { ...selection, id: crypto.randomUUID() };
    await persist();
    for (const p of s.ports) event(p, 'codex-selection', s.selection);
  }
}
const epubMessages = new Set([
  'epubBooks',
  'libraryDocuments',
  'epubSourceSave',
  'epubSourceRead',
  'epubResolve',
  'epubHighlightCreate',
  'epubHighlightDelete',
  'epubHighlightAsk',
  'epubHighlightNote',
  'epubHighlightStatus',
]);
// The EPUB reader names a book by its file hash; highlights are checked against that book.
async function epubMessage(msg, sender) {
  if (!isCurrentEpubSender(sender)) throw Error('Invalid EPUB reader sender');
  const tabId = sender.tab.id;
  if (msg.type === 'epubBooks') return vaultRequest('vault/books/list', { kind: 'epub' });
  // The library lists every vault document: webpages, PDFs and books.
  if (msg.type === 'libraryDocuments')
    return vault.request('vault/documents/list', {}, { timeout: 60000 });
  if (msg.type === 'epubSourceRead')
    return vault.request(
      'vault/source/read',
      { documentId: pageText(msg.documentId, 300), offset: msg.offset, length: msg.length },
      { timeout: 60000 },
    );
  if (msg.type === 'epubHighlightStatus' && msg.sha256 == null) {
    // The reader left its book: the tab shows no highlight status any more.
    await loaded;
    highlightStatus.delete(tabId);
    for (const s of sessions.values())
      if (s.tabId === tabId) for (const p of s.ports) event(p, 'codex-highlight-status', null);
    return {};
  }
  const url = bookUrl(msg.sha256);
  if (!url) throw new VaultError('invalid_params', 'Invalid book');
  const title = pageText(msg.title, 500);
  const book = { url, title, kind: 'epub', meta: cleanPageMeta(msg.meta) };
  if (msg.type === 'epubSourceSave')
    return vault.request(
      'vault/source/save',
      {
        ...book,
        // The library imports PDFs from the computer too, named by their hash the same way.
        kind: msg.kind === 'pdf' ? 'pdf' : 'epub',
        sha256: msg.sha256,
        size: msg.size,
        offset: msg.offset,
        data: pageText(msg.data, 6000000),
        name: pageText(msg.name, 255),
      },
      { timeout: 120000 },
    );
  if (msg.type === 'epubResolve') {
    const result = await vaultRequest('vault/document/resolve', book);
    return { document: result.document || null, highlights: result.highlights || [] };
  }
  if (msg.type === 'epubHighlightStatus') {
    await loaded;
    const status = {
      url,
      documentId: pageText(msg.documentId, 300) || null,
      anchored: Number.isInteger(msg.anchored) ? msg.anchored : 0,
      unanchored: (Array.isArray(msg.unanchored) ? msg.unanchored : [])
        .slice(0, 1000)
        .map((id) => pageText(id, 100)),
    };
    highlightStatus.set(tabId, status);
    for (const s of sessions.values())
      if (s.tabId === tabId) for (const p of s.ports) event(p, 'codex-highlight-status', status);
    return {};
  }
  const context = {
    before: pageText(msg.context?.before, 2000),
    after: pageText(msg.context?.after, 2000),
  };
  const chapterFile = /^chapters\/[^/\\]+\.md$/.test(msg.chapterFile) ? msg.chapterFile : '';
  // Codex reads the chapter from the vault instead of receiving the whole book.
  const locator = (anchor, document) => ({
    kind: 'epub',
    anchor,
    documentId: document?.id || null,
    ...(document?.folder && chapterFile
      ? { chapterFile: `${document.folder}/${chapterFile}` }
      : {}),
  });
  if (msg.type === 'epubHighlightCreate') {
    const anchor = cleanEpubAnchor(msg.anchor),
      text = pageText(msg.text, 20000);
    if (!anchor || !text.trim()) throw new VaultError('invalid_params', 'Invalid highlight');
    let created = {},
      failure = null;
    try {
      created = await vaultRequest('vault/highlight/create', {
        ...book,
        text,
        anchor,
        ...(anchor.chapter.title ? { location: anchor.chapter.title } : {}),
      });
    } catch (error) {
      if (!msg.ask) throw error;
      failure = error;
    }
    const highlight = created.highlight || null,
      document = created.document || null;
    if (msg.ask)
      await handOffSelection(sender, {
        url,
        text,
        title,
        context,
        location: anchor.chapter.title,
        highlight:
          highlight && document
            ? { documentId: document.id, highlightId: highlight.id, kind: 'epub' }
            : null,
        locator: locator(anchor, document),
      });
    return {
      document,
      highlight,
      ...(failure ? { vaultError: failure.message, code: failure.code } : {}),
    };
  }
  const resolved = await vaultRequest('vault/document/resolve', book);
  const highlight =
    resolved.document?.id === msg.documentId &&
    (resolved.highlights || []).find((h) => h.id === msg.highlightId);
  if (!highlight) throw new VaultError('not_found', 'Highlight not found in this book');
  if (msg.type === 'epubHighlightDelete') {
    await vaultRequest('vault/highlight/delete', {
      documentId: resolved.document.id,
      highlightId: highlight.id,
    });
    return { ok: true };
  }
  if (msg.type === 'epubHighlightNote')
    return updateNote(tabId, resolved.document.id, highlight.id, msg.note);
  await handOffSelection(sender, {
    url,
    text: pageText(highlight.text, 20000) || pageText(highlight.anchor?.quote?.exact, 20000),
    title,
    context,
    location: pageText(highlight.location, 200),
    highlight: { documentId: resolved.document.id, highlightId: highlight.id, kind: 'epub' },
    locator: locator(highlight.anchor || null, resolved.document),
  });
  return { ok: true };
}
// The clipped-page reader reads its page's clip from the vault. The document is the one its
// own address names, never one the reader asks for.
const clipMessages = new Set(['clipRead', 'clipAsset', 'clipDelete', 'clipOpen']);
async function clipMessage(msg, sender) {
  if (msg.type === 'clipOpen') {
    // From the clipping prompt on a webpage: open the clipped copy of that page beside it.
    if (!sender.tab || sender.tab.incognito || sender.frameId !== 0)
      throw Error('Invalid clip sender');
    const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 });
    if (!frame || (sender.documentId && frame.documentId !== sender.documentId))
      throw Error('Stale page');
    if (!/^https?:/.test(frame.url || '')) throw Error('Invalid clip sender');
    await openClip(sender.tab, frame.url);
    return {};
  }
  const page = clipSource(sender.url);
  if (!page || !(await isCurrentClipSender(sender))) throw Error('Invalid clipped page reader');
  const { document } = await vaultRequest('vault/document/resolve', {
    url: page,
    title: '',
    kind: 'web',
  });
  if (!document?.createdAt) throw new VaultError('not_found', 'This page has no clipped copy');
  const offset = Number.isInteger(msg.offset) ? msg.offset : 0;
  const length = Number.isInteger(msg.length) ? msg.length : 1024 * 1024;
  if (msg.type === 'clipRead')
    return vault.request(
      'vault/clip/read',
      { documentId: document.id, offset, length },
      { timeout: 60000 },
    );
  if (msg.type === 'clipAsset')
    return vault.request(
      'vault/clip/asset/read',
      { documentId: document.id, file: pageText(msg.file, 100), offset, length },
      { timeout: 60000 },
    );
  const result = await vaultRequest('vault/clip/delete', { documentId: document.id });
  await loaded;
  for (const s of sessions.values())
    if (s.tabId === sender.tab.id) for (const p of s.ports) event(p, 'codex-reading-changed');
  return result;
}
// The clipped copy of a page opens in a tab next to the page.
function openClip(tab, url) {
  return chrome.tabs.create({
    url: clipViewerUrl(documentUrl(url)),
    ...(tab?.windowId != null ? { windowId: tab.windowId } : {}),
    ...(Number.isInteger(tab?.index) ? { index: tab.index + 1 } : {}),
  });
}
// The viewer of an imported PDF reads its original back from the vault. The document is the
// one named by the viewer's address (urn:sha256:...), never one the page asks for.
async function pdfLocalRead(msg, sender) {
  const source = pdfSource(sender.url);
  if (!isLocalPdf(source) || !sender.tab || sender.tab.incognito || sender.frameId !== 0)
    throw Error('Invalid PDF viewer sender');
  // Chrome hides extension documents from webNavigation.getFrame.
  if (!(await isCurrentPdfSender(sender))) throw Error('Stale PDF viewer');
  const { document } = await vaultRequest('vault/document/resolve', {
    url: documentUrl(source),
    title: '',
    kind: 'pdf',
  });
  if (!document?.createdAt)
    throw new VaultError('not_found', 'This PDF is not in the reading vault');
  return vault.request(
    'vault/source/read',
    { documentId: document.id, offset: msg.offset, length: msg.length },
    { timeout: 60000 },
  );
}
// A PDF from the computer is copied into the vault once it has notes, so the library can
// reopen it and Codex can read its pages after the file moves. The document is the hash its
// viewer announced for this tab, never one the page names; the vault checks the bytes.
async function pdfFileSave(msg, sender) {
  const source = pdfSource(sender.url);
  if (!isFilePdf(source) || !sender.tab || sender.tab.incognito || sender.frameId !== 0)
    throw Error('Invalid PDF viewer sender');
  if (!(await isCurrentPdfSender(sender))) throw Error('Stale PDF viewer');
  const url = await filePdfUrl(sender.tab.id);
  return vault.request(
    'vault/source/save',
    {
      url,
      title: pageText(msg.title, 500),
      kind: 'pdf',
      meta: cleanPageMeta(msg.meta),
      sha256: url.slice('urn:sha256:'.length),
      size: msg.size,
      offset: msg.offset,
      data: pageText(msg.data, 6000000),
      name: pageText(msg.name, 255),
    },
    { timeout: 120000 },
  );
}
// Answered in pdf-routing.js.
const pdfRoutingMessages = new Set(['pdfFallback', 'localPdfOpen']);
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || pdfRoutingMessages.has(msg.type)) return;
  if (msg.type === 'pdfLocalRead' || msg.type === 'pdfFileSave') {
    (msg.type === 'pdfLocalRead' ? pdfLocalRead : pdfFileSave)(msg, sender).then(reply, (e) =>
      reply({ error: e.message, code: e.code || 'error' }),
    );
    return true;
  }
  if (clipMessages.has(msg.type)) {
    clipMessage(msg, sender).then(reply, (e) =>
      reply({ error: e.message, code: e.code || 'error' }),
    );
    return true;
  }
  if (highlightMessages.has(msg.type) || epubMessages.has(msg.type)) {
    (epubMessages.has(msg.type) ? epubMessage : highlightMessage)(msg, sender).then(reply, (e) =>
      reply({ error: e.message, code: e.code || 'error' }),
    );
    return true;
  }
  if (feedMessages.has(msg.type)) {
    // Only the library page manages subscriptions; web pages and other senders cannot.
    (isCurrentEpubSender(sender)
      ? feeds.message(msg)
      : Promise.reject(Error('Invalid EPUB reader sender'))
    ).then(reply, (e) => reply({ error: e.message, code: e.code || 'error' }));
    return true;
  }
  (async () => {
    if (msg.type === 'pageSelection' || msg.type === 'pageSelectionCleared') {
      const epub = isEpubReaderUrl(sender.url);
      const clipped = clipSource(sender.url);
      // A file from the computer: its top frame only, since local frames can load other files.
      const file = isLocalFileUrl(sender.url) && sender.frameId === 0;
      if (
        !sender.tab ||
        sender.tab.incognito ||
        (!/^https?:/.test(sender.url || '') &&
          !pdfSource(sender.url) &&
          !epub &&
          !clipped &&
          !file) ||
        (msg.type === 'pageSelection' && (typeof msg.text !== 'string' || !msg.text.trim()))
      )
        throw Error('Invalid selection');
      // sender.url keeps the load-time URL after history.pushState; the frame URL is current.
      let selectionUrl = pdfSource(sender.url);
      if (selectionUrl) {
        // Chrome hides extension documents from webNavigation.getFrame.
        if (!(await isCurrentPdfSender(sender))) throw Error('Stale PDF selection');
      } else if (clipped) {
        // The clipped-page reader quotes the page it shows.
        if (!(await isCurrentClipSender(sender))) throw Error('Stale clipped page selection');
        selectionUrl = clipped;
      } else if (epub) {
        // Like PDF.js, the reader is an extension document hidden from webNavigation.
        if (!isCurrentEpubSender(sender)) throw Error('Stale EPUB selection');
        // Quotes name the book by its vault identity, as PDF quotes name the source PDF.
        selectionUrl = epubDocument({ id: sender.tab.id, url: sender.url })?.url || sender.url;
      } else {
        const frame = await chrome.webNavigation.getFrame({
          tabId: sender.tab.id,
          frameId: sender.frameId,
        });
        if (!frame || (sender.documentId && frame.documentId !== sender.documentId))
          throw Error('Stale selection');
        selectionUrl = /^https?:/.test(frame.url || '') ? frame.url : sender.url;
      }
      await getSession(sender.tab.id);
      for (const s of sessions.values()) {
        if (s.tabId !== sender.tab.id) continue;
        if (msg.type === 'pageSelectionCleared') {
          if (
            !msg.selectionId ||
            s.selection?.selectionId !== msg.selectionId ||
            s.selection.frameId !== sender.frameId ||
            s.selection.documentId !== sender.documentId
          )
            continue;
          s.selection = null;
          await persist();
          for (const p of s.ports) event(p, 'codex-selection', null);
          continue;
        }
        s.selection = {
          selectionId: msg.selectionId,
          id: crypto.randomUUID(),
          text: msg.text.slice(0, 20000),
          truncated: !!msg.truncated || msg.text.length > 20000,
          url: selectionUrl,
          title: typeof msg.title === 'string' ? msg.title.slice(0, 500) : '',
          frameId: sender.frameId,
          documentId: sender.documentId,
          tabId: sender.tab.id,
          locator: msg.locator && JSON.stringify(msg.locator).length < 24000 ? msg.locator : null,
        };
        await persist();
        for (const p of s.ports) event(p, 'codex-selection', s.selection);
      }
      return {};
    }
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw Error('Invalid sender');
    if (readingMessages.has(msg.type)) return reading.message(msg, sender);
    if (msg.type === 'clipPage') {
      // From the side panel: the page it is beside, as for its reading notes.
      await loaded;
      const source = sessions.get(msg.conversationKey);
      if (!source) throw Error('Conversation not found');
      const tabId = sender.tab
        ? (agentCompanions.get(sender.tab.id) ?? source.tabId)
        : (msg.companionTabId ?? source.tabId);
      // A selection clip must still be the quote attached in this conversation.
      const selection = msg.mode === 'selection';
      return clipper.clip(tabId, {
        mode: selection ? 'selection' : 'article',
        expected: selection ? source.selection?.text || '' : '',
      });
    }
    if (msg.type === 'clipOpenView') {
      // From the side panel: the clipped copy of the page it is beside.
      await loaded;
      const source = sessions.get(msg.conversationKey);
      if (!source) throw Error('Conversation not found');
      const tabId = sender.tab
        ? (agentCompanions.get(sender.tab.id) ?? source.tabId)
        : (msg.companionTabId ?? source.tabId);
      const tab = await chrome.tabs.get(tabId);
      const url = pageAddress(tab.url || '');
      if (!/^https?:/.test(url)) throw Error('This page has no clipped copy');
      await openClip(tab, url);
      return {};
    }
    if (msg.type === 'openLibrary') {
      // From the side panel: the library opens next to the page it is beside.
      const tab = Number.isInteger(msg.companionTabId)
        ? await chrome.tabs.get(msg.companionTabId).catch(() => null)
        : null;
      await openEpubReader(tab || sender.tab);
      return {};
    }
    if (msg.type === 'openConversationLink') {
      await loaded;
      const source = sessions.get(msg.conversationKey);
      if (!source) throw Error('Conversation not found');
      const url = new URL(msg.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw Error('Invalid link');
      // A closed companion page cannot be navigated: the link opens beside the view instead.
      const owner = await chrome.tabs.get(
        await openTab(msg.companionTabId ?? source.tabId, sender.tab?.id ?? source.tabId),
      );
      if (msg.newTab === false && !owner.url?.startsWith(chrome.runtime.getURL('ui/chat.html'))) {
        await chrome.tabs.update(owner.id, { url: url.href });
        return { tabId: owner.id };
      }
      const tab = await chrome.tabs.create({
        url: url.href,
        windowId: owner.windowId,
        active: msg.active !== false,
      });
      await trackChild(tab.id, { ...source, tabId: owner.id });
      return { tabId: tab.id };
    }
    if (msg.type === 'urlHistory' || msg.type === 'switchHistory') {
      await loaded;
      const source = sessions.get(msg.conversationKey);
      if (!source) throw Error('Conversation not found');
      await Promise.all(
        [...sessions.values()].filter((s) => !s.closedTab).map((session) => recordHistory(session)),
      );
      const viewTabId = sender.tab
        ? (agentCompanions.get(sender.tab.id) ?? source.tabId)
        : (msg.companionTabId ?? source.tabId);
      if (source.threadId && !source.hasUserInput) {
        source.hasUserInput = await verifyHistory(source, source.threadId);
        await persist();
      }
      const viewSource = { ...source, tabId: viewTabId };
      await recordHistory(viewSource);
      const liveUrl = await historyUrl(viewSource);
      source.pageUrls ||= {};
      if (liveUrl) source.pageUrls[viewTabId] = liveUrl;
      const url = liveUrl || source.pageUrls[viewTabId] || '';
      await persist();
      const entries = url
        ? await urlHistory.list(url, (threadId) => verifyHistory(source, threadId))
        : [];
      if (
        source.threadId &&
        source.hasUserInput &&
        !entries.some((entry) => entry.threadId === source.threadId)
      ) {
        const current = await urlHistory.get(source.threadId);
        entries.unshift({
          ...current,
          threadId: source.threadId,
          title: source.title || current?.title || '',
          updatedAt: current?.updatedAt || Date.now(),
          settings: source.settings,
          scope: source.scope,
        });
      }
      if (msg.type === 'urlHistory') return { url, entries, current: source.threadId };
      const entry = entries.find((item) => item.threadId === msg.threadId);
      if (!entry) throw Error('Conversation does not belong to this URL');
      let target = [...sessions.values()].find(
        (s) => s.threadId === entry.threadId && !s.closedTab,
      );
      if (!target) {
        const id = crypto.randomUUID();
        target = {
          id,
          key: id,
          tabId: await openTab(viewTabId, sender.tab?.id ?? source.tabId),
          threadId: entry.threadId,
          title: entry.title,
          hasUserInput: true,
          scope: entry.scope || source.scope,
          settings: entry.settings,
          draft: '',
          ports: new Set(),
        };
        sessions.set(id, target);
      }
      reading.keepPage(target, source, viewTabId);
      if (sender.tab && agentViews.has(sender.tab.id)) {
        agentViews.set(sender.tab.id, target.key);
      } else {
        sidebarViews.set(viewTabId, target.key);
      }
      await persist();
      return {};
    }
    if (msg.type === 'openRelatedThread') {
      await loaded;
      const source = sessions.get(msg.conversationKey);
      if (!source?.relatedThreads?.includes(msg.threadId))
        throw Error('Conversation is not related');
      if (openingThreads.has(msg.threadId)) return openingThreads.get(msg.threadId);
      const operation = (async () => {
        let target = [...sessions.values()].find(
          (s) => s.threadId === msg.threadId && !s.closedTab,
        );
        if (target) {
          const view = [...agentViews].find(([, key]) => key === target.key);
          const tabId = target.viewOnly ? view?.[0] : target.tabId;
          if (tabId != null) {
            if (!target.viewOnly && !agentViews.has(tabId))
              chrome.sidePanel.open({ tabId }).catch(() => {});
            const tab = await chrome.tabs.update(tabId, { active: true });
            await chrome.windows.update(tab.windowId, { focused: true });
            return { tabId: tab.id };
          }
        }
        const saved = closedViews.get(msg.threadId);
        const companion =
          saved?.tabId != null ? await chrome.tabs.get(saved.tabId).catch(() => null) : null;
        const id = crypto.randomUUID();
        target = {
          id,
          key: id,
          threadId: msg.threadId,
          tabId: companion?.id ?? null,
          scope: saved?.scope || 'window',
          settings: saved?.settings,
          viewOnly: true,
          draft: '',
          ports: new Set(),
        };
        sessions.set(id, target);
        const owner = await chrome.tabs.get(source.tabId);
        const result = await openAgentTab(target, owner.windowId);
        await chrome.windows.update(owner.windowId, { focused: true });
        return result;
      })();
      openingThreads.set(msg.threadId, operation);
      try {
        return await operation;
      } finally {
        openingThreads.delete(msg.threadId);
      }
    }
    if (msg.type === 'openAgent') {
      await loaded;
      const s = sessions.get(msg.conversationKey);
      if (!s) throw Error('Conversation not found');
      return openAgentTab(s, msg.windowId, msg.companionTabId ?? s.tabId);
    }
    if (msg.type === 'takeForkInput') {
      await loaded;
      const source = sessions.get(msg.conversationKey);
      const input = source?.forkInput || null;
      if (source) {
        delete source.forkInput;
        await persist();
      }
      return { input };
    }
    if (msg.type === 'newConversation') {
      await loaded;
      const source = sessions.get(msg.conversationKey);
      if (!source) throw Error('Conversation not found');
      if (msg.fork?.threadId && !source.messageForks?.includes(msg.fork.threadId))
        throw Error('Conversation fork is not available');
      const id = crypto.randomUUID();
      const tabId = await openTab(
        msg.companionTabId ?? source.tabId,
        sender.tab?.id ?? source.tabId,
      );
      const session = {
        threadId: msg.fork?.threadId,
        forkInput: msg.fork?.input || null,
        hasUserInput: Boolean(msg.fork?.threadId),
        title: msg.fork?.threadId ? source.title : undefined,

        id,
        key: id,
        tabId,
        scope: source.scope,
        viewOnly: Boolean(sender.tab && agentViews.has(sender.tab.id)),
        settings: {
          model: String(msg.settings?.model || '').slice(0, 200),
          effort: String(msg.settings?.effort || '').slice(0, 30),
          mode: msg.settings?.mode === 'plan' ? 'plan' : 'default',
          permissionMode: ['ask', 'auto', 'full'].includes(msg.settings?.permissionMode)
            ? msg.settings.permissionMode
            : 'ask',
        },
        draft: '',
        annotations: cleanAnnotations(msg.annotations),
        ports: new Set(),
      };
      reading.keepPage(session, source, msg.companionTabId ?? source.tabId);
      await recordHistory(source);
      sessions.set(id, session);
      if (msg.fork?.threadId) await recordHistory(session);
      if (sender.tab && agentViews.has(sender.tab.id)) {
        agentViews.set(sender.tab.id, id);
      } else {
        sidebarViews.set(session.tabId, id);
      }
      await persist();
      return { conversationKey: id };
    }
  })().then(reply, (e) => reply({ error: e.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(async (id) => {
  await loaded;
  agentViews.delete(id);
  agentCompanions.delete(id);
  sidebarViews.delete(id);
  highlightStatus.delete(id);
  for (const [key, s] of sessions) {
    const remaining = [...agentViews, ...sidebarViews].find(([, owner]) => owner === key);
    if (s.tabId !== id && !(s.viewOnly && !remaining)) continue;
    if (remaining) s.tabId = remaining[0];
    else {
      if (!s.hasUserInput && !s.turnPending) {
        connect().postMessage({
          op: 'close',
          session: s.id,
          discardEmpty: true,
          threadId: s.threadId,
        });
        closedViews.delete(s.threadId);
        for (const child of sessions.values()) if (child.parent?.key === key) delete child.parent;
        sessions.delete(key);
        continue;
      }
      if (s.threadId)
        closedViews.set(s.threadId, {
          tabId: s.noCompanion ? null : s.tabId,
          scope: s.scope,
          settings: s.settings,
        });
      for (const child of sessions.values())
        if (child.parent?.key === key) child.parent.threadId ||= s.threadId;
      if (
        (s.parent && !s.linkRecorded) ||
        [...sessions.values()].some((child) => child.parent?.key === key && !child.linkRecorded)
      ) {
        s.closedTab = true;
      } else {
        native?.postMessage({ op: 'close', session: s.id });
        sessions.delete(key);
      }
    }
  }
  await persist();
  for (const session of sessions.values()) broadcast(session, { method: 'bridge/lineageChanged' });
  // Agent views whose page closed keep their conversation and show the page as closed.
  for (const session of sessions.values())
    for (const port of session.ports)
      if (port.companionTabId === id) {
        event(port, 'codex-context', await viewContext(session, port));
        event(port, 'codex-reading-changed');
      }
});
chrome.webNavigation.onCommitted.addListener(async (detail) => {
  await loaded;
  const staleHighlights = detail.frameId === 0 && highlightStatus.delete(detail.tabId);
  for (const s of sessions.values()) {
    if (staleHighlights && s.tabId === detail.tabId)
      for (const p of s.ports) event(p, 'codex-highlight-status', null);
    if (
      s.tabId !== detail.tabId &&
      ![...s.ports].some((port) => port.companionTabId === detail.tabId)
    )
      continue;
    if (detail.frameId === 0 && detail.url) {
      s.pageUrls ||= {};
      s.pageUrls[detail.tabId] = pageAddress(detail.url);
      reading.navigated(s, detail.tabId, s.pageUrls[detail.tabId]);
      await persist();
    }

    if (s.selection && (detail.frameId === 0 || s.selection.frameId === detail.frameId)) {
      s.selection = null;
      await persist();
      for (const p of s.ports) event(p, 'codex-selection', null);
    }
  }
});
// Files the user opens from the computer (file://): the one-time access prompt, and files that
// were open before Tabgent could read them.
startLocalFiles();
loaded.then(() => {
  connect();
  void reading.flush().catch(console.warn);
  for (const session of sessions.values()) {
    if (
      (session.parent && !session.linkRecorded) ||
      [...sessions.values()].some(
        (child) => child.parent?.key === session.key && !child.linkRecorded,
      )
    )
      connect().postMessage({ op: 'claim', session: session.id, threadId: session.threadId });
  }
});

// Native PDF selections are exposed by Chrome's selection context menu.
chrome.runtime.onInstalled.addListener(() => {
  void feeds.start().catch(console.warn);
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'quote-selection',
      title: chrome.i18n.getMessage('selectionMenu'),
      contexts: ['selection'],
    });
    // The toolbar button's right-click menu opens the library, which is also the EPUB reader.
    chrome.contextMenus.create({
      id: 'open-epub-reader',
      title: chrome.i18n.getMessage('libraryOpen'),
      contexts: ['action'],
    });
    // Clipping saves the page's text in the vault. The page item is not offered on a
    // selection, so the selection's own item is never grouped into a submenu with it.
    chrome.contextMenus.create({
      id: 'clip-page',
      title: chrome.i18n.getMessage('clipPage'),
      contexts: ['action'],
    });
    chrome.contextMenus.create({
      id: 'clip-page-context',
      title: chrome.i18n.getMessage('clipPage'),
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  });
});
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command === 'clip-page' && Number.isInteger(tab?.id))
    void clipper.clip(tab.id).catch(console.warn);
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-epub-reader') return void openEpubReader(tab).catch(console.warn);
  if (info.menuItemId === 'clip-page' || info.menuItemId === 'clip-page-context') {
    if (Number.isInteger(tab?.id)) void clipper.clip(tab.id).catch(console.warn);
    return;
  }
  if (info.menuItemId !== 'quote-selection' || !info.selectionText || !tab?.id || tab.incognito)
    return;
  // Invoke synchronously while Chrome's context-menu user gesture is active.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  void (async () => {
    await getSession(tab.id);
    for (const s of sessions.values()) {
      if (s.tabId !== tab.id) continue;
      const text = info.selectionText;
      const pdf = pdfSource(tab.url);
      const quoteUrl = pdf || info.frameUrl || info.pageUrl;
      const existing =
        s.selection?.text === text &&
        s.selection?.url === quoteUrl &&
        (pdf || s.selection?.frameId === (info.frameId || 0)) &&
        Date.now() - Date.parse(s.selection?.locator?.capturedAt) < 2000
          ? s.selection
          : null;
      s.selection = {
        ...existing,
        id: crypto.randomUUID(),
        text: text.slice(0, 20000),
        truncated: text.length > 20000,
        url: quoteUrl,
        title: tab.title || '',
        tabId: tab.id,
        frameId: info.frameId || 0,
        locator: existing?.locator || {
          kind: 'native-selection',
          pageUrl: info.pageUrl,
          frameUrl: info.frameUrl,
          positionAvailable: false,
        },
      };
      await persist();
      for (const p of s.ports) event(p, 'codex-selection', s.selection);
    }
  })();
});
