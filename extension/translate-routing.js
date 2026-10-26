// Hover translation requests from Tabgent's reading layers (content scripts and extension
// pages), relayed to the connector's translator. Each request is one-off: it carries the
// selected text only, never page context, a session or vault data. Requests a page drops
// (or a closed tab's) are cancelled in the connector too.
export const TRANSLATE_PORT = 'tabgent-translate';
const LIMIT = 4000;

export function createTranslateRelay(connect, { extensionId = chrome.runtime.id } = {}) {
  const routes = new Map();
  let sequence = 0;
  function post(message) {
    try {
      connect().postMessage(message);
      return true;
    } catch {
      return false;
    }
  }
  const answer = (port, message) => {
    try {
      port.postMessage(message);
    } catch {}
  };

  // Returns true when the port belongs to hover translation.
  function accept(port) {
    if (port.name !== TRANSLATE_PORT) return false;
    if (port.sender?.id !== extensionId || port.sender?.tab?.incognito) {
      port.disconnect();
      return true;
    }
    const own = new Map();
    port.onMessage.addListener((message) => {
      if (message?.type === 'warm') return void post({ op: 'translateWarm' });
      if (typeof message?.id !== 'string' || !message.id || message.id.length > 64) return;
      if (message.type === 'cancel') {
        const ident = own.get(message.id);
        if (!ident) return;
        own.delete(message.id);
        routes.delete(ident);
        post({ op: 'translateCancel', id: ident });
        return;
      }
      if (message.type !== 'translate' || own.has(message.id)) return;
      const text = typeof message.text === 'string' ? message.text : '';
      if (!text.trim() || text.length > LIMIT)
        return void answer(port, {
          id: message.id,
          error: { code: text.trim() ? 'too_long' : 'failed', message: '' },
        });
      const ident = `translate-${++sequence}`;
      own.set(message.id, ident);
      routes.set(ident, { port, id: message.id, own });
      if (!post({ op: 'translate', id: ident, text })) {
        own.delete(message.id);
        routes.delete(ident);
        answer(port, { id: message.id, error: { code: 'disconnected', message: '' } });
      }
    });
    port.onDisconnect.addListener(() => {
      for (const ident of own.values()) {
        routes.delete(ident);
        post({ op: 'translateCancel', id: ident });
      }
      own.clear();
    });
    return true;
  }

  // Returns true when the connector's message belonged to hover translation.
  function receive(message) {
    if (message?.op !== 'translate') return false;
    const route = routes.get(message.id);
    if (!route) return true;
    if (typeof message.delta === 'string') {
      answer(route.port, { id: route.id, delta: message.delta });
      return true;
    }
    routes.delete(message.id);
    route.own.delete(route.id);
    answer(
      route.port,
      message.error
        ? {
            id: route.id,
            error: {
              code: String(message.error.code || 'failed').slice(0, 40),
              message: String(message.error.message || '').slice(0, 300),
            },
          }
        : { id: route.id, done: true, text: typeof message.text === 'string' ? message.text : '' },
    );
    return true;
  }

  function disconnect(reason = '') {
    const code = /native messaging host not found/i.test(reason) ? 'host_missing' : 'disconnected';
    for (const route of routes.values()) {
      route.own.delete(route.id);
      answer(route.port, { id: route.id, error: { code, message: '' } });
    }
    routes.clear();
  }

  return {
    accept,
    receive,
    disconnect,
    get size() {
      return routes.size;
    },
  };
}
