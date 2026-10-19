// The title and metadata a PDF is saved under in the ReadingVault: the metadata title as
// PDF.js chooses it, else the file name. The viewer and the library's import both use it,
// so an imported PDF and its highlights name the same document.
export async function pdfInfo(pdfDocument, source, name) {
  try {
    const { info, metadata } = await pdfDocument.getMetadata();
    const value = metadata?.get('dc:title');
    const title = value && value !== 'Untitled' && !/[￰-￿]/.test(value) ? value : info?.Title;
    return {
      title: (typeof title === 'string' && title.trim()) || name,
      meta: {
        author: typeof info?.Author === 'string' ? info.Author.trim() : '',
        // An imported PDF (urn:sha256:...) has no host.
        siteName: new URL(source).hostname,
      },
    };
  } catch {
    return { title: name, meta: {} };
  }
}
