# Elite Auto Deal — contrat d'API (backend Node/Express, même origine que le site)

Le serveur sert : `/` = site public (public/index.html), `/admin` = tableau de bord (public/admin.html), `/api/*` = API JSON, `/webhooks/freda` = webhooks Freda Pay Issuing.
Le front détecte le mode réel avec `fetch("/api/config")` : si la réponse est OK et JSON → mode réel ; sinon (aperçu artifact, fichier local) → mode démonstration actuel, inchangé.
Erreurs : statut HTTP 4xx/5xx + `{ "error": { "code": "...", "message": "texte en français pour l'utilisateur" } }`.
Montants : toujours calculés par le serveur. Le client n'envoie JAMAIS de montant.

## Public

GET /api/config → `{ "mode": "sandbox"|"live", "taux_htg": 132, "taux_date": "2026-11-12", "tarifs": { "consultation":50, "recherche":30, "service_recherche":150, "essai":30, "vendre":200, "financement":25 }, "whatsapp": "50942405729", "methodes": ["moncash","natcash","carte"] }`
`methodes` peut ne contenir que "moncash" et "natcash" si le paiement carte n'est pas activé.

GET /api/vehicules → tableau d'objets avec EXACTEMENT les mêmes clés que le tableau `V` du site (`id, marque, modele, annee, couleur, hex, km, prix, statut, type, forme, moteur, trans, traction, places, delai, note`) + `vedette: bool`. Statuts : disponible | transit | precommande | vendu | indisponible.

POST /api/dossiers — `multipart/form-data` :
- `service` : precommande | achat | consultation | recherche | essai | vendre | financement (obligatoire)
- `vehicule_id` : obligatoire pour precommande et achat, optionnel pour essai
- `methode` : `moncash` | `natcash` (payés en HTG au taux affiché, le moyen choisi est envoyé tel quel à Freda Pay Issuing) | `carte` (payé en USD). `mobile`/`all` ne sont plus acceptés
- `client_nom`, `client_tel` (obligatoires), `client_whatsapp`, `client_email` (obligatoire si methode=carte)
- `conditions_acceptees` : "1" (obligatoire)
- `donnees` : chaîne JSON `{ "lignes": [[libellé, valeur], ...], "champs": { nom_du_champ: valeur, ... } }` (le récapitulatif du formulaire)
- `fichiers` : 0..30 fichiers (photos, vidéos, PDF ; 60 Mo max chacun) — le nom de champ d'origine peut être passé dans `fichiers_champs` (JSON tableau de même longueur).
Réponse 201 : `{ "ref": "EAD-2026-48213", "montant_usd": 50, "montant": 6600, "devise": "HTG", "methode": "moncash", "checkout_url": "https://...", "paiement_id": "pay_..." }`
Le front enregistre `ref` dans localStorage (`ead-derniere-ref`) puis fait `location.href = checkout_url`.

GET /api/dossiers/:ref → vue publique (aucune donnée personnelle sauf prénom) :
`{ "ref", "service", "titre", "detail", "cree_le": ISO, "etape": 0..n, "statuts": [libellés], "paiement": { "statut": "pending"|"succeeded"|"failed", "montant", "devise", "methode", "confirme_le": ISO|null }, "solde_usd": number|null, "prenom": "..." }`
Si le paiement est `pending`, le serveur interroge Freda Pay (`GET /v1/payments/:id`, au plus une fois toutes les 4 s) avant de répondre.
Le front affiche une page `#retour` qui lit `ead-derniere-ref` et interroge cette route toutes les 4 s pendant 10 min max : pending → « Paiement en attente de confirmation… », succeeded → écran de confirmation (référence, reçu, prochaines étapes, WhatsApp), failed → message + bouton « Réessayer ».

POST /api/dossiers/:ref/relancer `{ "methode": "moncash"|"natcash"|"carte", "client_email"? }` → `{ "checkout_url" }` (nouveau paiement, seulement si le dernier a échoué ou est resté en attente plus de 10 min).

## Administrateur (en-tête `Authorization: Bearer <token>`)

