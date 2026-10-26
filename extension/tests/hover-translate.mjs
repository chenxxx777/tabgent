import assert from 'node:assert/strict';
import { createTranslateRelay, TRANSLATE_PORT } from '../translate-routing.js';
await import('../hover-translate.js');
const hover = globalThis.tabgentHoverTranslate;

// English detection: a local rule, no language service.
for (const text of [
  'Reading is a loop, not a line.',
  'OK',
  'The word 中 means middle in Chinese, and it is one of the most common characters there.',
  'Café culture in Paris is older than most people think.',
  'const value = items.map((item) => item.id);',
])
  assert.equal(hover.isEnglish(text), true, text);
for (const text of [
  '阅读是一个循环，而不是一条线。',
  'Codex 是一个很好用的工具，我每天都用它来写代码。',
  'これは日本語の文章です。',
  '한국어 문장입니다.',
  'Это предложение на русском языке.',
  'Tiếng Việt có nhiều dấu thanh điệu khác nhau.',
  '2026-10-26 14:30',
  'a',
  '',
])
  assert.equal(hover.isEnglish(text), false, text);
console.log('PASS English is told apart from Chinese, Japanese, Korean and other scripts');

// What Codex receives, and the limit.
assert.deepEqual(hover.prepare('  Two   spaces\u00a0and\ttabs.  '), {
  text: 'Two spaces and tabs.',
  truncated: false,
});
assert.equal(
  hover.prepare('Title\nFirst line.\n\n\n\nNext part.').text,
  'Title\nFirst line.\n\nNext part.',
);
assert.equal(
  hover.prepare(
    'A PDF line that is cut by a hyphen in trans-\nlation and\nwraps.\n\nNew paragraph.',
    {
      joinLines: true,
    },
  ).text,
  'A PDF line that is cut by a hyphen in translation and wraps.\n\nNew paragraph.',
);
const sentence = 'This sentence has exactly fifty characters in it. ';
assert.equal(sentence.length, 50);
const long = hover.prepare(sentence.repeat(60));
assert.equal(long.truncated, true);
assert(long.text.length <= hover.LIMIT, long.text.length);
assert(long.text.endsWith('in it.'), 'Cut at a sentence end');
const words = hover.prepare('word '.repeat(1000));
assert.equal(words.truncated, true);
assert(words.text.length <= hover.LIMIT && words.text.endsWith('word'));
assert.equal(hover.prepare('x'.repeat(2000)).truncated, false);
assert.equal(hover.prepare('x'.repeat(2001)).text.length, 2000);
// A huge selection is never scanned whole.
const huge = hover.prepare('Huge selection text. '.repeat(100000));
assert.equal(huge.truncated, true);
assert(huge.text.length <= hover.LIMIT);
console.log('PASS selections are cleaned and cut to 2000 characters at a sentence or word');

// The cache keeps the most recently used translations.
const cache = hover.createCache(2);
cache.set('a', '甲');
cache.set('b', '乙');
assert.equal(cache.get('a'), '甲');
cache.set('c', '丙');
assert.equal(cache.get('b'), undefined, 'The least recently used entry goes first');
assert.equal(cache.get('a'), '甲');
assert.equal(cache.get('c'), '丙');
cache.delete('a');
assert.equal(cache.size, 1);
console.log('PASS the cache keeps recent translations and evicts the oldest');

// Dwell: the pointer must rest on the selection for the hover time.
function fakeTimers() {
  let now = 0,
    next = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      timers.set(next, { fn, at: now + ms });
      return next++;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at))
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
    },
    get pending() {
      return timers.size;
    },
  };
}
let fired = 0,
  delay = 1000;
