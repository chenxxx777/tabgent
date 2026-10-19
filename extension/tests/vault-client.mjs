import assert from 'node:assert/strict';
import { createVaultClient, cleanWebAnchor, documentUrl } from '../vault-client.js';

const sent = [];
let connected = 0,
  broken = false;
const port = {
  postMessage(message) {
    if (broken) throw Error('Attempting to use a disconnected port object');
    sent.push(message);
  },
};
const vault = createVaultClient(
  () => {
    connected++;
    return port;
  },
  { timeout: 50 },
);

const status = vault.request('vault/status');
const resolve = vault.request('vault/document/resolve', { url: 'https://example.test/a' });
assert.deepEqual(sent[0], { op: 'vault', id: sent[0].id, method: 'vault/status', params: {} });
assert.notEqual(sent[0].id, sent[1].id, 'Each request has its own id');
assert.equal(vault.receive({ op: 'event', session: 'x' }), false, 'Session traffic is not vault');
assert.equal(vault.receive({ op: 'vault', id: 'unknown', result: {} }), true);
// Responses can arrive out of order.
vault.receive({ op: 'vault', id: sent[1].id, result: { document: null, highlights: [] } });
vault.receive({ op: 'vault', id: sent[0].id, result: { configured: false } });
assert.deepEqual(await resolve, { document: null, highlights: [] });
assert.deepEqual(await status, { configured: false });
console.log('PASS envelope shape / unique ids / out-of-order results / foreign messages ignored');

const failing = vault.request('vault/highlight/delete', { documentId: 'd', highlightId: 'h' });
vault.receive({
  op: 'vault',
  id: sent.at(-1).id,
  error: { code: 'not_found', message: 'No such highlight' },
});
await assert.rejects(
  failing,
  (error) => error.code === 'not_found' && /No such/.test(error.message),
);
await assert.rejects(vault.request('vault/status'), (error) => error.code === 'timeout');
assert.equal(vault.size, 0, 'Timed-out requests are forgotten');
vault.receive({ op: 'vault', id: sent.at(-1).id, result: {} });
console.log('PASS host error codes / timeout rejection / late response after timeout');

const first = vault.request('vault/status'),
  second = vault.request('vault/highlights/list', { documentId: 'd' });
vault.disconnect('Native host has exited.');
await assert.rejects(first, (error) => error.code === 'disconnected');
await assert.rejects(second, (error) => error.code === 'disconnected');
const missing = vault.request('vault/status');
vault.disconnect('Specified native messaging host not found.');
await assert.rejects(missing, (error) => error.code === 'host_missing');
broken = true;
await assert.rejects(vault.request('vault/status'), (error) => error.code === 'disconnected');
assert.equal(vault.size, 0);
assert(connected >= 6, 'Every request asks for the current connector port');
console.log('PASS disconnect rejects pending requests / missing host / dead port');

const anchor = {
  kind: 'web',
  quote: { exact: 'quote', prefix: 'p'.repeat(100), suffix: 's', extra: true },
  position: { start: 3, end: 8 },
  dom: { start: { path: 'html > body', offset: 0 }, end: { path: 'html > body', offset: -1 } },
  script: '<b>',
};
assert.deepEqual(cleanWebAnchor(anchor), {
  kind: 'web',
  quote: { exact: 'quote', prefix: 'p'.repeat(64), suffix: 's' },
  position: { start: 3, end: 8 },
});
assert.equal(cleanWebAnchor({ ...anchor, kind: 'pdf' }), null);
assert.equal(cleanWebAnchor({ ...anchor, position: { start: 8, end: 3 } }), null);
assert.equal(documentUrl('https://example.test/a?b=1#section'), 'https://example.test/a?b=1');
console.log('PASS anchor cleaning and fragment-free document URLs');
