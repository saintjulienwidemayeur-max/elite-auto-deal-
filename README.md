# Elite Auto Deal : site, administration et paiements Freda Pay Issuing

## Contenu du dossier
- `src/` serveur Node.js (API, paiements, webhooks, espace client, admin) ; `public/` site et tableau de bord prêts à servir
- `sources/` fichiers sources du site et de l'admin ; `python3 sources/build.py` reconstruit `public/`
- `test/` tests automatiques (`npm test`) et faux Freda Pay pour les essais locaux
- `API.md` contrat complet de l'API ; `render.yaml` déploiement Render ; `.env.example` variables à renseigner

Un seul service Node.js sert :
- `/` le site public, `/admin` le tableau de bord (mot de passe `ADMIN_PASSWORD`)
- `/api/*` l'API (contrat : API.md), `/webhooks/freda` les notifications Freda Pay Issuing

## Paiement
1. Le client remplit un formulaire. Le serveur calcule le montant (jamais le navigateur) et crée le dossier `EAD-AAAA-NNNNN`.
2. `POST /v1/payments` chez Freda Pay Issuing :
   MonCash ou Natcash en HTG (`method: moncash` ou `method: natcash`, au choix du client ; montant = USD × taux affiché) ou carte en USD (`method: carte`, `return_url`).
   La référence envoyée (`EAD-…-P1`, `-P2` pour une relance, `-S1` pour le solde) rend l'opération idempotente.
3. Le client est redirigé vers `checkout_url`, puis revient sur `/retour-paiement`.
4. Le dossier n'est marqué payé que si Freda Pay Issuing le confirme :
   webhook `payment.succeeded` signé (HMAC-SHA256, en-tête `X-Freda-Signature`, doublons ignorés) ou `GET /v1/payments/:id`.
5. Précommande : 90 % au départ. Le véhicule passe « vendu ». À l'arrivée, l'admin clique « Envoyer le lien de solde » (10 %).

## Espace client
- Inscription par téléphone (et email facultatif) + mot de passe (scrypt). Session : cookie httpOnly signé, 30 jours.
- Le client voit ses dossiers, l'avancement, ses paiements et reçus, envoie des documents, paie le solde d'une précommande à l'arrivée du véhicule.
- Dossier créé avant l'inscription : « Ajouter un dossier existant » avec la référence et le même téléphone.
- Mot de passe oublié : un code à 6 chiffres est envoyé par email (voir « Emails (Brevo) ») ; sans email enregistré, l'admin reçoit une alerte et envoie un lien de 24 h sur WhatsApp depuis la page Clients.

