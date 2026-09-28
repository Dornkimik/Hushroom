(() => {
  const key = 'hushroom-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['light', 'dark', 'system'].includes(value);
  let preference = 'system';
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch { /* The theme still works when browser storage is unavailable. */ }
  function apply() {
    document.documentElement.dataset.theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    const select = document.getElementById('theme-select');
    if (select) select.value = preference;
  }
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = valid(event.newValue) ? event.newValue : 'system';
      apply();
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme-select');
    apply();
    select.addEventListener('change', () => {
      preference = select.value;
      try { localStorage.setItem(key, preference); } catch { /* Keep the in-memory choice. */ }
      apply();
    });
  });
})();
