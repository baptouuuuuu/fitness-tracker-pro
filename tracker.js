export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Erreur de communication.');
  return result;
}

export function message(text) {
  document.querySelector('#message').textContent = text;
}

export async function logout() {
  await api('/api/logout', {});
  location.assign('/account.html');
}

export function time(value) {
  return new Date(value * 1000).toLocaleDateString('fr-FR');
}
