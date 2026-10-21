// Vault document IDs. Must match extension/native/vault.py DOCUMENT_ID. Python 3 \w (no
// re.ASCII) is Unicode letters and numbers plus underscore. JavaScript \w is ASCII-only,
// so this uses \p{L}\p{N}. The id body is at most 160 characters, vault.py's limit.
// Hyphen is the separator. Slash, backslash, dot, whitespace and controls are not word
// characters, so they cannot appear in an id. An ID is an opaque key: the document's
// files are named after its title and found through the vault's catalog.
export const DOCUMENT_ID = /^(?:article|paper|book)-[\p{L}\p{N}_-]{1,160}$/u;

export function isDocumentId(value) {
  return typeof value === 'string' && DOCUMENT_ID.test(value);
}

// A section of a document's full text: an EPUB chapter's number in reading order, or a
// PDF page's number. Codex reads it from the vault with reading_vault.
export function isSection(value) {
  return Number.isInteger(value) && value >= 1 && value <= 100000;
}
