(() => {
  const dialog = document.createElement('dialog');
  dialog.id = 'feedback-dialog';
  dialog.setAttribute('aria-labelledby', 'feedback-title');
  dialog.innerHTML = `
    <div class="dialog-heading"><h2 id="feedback-title">Share feedback</h2><button class="close-dialog" type="button" aria-label="Close feedback">×</button></div>
    <p>Found a problem or have an idea? Let us know.</p>
    <p class="feedback-note" id="feedback-note">Only site admins can view your feedback. It is saved on the server until an admin deletes it. No name or email is required.</p>
    <form id="feedback-form" aria-describedby="feedback-note">
      <label for="feedback-subject">Title</label><input id="feedback-subject" name="title" maxlength="120" placeholder="A short summary" required>
      <label for="feedback-text">Feedback</label><textarea id="feedback-text" name="text" rows="6" maxlength="5000" placeholder="Tell us what happened or what you would improve…" required></textarea>
      <button class="primary" type="submit">Send feedback</button>
    </form>
    <p id="feedback-status" role="status" aria-live="polite"></p>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form'), status = dialog.querySelector('#feedback-status'), submit = form.querySelector('button');
  dialog.querySelector('.close-dialog').onclick = () => dialog.close();
  for (const button of document.querySelectorAll('[data-feedback]')) button.onclick = () => {
    if (form.hidden) { form.reset(); form.hidden = false; status.textContent = ''; }
    dialog.showModal();
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const title = form.elements.title.value.trim(), text = form.elements.text.value.trim();
    if (!title || !text) { status.textContent = 'Please add both a title and your feedback.'; return; }
    submit.disabled = true; status.textContent = 'Sending…';
    try {
      const session = await fetch('/api/session');
      if (!session.ok) throw new Error((await session.json()).error || 'Could not connect. Please try again.');
      const response = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, text }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not send feedback. Please try again.');
      form.hidden = true; status.textContent = 'Thank you! Your feedback has been sent to the admins.';
    } catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; }
  };
})();
