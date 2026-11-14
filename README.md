# Elite Auto Deal : site, administration et paiements Freda Pay Issuing

## Contenu du dossier
- `src/` serveur Node.js (API, paiements, webhooks, espace client, admin) ; `public/` site et tableau de bord prêts à servir
- `sources/` fichiers sources du site et de l'admin ; `python3 sources/build.py` reconstruit `public/`
- `identite/` logos SVG, couleurs et typographies (`tokens.json`), charte graphique, photos de la vitrine sans fond
- `captures/` captures d'écran mobile et PC
- `test/` tests automatiques (`npm test`) et faux Freda Pay pour les essais locaux
- `API.md` contrat complet de l'API ; `render.yaml` déploiement Render ; `.env.example` variables à renseigner

Un seul service Node.js sert :
- `/` le site public, `/admin` le tableau de bord (mot de passe `ADMIN_PASSWORD`)
- `/api/*` l'API (contrat : API.md), `/webhooks/freda` les notifications Freda Pay Issuing

## Paiement
1. Le client remplit un formulaire. Le serveur calcule le montant (jamais le navigateur) et crée le dossier `EAD-AAAA-NNNNN`.
2. `POST /v1/payments` chez Freda Pay Issuing :
   MonCash/Natcash en HTG (`method: all`, montant = USD × taux affiché) ou carte en USD (`method: carte`, `return_url`).
   La référence envoyée (`EAD-…-P1`, `-P2` pour une relance, `-S1` pour le solde) rend l'opération idempotente.
3. Le client est redirigé vers `checkout_url`, puis revient sur `/#retour`.
4. Le dossier n'est marqué payé que si Freda Pay Issuing le confirme :
   webhook `payment.succeeded` signé (HMAC-SHA256, en-tête `X-Freda-Signature`, doublons ignorés) ou `GET /v1/payments/:id`.
5. Précommande : 90 % au départ. Le véhicule passe « vendu ». À l'arrivée, l'admin clique « Envoyer le lien de solde » (10 %).

## Espace client
- Inscription par téléphone (et email facultatif) + mot de passe (scrypt). Session : cookie httpOnly signé, 30 jours.
- Le client voit ses dossiers, l'avancement, ses paiements et reçus, envoie des documents, paie le solde d'une précommande à l'arrivée du véhicule.
- Dossier créé avant l'inscription : « Ajouter un dossier existant » avec la référence et le même téléphone.
- Mot de passe oublié : l'admin reçoit une alerte et envoie un lien de 24 h sur WhatsApp depuis la page Clients (pas besoin de service d'email).

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
Dans l'administration, « Gestion des devis » permet de créer un devis (client, lignes, frais supplémentaires, total automatique), de le générer en PDF, de l'envoyer par email (PDF en pièce jointe, via Brevo) ou de le partager sur WhatsApp (lien PDF public non devinable). Optionnel : `DEVIS_VALIDITE_JOURS` ajoute une mention de validité dans le PDF.

## Tarifs
Consultation, recherche/achat accompagné et visite/essai : 50 $ (accompagnement, analyse, préparation des documents, démarches administratives et suivi du client). Vente d'un véhicule confié : 200 $. Dossier de financement : 25 $. Les bases existantes qui avaient encore 150 $ passent automatiquement à 50 $ au premier démarrage (une seule fois ; l'admin peut ensuite modifier les tarifs).

