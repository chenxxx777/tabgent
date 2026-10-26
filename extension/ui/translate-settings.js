// The hover translation switch and hover time in the reading menu. Every reading layer reads
// them from extension storage and follows changes at once.
import '../hover-translate.js';

export function initTranslateSettings({ $, i18n }) {
  const { KEY, DELAYS, DEFAULTS, settingsOf } = globalThis.tabgentHoverTranslate;
  const toggle = $('translateHover'),
    delay = $('translateDelay');
  for (const ms of DELAYS) {
    const option = document.createElement('option');
    option.value = String(ms);
    option.textContent = i18n('translateSeconds', ms / 1000);
    delay.append(option);
  }
  let settings = { ...DEFAULTS };
  function render() {
    toggle.checked = settings.enabled;
    delay.value = String(DELAYS.includes(settings.delay) ? settings.delay : DEFAULTS.delay);
    delay.disabled = !settings.enabled;
  }
  const storage = globalThis.chrome?.storage;
  async function save(change) {
    settings = { ...settings, ...change };
    render();
    await storage?.local.set({ [KEY]: settings });
  }
  toggle.onchange = () => void save({ enabled: toggle.checked });
  delay.onchange = () => void save({ delay: Number(delay.value) });
  storage?.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    settings = settingsOf(changes[KEY].newValue);
    render();
  });
  render();
  void storage?.local
    .get(KEY)
    .then((value) => {
      settings = settingsOf(value[KEY]);
      render();
    })
    .catch(() => {});
}
