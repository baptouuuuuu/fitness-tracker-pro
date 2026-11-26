import { api, escapeHtml as esc, logout, message, time } from './tracker.js';
import { makeTimeline, locatePhase, formatTime } from './core.js';

const container = document.querySelector('#sessions');
document.querySelector('#logout').addEventListener('click', () => logout().catch(error => message(error.message)));
let timer;
let timerTarget;

async function render() {
  const assignments = await api('/api/assignments');
  container.innerHTML = assignments.length ? assignments.map(a => `<article class="panel tracker-form">
    <h2>${esc(a.name)}</h2><p>Attribuée le ${time(a.createdAt)}</p>
    <button class="secondary" data-timer="${a.id}">Démarrer le chronomètre</button>
    <div id="timer-${a.id}" aria-live="polite"></div>
    ${a.items.map((item, index) => {
      const exercise = item.exercise;
      const entry = a.exercises.find(e => e.itemIndex === index);
      return `<section class="tracker-exercise">
        <h3>${esc(exercise?.name || item.exerciseId)}</h3>
        <p>${item.sets} séries · ${item.work} s d’effort · ${item.rest} s de repos</p>
        <details><summary>Instructions</summary><ol>${(exercise?.steps || []).map(step => `<li>${esc(step)}</li>`).join('')}</ol></details>
        <form class="tracker-form" data-id="${a.id}" data-index="${index}" data-type="exercise">
          <label><input type="checkbox" name="completed" ${entry?.completed ? 'checked' : ''}> Exercice réalisé</label>
          <label>Mon ressenti <textarea name="feedback" maxlength="2000">${esc(entry?.feedback || '')}</textarea></label>
          <button class="secondary">Enregistrer l’exercice</button>
        </form>
      </section>`;
    }).join('')}
    <form class="tracker-form" data-id="${a.id}" data-type="session">
      <h3>Feedback de la séance</h3>
      <label><input type="checkbox" name="completed" ${a.completedAt ? 'checked' : ''}> Séance terminée</label>
      <label>Mon ressenti <textarea name="feedback" maxlength="2000">${esc(a.feedback)}</textarea></label>
      <button class="primary">Enregistrer la séance</button>
    </form>
  </article>`).join('') : '<div class="empty">Votre professionnel ne vous a pas encore attribué de séance.</div>';
  for (const form of container.querySelectorAll('form')) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const data = new FormData(form);
      const body = {completed:data.has('completed'), feedback:data.get('feedback')};
      if (form.dataset.type === 'exercise') body.index = Number(form.dataset.index);
      try {
        await api(`/api/assignments/${form.dataset.id}/${form.dataset.type}`, body);
        message('Votre retour a été enregistré.');
      } catch (error) { message(error.message); }
    });
  }
  for (const button of container.querySelectorAll('[data-timer]')) {
    button.addEventListener('click', () => {
      clearInterval(timer);
      if (timerTarget) timerTarget.textContent = 'Chronomètre arrêté.';
      const a = assignments.find(item => item.id === Number(button.dataset.timer));
      const timeline = makeTimeline(a.items);
      const total = timeline.reduce((sum, p) => sum + p.duration, 0);
      const target = document.querySelector(`#timer-${a.id}`);
      timerTarget = target;
      target.innerHTML = '<p role="timer"></p><button class="secondary" type="button" data-pause>Pause</button> <button class="secondary" type="button" data-skip>Passer</button>';
      const display = target.querySelector('[role=timer]');
      const pause = target.querySelector('[data-pause]');
      const skip = target.querySelector('[data-skip]');
      let elapsed = 0, started = Date.now(), paused = false;
      const currentElapsed = () => elapsed + (paused ? 0 : (Date.now() - started) / 1000);
      function tick() {
        const currentTime = currentElapsed();
        const phase = locatePhase(timeline, currentTime);
        if (currentTime >= total) {
          display.textContent = 'Séance terminée. Pensez à enregistrer votre retour.';
          pause.disabled = true;
          skip.disabled = true;
          clearInterval(timer);
        } else {
          const current = timeline[phase.index];
          display.textContent = `${current.type === 'work' ? 'Effort' : 'Repos'} · ${a.items[current.itemIndex]?.exercise?.name || ''} · ${formatTime(phase.remaining)}${paused ? ' · En pause' : ''}`;
        }
      }
      pause.addEventListener('click', () => {
        if (!paused) elapsed = currentElapsed();
        else started = Date.now();
        paused = !paused;
        pause.textContent = paused ? 'Reprendre' : 'Pause';
        tick();
      });
      skip.addEventListener('click', () => {
        const phase = locatePhase(timeline, currentElapsed());
        elapsed = timeline.slice(0, phase.index + 1).reduce((sum, p) => sum + p.duration, 0);
        started = Date.now();
        tick();
      });
      tick();
      timer = setInterval(tick, 1000);
    });
  }
}
render().catch(error => message(error.message));
