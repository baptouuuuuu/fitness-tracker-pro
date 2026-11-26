#!/usr/bin/env bash
set -euo pipefail

release="${1:-}"
if [[ ! "$release" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]]; then
  echo "Identifiant de version invalide." >&2
  exit 1
fi

root="$HOME/fitness-tracker"
next="$root/releases/$release"
current="$root/current"
if [[ ! -f "$next/server.js" || ! -f "$HOME/.config/fitness-tracker.env" ]]; then
  echo "Version ou configuration serveur manquante." >&2
  exit 1
fi

previous=""
if [[ -L "$current" ]]; then
  previous="$(readlink "$current")"
elif [[ -e "$current" ]]; then
  echo "Le chemin current existe et n'est pas un lien symbolique." >&2
  exit 1
fi

switch_to() {
  local target="$1"
  local temporary="$root/.current-$release"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$current"
}

healthy() {
  systemctl --user is-active --quiet fitness-tracker.service &&
    curl --fail --silent --show-error --max-time 2 http://127.0.0.1:3000/account.html > /dev/null
}

wait_healthy() {
  for _ in {1..15}; do
    if healthy; then return 0; fi
    sleep 1
  done
  return 1
}

switch_to "$next"
if systemctl --user restart fitness-tracker.service && wait_healthy; then
  echo "Version $release activée."
  exit 0
fi

echo "Échec de démarrage : restauration de la version précédente." >&2
if [[ -n "$previous" ]]; then
  switch_to "$previous"
  if ! systemctl --user restart fitness-tracker.service || ! wait_healthy; then
    echo "La restauration du service a échoué ; intervention manuelle nécessaire." >&2
  fi
else
  rm -f "$current"
  if ! systemctl --user stop fitness-tracker.service; then
    echo "L'arrêt du service a échoué ; intervention manuelle nécessaire." >&2
  fi
fi
exit 1