POST /api/admin/login `{ "password" }` → `{ "token", "expire_le" }` (12 h). 401 sinon.
GET /api/admin/resume → `{ "paiements_jour_usd", "paiements_mois_usd", "dossiers_a_traiter", "validations_requises", "vehicules_stock", "vehicules_transit", "precommandes_en_cours", "soldes_a_percevoir_usd", "recettes_par_service": [{ "service", "total_usd" }], "alertes": [{ "type": "paiement_echoue"|"dossier_incomplet"|"solde_a_percevoir"|"retard", "ref", "texte" }], "activite": [{ "quand", "texte", "type" }] }`
GET /api/admin/dossiers?service=&etat= → `[{ "ref", "service", "titre", "client_nom", "client_tel", "client_whatsapp", "detail", "etape", "statuts", "etat": "paiement_en_attente"|"a_traiter"|"en_cours"|"validation_requise"|"cloture", "paiement_statut", "montant_usd", "cree_le" }]`
GET /api/admin/dossiers/:ref → idem + `client_email, donnees, fichiers: [{ "id", "nom", "type", "taille", "url" }], paiements: [...], journal: [{ "quand", "texte", "par" }], vehicule`
PATCH /api/admin/dossiers/:ref `{ "etape"?, "etat"?, "note"? }` → dossier mis à jour (journalisé). Refusé (409) si aucun paiement confirmé.
GET /api/admin/fichiers/:id → le fichier (redirection vers une URL signée ou flux direct).
GET /api/admin/paiements → `[{ "id", "ref", "service", "client_nom", "montant", "devise", "montant_usd", "methode", "prestataire": "Freda Pay Issuing", "statut", "freda_id", "cree_le", "confirme_le", "type": "initial"|"solde" }]`
GET /api/admin/vehicules ; POST /api/admin/vehicules (JSON, mêmes clés que /api/vehicules) ; PATCH /api/admin/vehicules/:id ; DELETE /api/admin/vehicules/:id
GET /api/admin/precommandes → `[{ "ref", "client_nom", "vehicule", "prix_usd", "paye_usd", "solde_usd", "statut_solde": "non_du"|"a_envoyer"|"envoye"|"paye", "arrive": bool, "delai", "checkout_url_solde" }]`
POST /api/admin/precommandes/:ref/arrivee → marque arrivé en Haïti.
POST /api/admin/precommandes/:ref/solde → crée le paiement du solde de 10 % → `{ "checkout_url", "message_whatsapp" }` (l'admin l'envoie lui-même).
GET /api/admin/parametres ; PUT /api/admin/parametres `{ "taux_htg", "taux_date", "tarifs": {...}, "messages": { "accueil", "confirmation", "solde", "rappel" } }`
GET /api/admin/rapports?annee=2026 → `{ "mois": [{ "mois": "2026-11", "recettes_usd", "ventes": n }], "par_service": [...] }`