## Mise en ligne (Render)
1. Pousser ce dossier sur GitHub, puis créer le Blueprint depuis `render.yaml` (service web ; la base de données est sur Supabase, renseigner `DATABASE_URL`).
2. Renseigner `FREDA_SECRET_KEY` (sk_test_ d'abord), `ADMIN_PASSWORD`, `PUBLIC_URL`.
3. Dans le tableau de bord Freda Pay Issuing, enregistrer le webhook `https://VOTRE-DOMAINE/webhooks/freda`, copier le `whsec_…` dans `FREDA_WEBHOOK_SECRET`.
4. Tester avec « Tester ma clé API » (événement `webhook.test`), faire un paiement Sandbox, puis passer en `sk_live_`.
5. Fichiers clients : créer un bucket privé `dossiers` dans Supabase Storage et renseigner `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (le disque Render est effacé à chaque déploiement).

## Tests locaux
`node test/mock-freda.js` (faux Freda sur :4555), puis `node --env-file=.env.test src/index.js`, puis `npm test` (paiement, espace client et emails/OTP ; lancer aussi `node test/mock-brevo.js`, avec `BREVO_API_KEY=xkeysib-test`, `BREVO_API_URL=http://localhost:4556/v3/smtp/email` et `EMAIL_EXPEDITEUR=test@ex.ht` dans `.env.test`).

## Emails (Brevo)
À l'inscription avec un email, le client reçoit un email de bienvenue contenant un code à 6 chiffres pour confirmer son adresse. « Mot de passe oublié » envoie aussi un code par email (10 min, 5 essais, 1 envoi/minute) ; sans email enregistré ou sans Brevo, le lien WhatsApp géré par l'admin reste utilisé.
Renseigner `BREVO_API_KEY` et `EMAIL_EXPEDITEUR` (adresse validée dans Brevo → Senders).

## SEO, GEO et identité
- `public/` contient le logo (`logo.svg`, `logo-blanc.svg`), les icônes (`favicon.ico/svg`, `icon-192/512`, `icon-maskable-512`, `apple-touch-icon`), l'image de partage `og-image.png` (1200x630) et `logo-email.png` (utilisé dans les emails).
- Régénérer ces fichiers : `node sources/assets/generate.cjs` (Playwright requis) ; reconstruire les pages : `python3 sources/build.py`.
- `index.html` : balises SEO/Open Graph/Twitter, données structurées JSON-LD (Organization, AutoDealer avec tarifs, WebSite, WebPage, FAQPage) et section FAQ visible.
- `robots.txt` (admin, API et webhooks exclus ; Google, Bing et assistants IA autorisés), `sitemap.xml`, `llms.txt` (résumé pour les assistants IA), `manifest.webmanifest` (installation sur mobile).
- `/admin`, `/api`, `/webhooks` et `/sante` envoient `X-Robots-Tag: noindex`.
- Les adresses du site sont en dur sur `https://eliteautodeal.com` : à modifier dans `sources/site.src.html`, `public/robots.txt`, `sitemap.xml` et `llms.txt` si le domaine change.

## Gestion des devis
Dans l'administration, « Gestion des devis » permet de créer un devis (client, lignes, frais supplémentaires, total automatique), de le générer en PDF, de l'envoyer par email (via Brevo) ou de le partager sur WhatsApp, avec un lien sécurisé non devinable vers la page du devis (voir « Devis par lien sécurisé »). Optionnel : `DEVIS_VALIDITE_JOURS` (30 par défaut) fixe la validité d'un devis ; elle est modifiable devis par devis (date « Valable jusqu'au »).

## Tarifs
Consultation et recherche/achat accompagné : 50 $ (accompagnement, analyse, préparation des documents, démarches administratives et suivi du client). Visite ou essai : 30 $. Vente d'un véhicule confié : 200 $. Dossier de financement : 25 $. Les bases existantes qui avaient encore 150 $ passent automatiquement à 50 $ au premier démarrage (une seule fois ; l'administrateur peut ensuite modifier les tarifs). La visite ou l'essai passe de 50 $ à 30 $ de la même façon.

