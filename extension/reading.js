// Reading companion: conversations bound to ReadingVault documents and highlights.
// Pure helpers shared by the service worker and tests. They are generic over the
// document kind, so web, PDF and EPUB readers bind conversations the same way.
import { pageContextPrefix, readingContextPrefix } from './session-config.js';
import { normalizeUserInput } from './ui/user-input.js';
import { documentUrl } from './vault-client.js';

export const documentKinds = ['web', 'pdf', 'epub'];
export const limits = {
  highlight: 1500,
  noteUser: 600,
  noteAssistant: 1500,
  notes: 6000,
  noteCount: 5,
  quote: 2000,
};
const string = (value) => (typeof value === 'string' ? value : '');
export function clip(value, limit) {
  const text = string(value);
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

// The highlight a quoted selection was saved as, from any reader's hand-off payload.
export function selectionHighlight(selection) {
  const value = selection?.highlight;
  if (
    !/^(?:article|paper|book)-[\w-]{1,160}$/.test(string(value?.documentId)) ||
    !/^h\d{3,9}$/.test(string(value?.highlightId))
  )
    return null;
  return { documentId: value.documentId, highlightId: value.highlightId };
}
// Readers name their document kind on the highlight or the locator ('dom' is a plain page).
export function selectionKind(selection) {
  const kind = selection?.highlight?.kind || selection?.locator?.kind;
  return documentKinds.includes(kind) ? kind : null;
}

// A highlight binding for a conversation, built from a selection that carries a highlight.
export function highlightBinding(selection, page = {}) {
  const ref = selectionHighlight(selection);
  if (!ref) return null;
  return {
    ...ref,
    url: documentUrl(selection.url || page.url),
    title: clip(selection.title || page.title, 500),
    kind: selectionKind(selection) || page.kind || 'web',
    location: clip(selection.location, 200),
    text: clip(selection.text, limits.highlight),
  };
}

// Earlier turns on the same highlight from other conversations, newest first within
// the budget, returned in chronological order.
export function earlierNotes(turns, threadId, options = {}) {
  const { count, notes: budget } = { count: limits.noteCount, notes: limits.notes, ...options };
  const picked = [];
  let used = 0;
  for (const turn of [...(Array.isArray(turns) ? turns : [])].reverse()) {
    if (!turn || turn.threadId === threadId) continue;
    const note = {
      at: string(turn.at),
      user: clip(turn.user, limits.noteUser),
      assistant: clip(turn.assistant, limits.noteAssistant),
    };
    const size = note.user.length + note.assistant.length;
    if (picked.length >= count || used + size > budget) break;
    used += size;
    picked.unshift(note);
  }
  return picked;
}

// The hidden per-message context part. It is also the durable record of where a turn
// belongs: the service worker reads it back from the turn's user message when saving.
export function readingContext({ document, highlight, notes, vault, saving }) {
  const value = {};
  if (document)
    value.document = {
      title: clip(document.title, 500),
      url: document.url,
      kind: document.kind,
      ...(document.id ? { id: document.id } : {}),
      ...(document.notes ? { notes: document.notes } : {}),
      ...(document.chapters ? { chapters: document.chapters } : {}),
    };
  if (highlight)
    value.highlight = {
      id: highlight.highlightId,
      ...(highlight.location ? { location: highlight.location } : {}),
      ...(highlight.attached
        ? { attached: true }
        : highlight.text
          ? { text: clip(highlight.text, limits.highlight) }
          : {}),
    };
  if (notes?.length) value.earlierNotes = notes;
  if (vault?.path)
    value.vault = { path: vault.path, guide: vault.path.replace(/\/$/, '') + '/AGENTS.md' };
  value.saving = saving || 'off';
  return { type: 'text', text: readingContextPrefix + JSON.stringify(value), text_elements: [] };
}

function parse(text, prefix) {
  try {
    const value = JSON.parse(text.slice(prefix.length));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Extracts the saved form of a completed turn: the user's own words (several when the
// turn was steered), the final assistant Markdown, and the turn's reading context.
export function readingTurn(items, quoteLabel = '') {
  let reading = null,
    page = null,
    assistant = '';
  const texts = [],
    quotes = [],
    files = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.type === 'agentMessage') {
      if (item.phase !== 'commentary' && string(item.text).trim()) assistant = item.text;
      continue;
    }
    if (item?.type !== 'userMessage') continue;
    for (const part of normalizeUserInput(item.content || [])) {
      if (part.type === 'mention' || part.type === 'localImage') {
        files.push(string(part.name) || string(part.path).split('/').pop());
        continue;
      }
      if (!['text', 'input_text'].includes(part.type)) continue;
      const text = string(part.text);
      if (part.browserContext) {
        if (text.startsWith(readingContextPrefix)) reading ||= parse(text, readingContextPrefix);
        if (text.startsWith(pageContextPrefix)) page ||= parse(text, pageContextPrefix);
        continue;
      }
      if (quoteLabel && text.startsWith(quoteLabel + '\n')) {
        const [, , , ...lines] = text.split('\n');
        quotes.push(lines.join('\n').trim());
        continue;
      }
      if (text.trim()) texts.push(text.trim());
    }
  }
  const quoted = reading?.highlight?.attached ? [] : quotes.filter(Boolean);
  const user = [
    ...quoted.map((quote) =>
      clip(quote, limits.quote)
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n'),
    ),
    ...texts,
    ...(files.filter(Boolean).length ? ['Attached: ' + files.filter(Boolean).join(', ')] : []),
  ].join('\n\n');
  return { reading, page, user, assistant };
}

// vault/discussion/append parameters for a saved turn, or null when it is not saved.
export function appendParams(record, threadId, turn) {
  const reading = record?.reading,
    document = reading?.document;
  if (
    !reading ||
    !['highlight', 'document'].includes(reading.saving) ||
    !document?.url ||
    !documentKinds.includes(document.kind) ||
    !threadId ||
    !turn?.id ||
    turn.status !== 'completed' ||
    !string(record.assistant).trim()
  )
    return null;
  const highlightId = reading.saving === 'highlight' ? string(reading.highlight?.id) || null : null;
  if (reading.saving === 'highlight' && (!highlightId || !document.id)) return null;
  return {
    ...(document.id ? { documentId: document.id } : {}),
    url: document.url,
    title: string(document.title),
    kind: document.kind,
    highlightId,
    threadId,
    turnId: turn.id,
    user: record.user,
    assistant: record.assistant,
    at: Number.isFinite(turn.completedAt) ? turn.completedAt * 1000 : Date.now(),
  };
}

// The binding recorded in a reading context part, used when a thread is resumed or
// forked without one (for example after a browser restart cleared session state).
export function recordedBinding(reading) {
  const document = reading?.document;
  if (!document?.url || !documentKinds.includes(document.kind) || !document.id) return null;
  if (reading.saving === 'highlight' && /^h\d{3,9}$/.test(string(reading.highlight?.id)))
    return {
      documentId: document.id,
      highlightId: reading.highlight.id,
      url: document.url,
      title: clip(document.title, 500),
      kind: document.kind,
      location: clip(reading.highlight.location, 200),
      text: clip(reading.highlight.text, limits.highlight),
    };
  if (reading.saving === 'document')
    return {
      documentId: document.id,
      highlightId: null,
      url: document.url,
      title: clip(document.title, 500),
      kind: document.kind,
    };
  return null;
}

// The latest recorded binding in a thread's history.
export function threadBinding(thread) {
  for (const turn of [...(thread?.turns || [])].reverse())
    for (const item of [...(turn.items || [])].reverse()) {
      if (item?.type !== 'userMessage') continue;
      const { reading } = readingTurn([item]);
      if (reading) return recordedBinding(reading);
    }
  return null;
}