const timers = fakeTimers();
const dwell = hover.createDwell({ delay: () => delay, fire: () => fired++, timers });
dwell.update({ x: 10, y: 10 });
timers.advance(999);
assert.equal(fired, 0);
timers.advance(1);
assert.equal(fired, 1, 'Fires after the hover time');
dwell.update({ x: 10, y: 10 });
timers.advance(600);
dwell.update({ x: 12, y: 11 }); // a tremor is not a move
timers.advance(400);
assert.equal(fired, 2, 'Small movements do not restart the wait');
dwell.update({ x: 10, y: 10 });
timers.advance(600);
dwell.update({ x: 40, y: 10 });
timers.advance(600);
assert.equal(fired, 2, 'A real move restarts the wait');
timers.advance(400);
assert.equal(fired, 3);
dwell.update({ x: 10, y: 10 });
timers.advance(500);
dwell.update(null);
timers.advance(2000);
assert.equal(fired, 3, 'Leaving the selection stops the wait');
assert.equal(dwell.waiting, false);
delay = 2000;
dwell.update({ x: 1, y: 1 });
timers.advance(1500);
assert.equal(fired, 3, 'The hover time comes from the settings');
timers.advance(500);
assert.equal(fired, 4);
dwell.update({ x: 1, y: 1 });
dwell.stop();
assert.equal(timers.pending, 0);
console.log('PASS the hover timer waits for a resting pointer and stops when it leaves');

assert.deepEqual(hover.settingsOf(undefined), { enabled: true, delay: 1000 });
assert.deepEqual(hover.settingsOf({ enabled: false, delay: 1500 }), {
  enabled: false,
  delay: 1500,
});
assert.deepEqual(hover.settingsOf({ delay: 99999 }), { enabled: true, delay: 5000 });
assert.deepEqual(hover.settingsOf({ delay: 'soon' }), { enabled: true, delay: 1000 });
console.log('PASS settings default to on and one second');

// The page side of the port: streaming, cancel and a lost connection.
function fakePort() {
  const listeners = { message: [], disconnect: [] };
  return {
    sent: [],
    postMessage(message) {
      this.sent.push(message);
    },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    emit(message) {
      for (const fn of listeners.message) fn(message);
    },
    drop() {
      for (const fn of listeners.disconnect) fn();
    },
  };
}
let pagePort = fakePort(),
  connects = 0;
const client = hover.createClient(() => {
  connects++;
  return pagePort;
});
const events = [];
const handlers = (name) => ({
  onDelta: (delta) => events.push([name, 'delta', delta]),
  onDone: (text) => events.push([name, 'done', text]),
  onError: (error) => events.push([name, 'error', error.code]),
});
client.warm();
const cancelA = client.translate('First text.', handlers('a'));
client.translate('Second text.', handlers('b'));
assert.equal(connects, 1, 'One port per document');
assert.deepEqual(pagePort.sent[0], { type: 'warm' });
const [a, b] = pagePort.sent.slice(1);
assert.deepEqual(a, { type: 'translate', id: a.id, text: 'First text.' });
assert.notEqual(a.id, b.id);
pagePort.emit({ id: a.id, delta: '第一' });
pagePort.emit({ id: a.id, delta: '段' });
pagePort.emit({ id: a.id, done: true, text: '第一段' });
pagePort.emit({ id: a.id, delta: 'late' });
assert.deepEqual(events, [
  ['a', 'delta', '第一'],
  ['a', 'delta', '段'],
  ['a', 'done', '第一段'],
]);
cancelA(); // already finished: nothing to cancel
assert.equal(pagePort.sent.length, 3);
const cancelC = client.translate('Third text.', handlers('c'));
const c = pagePort.sent.at(-1);
cancelC();
assert.deepEqual(pagePort.sent.at(-1), { type: 'cancel', id: c.id });
pagePort.emit({ id: c.id, delta: 'ignored' });
pagePort.emit({ id: c.id, done: true, text: 'ignored' });
assert(!events.some(([name]) => name === 'c'), 'A cancelled request reports nothing');
pagePort.drop();
assert.deepEqual(events.at(-1), ['b', 'error', 'disconnected'], 'A lost port fails what is open');
pagePort = fakePort();
client.translate('Again.', handlers('d'));
assert.equal(connects, 2, 'The next request opens a new port');
assert.equal(client.size, 1);
const orphaned = hover.createClient(() => {
  throw Error('Extension context invalidated.');
});
orphaned.translate('Text.', handlers('e'));
assert.deepEqual(events.at(-1), ['e', 'error', 'disconnected']);
console.log('PASS the page client streams, cancels and reports a lost connection');