## Code d'accès administrateur
Au départ, le code d'accès est la variable `ADMIN_PASSWORD`. Depuis l'administration (Paramètres du site → Code d'accès administrateur), il peut être modifié : le nouveau code est stocké haché en base (table `parametres`, clé `admin_acces`) et remplace `ADMIN_PASSWORD`. Changer le code déconnecte les autres appareils.
Code oublié : supprimer la ligne `admin_acces` de la table `parametres` (Supabase → Table Editor) : `ADMIN_PASSWORD` redevient le code valable.

## URL par page (SEO)
Chaque page a sa vraie adresse : `/`, `/vehicules`, `/vehicules/<id>`, `/precommande`, `/acheter`, `/consultation`, `/recherche-vehicule`, `/essai-visite`, `/vendre-mon-vehicule`, `/financement`, `/suivi-dossier`, `/conditions` (pages privées non indexées : `/mon-espace`, `/mon-espace/dossier`, `/retour-paiement`). Le serveur (`src/seo.js`) envoie pour chaque URL son titre, sa description, son canonical, ses balises Open Graph, son JSON-LD (fil d'Ariane, Service avec tarif de la base, Car + Offer pour une fiche véhicule) et sa vue initiale. `/sitemap.xml` est généré à partir des véhicules publiés. Une adresse inconnue renvoie un 404 non indexé. Les anciens liens `/#consultation` et `/?ref=…` sont convertis automatiquement côté navigateur.


## Anti-veille (Render gratuit)
Le serveur appelle sa propre adresse publique (`/sante`) toutes les 5 minutes, et fait un `select 1` sur la base, pour éviter la mise en veille (arrêt après 15 min sans visite). Actif seulement si `PUBLIC_URL` (ou `RENDER_EXTERNAL_URL`) est en `https`. Variables : `KEEP_ALIVE=false` pour désactiver, `KEEP_ALIVE_URL`, `KEEP_ALIVE_MINUTES`. Limite : si le service est déjà endormi, il ne peut pas se réveiller seul : pour une garantie, utiliser un moniteur externe (UptimeRobot, cron-job.org) sur `/sante`, ou le plan Starter.

## Devis par lien sécurisé (paiement en ligne)
Un devis est une page du site : `/devis/<jeton>` (jeton aléatoire non devinable, un jeton = un seul devis, jamais indexée). Le client y voit le devis (référence `EAD-DEV-xxxx`, ses informations, les lignes, les frais supplémentaires, la date d'expiration et le total), puis, juste en dessous, peut le payer (MonCash, Natcash ou carte, `Payer maintenant`), télécharger le PDF ou l'imprimer. Le montant est celui enregistré sur le serveur et ne peut pas être changé par le client ; un devis expiré ou déjà payé ne peut plus être payé. Au premier paiement, un dossier « devis » est créé (suivi, reçu) et le devis passe à « Payé » quand Freda Pay Issuing confirme. L'envoi par email et par WhatsApp contient le lien de la page.
Frais de recherche : 30 $ de frais de dossier à l'ouverture ; les 150 $ de frais de service (tarif `service_recherche`) sont ajoutés au devis quand le véhicule est trouvé (bouton « Ajouter les frais de service de recherche » dans Gestion des devis).

## Vitrine du site et promos
Admin → **Vitrine du site** : ajouter, modifier, réordonner (↑ ↓), masquer ou supprimer les diapositives de la première page (image PNG/WebP détourée, marque, modèle, filigrane, accroche, véhicule lié, badge Promo + texte). Elles sont stockées en base (table `vitrine`, images incluses) et chargées une seule fois depuis `sources/photos/vitrine.json` à la première installation. Admin → **Véhicules** : colonne **Prix promo** (vide = pas de promo) : le site affiche le prix barré et le client paie le prix promo. Une diapositive liée à un véhicule en promo affiche le badge « Promo » automatiquement ; elle est masquée si le véhicule est vendu.

## Adresse publique (liens envoyés aux clients)
`PUBLIC_URL` (ex. `https://eliteautodeal.com`) sert à fabriquer les liens des devis, des emails, du retour de paiement et de la réinitialisation du mot de passe. **À renseigner sur Render.** Sans elle, le serveur utilise `RENDER_EXTERNAL_URL` (adresse `onrender.com`, fournie par Render) et affiche un avertissement au démarrage ; `localhost` n'est utilisé qu'en développement. Un lien déjà envoyé avec une mauvaise adresse doit être renvoyé : le jeton du devis, lui, ne change pas (`/devis/<jeton>`).


## Tarifs affichés sur le site
Tous les prix affichés (pages, menu, FAQ, conditions, JSON-LD, `llms.txt`, scripts) viennent des tarifs de l'administration (Paramètres du site → Tarifs des services). Les sources contiennent des repères `{{T:cle}}` (« 50 $ ») et `{{N:cle}}` (« 50 ») que le serveur remplace à chaque page (`src/seo.js`, `remplacerTarifs`) ; `public/index.html` n'est donc jamais servi tel quel. Pour ajouter un tarif affiché, utiliser un repère plutôt qu'un montant écrit en dur.

## Photos et vidéos des véhicules
- **Photos : 4:5 portrait, 1080 × 1350 px** (idéal Instagram et Facebook). Toute photo envoyée depuis l'administration (Véhicules → « Photos et vidéos ») est ramenée à ce format et enregistrée en WebP (`sharp`, `src/medias.js`) : une photo déjà en 4:5 est simplement redimensionnée ; une autre est posée entière au centre sur un fond flou de la même photo (ni déformée, ni coupée). Les cartes et la fiche du véhicule s'affichent en 4:5.
- **Vidéos : format libre** (verticale, horizontale, carrée), MP4, WebM ou MOV, 50 Mo maximum. Elles apparaissent dans la galerie de la fiche avec les photos et s'adaptent à leur espace (`object-fit: contain`) sans déformation ni coupe. La lecture par morceaux (requêtes `Range`) est gérée, y compris sur iPhone. Table `videos_vehicules`.
- La mention « Financement disponible » reste affichée sur les véhicules disponibles (champ « Conditions affichées », rempli d'office pour un nouveau véhicule).

## Mises à jour immédiates
Rien de ce qui vient de l'administration n'est gardé en cache : pages HTML (`max-age=0, must-revalidate`), `/api/*` (`no-cache`), `llms.txt`. Le site ouvert se rafraîchit seul toutes les 30 secondes, au retour sur l'onglet et au focus (véhicules, prix promo, photos, vidéos, vitrine), sans recharger la page. Les tarifs sont servis dans le HTML à chaque chargement.

## Palette de couleurs
Rouge principal `#C8102E` (boutons, liens, actions), rouge foncé `#9E0B22` (survol), blanc `#FFFFFF`, blanc cassé `#F7F7F8` (sections alternées), noir `#0B0B0C` (titres, en-tête, pied de page), gris texte `#5B5F66` (paragraphes), gris bordure `#E5E7EB`. Proportions visées : ~80 % blanc, ~15 % rouge, ~5 % noir. Variables CSS dans `sources/site.src.html` et `sources/admin.src.html` ; mêmes couleurs dans les emails (`src/email.js`), le PDF des devis (`src/devis.js`) et les icônes (`sources/assets/generate.cjs`, `node sources/assets/generate.cjs`). Règle : pas de texte rouge sur fond noir pour un long paragraphe.

## Compte bancaire (virement ou dépôt)
Les coordonnées (banque, titulaire, numéro de compte, succursale, devise) sont modifiables dans l'administration (Paramètres du site → Compte bancaire) et stockées dans `parametres` (clé `banque`). Elles s'affichent au paiement d'un véhicule (achat comptant ou précommande) et sur la page d'un devis (`/api/config` et `/api/devis/:jeton` les renvoient). Ce paiement n'est pas confirmé automatiquement : le client envoie la preuve sur WhatsApp et l'équipe vérifie avec la banque.

## Virement bancaire (preuve de paiement)

Pour un achat, une précommande ou un devis, le client peut choisir « Virement bancaire » (disponible dès que le compte bancaire est renseigné dans Paramètres du site). Aucun appel à Freda : un paiement `virement` en gourdes reste `pending`.

1. Le client reçoit les coordonnées bancaires et un écran pour déposer sa preuve (photo ou PDF, 10 Mo max, 6 fichiers max). L'accès au dépôt est protégé par un jeton propre au dossier (mémorisé dans le navigateur du client).
2. Admin → **Virements** : preuves consultables, boutons « Confirmer la réception » ou « Refuser » (avec motif).
3. À la confirmation, le dossier passe en « payé » (véhicule vendu, devis payé) et le client reçoit l'email « Paiement confirmé ». Au refus, il reçoit un email avec le motif et peut déposer une nouvelle preuve.

API : `POST /api/dossiers/:ref/preuve` (jeton), `GET /api/dossiers/:ref/virement?jeton=`, `GET /api/admin/virements`, `POST /api/admin/virements/:id/confirmer|refuser`. Test : `node test/virement.js`.
