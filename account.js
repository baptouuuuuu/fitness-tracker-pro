import { api, message } from './tracker.js';

const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
if (invite) {
  document.querySelector('#register-title').textContent = 'Créer mon compte client';
  document.querySelector('#register-description').textContent = 'Cette invitation vous relie au professionnel qui vous l’a envoyée.';
}
for (const form of document.querySelectorAll('form')) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (form.id === 'register' && invite) data.invite = invite;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const result = await api(`/api/${form.id}`, data);
      location.assign(result.role === 'client' ? '/client.html' : '/portal.html');
    } catch (error) {
      message(error.message);
      button.disabled = false;
    }
  });
}
