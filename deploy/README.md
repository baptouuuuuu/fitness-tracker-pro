# Déploiement de test : Oracle Cloud Always Free

Une VM [Oracle Cloud Always Free](https://www.oracle.com/cloud/free/) peut héberger le serveur Node et la base SQLite sur son disque de démarrage, conservé entre redémarrages et déploiements. Oracle propose notamment des instances A1 Flex dans sa [configuration officielle Always Free](https://github.com/oracle/terraform-provider-oci/tree/master/examples/always_free). Les quotas, disponibilités et conditions peuvent évoluer : sélectionnez uniquement des ressources signalées **Always Free**, vérifiez les limites et coûts dans la console, et évitez les ressources payantes. L'inscription peut nécessiter une carte bancaire et certaines régions peuvent manquer de capacité. Une instance inactive peut être récupérée par le fournisseur.

Cette procédure est destinée aux **données fictives uniquement**. Elle ne constitue pas un hébergement HDS ni une validation RGPD. Les sauvegardes ne sont pas incluses ; la perte de la VM ou du volume peut entraîner la perte de la base. Les minutes GitHub Actions d'un dépôt privé sont soumises aux quotas de votre offre GitHub.

## 1. Créer la VM

Créez un compte Oracle Cloud, puis une VM Ubuntu avec adresse IPv4 publique et disque de démarrage dans les limites Always Free. Configurez une clé SSH d'administration distincte. Dans les règles réseau Oracle **et** le pare-feu de l'OS, autorisez TCP 80 et 443 ; autorisez TCP 22 pour l'administration et les runners GitHub Actions. Ne publiez pas le port 3000. Un domaine public pointant vers l'IP de la VM est nécessaire pour HTTPS ; un sous-domaine gratuit est possible auprès d'un fournisseur DNS.

Installez sur la VM `rsync`, `curl`, `systemd`, [Node.js](https://nodejs.org/en/download) **22.13 ou plus récent**, et [Caddy](https://caddyserver.com/docs/install). Vérifiez `PATH=/usr/local/bin:/usr/bin:/bin node --version` ; le service utilise ce même chemin. La disponibilité de ces ressources et logiciels n'est pas vérifiée par ce dépôt.

## 2. Vérifier l'identité SSH de la VM

Récupérez la clé d'hôte et **vérifiez son empreinte par un canal de confiance**, par exemple la console Oracle :

```sh
# Sur la console de la VM :
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
# Sur votre ordinateur : comparer l'empreinte avant de faire confiance au résultat.
ssh-keyscan -t ed25519 IP_VM > known_hosts_fitness_tracker
ssh-keygen -lf known_hosts_fitness_tracker
```

Ne faites pas confiance à une clé obtenue par `ssh-keyscan` sans comparaison indépendante. Utilisez ensuite `-o UserKnownHostsFile=known_hosts_fitness_tracker -o StrictHostKeyChecking=yes` pour les connexions SSH et SCP depuis le répertoire contenant ce fichier. Les exemples ci-dessous supposent ce fichier ajouté à votre configuration SSH ou à `~/.ssh/known_hosts` après vérification.

## 3. Créer un utilisateur de déploiement

Sur votre ordinateur, depuis une copie du dépôt contenant cette PR :

```sh
ssh-keygen -t ed25519 -f ~/.ssh/fitness-tracker-deploy -C github-actions-fitness-tracker
scp -i CHEMIN_CLE_ADMIN ~/.ssh/fitness-tracker-deploy.pub ubuntu@IP_VM:/tmp/fitness-tracker-deploy.pub
```

La clé de déploiement doit être dédiée à cette VM et sans phrase de passe pour Actions. Conservez la clé privée hors du dépôt. Remplacez `ubuntu`, `IP_VM` et le chemin de clé par les valeurs de votre VM. Connectez-vous avec votre clé d'administration, puis exécutez :

```sh
sudo useradd -m -s /bin/bash tracker
sudo install -d -m 700 -o tracker -g tracker /home/tracker/.ssh
sudo install -m 600 -o tracker -g tracker /tmp/fitness-tracker-deploy.pub /home/tracker/.ssh/authorized_keys
sudo loginctl enable-linger tracker
```

L'utilisateur `tracker` ne doit pas avoir de droits sudo. Testez sa connexion SSH depuis votre ordinateur avec la clé dédiée.

## 4. Préparer l'application

Depuis votre ordinateur :

```sh
ssh -i ~/.ssh/fitness-tracker-deploy tracker@IP_VM 'mkdir -p ~/.config/systemd/user ~/fitness-tracker/releases ~/fitness-tracker/data'
scp -i ~/.ssh/fitness-tracker-deploy deploy/fitness-tracker.service tracker@IP_VM:.config/systemd/user/fitness-tracker.service
```

Connectez-vous comme `tracker` et créez `~/.config/fitness-tracker.env` avec ces valeurs, en remplaçant le domaine :

```ini
APP_URL=https://fitness.example.com
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=/home/tracker/fitness-tracker/data/tracker.sqlite
TRUST_CADDY=1
```

Si vous configurez Stripe, ajoutez aussi `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` et `STRIPE_WEBHOOK_SECRET` à ce fichier. Ne copiez aucune clé dans le dépôt. Puis :

```sh
chmod 600 ~/.config/fitness-tracker.env
chmod 700 ~/fitness-tracker/data
systemctl --user daemon-reload
systemctl --user enable fitness-tracker.service
```

Le service démarrera lors du premier déploiement. Le processus reste lié à `127.0.0.1` ; ne changez pas cette adresse tant que `TRUST_CADDY=1`. Le fichier SQLite reste dans `data/`, en dehors des versions déployées.

## 5. Activer HTTPS

En tant qu'administrateur, configurez le domaine réel dans `/etc/caddy/Caddyfile` :

```caddyfile
fitness.example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Tracker-Client-IP {remote_host}
    }
}
```

Validez la configuration puis rechargez Caddy :

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtient et renouvelle le certificat HTTPS si le DNS et les ports 80/443 sont correctement configurés. L'en-tête ci-dessus **remplace** toute valeur fournie par le client et permet la limitation des tentatives par adresse. N'activez pas `TRUST_CADDY` avec un autre proxy ou une configuration qui ne remplace pas cet en-tête ; n'exposez jamais directement le port Node.

## 6. Configurer GitHub Actions

Dans **Settings → Secrets and variables → Actions** du dépôt, ajoutez :

| Type | Nom | Valeur |
| --- | --- | --- |
| Variable | `DEPLOY_HOST` | IP publique ou nom d'hôte de la VM |
| Variable | `DEPLOY_USER` | `tracker` |
| Secret | `DEPLOY_SSH_KEY` | Contenu complet de la clé privée `~/.ssh/fitness-tracker-deploy` |
| Secret | `DEPLOY_KNOWN_HOSTS` | Contenu de `known_hosts_fitness_tracker` après vérification de l'empreinte |

Après fusion sur `main`, chaque push sur `main` exécute les tests puis déploie **le commit testé** si les tests réussissent. Dans **Actions → Tests → Run workflow**, choisissez `main` pour lancer le premier déploiement ou le relancer. Les PR et les autres branches ne sont jamais déployées.

Le workflow copie chaque version dans `~/fitness-tracker/releases/`, bascule le lien `current`, redémarre le service et vérifie `/account.html` en local. Si le démarrage échoue, il réactive la version précédente et signale l'échec. Le retour arrière ne restaure pas la base : prévoyez des sauvegardes cohérentes et un plan de migration avant toute évolution de son schéma. Les anciennes versions ne sont pas supprimées automatiquement ; surveillez l'espace disque.

Vérifiez ensuite `https://fitness.example.com/account.html`, puis testez avec des comptes fictifs. Pour diagnostiquer : `systemctl --user status fitness-tracker.service` et `journalctl --user -u fitness-tracker.service`. Si les secrets, la VM, le domaine ou Stripe ne sont pas configurés, aucun déploiement ou paiement fonctionnel ne peut être garanti.
