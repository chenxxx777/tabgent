// Explains Chrome's "Allow access to file URLs" setting, the one step Tabgent needs before
// it can read files the user opens in Chrome, and opens Tabgent's page in chrome://extensions.
import { localize } from './i18n.js';
import { fileAccessAllowed, fileAccessSettingsUrl } from './local-files.js';
localize();
const button = document.querySelector('#open');
button.onclick = async () => {
  const tab = await chrome.tabs.getCurrent();
  await chrome.tabs.update(tab.id, { url: fileAccessSettingsUrl() });
};
// Turning the setting on reloads Tabgent, which closes this page; a page opened later says so.
if (await fileAccessAllowed()) {
  document.querySelector('#status').hidden = false;
  button.hidden = true;
}
