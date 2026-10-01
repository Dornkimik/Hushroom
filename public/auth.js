(() => {
  const form = document.querySelector('#account-form');
  const notice = document.querySelector('#account-error');
  let busy = false;
  async function enter(action) {
    if (busy) return;
    busy = true; notice.textContent = '';
    for (const button of document.querySelectorAll('#entry button')) button.disabled = true;
    try {
      const response = await fetch(action === 'guest' ? '/api/session' : `/api/auth/${action}`, action === 'guest' ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username.value, password: form.password.value })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      form.reset(); location.assign('/chat/');
    } catch (e) { notice.textContent = e.message || 'Could not connect. Please try again.'; }
    finally { busy = false; for (const button of document.querySelectorAll('#entry button')) button.disabled = false; }
  }
  form.addEventListener('submit', event => { event.preventDefault(); enter(form.mode.value); });
  form.mode.addEventListener('change', () => {
    const register = form.mode.value === 'register';
    form.password.autocomplete = register ? 'new-password' : 'current-password';
    form.password.minLength = register ? 15 : 1;
    document.querySelector('#account-submit').textContent = register ? 'Create account & enter' : 'Log in & enter';
  });
  document.querySelector('#guest-enter').onclick = () => enter('guest');
  fetch('/api/auth/status').then(r => r.json()).then(({ me }) => {
    if (me?.account) {
      const link = document.querySelector('#continue-account'); link.hidden = false;
      link.textContent = `Continue as ${me.alias}`;
      document.querySelector('#guest-enter').hidden = true;
      form.hidden = true;
      document.querySelector('#guest-choice').hidden = true;
      document.querySelector('#account-choice').hidden = true;
      document.querySelector('#entry-return').hidden = false;
      document.querySelector('#entry').classList.add('has-account');
      document.querySelector('#entry-signout').hidden = false;
    }
  }).catch(() => {});
  document.querySelector('#entry-signout').onclick = async () => {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Could not sign out.');
      location.reload();
    } catch (e) { notice.textContent = e.message; }
  };
})();
