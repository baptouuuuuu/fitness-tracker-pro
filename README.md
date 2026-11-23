# Fitness Tracker Pro

Application dérivée de Fitness Maker pour créer des séances et suivre leur réalisation par des clients. Le dépôt a été initialisé avec l'historique de Fitness Maker ; ce n'est pas un fork GitHub officiel.

## Utilisation

1. Créez un compte professionnel, puis ouvrez le créateur pour composer et enregistrer une séance. La bibliothèque, les filtres, le générateur et les exports JSON de Fitness Maker sont conservés.
2. Dans l'espace professionnel, créez un lien d'invitation et transmettez-le au client par un canal privé. Il est valable sept jours et ne peut être utilisé qu'une fois. Le client crée son compte depuis ce lien.
3. Sélectionnez le client et une séance enregistrée dans ce navigateur pour l'attribuer. Les séances attribuées sont des copies : modifier la séance locale ne modifie pas une séance déjà envoyée.
4. Le client voit ses seules séances attribuées, peut utiliser le chronomètre et enregistrer un feedback ainsi qu'un état réalisé pour chaque exercice et pour la séance. Le professionnel retrouve ces informations dans son tableau de suivi.

L'offre gratuite permet **un client et trois attributions au total**. L'abonnement actif lève ces limites. Après résiliation ou défaut de paiement, les données restent consultables ; les limites gratuites s'appliquent aux nouvelles attributions et invitations. Une invitation en attente est également soumise à la limite au moment de son utilisation.

Les brouillons et séances créées dans le créateur restent dans le stockage local du navigateur du professionnel, séparés par compte ; ils ne sont ni synchronisés ni sauvegardés par le serveur. N'y inscrivez pas de données identifiantes de patients. Les attributions et feedbacks sont stockés sur le serveur. Le client ne télécharge pas le catalogue complet et ne voit que ses exercices attribués. Ses images ne sont pas chargées depuis le serveur tiers afin d'éviter de divulguer ses consultations à ce tiers.

Le contenu des exercices est informatif et ne remplace pas un avis médical. Adaptez les séances et arrêtez en cas de douleur.

## Démarrage local

Node.js 22.13 ou supérieur avec `node:sqlite` est requis. Aucune dépendance npm n'est nécessaire.

```sh
npm start
```

Ouvrir http://localhost:3000. La base SQLite `tracker.sqlite` est créée localement. Pour les tests : `npm test`.

Variables disponibles :

| Variable | Rôle |
| --- | --- |
| `APP_URL` | Origine publique exacte, HTTPS obligatoire hors localhost ; défaut `http://localhost:3000` |
| `HOST`, `PORT` | Adresse et port d'écoute ; défaut `127.0.0.1:3000` |
| `DATABASE_PATH` | Chemin du fichier SQLite ; défaut `tracker.sqlite` |
| `STRIPE_SECRET_KEY` | Clé secrète Stripe, jamais exposée au navigateur |
| `STRIPE_PRICE_ID` | Identifiant du tarif Stripe récurrent |
| `STRIPE_WEBHOOK_SECRET` | Secret de signature du webhook Stripe |

## Paiement

Créez un produit et un tarif récurrent dans Stripe, configurez les trois variables `STRIPE_*`, puis configurez le portail client Stripe. Enregistrez l'URL `APP_URL/api/stripe/webhook` pour les événements `checkout.session.completed` et `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Les signatures sont vérifiées et l'état courant de l'abonnement est relu auprès de Stripe avant d'accorder ou retirer les droits. Sans configuration, les boutons de paiement renvoient une erreur explicite et aucun compte n'est marqué payant. Commencez avec les clés et moyens de paiement de test Stripe.

## Limites avant utilisation réelle

Ce projet est un prototype fonctionnel, **pas une plateforme validée pour des données de santé réelles**. Avant toute mise en service, il faut notamment un hébergement et des sauvegardes adaptés et chiffrés, une analyse de sécurité indépendante, une gestion de la récupération et suppression des comptes, et une analyse RGPD/HDS applicable au contexte. SQLite n'est pas chiffré par l'application ; la sauvegarde, le contrôle d'accès au fichier et la gestion du cycle de vie des données relèvent de l'hébergement. Le prototype doit être exécuté en un seul processus : la limitation des tentatives de connexion est en mémoire et par adresse de connexion, sans prise en charge des adresses transmises par un proxy. Les séances locales sont accessibles aux personnes ayant accès au profil du navigateur.

Le site ne peut plus être publié comme site statique GitHub Pages : les comptes, autorisations, feedbacks et webhooks nécessitent le serveur Node et une base persistante. L'ancien workflow de publication Pages a été supprimé.

## Données et images

Exercise data by [RepDB (repdb.co)](https://repdb.co). Le catalogue et les images fixes proviennent de [RepDB/exercise-dataset](https://github.com/RepDB/exercise-dataset), révision `f12da458a90f353a86c953f204304d5a8bd98275`, sous la [licence gratuite RepDB](https://github.com/RepDB/exercise-dataset/blob/f12da458a90f353a86c953f204304d5a8bd98275/LICENSE-DATA.md). Elle autorise l'utilisation dans une application avec attribution, mais interdit notamment la redistribution sous forme de jeu de données. Le créateur professionnel charge les illustrations depuis GitHub et nécessite une connexion Internet ; ce tiers reçoit donc les requêtes d'images et l'adresse IP du navigateur.

Pour actualiser le catalogue, télécharger `exercises.json` de la révision choisie, exécuter `node generate-data.mjs chemin/vers/exercises.json` et actualiser la révision des images dans `exercises.js`.

Les anciennes séances conservent leurs données issues de [hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset) sous licence MIT ; voir [LICENSE-DATA](LICENSE-DATA). Les animations premium de RepDB ne sont pas incluses dans la licence gratuite.
