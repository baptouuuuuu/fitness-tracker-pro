import { api, escapeHtml as esc, logout, message, time } from './tracker.js';
import { exportSession } from './core.js';

const portal = document.querySelector('#portal');
document.querySelector('#logout').addEventListener('click', () => logout().catch(error => message(error.message)));

async function render() {
  const [me, clients, assignments] = await Promise.all([api('/api/me'), api('/api/clients'), api('/api/assignments')]);
  let local = {};
  try { local = JSON.parse(localStorage.getItem(`fitness-tracker-professional-${me.id}`) || '{}'); }
  catch { message('Impossible de lire les séances locales de ce navigateur.'); }
  const sessions = Array.isArray(local.sessions) ? local.sessions : [];
  const clientSummaries = clients.map(client => {
    const assigned = assignments.filter(a => a.clientId === client.id);
    const completed = assigned.filter(a => a.completedAt).length;
    const exercisesDone = assigned.reduce((count, a) => count + a.exercises.filter(e => e.completed).length, 0);
    const exercisesTotal = assigned.reduce((count, a) => count + a.items.length, 0);
    return `<li><strong>${esc(client.email)}</strong> · ${completed}/${assigned.length} séances terminées · ${exercisesDone}/${exercisesTotal} exercices réalisés</li>`;
  }).join('');
  portal.innerHTML = `
    <div class="tracker-grid">
      <section class="panel tracker-form">
        <h2>Mes clients</h2>
        ${clients.length ? `<ul>${clientSummaries}</ul>` : '<p>Aucun client pour le moment.</p>'}
        <button class="secondary" id="invite">Créer un lien d’invitation</button>
        <p id="invite-result"></p>
      </section>
      <section class="panel tracker-form">
        <h2>Mon offre</h2>
        <p>${me.paid ? 'Abonnement actif.' : 'Gratuit : 1 client et 3 séances attribuées au total.'}</p>
        ${me.paid ? '' : '<button class="primary" id="checkout">Passer à l’offre payante</button>'}
        <button class="secondary" id="billing">Gérer mon abonnement</button>
      </section>
    </div>
    <section class="panel tracker-form">
      <h2>Attribuer une séance</h2>
      <p>Les séances créées dans ce navigateur sont disponibles ici.</p>
      <a class="secondary tracker-link" href="/">Créer ou modifier une séance ↗</a>
      <form id="assign" class="tracker-form">
        <label>Client <select name="client" required><option value="">Choisir un client</option>${clients.map(c => `<option value="${c.id}">${esc(c.email)}</option>`).join('')}</select></label>
        <label>Séance enregistrée <select name="session" required><option value="">Choisir une séance</option>${sessions.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join('')}</select></label>
        <button class="primary">Envoyer la séance</button>
      </form>
    </section>
    <section class="tracker-form">
      <h2>Suivi des séances</h2>
      ${assignments.length ? assignments.map(a => `<article class="panel tracker-form">
        <h3>${esc(a.name)} · ${esc(a.clientEmail)}</h3>
        <p>Attribuée le ${time(a.createdAt)} · ${a.completedAt ? `Terminée le ${time(a.completedAt)}` : 'Non terminée'}</p>
        <p>Feedback de séance : ${esc(a.feedback || '—')}</p>
        <ul>${a.items.map((item, index) => {
          const entry = a.exercises.find(e => e.itemIndex === index);
          return `<li>${esc(item.exercise?.name || item.exerciseId)} — ${entry?.completed ? 'réalisé' : 'à faire'}${entry?.feedback ? ` · ${esc(entry.feedback)}` : ''}</li>`;
        }).join('')}</ul>
      </article>`).join('') : '<p>Aucune séance attribuée.</p>'}
    </section>`;
  document.querySelector('#invite').addEventListener('click', async () => {
    try {
      const result = await api('/api/invites', {});
      const target = document.querySelector('#invite-result');
      target.textContent = `Lien valable 7 jours, à transmettre en privé : ${result.url}`;
    } catch (error) { message(error.message); }
  });
  for (const [id, endpoint] of [['checkout','checkout'], ['billing','portal']]) {
    document.querySelector(`#${id}`)?.addEventListener('click', async () => {
      try {
        const result = await api(`/api/billing/${endpoint}`, {});
        location.assign(result.url);
      } catch (error) { message(error.message); }
    });
  }
  document.querySelector('#assign').addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const session = sessions[Number(data.get('session'))];
    if (!session) return message('Choisissez une séance.');
    try {
      await api('/api/assignments', {clientId:Number(data.get('client')), session:JSON.parse(exportSession(session))});
      message('Séance envoyée.');
      await render();
    } catch (error) { message(error.message); }
  });
}

render().catch(error => message(error.message));