// The service worker relay: requests reach the connector, answers return to their port.
const native = { sent: [] };
let nativeBroken = false;
native.postMessage = (message) => {
  if (nativeBroken) throw Error('Attempting to use a disconnected port object');
  native.sent.push(message);
};
const relay = createTranslateRelay(() => native, { extensionId: 'tabgent' });
function senderPort(sender = { id: 'tabgent', tab: { id: 1 } }, name = TRANSLATE_PORT) {
  const port = fakePort();
  port.name = name;
  port.sender = sender;
  port.disconnected = false;
  port.disconnect = () => (port.disconnected = true);
  return port;
}
assert.equal(relay.accept(senderPort(undefined, 'chat')), false, 'Other ports are not ours');
const stranger = senderPort({ id: 'other-extension' });
assert.equal(relay.accept(stranger), true);
assert.equal(stranger.disconnected, true, 'Only Tabgent’s own scripts may translate');
const page = senderPort();
relay.accept(page);
page.emit({ type: 'warm' });
assert.deepEqual(native.sent.at(-1), { op: 'translateWarm' });
page.emit({ type: 'translate', id: 't1', text: 'Hello there.' });
const forwarded = native.sent.at(-1);
assert.deepEqual(forwarded, { op: 'translate', id: forwarded.id, text: 'Hello there.' });
assert.equal(relay.receive({ op: 'vault', id: 'x' }), false, 'Vault traffic is not ours');
relay.receive({ op: 'translate', id: forwarded.id, delta: '你好' });
relay.receive({ op: 'translate', id: forwarded.id, done: true, text: '你好。' });
assert.deepEqual(page.sent, [
  { id: 't1', delta: '你好' },
  { id: 't1', done: true, text: '你好。' },
]);
page.emit({ type: 'translate', id: 't2', text: 'x'.repeat(4001) });
assert.equal(page.sent.at(-1).error.code, 'too_long');
page.emit({ type: 'translate', id: 't3', text: '   ' });
assert.equal(page.sent.at(-1).error.code, 'failed');
page.emit({ type: 'translate', id: 't4', text: 'Cancel me.' });
const t4 = native.sent.at(-1).id;
page.emit({ type: 'cancel', id: 't4' });
assert.deepEqual(native.sent.at(-1), { op: 'translateCancel', id: t4 });
relay.receive({ op: 'translate', id: t4, done: true, text: 'late' });
assert.notDeepEqual(page.sent.at(-1).id, 't4', 'A cancelled answer is dropped');
page.emit({ type: 'translate', id: 't5', text: 'Tab closes.' });
const t5 = native.sent.at(-1).id;
page.drop();
assert.deepEqual(native.sent.at(-1), { op: 'translateCancel', id: t5 }, 'A closed page cancels');
assert.equal(relay.size, 0);
const other = senderPort();
relay.accept(other);
other.emit({ type: 'translate', id: 'u1', text: 'Connector goes away.' });
relay.disconnect('Native host has exited.');
assert.deepEqual(other.sent.at(-1), { id: 'u1', error: { code: 'disconnected', message: '' } });
other.emit({ type: 'translate', id: 'u2', text: 'No connector.' });
relay.disconnect('Specified native messaging host not found.');
assert.deepEqual(other.sent.at(-1), { id: 'u2', error: { code: 'host_missing', message: '' } });
nativeBroken = true;
other.emit({ type: 'translate', id: 'u3', text: 'Broken port.' });
assert.deepEqual(other.sent.at(-1), { id: 'u3', error: { code: 'disconnected', message: '' } });
console.log('PASS the relay forwards, cancels for closed pages and fails on a lost connector');
