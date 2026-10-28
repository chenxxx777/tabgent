const escape = (text) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
const glob = (pattern, text) =>
  new RegExp(`^${escape(pattern).replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(text);

function matches(pattern, address) {
  const url = new URL(address);
  const parts = /^(\*|https?|file):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!parts) return false;
  const [, scheme, host, pathname] = parts;
  if (scheme === '*' ? !/^https?:$/.test(url.protocol) : url.protocol !== `${scheme}:`)
    return false;
  if (
    host !== '*' &&
    host !== url.hostname &&
    !(
      host.startsWith('*.') &&
      (url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)))
    )
  )
    return false;
  return glob(pathname, url.pathname + url.search + url.hash);
}

// Reuse the manifest's order, frame scope and exclusions; never broaden host access.
export async function reinjectContentScripts(api = chrome) {
  const scripts = api.runtime.getManifest().content_scripts || [];
  const fileAccess = await api.extension.isAllowedFileSchemeAccess();
  const tabs = await api.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((tab) => !tab.incognito && Number.isInteger(tab.id))
      .map(async (tab) => {
        const frames = (await api.webNavigation.getAllFrames({ tabId: tab.id })) || [];
        await Promise.allSettled(
          frames.map(async (frame) => {
            if (
              !/^https?:|^file:/.test(frame.url) ||
              (!fileAccess && frame.url.startsWith('file:'))
            )
              return;
            if (frame.documentLifecycle && frame.documentLifecycle !== 'active') return;
            const entries = scripts.filter(
              (entry) =>
                (entry.all_frames || frame.frameId === 0) &&
                entry.matches.some((pattern) => matches(pattern, frame.url)) &&
                !entry.exclude_matches?.some((pattern) => matches(pattern, frame.url)) &&
                (!entry.include_globs ||
                  entry.include_globs.some((pattern) => glob(pattern, frame.url))) &&
                !entry.exclude_globs?.some((pattern) => glob(pattern, frame.url)),
            );
            const files = [...new Set(entries.flatMap((entry) => entry.js || []))];
            if (!files.length) return;
            // A navigation between enumeration and injection must not target the next document.
            const target = {
              tabId: tab.id,
              ...(frame.documentId
                ? { documentIds: [frame.documentId] }
                : { frameIds: [frame.frameId] }),
            };
            const css = [...new Set(entries.flatMap((entry) => entry.css || []))];
            if (css.length) {
              await api.scripting.removeCSS({ target, files: css });
              await api.scripting.insertCSS({ target, files: css });
            }
            await api.scripting.executeScript({ target, files });
          }),
        );
      }),
  );
}
