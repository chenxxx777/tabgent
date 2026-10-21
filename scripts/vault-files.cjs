// The documents of a test vault as the browser tests check them: each one's record
// (.tabgent/documents/<id>/anchors.json) and the Markdown files it names: its note, its
// discussions with Codex and its full text.
const fs = require('node:fs');
const path = require('node:path');

function read(vault, relative) {
  const file = relative && path.join(vault, relative);
  return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function vaultDocuments(vault) {
  const records = path.join(vault, '.tabgent', 'documents');
  if (!fs.existsSync(records)) return [];
  return fs
    .readdirSync(records)
    .filter((id) => fs.existsSync(path.join(records, id, 'anchors.json')))
    .map((id) => {
      const folder = path.join(records, id);
      const anchors = JSON.parse(fs.readFileSync(path.join(folder, 'anchors.json'), 'utf8'));
      const files = anchors.document.files || {};
      const full = (files.full || [])[0];
      return {
        id,
        name: id,
        folder,
        anchors,
        category: anchors.document.category,
        files,
        notesPath: files.notes && path.join(vault, files.notes),
        notes: read(vault, files.notes),
        discussionsPath: files.discussions && path.join(vault, files.discussions),
        discussions: read(vault, files.discussions),
        fullTextPath: full && path.join(vault, full),
        fullText: read(vault, full),
      };
    });
}

module.exports = { vaultDocuments };