## Photos des véhicules (ajout)
- `GET /api/vehicules` : chaque véhicule a en plus `photo` (URL de la photo principale ou null) et `photos` (tableau d'URL, la principale en premier).
- `GET /api/photos/:id` : image publique (cache 1 jour).
- Admin : `GET /api/admin/vehicules` ajoute `photos: [{ "id", "url" }]` (principale en premier).
- `POST /api/admin/vehicules/:id/photos` multipart, champ `photos` (1 à 12 images JPEG/PNG/WebP, 10 Mo max chacune) → véhicule complet (format admin).
- `DELETE /api/admin/vehicules/:id/photos/:photoId` → véhicule complet.
- `POST /api/admin/vehicules/:id/photos/:photoId/principale` → véhicule complet.
Sans photo, le site affiche un emplacement neutre (fond studio + symbole du logo + « Photo bientôt disponible »), plus aucun dessin de voiture.

## Espace client (ajout)
Session client : cookie httpOnly `ead_session` (SameSite=Lax, Secure en https, 30 jours), posé par le serveur. Le front n'a jamais le jeton ; il appelle les routes avec `credentials: "same-origin"` (par défaut pour fetch même origine).
Profil client : `{ "id", "nom", "tel", "whatsapp", "email", "cree_le" }`.

- POST /api/compte/inscription `{ nom, tel, whatsapp?, email?, mot_de_passe (8+ caractères) }` → 201 `{ client }` + cookie. 409 si téléphone ou email déjà utilisé. Les dossiers déjà créés avec ce même téléphone NE sont PAS rattachés automatiquement (sécurité) : utiliser « rattacher ».
- POST /api/compte/connexion `{ identifiant (téléphone ou email), mot_de_passe }` → `{ client }` + cookie. 401 « Identifiants incorrects. »
- POST /api/compte/deconnexion → `{ ok }`
- GET /api/compte → 200 `{ client, dossiers: [vue publique de dossier + "lignes" (récap du formulaire), "montant_usd", "service_titre"], stats: { en_cours, payes_usd, soldes_usd } }` ; 401 si pas de session (le front affiche alors connexion/inscription).
- PATCH /api/compte `{ nom?, tel?, whatsapp?, email? }` → `{ client }`
- POST /api/compte/mot-de-passe `{ actuel, nouveau }` → `{ ok }`
- POST /api/compte/oubli `{ identifiant }` → toujours `{ ok: true, message }` (une alerte arrive chez l'admin qui envoie un lien par WhatsApp).
- POST /api/compte/reinitialiser `{ jeton, mot_de_passe }` → `{ client }` + cookie. Le lien envoyé par l'admin est `/?reinit=<jeton>#compte`.
- POST /api/compte/rattacher `{ ref, tel }` → `{ dossier }` : rattache un dossier existant si le téléphone correspond à celui du dossier et qu'il n'appartient à aucun autre compte.
- GET /api/compte/dossiers/:ref → détail (seulement si le dossier appartient au client) : vue publique + `lignes`, `paiements: [{ id, type, montant, devise, methode, statut, cree_le, confirme_le }]`, `fichiers: [{ id, nom, type, taille, cree_le }]`, `historique: [{ quand, texte }]` (journal sans notes internes), `solde: { prix_usd, paye_usd, solde_usd, statut, arrive } | null`, `peut_payer_solde: bool` (vrai si arrivé en Haïti et solde non payé).
- GET /api/compte/fichiers/:id → le fichier (s'il appartient au client).
- POST /api/compte/dossiers/:ref/fichiers multipart `fichiers` (photos, vidéos, PDF, 60 Mo max, 10 par envoi) → détail mis à jour. Ajoute une alerte « Nouveaux documents » côté admin.
- POST /api/compte/dossiers/:ref/solde `{ methode: "moncash"|"natcash"|"carte" }` → `{ checkout_url }` (réutilise le lien de solde en attente s'il existe).
- GET /api/compte/paiements/:id/recu → `{ numero, date, client, ref, service, detail, montant, devise, montant_usd, methode, prestataire: "Freda Pay Issuing", freda_id, statut }` (paiements réussis uniquement).
- POST /api/dossiers (existant) : si la session client est valide, le dossier est rattaché au compte, et les champs client manquants sont complétés depuis le profil.

Admin :
- GET /api/admin/clients → `[{ id, nom, tel, whatsapp, email, cree_le, nb_dossiers, total_paye_usd, reinit_demandee: bool }]`
- POST /api/admin/clients/:id/reinitialisation → `{ lien, message_whatsapp, whatsapp }` (lien valable 24 h, usage unique).
- Le détail admin d'un dossier ajoute `client_compte: { id, nom } | null`.

## Devis (administrateur, en-tête `Authorization: Bearer <jeton admin>`)
- GET /api/admin/devis → liste (200 derniers). POST /api/admin/devis `{ client_nom, client_email?, client_tel?, lignes: [{ description, quantite, prix_unitaire }], frais_supplementaires?, expire_le? (AAAA-MM-JJ, 30 jours par défaut) }` → 201 devis `{ id, numero: "EAD-DEV-0001", jeton, total_usd, statut, expire_le, ... }`. Le total est toujours recalculé par le serveur.
- PATCH /api/admin/devis/:id (mêmes champs ; refusé si le devis est déjà payé) · DELETE /api/admin/devis/:id
- GET /api/admin/devis/:id/pdf → PDF (A4)
- POST /api/admin/devis/:id/email → envoie par Brevo un email avec le lien du devis (`client_email` requis) ; statut `envoye`
- POST /api/admin/devis/:id/whatsapp → `{ lien_whatsapp, lien_devis, lien_pdf, message }` ; statut `partage`

### Devis (client, sans compte)
- Page : `/devis/<jeton>` (jeton non devinable, un jeton = un seul devis, `noindex`). PDF : `/devis/<jeton>.pdf`.
- GET /api/devis/:jeton → `{ numero, client_nom, lignes, frais_supplementaires, total_usd, cree_le, expire_le, statut: "actif"|"paye"|"expire", ref, paiement, methodes, taux_htg, ... }` (sans email ni téléphone).
- POST /api/devis/:jeton/payer `{ methode: "moncash"|"natcash"|"carte", client_email? }` → `{ ref, checkout_url }`. Le montant est celui du devis ; réponses 409 (déjà payé) et 410 (expiré).
