import express from "express";
import helmet from "helmet";
import compression from "compression";
import multer from "multer";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { q, un, tous, migrer, parametres, journaliser, transaction } from "./db.js";
import { SERVICES, COLS_VEHICULE } from "./catalogue.js";
import { creerPaiement, lirePaiement, signatureValide, modeFreda, fredaConfiguree, ErreurFreda } from "./freda.js";
import { enregistrer, servir, servirPublic, servirPublicRange, supprimer } from "./stockage.js";
import { photo45 } from "./medias.js";
import { envoyerEmail, emailConfigure, emailBienvenue, emailCode, emailDevis, emailPaiementConfirme, emailVirementRefuse } from "./email.js";
import { validerDevis, genererPdf, montant as montantDevis } from "./devis.js";
import { pageHtml, sitemapXml, CHEMINS, remplacerTarifs } from "./seo.js";

const PORT = process.env.PORT || 3000;
// Adresse publique utilisée dans les liens envoyés aux clients (devis, retour de paiement, emails, réinitialisation).
// Ordre : PUBLIC_URL (à renseigner : https://eliteautodeal.com) > RENDER_EXTERNAL_URL (fournie par Render) > localhost (développement seulement).
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
if (process.env.RENDER && !process.env.PUBLIC_URL) console.warn(`[config] PUBLIC_URL n'est pas renseignée : les liens utilisent ${PUBLIC_URL}. Définissez PUBLIC_URL=https://eliteautodeal.com sur Render.`);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const CARTE_ACTIVE = process.env.CARTE_ACTIVE !== "false";
const DOSSIER_PUBLIC = path.resolve(process.env.PUBLIC_DIR || new URL("../public", import.meta.url).pathname);

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

/* ---------- Utilitaires ---------- */
class ErreurApi extends Error { constructor(statut, code, message) { super(message); this.statut = statut; this.code = code; } }
const err = (s, c, m) => new ErreurApi(s, c, m);
const enveloppe = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const arrondi2 = n => Math.round(n * 100) / 100;
const prenomDe = nom => String(nom || "").trim().split(/\s+/)[0] || "";
const MAX_ETAPE = s => SERVICES[s].statuts.length;

async function nouvelleRef() {
  const an = new Date().getFullYear();
  for (let i = 0; i < 20; i++) {
    const ref = `EAD-${an}-${crypto.randomInt(10000, 100000)}`;
    if (!(await un("select 1 from dossiers where ref=$1", [ref]))) return ref;
  }
  throw err(500, "REF", "Impossible de générer une référence, réessayez.");
}

/* ---------- Webhook Freda Pay Issuing (corps brut, AVANT express.json) ---------- */
app.post("/webhooks/freda", express.raw({ type: "*/*", limit: "1mb" }), enveloppe(async (req, res) => {
  if (!signatureValide(req.body, req.get("X-Freda-Signature"))) return res.status(401).json({ error: { code: "SIGNATURE", message: "Signature invalide" } });
  let evt; try { evt = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).end(); }
  const id = evt.id || req.get("X-Freda-Event-Id");
  const deja = await q("insert into webhook_evenements(id, evenement, corps) values ($1,$2,$3) on conflict (id) do nothing", [id, evt.event, evt]);
  res.status(200).json({ recu: true }); // répondre vite, traiter ensuite
  if (deja.rowCount === 0) return;       // doublon
  try {
    if (evt.event === "payment.succeeded" || evt.event === "payment.failed") {
      const d = evt.data || {};
      const p = await un("select * from paiements where freda_id=$1 or freda_reference=$2", [d.id || null, d.reference || null]);
      if (p) await appliquerStatut(p, evt.event === "payment.succeeded" ? "succeeded" : "failed", d, "webhook");
    }
  } catch (e) { console.error("webhook", e); }
}));

app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"], imgSrc: ["'self'", "data:", "blob:"], mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"], scriptSrcAttr: ["'unsafe-inline'"],
    },
  },
}));
// L'administration, l'API et les webhooks ne doivent jamais être indexés (moteurs de recherche et IA)
app.use(["/admin", "/admin.html", "/api", "/webhooks", "/sante", "/devis"], (_req, res, next) => { res.set("X-Robots-Tag", "noindex, nofollow, noarchive"); next(); });
// Toute modification faite dans l'administration doit apparaître tout de suite : aucune réponse JSON de l'API n'est mise en cache
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-cache"); next(); });
app.use(express.json({ limit: "200kb" }));

/* ---------- Changement de statut d'un paiement (webhook ou vérification) ---------- */
async function appliquerStatut(p, statut, data = {}, source = "verification") {
  if (p.statut === statut || p.statut === "succeeded") return; // un paiement réussi est définitif
  await transaction(async c => {
    const r = await c.query(
      `update paiements set statut=$2, frais=$3, net=$4, echec_raison=$5, confirme_le=case when $2='succeeded' then now() else null end
       where id=$1 and statut<>'succeeded' returning *`,
      [p.id, statut, data.fee ?? null, data.net_amount ?? null, data.failure_reason ?? null]);
    if (!r.rowCount) return;
    const d = (await c.query("select * from dossiers where ref=$1 for update", [p.ref])).rows[0];
    if (statut === "succeeded") {
      if (p.type === "initial") {
        await c.query("update dossiers set etat='a_traiter', etape=greatest(etape,1), maj_le=now() where ref=$1", [p.ref]);
        await c.query("update devis set statut='paye', maj_le=now() where dossier_ref=$1", [p.ref]); // devis payé en ligne
        if ((d.service === "achat" || d.service === "precommande") && d.vehicule_id) {
          const v = (await c.query("update vehicules set statut='vendu', maj_le=now() where id=$1 and statut<>'vendu' returning id", [d.vehicule_id])).rowCount;
          if (!v) await c.query("insert into journal(ref, texte, type) values ($1,$2,'alerte')", [p.ref, "Attention : ce véhicule était déjà marqué vendu au moment du paiement. Vérifiez le dossier."]);
        }
      } else {
        await c.query("update dossiers set statut_solde='paye', etape=greatest(etape,$2), etat='en_cours', maj_le=now() where ref=$1", [p.ref, MAX_ETAPE(d.service) - 1]);
      }
      await c.query("insert into journal(ref, texte, type) values ($1,$2,'paiement')",
        [p.ref, `Paiement ${p.type === "solde" ? "du solde " : ""}confirmé ${p.methode === "virement" ? "par l'administrateur (virement bancaire)" : `par Freda Pay Issuing (${source})`} : ${p.montant} ${p.devise}`]);
    } else {
      await c.query("insert into journal(ref, texte, type) values ($1,$2,'alerte')", [p.ref, `Paiement échoué${data.failure_reason ? " : " + data.failure_reason : ""}`]);
    }
  });
}

/** Interroge Freda Pay si le dernier paiement est en attente (au plus toutes les 4 s). */
async function rafraichir(ref) {
  const p = await un("select * from paiements where ref=$1 order by id desc limit 1", [ref]);
  if (!p || p.statut !== "pending" || !p.freda_id || !fredaConfiguree()) return;
  const verrou = await q("update paiements set derniere_verif=now() where id=$1 and (derniere_verif is null or derniere_verif < now() - interval '4 seconds')", [p.id]);
  if (!verrou.rowCount) return;
  try {
    const f = await lirePaiement(p.freda_id);
    if (f?.status === "succeeded" || f?.status === "failed") await appliquerStatut(p, f.status, f, "vérification");
  } catch (e) { console.warn("vérification Freda", e.message); }
}

/* ---------- Paiement ---------- */
const LIB_METHODE = { moncash: "MonCash", natcash: "Natcash", mobile: "MonCash ou Natcash", carte: "Carte bancaire", virement: "Virement bancaire" };
// Le client choisit explicitement MonCash, Natcash ou la carte : c'est cette valeur exacte qui est envoyée à Freda Pay Issuing.
function lireMethode(v, virement = false) {
  if (v === "moncash" || v === "natcash" || v === "carte" || (virement && v === "virement")) return v;
  throw err(400, "METHODE", "Choisissez MonCash, Natcash ou la carte bancaire.");
}
async function lancerPaiement({ dossier, type, methode, montantUsd, email }) {
  if (!fredaConfiguree()) throw err(503, "PAIEMENT_INDISPONIBLE", "Le paiement en ligne n'est pas encore activé. Écrivez-nous sur WhatsApp.");
  if (methode === "carte" && !CARTE_ACTIVE) throw err(400, "CARTE_INACTIVE", "Le paiement par carte n'est pas encore disponible. Choisissez MonCash ou Natcash.");
  const { taux } = await parametres();
  const tentative = ((await un("select count(*)::int n from paiements where ref=$1 and type=$2", [dossier.ref, type])).n) + 1;
  const freda_reference = `${dossier.ref}-${type === "solde" ? "S" : "P"}${tentative}`;
  const montant = methode === "carte" ? arrondi2(montantUsd) : Math.round(montantUsd * taux.taux_htg); // MonCash / Natcash : gourdes
  const devise = methode === "carte" ? "USD" : "HTG";
  if (methode !== "carte" && montant < 20) throw err(400, "MONTANT", "Montant trop faible pour MonCash ou Natcash.");
  let f;
  try {
    f = await creerPaiement({
      methode, montant, reference: freda_reference, client_nom: dossier.client_nom, client_email: email || dossier.client_email,
      return_url: `${PUBLIC_URL}/retour-paiement?ref=${encodeURIComponent(dossier.ref)}`,
    });
  } catch (e) {
    await journaliser(dossier.ref, `Création du paiement refusée par Freda Pay Issuing : ${e.message}`, "alerte");
    if (e instanceof ErreurFreda && e.corps?.error?.code === "CARD_NOT_AVAILABLE") throw err(400, "CARTE_INACTIVE", "Le paiement par carte n'est pas encore disponible. Choisissez MonCash ou Natcash.");
    throw err(502, "PAIEMENT", "Le service de paiement ne répond pas pour le moment. Réessayez dans quelques minutes.");
  }
  if (!f?.checkout_url) throw err(502, "PAIEMENT", "Lien de paiement non reçu. Réessayez.");
  await q(`insert into paiements(ref, type, tentative, freda_reference, freda_id, methode, montant, devise, montant_usd, taux_htg, statut, checkout_url)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (freda_reference) do nothing`,
    [dossier.ref, type, tentative, freda_reference, f.id, methode, montant, devise, montantUsd, taux.taux_htg, "pending", f.checkout_url]);
  await journaliser(dossier.ref, `Lien de paiement ${type === "solde" ? "du solde " : ""}créé : ${montant} ${devise}`);
  return { checkout_url: f.checkout_url, paiement_id: f.id, montant, devise };
}

/** Virement bancaire : aucun appel à Freda. Le paiement reste « pending » jusqu'à la confirmation de l'administrateur. */
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
async function creerVirement({ dossier, montantUsd, email }) {
  if (!EMAIL_OK.test(email || dossier.client_email || "")) throw err(400, "EMAIL", "Une adresse email est nécessaire pour le virement (confirmation de réception).");
  if (!dossier.client_email && email) await q("update dossiers set client_email=$2 where ref=$1", [dossier.ref, email]);
  const { taux, banque } = await parametres();
  const tentative = ((await un("select count(*)::int n from paiements where ref=$1 and type='initial'", [dossier.ref])).n) + 1;
  const montant = Math.round(montantUsd * taux.taux_htg);
  await q(`insert into paiements(ref, type, tentative, freda_reference, methode, montant, devise, montant_usd, taux_htg, statut)
           values ($1,'initial',$2,$3,'virement',$4,'HTG',$5,$6,'pending')`,
    [dossier.ref, tentative, `${dossier.ref}-V${tentative}`, montant, montantUsd, taux.taux_htg]);
  const jeton = dossier.preuve_jeton || crypto.randomBytes(18).toString("hex");
  await q("update dossiers set preuve_jeton=$2 where ref=$1", [dossier.ref, jeton]);
  await journaliser(dossier.ref, `Virement bancaire choisi : ${montant} HTG à recevoir. En attente de la preuve de paiement.`);
  return { virement: true, jeton, montant, devise: "HTG", banque };
}
async function virementInfo(p) { const { banque } = await parametres(); return { montant: p.montant, devise: p.devise, banque }; }
async function dossierAvecJeton(req) {
  const ref = String(req.params.ref).toUpperCase();
  const d = await un("select * from dossiers where ref=$1", [ref]);
  const j = String(req.body?.jeton || req.query?.jeton || "");
  const ok = d?.preuve_jeton && j.length === d.preuve_jeton.length && crypto.timingSafeEqual(Buffer.from(j), Buffer.from(d.preuve_jeton));
  if (!ok) throw err(403, "ACCES", "Lien de preuve invalide. Utilisez le lien reçu après votre choix de virement.");
  return d;
}

/* ---------- Public ---------- */
// Public : « prix » = prix promo s'il existe (c'est lui qui est payé), « prix_normal » = prix barré. Admin : prix réel + prix_promo.
const VUE_V = `select ${COLS_VEHICULE.filter(c => c !== "prix").join(",")}, coalesce(prix_promo, prix) as prix, case when prix_promo is not null then prix end as prix_normal from vehicules`;
const COLS_ADMIN = `${COLS_VEHICULE.join(",")}, prix_promo`;
const VUE_V_ADMIN = `select ${COLS_ADMIN} from vehicules`;
async function avecPhotos(vs, admin = false) {
  const liste = Array.isArray(vs) ? vs : [vs];
  if (!liste.length || !liste[0]) return vs;
  const ph = await tous("select id, vehicule_id from photos_vehicules where vehicule_id = any($1) order by ordre, id", [liste.map(v => v.id)]);
  const vd = await tous("select id, vehicule_id from videos_vehicules where vehicule_id = any($1) order by ordre, id", [liste.map(v => v.id)]);
  for (const v of liste) {
    const p = ph.filter(x => x.vehicule_id === v.id), d = vd.filter(x => x.vehicule_id === v.id);
    if (admin) { v.photos = p.map(x => ({ id: x.id, url: `/api/photos/${x.id}` })); v.videos = d.map(x => ({ id: x.id, url: `/api/videos/${x.id}` })); }
    else { v.photos = p.map(x => `/api/photos/${x.id}`); v.photo = v.photos[0] || null; v.videos = d.map(x => `/api/videos/${x.id}`); }
  }
  return vs;
}

app.get("/api/config", enveloppe(async (_req, res) => {
  const { taux, tarifs, banque } = await parametres();
  res.json({ mode: modeFreda(), taux_htg: taux.taux_htg, taux_date: taux.taux_date, tarifs, banque, whatsapp: process.env.WHATSAPP_NUMERO || "50942405729",
    methodes: CARTE_ACTIVE ? ["moncash", "natcash", "carte"] : ["moncash", "natcash"], paiement_actif: fredaConfiguree() });
}));

app.get("/api/vehicules", enveloppe(async (_req, res) => {
  res.set("Cache-Control", "no-cache"); // véhicules : toujours à jour (les changements de l'administration apparaissent tout de suite)
  res.json(await avecPhotos(await tous(`${VUE_V} where not retire order by vedette desc, (statut='vendu'), maj_le desc`)));
}));

const TYPES_OK = /^(image\/|video\/|application\/pdf$)/;
const upload = multer({
  dest: os.tmpdir(), limits: { fileSize: 60 * 1024 * 1024, files: 30, fields: 40, fieldSize: 200 * 1024 },
  fileFilter: (_req, f, cb) => cb(TYPES_OK.test(f.mimetype) ? null : err(400, "FICHIER", `Type de fichier non accepté : ${f.originalname}. Photos, vidéos ou PDF uniquement.`), true),
});

const limiteur = (max, fenetreMs) => {
  const m = new Map();
  return (req, _res, next) => {
    const k = req.ip, t = Date.now(), l = (m.get(k) || []).filter(x => t - x < fenetreMs);
    if (l.length >= max) return next(err(429, "TROP_DE_DEMANDES", "Trop de tentatives. Patientez quelques minutes."));
    l.push(t); m.set(k, l); next();
  };
};

app.post("/api/dossiers", limiteur(Number(process.env.LIMITE_DOSSIERS) || 12, 15 * 60e3), upload.array("fichiers", 30), enveloppe(async (req, res) => {
  const b = req.body, fichiers = req.files || [];
  try {
    const service = b.service, S = SERVICES[service];
    if (!S) throw err(400, "SERVICE", "Service inconnu.");
    const idCli = idSession(req), cli = idCli ? await un("select * from clients where id=$1", [idCli]) : null;
    const nom = String(b.client_nom || cli?.nom || "").trim().slice(0, 120), tel = String(b.client_tel || cli?.tel || "").trim().slice(0, 40);
    if (nom.length < 2 || tel.replace(/\D/g, "").length < 8) throw err(400, "CLIENT", "Indiquez votre nom complet et un numéro de téléphone valide.");
    if (b.conditions_acceptees !== "1") throw err(400, "CONDITIONS", "Vous devez accepter les conditions avant de payer.");
    const methode = lireMethode(b.methode, ["achat", "precommande"].includes(b.service));
    const email = String(b.client_email || cli?.email || "").trim().slice(0, 160);
    if ((methode === "carte" || methode === "virement") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err(400, "EMAIL", "Une adresse email est nécessaire pour le paiement par carte (reçu).");
    let donnees = {}; try { donnees = JSON.parse(b.donnees || "{}"); } catch { /* ignoré */ }

    // Montant calculé uniquement côté serveur
    const { tarifs } = await parametres();
    let v = null, montantUsd, prixV = null;
    if (b.vehicule_id && b.vehicule_id !== "autre") v = await un(`${VUE_V} where id=$1 and not retire`, [b.vehicule_id]);
    if (service === "essai") { // visite ou essai : uniquement un véhicule de l'inventaire, disponible en Haïti
      if (!v) throw err(400, "VEHICULE", "Choisissez un véhicule de notre inventaire.");
      if (v.statut !== "disponible") throw err(409, "VEHICULE_INDISPONIBLE", "Ce véhicule n'est plus disponible pour une visite ou un essai.");
    }
    if (S.vehicule === "precommandable" || S.vehicule === "disponible") {
      if (!v) throw err(400, "VEHICULE", "Choisissez un véhicule.");
      if (v.prix == null) throw err(400, "PRIX", "Ce véhicule n'a pas de prix affiché. Contactez-nous sur WhatsApp.");
      const okStatut = S.vehicule === "precommandable" ? ["precommande", "transit"].includes(v.statut) : v.statut === "disponible";
      if (!okStatut) throw err(409, "VEHICULE_INDISPONIBLE", "Ce véhicule n'est plus disponible pour ce service.");
      prixV = v.prix; montantUsd = service === "precommande" ? arrondi2(v.prix * 0.9) : v.prix;
    } else {
      montantUsd = Number(tarifs[S.tarif]);
    }
    if (!(montantUsd > 0)) throw err(400, "MONTANT", "Montant introuvable pour ce service.");

    const ref = await nouvelleRef();
    const detail = v ? `${v.marque} ${v.modele}` : (donnees?.champs?.marque ? `${donnees.champs.marque} ${donnees.champs.modele || ""}`.trim() : S.titre);
    donnees.detail = detail;
    const dossier = await un(
      `insert into dossiers(ref, service, vehicule_id, client_nom, client_tel, client_whatsapp, client_email, donnees, montant_usd, prix_vehicule_usd, conditions_acceptees_le, statut_solde, client_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11, $12) returning *`,
      [ref, service, v?.id || null, nom, tel, String(b.client_whatsapp || cli?.whatsapp || tel).slice(0, 40), email || null, donnees, montantUsd, prixV, service === "precommande" ? "a_envoyer" : "non_du", cli?.id || null]);
    await journaliser(ref, `Dossier créé : ${S.titre}${v ? " (" + detail + ")" : ""}`, "dossier");

    let champs = []; try { champs = JSON.parse(b.fichiers_champs || "[]"); } catch { /* ignoré */ }
    for (const [i, f] of fichiers.entries()) {
      const s = await enregistrer(f.path, ref, f.originalname, f.mimetype);
      await q("insert into fichiers(ref, champ, nom, type, taille, stockage, chemin) values ($1,$2,$3,$4,$5,$6,$7)",
        [ref, champs[i] || f.fieldname, f.originalname, f.mimetype, f.size, s.stockage, s.chemin]);
    }
    if (fichiers.length) await journaliser(ref, `${fichiers.length} fichier(s) reçu(s)`, "media");

    if (methode === "virement") {
      const v2 = await creerVirement({ dossier, montantUsd, email });
      return res.status(201).json({ ref, montant_usd: montantUsd, montant: v2.montant, devise: "HTG", methode, virement: true, jeton: v2.jeton, banque: v2.banque });
    }
    const p = await lancerPaiement({ dossier, type: "initial", methode, montantUsd, email });
    res.status(201).json({ ref, montant_usd: montantUsd, montant: p.montant, devise: p.devise, methode, checkout_url: p.checkout_url, paiement_id: p.paiement_id });
  } finally {
    for (const f of fichiers) unlink(f.path).catch(() => {});
  }
}));

app.get("/api/dossiers/:ref", limiteur(240, 10 * 60e3), enveloppe(async (req, res) => {
  const ref = String(req.params.ref).toUpperCase();
  if (!/^EAD-\d{4}-\d{5}$/.test(ref)) throw err(404, "INTROUVABLE", "Aucun dossier ne porte cette référence.");
  await rafraichir(ref);
  const d = await un("select * from dossiers where ref=$1", [ref]);
  if (!d) throw err(404, "INTROUVABLE", "Aucun dossier ne porte cette référence.");
  const p = await un("select * from paiements where ref=$1 and type='initial' order by id desc limit 1", [ref]);
  const S = SERVICES[d.service];
  res.set("Cache-Control", "no-store").json({
    ref, service: d.service, titre: S.titre, detail: d.donnees?.detail || "", cree_le: d.cree_le, etape: d.etape, statuts: S.statuts,
    paiement: p ? { statut: p.statut, montant: p.montant, devise: p.devise, methode: p.methode, confirme_le: p.confirme_le, motif_refus: p.statut === "failed" ? p.motif_refus : null } : null,
    preuves: p?.methode === "virement" ? (await un("select count(*)::int n from fichiers where ref=$1 and champ='preuve_virement'", [ref])).n : null,
    solde_usd: d.service === "precommande" && d.statut_solde !== "paye" ? arrondi2(d.prix_vehicule_usd - d.montant_usd) : null,
    prenom: prenomDe(d.client_nom),
  });
}));

// Virement : le client dépose sa preuve de paiement (image ou PDF, 10 Mo max, 3 fichiers max)
const uploadPreuve = multer({
  dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024, files: 3 },
  fileFilter: (_req, f, cb) => cb(/^(image\/|application\/pdf$)/.test(f.mimetype) ? null : err(400, "FICHIER", `Type de fichier non accepté : ${f.originalname}. Photo ou PDF uniquement.`), true),
});
app.post("/api/dossiers/:ref/preuve", limiteur(20, 15 * 60e3), uploadPreuve.array("fichiers", 3), enveloppe(async (req, res) => {
  const fichiers = req.files || [];
  try {
    const d = await dossierAvecJeton(req);
    const p = await un("select * from paiements where ref=$1 and type='initial' order by id desc limit 1", [d.ref]);
    if (!p || p.methode !== "virement") throw err(409, "PAS_DE_VIREMENT", "Ce dossier n'a pas de virement en cours.");
    if (p.statut === "succeeded") throw err(409, "DEJA_PAYE", "Ce paiement est déjà confirmé. Merci !");
    if (!fichiers.length) throw err(400, "VIDE", "Ajoutez la photo ou le PDF de votre reçu de virement.");
    const deja = (await un("select count(*)::int n from fichiers where ref=$1 and champ='preuve_virement'", [d.ref])).n;
    if (deja + fichiers.length > 6) throw err(400, "TROP", "Maximum 6 fichiers de preuve par dossier.");
    for (const f of fichiers) {
      const s = await enregistrer(f.path, d.ref, f.originalname, f.mimetype);
      await q("insert into fichiers(ref, champ, nom, type, taille, stockage, chemin) values ($1,'preuve_virement',$2,$3,$4,$5,$6)",
        [d.ref, f.originalname, f.mimetype, f.size, s.stockage, s.chemin]);
    }
    if (p.statut === "failed") await q("update paiements set statut='pending', echec_raison=null where id=$1", [p.id]);
    await journaliser(d.ref, `Preuve de virement reçue (${fichiers.length} fichier(s)) : à vérifier par l'administrateur`, "paiement");
    res.status(201).json({ ok: true, preuves: deja + fichiers.length });
  } finally {
    for (const f of fichiers) unlink(f.path).catch(() => {});
  }
}));
app.get("/api/dossiers/:ref/virement", limiteur(60, 10 * 60e3), enveloppe(async (req, res) => {
  const d = await dossierAvecJeton(req);
  const p = await un("select * from paiements where ref=$1 and type='initial' and methode='virement' order by id desc limit 1", [d.ref]);
  if (!p) throw err(404, "INTROUVABLE", "Aucun virement pour ce dossier.");
  const n = (await un("select count(*)::int n from fichiers where ref=$1 and champ='preuve_virement'", [d.ref])).n;
  res.set("Cache-Control", "no-store").json({ ref: d.ref, statut: p.statut, motif_refus: p.motif_refus, preuves: n, ...(await virementInfo(p)) });
}));

app.get("/api/photos/:id", enveloppe(async (req, res) => {
  const f = await un("select * from photos_vehicules where id=$1", [Number(req.params.id) || 0]);
  if (!f) return res.status(404).end();
  await servirPublic(f, res);
}));

app.post("/api/dossiers/:ref/relancer", limiteur(10, 15 * 60e3), enveloppe(async (req, res) => {
  const ref = String(req.params.ref).toUpperCase();
  const d = await un("select * from dossiers where ref=$1", [ref]);
  if (!d) throw err(404, "INTROUVABLE", "Aucun dossier ne porte cette référence.");
  await rafraichir(ref);
  const p = await un("select * from paiements where ref=$1 and type='initial' order by id desc limit 1", [ref]);
  if (p?.statut === "succeeded") throw err(409, "DEJA_PAYE", "Ce dossier est déjà payé.");
  if (p?.statut === "pending" && p.methode === "virement") return res.json({ virement: true, en_attente: true });
  if (p?.statut === "pending" && Date.now() - new Date(p.cree_le).getTime() < 10 * 60e3) return res.json({ checkout_url: p.checkout_url });
  const methode = lireMethode(req.body?.methode);
  const r = await lancerPaiement({ dossier: d, type: "initial", methode, montantUsd: d.montant_usd, email: req.body?.client_email });
  res.json({ checkout_url: r.checkout_url });
}));

const signer = s => crypto.createHmac("sha256", SESSION_SECRET).update(s).digest("base64url");
/* ---------- Espace client ---------- */
const scryptP = (mdp, sel) => new Promise((ok, ko) => crypto.scrypt(mdp, sel, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? ko(e) : ok(k)));
async function hacher(mdp) { const sel = crypto.randomBytes(16); return `s1$${sel.toString("hex")}$${(await scryptP(mdp, sel)).toString("hex")}`; }
async function verifierMdp(mdp, h) {
  const [v, sel, k] = String(h || "").split("$"); if (v !== "s1") return false;
  const a = await scryptP(mdp, Buffer.from(sel, "hex")), b = Buffer.from(k, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const telNorm = t => { let d = String(t || "").replace(/\D/g, ""); if (d.length === 8) d = "509" + d; return d; };
const COOKIE = "ead_session", DUREE_CLIENT = 30 * 24 * 3600e3;
const SECURE = PUBLIC_URL.startsWith("https://");
function poserSession(res, id) {
  const exp = Date.now() + DUREE_CLIENT, c = `cli.${id}.${exp}`;
  res.setHeader("Set-Cookie", `${COOKIE}=${c}.${signer(c)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DUREE_CLIENT / 1000}${SECURE ? "; Secure" : ""}`);
}
const finirSession = res => res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE ? "; Secure" : ""}`);
function idSession(req) {
  const m = (req.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [a, id, exp, sig] = decodeURIComponent(m[1]).split(".");
  if (a !== "cli" || !(Number(exp) > Date.now()) || !/^[0-9a-f-]{36}$/.test(id || "")) return null;
  const att = Buffer.from(signer(`${a}.${id}.${exp}`)), recu = Buffer.from(sig || "");
  return att.length === recu.length && crypto.timingSafeEqual(att, recu) ? id : null;
}
async function client(req, _res, next) {
  try {
    const id = idSession(req);
    const c = id && await un("select * from clients where id=$1", [id]);
    if (!c) return next(err(401, "SESSION", "Connectez-vous pour accéder à votre espace."));
    req.client = c; next();
  } catch (e) { next(e); }
}
const profil = c => ({ id: c.id, nom: c.nom, tel: c.tel, whatsapp: c.whatsapp, email: c.email, email_verifie: !!c.email_verifie_le, cree_le: c.cree_le });

/* ---------- Codes à usage unique (OTP) par email ---------- */
const OTP_VALIDITE_MIN = 10, OTP_ESSAIS_MAX = 5, OTP_DELAI_RENVOI_MS = 60e3;
const otpHash = (clientId, finalite, code) => crypto.createHmac("sha256", SESSION_SECRET).update(`${clientId}:${finalite}:${code}`).digest("hex");
// Crée un code (l'ancien est invalidé). Retourne null si un code a été émis il y a moins d'une minute.
async function creerOtp(c, finalite) {
  const dernier = await un("select cree_le from otp_codes where client_id=$1 and finalite=$2 order by id desc limit 1", [c.id, finalite]);
  if (dernier && Date.now() - new Date(dernier.cree_le).getTime() < OTP_DELAI_RENVOI_MS) return null;
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
  await q("update otp_codes set utilise=true where client_id=$1 and finalite=$2 and not utilise", [c.id, finalite]);
  await q("insert into otp_codes(client_id, finalite, code_hash, expire_le) values ($1,$2,$3, now() + make_interval(mins => $4))", [c.id, finalite, otpHash(c.id, finalite, code), OTP_VALIDITE_MIN]);
  return code;
}
async function verifierOtp(c, finalite, saisi) {
  const o = await un("select * from otp_codes where client_id=$1 and finalite=$2 and not utilise and expire_le > now() order by id desc limit 1", [c.id, finalite]);
  const echec = err(400, "CODE", "Code incorrect ou expiré. Demandez-en un nouveau.");
  if (!o) throw echec;
  const { tentatives } = await un("update otp_codes set tentatives=tentatives+1 where id=$1 returning tentatives", [o.id]);
  if (tentatives > OTP_ESSAIS_MAX) { await q("update otp_codes set utilise=true where id=$1", [o.id]); throw err(429, "CODE_ESSAIS", "Trop d'essais. Demandez un nouveau code."); }
  const a = Buffer.from(o.code_hash), b = Buffer.from(otpHash(c.id, finalite, String(saisi || "").replace(/\D/g, "")));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw echec;
  await q("update otp_codes set utilise=true where id=$1", [o.id]);
}
async function envoyerCodeEmail(c, finalite) {
  const code = await creerOtp(c, finalite);
  if (!code) return false;
  await envoyerEmail({ a: c.email, nom: c.nom, ...emailCode({ code, finalite }) });
  return true;
}
const emailOk = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function vuePublique(d) {
  const p = await un("select * from paiements where ref=$1 and type='initial' order by id desc limit 1", [d.ref]);
  const S = SERVICES[d.service];
  return {
    ref: d.ref, service: d.service, titre: S.titre, service_titre: S.titre, detail: d.donnees?.detail || "", cree_le: d.cree_le, etape: d.etape, statuts: S.statuts,
    paiement: p ? { statut: p.statut, montant: p.montant, devise: p.devise, methode: p.methode, confirme_le: p.confirme_le } : null,
    solde_usd: d.service === "precommande" && d.statut_solde !== "paye" ? arrondi2(d.prix_vehicule_usd - d.montant_usd) : null,
    prenom: prenomDe(d.client_nom), lignes: d.donnees?.lignes || [], montant_usd: d.montant_usd,
  };
}
async function dossierClient(req) {
  const ref = String(req.params.ref || "").toUpperCase();
  const d = await un("select * from dossiers where ref=$1 and client_id=$2", [ref, req.client.id]);
  if (!d) throw err(404, "INTROUVABLE", "Ce dossier n'est pas dans votre espace.");
  return d;
}
async function detailClient(d) {
  await rafraichir(d.ref);
  d = await un("select * from dossiers where ref=$1", [d.ref]);
  const solde = d.service === "precommande" ? { prix_usd: d.prix_vehicule_usd, paye_usd: d.montant_usd + (d.statut_solde === "paye" ? arrondi2(d.prix_vehicule_usd - d.montant_usd) : 0), solde_usd: arrondi2(d.prix_vehicule_usd - d.montant_usd), statut: d.statut_solde, arrive: d.arrive } : null;
  const initPaye = await un("select 1 from paiements where ref=$1 and type='initial' and statut='succeeded'", [d.ref]);
  return {
    ...(await vuePublique(d)),
    paiements: await tous("select id, type, montant, devise, methode, statut, cree_le, confirme_le from paiements where ref=$1 order by id", [d.ref]),
    fichiers: await tous("select id, nom, type, taille, cree_le from fichiers where ref=$1 order by id", [d.ref]),
    historique: await tous("select quand, texte from journal where ref=$1 and type not in ('note','alerte') order by quand desc limit 50", [d.ref]),
    solde, peut_payer_solde: !!(solde && initPaye && d.arrive && d.statut_solde !== "paye"),
  };
}

app.post("/api/compte/inscription", limiteur(8, 15 * 60e3), enveloppe(async (req, res) => {
  const b = req.body || {};
  const nom = String(b.nom || "").trim().slice(0, 120), tel = String(b.tel || "").trim().slice(0, 40), tn = telNorm(tel);
  const email = String(b.email || "").trim().toLowerCase().slice(0, 160) || null, mdp = String(b.mot_de_passe || "");
  if (nom.length < 2) throw err(400, "NOM", "Indiquez votre nom complet.");
  if (tn.length < 8) throw err(400, "TEL", "Numéro de téléphone invalide.");
  if (email && !emailOk(email)) throw err(400, "EMAIL", "Adresse email invalide.");
  if (mdp.length < 8) throw err(400, "MDP", "Le mot de passe doit contenir au moins 8 caractères.");
  if (await un("select 1 from clients where tel_norm=$1 or ($2::text is not null and lower(email)=$2)", [tn, email]))
    throw err(409, "EXISTE", "Un compte existe déjà avec ce téléphone ou cet email. Connectez-vous.");
  const c = await un("insert into clients(nom, tel, tel_norm, whatsapp, email, mdp_hash) values ($1,$2,$3,$4,$5,$6) returning *",
    [nom, tel, tn, String(b.whatsapp || tel).slice(0, 40), email, await hacher(mdp)]);
  await journaliser(null, `Nouveau compte client : ${nom}`, "client");
  if (email) { // email de bienvenue + code de confirmation ; un échec d'envoi ne bloque jamais l'inscription
    creerOtp(c, "verification")
      .then(code => envoyerEmail({ a: email, nom, ...emailBienvenue({ nom, code, publicUrl: PUBLIC_URL, whatsapp: process.env.WHATSAPP_NUMERO || "50942405729" }) }))
      .catch(e => console.error("[email] bienvenue :", e.message));
  }
  poserSession(res, c.id); res.status(201).json({ client: profil(c) });
}));

app.post("/api/compte/connexion", limiteur(10, 15 * 60e3), enveloppe(async (req, res) => {
  const id = String(req.body?.identifiant || "").trim(), mdp = String(req.body?.mot_de_passe || "");
  const c = id.includes("@") ? await un("select * from clients where lower(email)=lower($1)", [id]) : await un("select * from clients where tel_norm=$1", [telNorm(id)]);
  const ok = c ? await verifierMdp(mdp, c.mdp_hash) : (await hacher("x"), false); // temps constant approximatif
  if (!ok) throw err(401, "IDENTIFIANTS", "Identifiants incorrects.");
  poserSession(res, c.id); res.json({ client: profil(c) });
}));
app.post("/api/compte/deconnexion", (_req, res) => { finirSession(res); res.json({ ok: true }); });

app.post("/api/compte/oubli", limiteur(5, 15 * 60e3), enveloppe(async (req, res) => {
  const id = String(req.body?.identifiant || "").trim();
  const c = id.includes("@") ? await un("select * from clients where lower(email)=lower($1)", [id]) : await un("select * from clients where tel_norm=$1", [telNorm(id)]);
  if (c && c.email && emailConfigure()) {
    await envoyerCodeEmail(c, "reinit").catch(e => console.error("[email] code :", e.message));
  } else if (c) { await q("update clients set reinit_demandee=true where id=$1", [c.id]); await journaliser(null, `Mot de passe oublié : ${c.nom} (${c.tel})`, "alerte"); }
  res.json({ ok: true, message: "Si un compte existe, vous recevrez un code par email (s'il y a une adresse enregistrée), sinon un conseiller Elite Auto Deal vous enverra un lien sur WhatsApp." });
}));

app.post("/api/compte/reinitialiser", limiteur(10, 15 * 60e3), enveloppe(async (req, res) => {
  const j = String(req.body?.jeton || ""), mdp = String(req.body?.mot_de_passe || "");
  if (mdp.length < 8) throw err(400, "MDP", "Le mot de passe doit contenir au moins 8 caractères.");
  if (!j) { // réinitialisation par code reçu par email
    const id = String(req.body?.identifiant || "").trim();
    const cl = id.includes("@") ? await un("select * from clients where lower(email)=lower($1)", [id]) : await un("select * from clients where tel_norm=$1", [telNorm(id)]);
    if (!cl) throw err(400, "CODE", "Code incorrect ou expiré. Demandez-en un nouveau.");
    await verifierOtp(cl, "reinit", req.body?.code);
    const n = await un("update clients set mdp_hash=$2, reinit_hash=null, reinit_expire=null, reinit_demandee=false, email_verifie_le=coalesce(email_verifie_le, now()), maj_le=now() where id=$1 returning *", [cl.id, await hacher(mdp)]);
    await journaliser(null, `Mot de passe réinitialisé par code email : ${cl.nom}`, "client");
    poserSession(res, n.id); return res.json({ client: profil(n) });
  }
  const h = crypto.createHash("sha256").update(j).digest("hex");
  const c = await un("update clients set mdp_hash=$2, reinit_hash=null, reinit_expire=null, reinit_demandee=false, maj_le=now() where reinit_hash=$1 and reinit_expire > now() returning *", [h, await hacher(mdp)]);
  if (!c) throw err(400, "LIEN", "Ce lien a expiré ou a déjà été utilisé. Demandez-en un nouveau.");
  poserSession(res, c.id); res.json({ client: profil(c) });
}));

app.use("/api/compte", client);

app.get("/api/compte", enveloppe(async (req, res) => {
  const ds = await tous("select * from dossiers where client_id=$1 order by cree_le desc", [req.client.id]);
  for (const d of ds) if (d.etat === "paiement_en_attente") await rafraichir(d.ref);
  const vues = []; for (const d of await tous("select * from dossiers where client_id=$1 order by cree_le desc", [req.client.id])) vues.push(await vuePublique(d));
  const payes = await un("select coalesce(sum(p.montant_usd),0) t from paiements p join dossiers d using(ref) where d.client_id=$1 and p.statut='succeeded'", [req.client.id]);
  res.set("Cache-Control", "no-store").json({
    client: profil(req.client), dossiers: vues,
    stats: {
      en_cours: vues.filter(v => v.paiement?.statut === "succeeded" && v.etape < v.statuts.length).length,
      payes_usd: payes.t,
      soldes_usd: vues.filter(v => v.paiement?.statut === "succeeded").reduce((s, v) => s + (v.solde_usd || 0), 0),
    },
  });
}));

app.patch("/api/compte", enveloppe(async (req, res) => {
  const b = req.body || {}, c = req.client;
  const nom = b.nom != null ? String(b.nom).trim().slice(0, 120) : c.nom;
  const tel = b.tel != null ? String(b.tel).trim().slice(0, 40) : c.tel, tn = telNorm(tel);
  const email = b.email != null ? (String(b.email).trim().toLowerCase().slice(0, 160) || null) : c.email;
  if (nom.length < 2) throw err(400, "NOM", "Indiquez votre nom complet.");
  if (tn.length < 8) throw err(400, "TEL", "Numéro de téléphone invalide.");
  if (email && !emailOk(email)) throw err(400, "EMAIL", "Adresse email invalide.");
  if (await un("select 1 from clients where id<>$3 and (tel_norm=$1 or ($2::text is not null and lower(email)=$2))", [tn, email, c.id]))
    throw err(409, "EXISTE", "Ce téléphone ou cet email est déjà utilisé par un autre compte.");
  const emailChange = email !== c.email;
  const n = await un("update clients set nom=$2, tel=$3, tel_norm=$4, whatsapp=$5, email=$6, email_verifie_le=case when $7 then null else email_verifie_le end, maj_le=now() where id=$1 returning *",
    [c.id, nom, tel, tn, b.whatsapp != null ? String(b.whatsapp).slice(0, 40) : c.whatsapp, email, emailChange]);
  if (emailChange && email) envoyerCodeEmail(n, "verification").catch(e => console.error("[email] code :", e.message));
  res.json({ client: profil(n) });
}));

app.post("/api/compte/email/envoyer", limiteur(5, 15 * 60e3), enveloppe(async (req, res) => {
  const c = req.client;
  if (!c.email) throw err(400, "EMAIL", "Aucune adresse email n'est enregistrée sur votre compte.");
  if (c.email_verifie_le) throw err(400, "DEJA", "Votre adresse email est déjà confirmée.");
  if (!emailConfigure()) throw err(503, "EMAIL_INDISPONIBLE", "L'envoi d'email n'est pas disponible pour le moment.");
  if (!(await envoyerCodeEmail(c, "verification"))) throw err(429, "TROP_TOT", "Patientez une minute avant de demander un nouveau code.");
  res.json({ ok: true });
}));
app.post("/api/compte/email/verifier", limiteur(10, 15 * 60e3), enveloppe(async (req, res) => {
  const c = req.client;
  if (!c.email) throw err(400, "EMAIL", "Aucune adresse email n'est enregistrée sur votre compte.");
  await verifierOtp(c, "verification", req.body?.code);
  const n = await un("update clients set email_verifie_le=now(), maj_le=now() where id=$1 returning *", [c.id]);
  res.json({ client: profil(n) });
}));

app.post("/api/compte/mot-de-passe", limiteur(10, 15 * 60e3), enveloppe(async (req, res) => {
  const { actuel, nouveau } = req.body || {};
  if (!(await verifierMdp(String(actuel || ""), req.client.mdp_hash))) throw err(400, "MDP_ACTUEL", "Mot de passe actuel incorrect.");
  if (String(nouveau || "").length < 8) throw err(400, "MDP", "Le nouveau mot de passe doit contenir au moins 8 caractères.");
  await q("update clients set mdp_hash=$2, maj_le=now() where id=$1", [req.client.id, await hacher(String(nouveau))]);
  res.json({ ok: true });
}));

app.post("/api/compte/rattacher", limiteur(10, 15 * 60e3), enveloppe(async (req, res) => {
  const ref = String(req.body?.ref || "").trim().toUpperCase();
  const d = await un("select * from dossiers where ref=$1", [ref]);
  if (!d || telNorm(d.client_tel) !== telNorm(req.body?.tel)) throw err(404, "INTROUVABLE", "Aucun dossier ne correspond à cette référence et à ce téléphone.");
  if (d.client_id && d.client_id !== req.client.id) throw err(409, "AUTRE_COMPTE", "Ce dossier est déjà rattaché à un autre compte. Contactez-nous sur WhatsApp.");
  await q("update dossiers set client_id=$2 where ref=$1", [ref, req.client.id]);
  await journaliser(ref, "Dossier rattaché à l'espace client", "dossier", "client");
  res.json({ dossier: await vuePublique(d) });
}));

app.get("/api/compte/dossiers/:ref", enveloppe(async (req, res) => {
  res.set("Cache-Control", "no-store").json(await detailClient(await dossierClient(req)));
}));

app.get("/api/compte/fichiers/:id", enveloppe(async (req, res) => {
  const f = await un("select f.* from fichiers f join dossiers d using(ref) where f.id=$1 and d.client_id=$2", [Number(req.params.id) || 0, req.client.id]);
  if (!f) throw err(404, "INTROUVABLE", "Fichier introuvable.");
  await servir(f, res);
}));

const uploadClient = multer({
  dest: os.tmpdir(), limits: { fileSize: 60 * 1024 * 1024, files: 10 },
  fileFilter: (_req, f, cb) => cb(TYPES_OK.test(f.mimetype) ? null : err(400, "FICHIER", `Type de fichier non accepté : ${f.originalname}. Photos, vidéos ou PDF uniquement.`), true),
});
app.post("/api/compte/dossiers/:ref/fichiers", uploadClient.array("fichiers", 10), enveloppe(async (req, res) => {
  const fichiers = req.files || [];
  try {
    const d = await dossierClient(req);
    if (!fichiers.length) throw err(400, "VIDE", "Ajoutez au moins un fichier.");
    for (const f of fichiers) {
      const s = await enregistrer(f.path, d.ref, f.originalname, f.mimetype);
      await q("insert into fichiers(ref, champ, nom, type, taille, stockage, chemin) values ($1,'espace_client',$2,$3,$4,$5,$6)", [d.ref, f.originalname, f.mimetype, f.size, s.stockage, s.chemin]);
    }
    await journaliser(d.ref, `${fichiers.length} nouveau(x) document(s) envoyé(s) par le client`, "documents_client", "client");
    res.status(201).json(await detailClient(d));
  } finally { for (const f of fichiers) unlink(f.path).catch(() => {}); }
}));

app.post("/api/compte/dossiers/:ref/solde", limiteur(10, 15 * 60e3), enveloppe(async (req, res) => {
  const d = await dossierClient(req);
  const det = await detailClient(d);
  if (!det.peut_payer_solde) throw err(409, "SOLDE", "Le solde pourra être réglé à l'arrivée du véhicule en Haïti.");
  const methode = lireMethode(req.body?.methode);
  const enAttente = await un("select * from paiements where ref=$1 and type='solde' and statut='pending' and methode=$2 and cree_le > now() - interval '24 hours' order by id desc limit 1", [d.ref, methode]);
  if (enAttente) return res.json({ checkout_url: enAttente.checkout_url });
  if (methode === "carte" && !(req.body?.client_email || d.client_email || req.client.email)) throw err(400, "EMAIL", "Ajoutez une adresse email à votre profil pour payer par carte.");
  const p = await lancerPaiement({ dossier: d, type: "solde", methode, montantUsd: det.solde.solde_usd, email: req.body?.client_email || d.client_email || req.client.email });
  await q("update dossiers set statut_solde='envoye' where ref=$1 and statut_solde<>'paye'", [d.ref]);
  res.json({ checkout_url: p.checkout_url });
}));

app.get("/api/compte/paiements/:id/recu", enveloppe(async (req, res) => {
  const p = await un(`select p.*, d.service, d.donnees, d.client_nom from paiements p join dossiers d using(ref)
     where p.id=$1 and d.client_id=$2 and p.statut='succeeded'`, [Number(req.params.id) || 0, req.client.id]);
  if (!p) throw err(404, "INTROUVABLE", "Reçu introuvable.");
  res.json({
    numero: `R-${p.ref}-${p.id}`, date: p.confirme_le, client: p.client_nom, ref: p.ref, service: SERVICES[p.service].titre + (p.type === "solde" ? " (solde)" : ""),
    detail: p.donnees?.detail || "", montant: p.montant, devise: p.devise, montant_usd: p.montant_usd, methode: LIB_METHODE[p.methode] || p.methode,
    prestataire: "Freda Pay Issuing", freda_id: p.freda_id, statut: p.statut,
  });
}));


/* ---------- Administration ---------- */
/* Code d'accès administrateur : modifiable depuis l'administration (haché en base). Sans modification, ADMIN_PASSWORD (variable d'environnement) reste valable. */
const accesAdmin = async () => (await un("select valeur from parametres where cle='admin_acces'"))?.valeur || null; // { hash, version }
async function codeAdminValide(saisi, acces) {
  if (acces?.hash) return verifierMdp(saisi, acces.hash);
  const a = crypto.createHash("sha256").update(String(saisi || "")).digest(), b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
// Le jeton contient la version du code : changer le code déconnecte toutes les autres sessions
function jeton(version = 0) { const exp = Date.now() + 12 * 3600e3; const c = `adm.${exp}.${version}`; return { token: `${c}.${signer(c)}`, expire_le: new Date(exp).toISOString() }; }
async function admin(req, _res, next) {
  try {
    const t = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const [a, exp, version, sig] = t.split(".");
    const attendu = Buffer.from(signer(`${a}.${exp}.${version}`)), recu = Buffer.from(sig || "");
    let ok = a === "adm" && Number(exp) > Date.now() && attendu.length === recu.length && crypto.timingSafeEqual(attendu, recu);
    if (ok) ok = Number(version) === Number((await accesAdmin())?.version || 0);
    ok ? next() : next(err(401, "SESSION", "Session expirée. Reconnectez-vous."));
  } catch (e) { next(e); }
}

app.post("/api/admin/login", limiteur(6, 15 * 60e3), enveloppe(async (req, res) => {
  const acces = await accesAdmin();
  if (!acces && !ADMIN_PASSWORD) throw err(503, "NON_CONFIGURE", "Mot de passe administrateur non configuré sur le serveur.");
  if (!(await codeAdminValide(String(req.body?.password || ""), acces))) throw err(401, "MOT_DE_PASSE", "Mot de passe incorrect.");
  res.json(jeton(Number(acces?.version || 0)));
}));
app.use("/api/admin", admin);
app.post("/api/admin/mot-de-passe", limiteur(6, 15 * 60e3), enveloppe(async (req, res) => {
  const { actuel, nouveau, confirmation } = req.body || {};
  const acces = await accesAdmin();
  if (!(await codeAdminValide(String(actuel || ""), acces))) throw err(400, "MDP_ACTUEL", "Le code d'accès actuel est incorrect.");
  const n = String(nouveau || "");
  if (n.length < 8) throw err(400, "MDP", "Le nouveau code doit contenir au moins 8 caractères.");
  if (confirmation != null && String(confirmation) !== n) throw err(400, "MDP_CONFIRMATION", "La confirmation ne correspond pas au nouveau code.");
  if (n === String(actuel)) throw err(400, "MDP_IDENTIQUE", "Le nouveau code doit être différent de l'actuel.");
  const version = Number(acces?.version || 0) + 1;
  await q("insert into parametres(cle, valeur) values ('admin_acces', $1) on conflict (cle) do update set valeur=excluded.valeur", [JSON.stringify({ hash: await hacher(n), version })]);
  await journaliser(null, "Code d'accès administrateur modifié", "parametres", "administrateur");
  res.json({ ok: true, ...jeton(version) }); // nouveau jeton : la session en cours reste ouverte
}));

function etatCalc(d, p) { return !p || p.statut !== "succeeded" ? "paiement_en_attente" : d.etat; }
const LISTE_DOSSIERS = `
  select d.*, p.statut paiement_statut from dossiers d
  left join lateral (select statut from paiements where ref=d.ref and type='initial' order by id desc limit 1) p on true`;
const formeDossier = d => ({
  ref: d.ref, service: d.service, titre: SERVICES[d.service].titre, client_nom: d.client_nom, client_tel: d.client_tel, client_whatsapp: d.client_whatsapp,
  detail: d.donnees?.detail || "", etape: d.etape, statuts: SERVICES[d.service].statuts,
  etat: d.paiement_statut === "succeeded" ? d.etat : "paiement_en_attente", paiement_statut: d.paiement_statut || "pending",
  montant_usd: d.montant_usd, cree_le: d.cree_le,
});

app.get("/api/admin/resume", enveloppe(async (_req, res) => {
  const r = await un(`select
    coalesce(sum(montant_usd) filter (where statut='succeeded' and confirme_le::date = (now() at time zone 'America/Port-au-Prince')::date),0) jour,
    coalesce(sum(montant_usd) filter (where statut='succeeded' and date_trunc('month', confirme_le) = date_trunc('month', now())),0) mois
    from paiements`);
  const ds = (await tous(LISTE_DOSSIERS)).map(formeDossier);
  const v = await un("select count(*) filter (where statut in ('disponible')) stock, count(*) filter (where statut='transit') transit from vehicules where not retire");
  const pre = await tous(`select ref, client_nom, prix_vehicule_usd - montant_usd solde, statut_solde, arrive, donnees->>'detail' detail from dossiers d
     where service='precommande' and statut_solde <> 'paye' and exists (select 1 from paiements where ref=d.ref and type='initial' and statut='succeeded')`);
  const rec = await tous(`select d.service, sum(p.montant_usd) total_usd from paiements p join dossiers d using(ref)
     where p.statut='succeeded' and date_trunc('month', p.confirme_le) = date_trunc('month', now()) group by 1 order by 2 desc`);
  const echecs = await tous(`select p.ref, d.client_nom, d.service from paiements p join dossiers d using(ref) where p.statut='failed' and p.cree_le > now() - interval '7 days'
     and not exists (select 1 from paiements x where x.ref=p.ref and x.type=p.type and x.statut='succeeded') order by p.id desc limit 10`);
  const alertes = [
    ...echecs.map(e => ({ type: "paiement_echoue", ref: e.ref, texte: `${SERVICES[e.service].titre}, ${e.client_nom}` })),
    ...pre.filter(p => p.arrive && p.statut_solde !== "paye").map(p => ({ type: "solde_a_percevoir", ref: p.ref, texte: `${p.detail}, ${p.client_nom} : ${p.solde} $` })),
    ...(await tous("select id, nom, tel from clients where reinit_demandee")).map(c => ({ type: "reinitialisation_demandee", ref: null, client_id: c.id, texte: `${c.nom} (${c.tel}) a oublié son mot de passe` })),
    ...(await tous("select distinct on (ref) ref, texte from journal where type='documents_client' and quand > now() - interval '7 days' order by ref, quand desc")).map(j => ({ type: "nouveaux_documents", ref: j.ref, texte: j.texte })),
    ...ds.filter(d => d.service === "financement" && d.etat === "a_traiter" && d.etape <= 1).map(d => ({ type: "dossier_incomplet", ref: d.ref, texte: `Financement, ${d.client_nom} : vérifier les pièces` })),
  ];
  res.json({
    paiements_jour_usd: r.jour, paiements_mois_usd: r.mois,
    dossiers_a_traiter: ds.filter(d => d.etat === "a_traiter").length,
    validations_requises: ds.filter(d => d.etat === "validation_requise").length,
    vehicules_stock: Number(v.stock), vehicules_transit: Number(v.transit),
    precommandes_en_cours: pre.length, soldes_a_percevoir_usd: pre.reduce((s, p) => s + Number(p.solde), 0),
    recettes_par_service: rec, alertes,
    activite: await tous("select quand, texte, type, ref from journal order by quand desc limit 15"),
  });
}));

app.get("/api/admin/dossiers", enveloppe(async (req, res) => {
  let ds = (await tous(`${LISTE_DOSSIERS} order by d.cree_le desc limit 500`)).map(formeDossier);
  if (req.query.service) ds = ds.filter(d => d.service === req.query.service);
  if (req.query.etat) ds = ds.filter(d => d.etat === req.query.etat);
  res.json(ds);
}));

app.get("/api/admin/dossiers/:ref", enveloppe(async (req, res) => {
  const d = await un(`${LISTE_DOSSIERS} where d.ref=$1`, [req.params.ref]);
  if (!d) throw err(404, "INTROUVABLE", "Dossier introuvable.");
  const fichiers = (await tous("select id, nom, type, taille, champ from fichiers where ref=$1 order by id", [d.ref])).map(f => ({ ...f, url: `/api/admin/fichiers/${f.id}` }));
  res.json({
    ...formeDossier(d), client_email: d.client_email, donnees: d.donnees, fichiers,
    client_compte: d.client_id ? await un("select id, nom from clients where id=$1", [d.client_id]) : null,
    paiements: await tous("select id, type, methode, montant, devise, montant_usd, statut, freda_id, cree_le, confirme_le, echec_raison from paiements where ref=$1 order by id", [d.ref]),
    journal: await tous("select quand, texte, par, type from journal where ref=$1 order by quand desc", [d.ref]),
    vehicule: d.vehicule_id ? await un(`${VUE_V_ADMIN} where id=$1`, [d.vehicule_id]) : null,
    solde: d.service === "precommande" ? { prix_usd: d.prix_vehicule_usd, paye_usd: d.montant_usd, solde_usd: arrondi2(d.prix_vehicule_usd - d.montant_usd), statut: d.statut_solde, arrive: d.arrive } : null,
  });
}));

app.patch("/api/admin/dossiers/:ref", enveloppe(async (req, res) => {
  const d = await un(`${LISTE_DOSSIERS} where d.ref=$1`, [req.params.ref]);
  if (!d) throw err(404, "INTROUVABLE", "Dossier introuvable.");
  if (d.paiement_statut !== "succeeded") throw err(409, "NON_PAYE", "Aucun paiement confirmé par Freda Pay Issuing : action impossible.");
  const { etape, etat, note } = req.body || {};
  const ETATS = ["a_traiter", "en_cours", "validation_requise", "cloture"];
  if (etape != null && !(Number.isInteger(etape) && etape >= 0 && etape <= MAX_ETAPE(d.service))) throw err(400, "ETAPE", "Étape invalide.");
  if (etat != null && !ETATS.includes(etat)) throw err(400, "ETAT", "État invalide.");
  await q("update dossiers set etape=coalesce($2,etape), etat=coalesce($3,etat), maj_le=now() where ref=$1", [d.ref, etape ?? null, etat ?? null]);
  const S = SERVICES[d.service];
  if (etape != null) await journaliser(d.ref, `Étape : ${S.statuts[Math.min(etape, S.statuts.length - 1)]}`, "dossier", "administrateur");
  if (etat != null) await journaliser(d.ref, `État : ${etat.replace("_", " ")}`, "dossier", "administrateur");
  if (note) await journaliser(d.ref, String(note).slice(0, 1000), "note", "administrateur");
  res.json(formeDossier(await un(`${LISTE_DOSSIERS} where d.ref=$1`, [d.ref])));
}));

app.get("/api/admin/fichiers/:id", enveloppe(async (req, res) => {
  const f = await un("select * from fichiers where id=$1", [Number(req.params.id) || 0]);
  if (!f) throw err(404, "INTROUVABLE", "Fichier introuvable.");
  await servir(f, res);
}));

// Virements bancaires : vérification et confirmation par l'administrateur
app.get("/api/admin/virements", enveloppe(async (_req, res) => {
  const l = await tous(`select p.id, p.ref, p.montant, p.devise, p.montant_usd, p.statut, p.motif_refus, p.cree_le, p.confirme_le, d.service, d.client_nom, d.client_tel, d.client_email, d.donnees
    from paiements p join dossiers d using(ref) where p.methode='virement' order by (p.statut='pending') desc, p.id desc limit 500`);
  const fs = l.length ? await tous("select id, ref, nom, type, taille from fichiers where champ='preuve_virement' and ref = any($1) order by id", [l.map(x => x.ref)]) : [];
  res.set("Cache-Control", "no-store").json(l.map(x => ({
    ...x, detail: x.donnees?.detail || SERVICES[x.service]?.titre || "", donnees: undefined,
    preuves: fs.filter(f => f.ref === x.ref).map(f => ({ id: f.id, nom: f.nom, type: f.type, taille: f.taille })),
  })));
}));
async function virementAdmin(req) {
  const p = await un("select * from paiements where id=$1 and methode='virement'", [Number(req.params.id) || 0]);
  if (!p) throw err(404, "INTROUVABLE", "Virement introuvable.");
  if (p.statut === "succeeded") throw err(409, "DEJA_CONFIRME", "Ce virement est déjà confirmé.");
  return { p, d: await un("select * from dossiers where ref=$1", [p.ref]) };
}
const montantFmt = p => `${Number(p.montant).toLocaleString("fr-FR")} ${p.devise}`;
const WA = () => process.env.WHATSAPP_NUMERO || "50942405729";
app.post("/api/admin/virements/:id/confirmer", enveloppe(async (req, res) => {
  const { p, d } = await virementAdmin(req);
  await appliquerStatut(p, "succeeded", {}, "virement");
  let email = false;
  if (d.client_email && emailConfigure()) {
    try {
      await envoyerEmail({ a: d.client_email, nom: d.client_nom, ...emailPaiementConfirme({ nom: d.client_nom, ref: d.ref, montant: montantFmt(p), detail: d.donnees?.detail || SERVICES[d.service]?.titre || "", lien: `${PUBLIC_URL}/mon-espace`, whatsapp: WA() }) });
      email = true; await journaliser(d.ref, "Email de confirmation de paiement envoyé au client", "paiement");
    } catch (e) { await journaliser(d.ref, `Email de confirmation non envoyé : ${e.message}`, "alerte"); }
  }
  res.json({ ok: true, email });
}));
app.post("/api/admin/virements/:id/refuser", enveloppe(async (req, res) => {
  const { p, d } = await virementAdmin(req);
  const motif = String(req.body?.motif || "").trim().slice(0, 300) || "Le virement n'a pas pu être vérifié.";
  await q("update paiements set statut='failed', echec_raison=$2, motif_refus=$2 where id=$1", [p.id, motif]);
  await journaliser(d.ref, `Virement refusé : ${motif}`, "alerte", "administrateur");
  let email = false;
  if (d.client_email && emailConfigure()) {
    try { await envoyerEmail({ a: d.client_email, nom: d.client_nom, ...emailVirementRefuse({ nom: d.client_nom, ref: d.ref, motif, lien: `${PUBLIC_URL}/mon-espace`, whatsapp: WA() }) }); email = true; } catch { /* ignoré */ }
  }
  res.json({ ok: true, email });
}));

app.get("/api/admin/paiements", enveloppe(async (_req, res) => {
  res.json((await tous(`select p.*, d.service, d.client_nom from paiements p join dossiers d using(ref) order by p.id desc limit 1000`)).map(p => ({
    id: p.id, ref: p.ref, service: p.service, client_nom: p.client_nom, montant: p.montant, devise: p.devise, montant_usd: p.montant_usd,
    methode: p.methode, prestataire: "Freda Pay Issuing", statut: p.statut, freda_id: p.freda_id, cree_le: p.cree_le, confirme_le: p.confirme_le, type: p.type,
  })));
}));

/* Véhicules */
const nettoyerV = b => {
  const o = {};
  for (const k of COLS_VEHICULE) if (k in (b || {})) o[k] = b[k] === "" ? null : b[k];
  if (o.statut && !["disponible", "transit", "precommande", "vendu", "indisponible"].includes(o.statut)) throw err(400, "STATUT", "Statut invalide.");
  if (o.forme && !["suv", "berline", "pickup"].includes(o.forme)) throw err(400, "FORME", "Type de carrosserie invalide.");
  if (b && "prix_promo" in b) o.prix_promo = b.prix_promo === "" || b.prix_promo == null || Number(b.prix_promo) === 0 ? null : b.prix_promo;
  for (const k of ["prix", "prix_promo", "km", "annee", "places"]) if (o[k] != null && !(Number(o[k]) >= 0)) throw err(400, "NOMBRE", `Valeur invalide : ${k}.`);
  if (o.prix_promo != null && o.prix != null && !(Number(o.prix_promo) < Number(o.prix))) throw err(400, "PROMO", "Le prix promo doit être inférieur au prix normal.");
  return o;
};
app.get("/api/admin/vehicules", enveloppe(async (_req, res) => res.json(await avecPhotos(await tous(`${VUE_V_ADMIN} where not retire order by maj_le desc`), true))));
app.post("/api/admin/vehicules", enveloppe(async (req, res) => {
  const o = nettoyerV(req.body);
  if (!o.marque || !o.modele) throw err(400, "CHAMPS", "Marque et modèle sont obligatoires.");
  o.id = (String(o.id || `${o.marque}-${o.modele}`).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)) + "-" + crypto.randomInt(100, 999);
  const k = Object.keys(o);
  const v = await un(`insert into vehicules(${k.join(",")}) values (${k.map((_, i) => "$" + (i + 1)).join(",")}) returning ${COLS_ADMIN}`, Object.values(o));
  await journaliser(null, `Véhicule ajouté : ${v.marque} ${v.modele}`, "vehicule", "administrateur");
  res.status(201).json(await avecPhotos(v, true));
}));
app.patch("/api/admin/vehicules/:id", enveloppe(async (req, res) => {
  const o = nettoyerV(req.body); delete o.id;
  const k = Object.keys(o);
  if (!k.length) throw err(400, "VIDE", "Rien à modifier.");
  if (o.prix_promo != null && o.prix == null) { // le prix promo doit rester sous le prix normal enregistré
    const cur = await un("select prix from vehicules where id=$1", [req.params.id]);
    if (cur && cur.prix != null && !(Number(o.prix_promo) < Number(cur.prix))) throw err(400, "PROMO", "Le prix promo doit être inférieur au prix normal.");
  }
  const v = await un(`update vehicules set ${k.map((c, i) => `${c}=$${i + 2}`).join(",")}, maj_le=now() where id=$1 returning ${COLS_ADMIN}`, [req.params.id, ...Object.values(o)]);
  if (!v) throw err(404, "INTROUVABLE", "Véhicule introuvable.");
  await journaliser(null, `Véhicule modifié : ${v.marque} ${v.modele} (${k.join(", ")})`, "vehicule", "administrateur");
  res.json(await avecPhotos(v, true));
}));
app.delete("/api/admin/vehicules/:id", enveloppe(async (req, res) => {
  const v = await un("update vehicules set retire=true, maj_le=now() where id=$1 returning marque, modele", [req.params.id]);
  if (!v) throw err(404, "INTROUVABLE", "Véhicule introuvable.");
  await journaliser(null, `Véhicule retiré du site : ${v.marque} ${v.modele}`, "vehicule", "administrateur");
  res.json({ ok: true });
}));

/* Photos des véhicules */
const uploadPhotos = multer({
  dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024, files: 12 },
  fileFilter: (_req, f, cb) => cb(/^image\/(jpeg|png|webp)$/.test(f.mimetype) ? null : err(400, "FICHIER", `Image non acceptée : ${f.originalname}. JPEG, PNG ou WebP uniquement.`), true),
});
const vehiculeAdmin = async id => { const v = await un(`${VUE_V_ADMIN} where id=$1`, [id]); if (!v) throw err(404, "INTROUVABLE", "Véhicule introuvable."); return avecPhotos(v, true); };
app.post("/api/admin/vehicules/:id/photos", uploadPhotos.array("photos", 12), enveloppe(async (req, res) => {
  const fichiers = req.files || [];
  try {
    const v = await un("select id, marque, modele from vehicules where id=$1", [req.params.id]);
    if (!v) throw err(404, "INTROUVABLE", "Véhicule introuvable.");
    if (!fichiers.length) throw err(400, "VIDE", "Ajoutez au moins une photo.");
    let { m } = await un("select coalesce(max(ordre), -1)::int m from photos_vehicules where vehicule_id=$1", [v.id]);
    for (const f of fichiers) {
      let n; try { n = await photo45(f.path); } catch { throw err(400, "IMAGE", `Image illisible : ${f.originalname}.`); } // photo ramenée en 4:5, 1080 x 1350
      const s = await enregistrer(n.chemin, `vehicules/${v.id}`, f.originalname.replace(/\.[^.]+$/, "") + ".webp", n.type);
      await q("insert into photos_vehicules(vehicule_id, stockage, chemin, type, taille, ordre) values ($1,$2,$3,$4,$5,$6)", [v.id, s.stockage, s.chemin, n.type, n.taille, ++m]);
    }
    await q("update vehicules set maj_le=now() where id=$1", [v.id]);
    await journaliser(null, `${fichiers.length} photo(s) ajoutée(s) : ${v.marque} ${v.modele}`, "vehicule", "administrateur");
    res.status(201).json(await vehiculeAdmin(v.id));
  } finally { for (const f of fichiers) unlink(f.path).catch(() => {}); }
}));
app.delete("/api/admin/vehicules/:id/photos/:pid", enveloppe(async (req, res) => {
  const f = await un("delete from photos_vehicules where id=$1 and vehicule_id=$2 returning *", [Number(req.params.pid) || 0, req.params.id]);
  if (!f) throw err(404, "INTROUVABLE", "Photo introuvable.");
  await supprimer(f);
  res.json(await vehiculeAdmin(req.params.id));
}));
app.post("/api/admin/vehicules/:id/photos/:pid/principale", enveloppe(async (req, res) => {
  const f = await un("update photos_vehicules set ordre=(select coalesce(min(ordre),0)-1 from photos_vehicules where vehicule_id=$2) where id=$1 and vehicule_id=$2 returning id", [Number(req.params.pid) || 0, req.params.id]);
  if (!f) throw err(404, "INTROUVABLE", "Photo introuvable.");
  res.json(await vehiculeAdmin(req.params.id));
}));

/* Vidéos des véhicules (tous formats acceptés) */
const uploadVideos = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024, files: 4 },
  fileFilter: (_req, f, cb) => cb(/^video\/(mp4|webm|quicktime|x-m4v)$/.test(f.mimetype) ? null : err(400, "FICHIER", `Vidéo non acceptée : ${f.originalname}. MP4, WebM ou MOV uniquement.`), true) });
app.post("/api/admin/vehicules/:id/videos", uploadVideos.array("videos", 4), enveloppe(async (req, res) => {
  const fichiers = req.files || [];
  try {
    const v = await un("select id, marque, modele from vehicules where id=$1", [req.params.id]);
    if (!v) throw err(404, "INTROUVABLE", "Véhicule introuvable.");
    if (!fichiers.length) throw err(400, "VIDE", "Ajoutez au moins une vidéo.");
    let { m } = await un("select coalesce(max(ordre), -1)::int m from videos_vehicules where vehicule_id=$1", [v.id]);
    for (const f of fichiers) {
      const s = await enregistrer(f.path, `vehicules/${v.id}`, f.originalname, f.mimetype);
      await q("insert into videos_vehicules(vehicule_id, stockage, chemin, type, taille, ordre) values ($1,$2,$3,$4,$5,$6)", [v.id, s.stockage, s.chemin, f.mimetype, f.size, ++m]);
    }
    await q("update vehicules set maj_le=now() where id=$1", [v.id]);
    await journaliser(null, `${fichiers.length} vidéo(s) ajoutée(s) : ${v.marque} ${v.modele}`, "vehicule", "administrateur");
    res.status(201).json(await vehiculeAdmin(v.id));
  } finally { for (const f of fichiers) unlink(f.path).catch(() => {}); }
}));
app.delete("/api/admin/vehicules/:id/videos/:vid", enveloppe(async (req, res) => {
  const f = await un("delete from videos_vehicules where id=$1 and vehicule_id=$2 returning *", [Number(req.params.vid) || 0, req.params.id]);
  if (!f) throw err(404, "INTROUVABLE", "Vidéo introuvable.");
  await supprimer(f); await q("update vehicules set maj_le=now() where id=$1", [req.params.id]);
  res.json(await vehiculeAdmin(req.params.id));
}));
app.get("/api/videos/:id", enveloppe(async (req, res) => {
  const f = await un("select * from videos_vehicules where id=$1", [Number(req.params.id) || 0]);
  if (!f) return res.status(404).end();
  await servirPublicRange(f, req, res);
}));

/* Devis (espace administrateur : Gestion des devis) */
const VUE_DEVIS = "id, numero, jeton, client_nom, client_email, client_tel, lignes, frais_supplementaires, total_usd, statut, envoye_le, expire_le, dossier_ref, cree_le, maj_le";
const devisParId = async id => { const d = await un(`select ${VUE_DEVIS} from devis where id=$1`, [Number(id) || 0]); if (!d) throw err(404, "INTROUVABLE", "Devis introuvable."); return d; };
const verifier = b => { try { return validerDevis(b); } catch (e) { throw err(400, "DEVIS", e.message); } };
const nomPdf = d => `Devis-${d.numero}.pdf`;
const lienPdf = d => `${PUBLIC_URL}/devis/${d.jeton}.pdf`;
const lienDevis = d => `${PUBLIC_URL}/devis/${d.jeton}`; // page du devis (consultation et paiement en ligne)
app.get("/api/admin/devis", enveloppe(async (_req, res) => res.json(await tous(`select ${VUE_DEVIS} from devis order by cree_le desc limit 200`))));
app.post("/api/admin/devis", enveloppe(async (req, res) => {
  const v = verifier(req.body);
  const { id } = await un("select nextval(pg_get_serial_sequence('devis','id'))::int id");
  const numero = `EAD-DEV-${String(id).padStart(4, "0")}`;
  const d = await un(`insert into devis(id, numero, jeton, client_nom, client_email, client_tel, lignes, frais_supplementaires, total_usd, expire_le)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning ${VUE_DEVIS}`, [id, numero, crypto.randomBytes(24).toString("base64url"), v.client_nom, v.client_email, v.client_tel, JSON.stringify(v.lignes), v.frais_supplementaires, v.total_usd, v.expire_le]);
  await journaliser(null, `Devis ${numero} créé pour ${v.client_nom} (${montantDevis(v.total_usd)})`, "devis", "administrateur");
  res.status(201).json(d);
}));
app.patch("/api/admin/devis/:id", enveloppe(async (req, res) => {
  const ex = await devisParId(req.params.id);
  if (ex.statut === "paye") throw err(409, "DEJA_PAYE", "Ce devis est déjà payé : il ne peut plus être modifié.");
  const v = verifier(req.body);
  if (!req.body?.expire_le) v.expire_le = ex.expire_le; // pas de nouvelle date : on garde l'expiration actuelle
  res.json(await un(`update devis set client_nom=$2, client_email=$3, client_tel=$4, lignes=$5, frais_supplementaires=$6, total_usd=$7, expire_le=$8, maj_le=now() where id=$1 returning ${VUE_DEVIS}`,
    [Number(req.params.id), v.client_nom, v.client_email, v.client_tel, JSON.stringify(v.lignes), v.frais_supplementaires, v.total_usd, v.expire_le]));
}));
app.delete("/api/admin/devis/:id", enveloppe(async (req, res) => { const d = await devisParId(req.params.id); await q("delete from devis where id=$1", [d.id]); await journaliser(null, `Devis ${d.numero} supprimé`, "devis", "administrateur"); res.json({ ok: true }); }));
app.get("/api/admin/devis/:id/pdf", enveloppe(async (req, res) => {
  const d = await devisParId(req.params.id);
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${nomPdf(d)}"`, "Cache-Control": "no-store" }).send(await genererPdf(d));
}));
app.post("/api/admin/devis/:id/email", limiteur(30, 15 * 60e3), enveloppe(async (req, res) => {
  const d = await devisParId(req.params.id);
  if (!d.client_email) throw err(400, "EMAIL", "Ajoutez l'adresse email du client pour envoyer le devis par email.");
  if (!emailConfigure()) throw err(503, "EMAIL_INDISPONIBLE", "L'envoi d'email n'est pas configuré (clé Brevo manquante).");
  const ok = await envoyerEmail({ a: d.client_email, nom: d.client_nom,
    ...emailDevis({ nom: d.client_nom, numero: d.numero, total: montantDevis(d.total_usd), lien: lienDevis(d), expire: d.expire_le, whatsapp: process.env.WHATSAPP_NUMERO || "50942405729" }) });
  if (!ok) throw err(502, "EMAIL", "Brevo n'a pas pu envoyer l'email. Vérifiez la clé API et l'expéditeur validé.");
  const n = await un(`update devis set statut='envoye', envoye_le=now(), maj_le=now() where id=$1 returning ${VUE_DEVIS}`, [d.id]);
  await journaliser(null, `Devis ${d.numero} envoyé par email à ${d.client_email}`, "devis", "administrateur");
  res.json(n);
}));
app.post("/api/admin/devis/:id/whatsapp", enveloppe(async (req, res) => {
  const d = await devisParId(req.params.id);
  const tel = telNorm(d.client_tel);
  if (tel.length < 8) throw err(400, "TEL", "Ajoutez le numéro WhatsApp du client pour partager le devis.");
  const message = `Bonjour ${prenomDe(d.client_nom)}, voici votre devis Elite Auto Deal n° ${d.numero} d'un montant de ${montantDevis(d.total_usd)}${d.expire_le ? ` (valable jusqu'au ${new Date(d.expire_le).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Port-au-Prince" })})` : ""}. Consultez-le et payez-le en ligne : ${lienDevis(d)}`;
  const n = await un(`update devis set statut=case when statut='envoye' then statut else 'partage' end, maj_le=now() where id=$1 returning ${VUE_DEVIS}`, [d.id]);
  await journaliser(null, `Devis ${d.numero} partagé par WhatsApp (${d.client_nom})`, "devis", "administrateur");
  res.json({ devis: n, lien_devis: lienDevis(d), lien_pdf: lienPdf(d), message, lien_whatsapp: `https://wa.me/${tel}?text=${encodeURIComponent(message)}` });
}));

/* ---------- Vitrine du site (diapositives de la première page) ---------- */
const imageVitrine = (id, v) => `/api/vitrine/${encodeURIComponent(id)}/image?v=${v}`;
async function lireVitrine(admin = false) {
  const rows = await tous(`select s.id, s.marque, s.modele, s.filigrane, s.accroche, s.vehicule_id, s.promo, s.promo_texte, s.ordre, s.actif, (s.image is not null) as a_image,
      extract(epoch from s.maj_le)::bigint as v, ve.prix as v_prix, ve.prix_promo as v_promo, ve.statut as v_statut, ve.retire as v_retire, ve.marque as v_marque, ve.modele as v_modele,
      (select id from photos_vehicules where vehicule_id=s.vehicule_id order by ordre, id limit 1) as photo_id
    from vitrine s left join vehicules ve on ve.id=s.vehicule_id
    ${admin ? "" : "where s.actif and (s.vehicule_id is null or (not ve.retire and ve.statut <> 'vendu'))"} order by s.ordre, s.cree_le`);
  return rows.map(r => {
    const promoVeh = r.v_promo != null;
    const base = { id: r.id, marque: r.marque, modele: r.modele, filigrane: r.filigrane || "", accroche: r.accroche || "", vehicule_id: r.vehicule_id, promo: !!r.promo || promoVeh, promo_texte: r.promo_texte || "",
      prix: r.vehicule_id && r.v_prix != null ? Number(promoVeh ? r.v_promo : r.v_prix) : null, prix_normal: promoVeh ? Number(r.v_prix) : null,
      image: r.a_image ? imageVitrine(r.id, r.v) : r.photo_id ? `/api/photos/${r.photo_id}` : null, photo: !r.a_image && !!r.photo_id };
    return admin ? { ...base, actif: r.actif, ordre: r.ordre, promo_manuel: !!r.promo, vehicule: r.vehicule_id ? `${r.v_marque || ""} ${r.v_modele || ""}`.trim() : null, a_image: r.a_image, statut_veh: r.v_statut } : base;
  }).filter(x => admin || x.image);
}
app.get("/api/vitrine", enveloppe(async (_req, res) => res.json(await lireVitrine())));
app.get("/api/vitrine/:id/image", enveloppe(async (req, res) => {
  const r = await un("select image, image_type from vitrine where id=$1 and image is not null", [String(req.params.id)]);
  if (!r) throw err(404, "INTROUVABLE", "Image introuvable.");
  res.set({ "Content-Type": r.image_type || "image/webp", "Cache-Control": "public, max-age=31536000, immutable" }).send(r.image);
}));
const uploadVitrine = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (_req, f, cb) => cb(/^image\/(png|webp|jpeg)$/.test(f.mimetype) ? null : err(400, "FICHIER", "Image non acceptée : PNG, WebP ou JPEG uniquement."), true) });
const champsVitrine = b => {
  const t = (k, n) => String(b[k] ?? "").trim().slice(0, n);
  const o = { marque: t("marque", 60), modele: t("modele", 80), filigrane: t("filigrane", 12), accroche: t("accroche", 120), promo_texte: t("promo_texte", 60), vehicule_id: t("vehicule_id", 80) || null,
    promo: b.promo === true || b.promo === "true" || b.promo === "1" || b.promo === "on", actif: !(b.actif === false || b.actif === "false" || b.actif === "0") };
  if (!o.marque || !o.modele) throw err(400, "CHAMPS", "Indiquez la marque et le modèle.");
  return o;
};
app.get("/api/admin/vitrine", enveloppe(async (_req, res) => res.json(await lireVitrine(true))));
app.post("/api/admin/vitrine", uploadVitrine.single("image"), enveloppe(async (req, res) => {
  const o = champsVitrine(req.body || {});
  if (!req.file && !o.vehicule_id) throw err(400, "IMAGE", "Ajoutez une image (de préférence détourée, fond transparent) ou liez la diapositive à un véhicule qui a des photos.");
  if (o.vehicule_id && !(await un("select 1 from vehicules where id=$1 and not retire", [o.vehicule_id]))) throw err(400, "VEHICULE", "Véhicule introuvable.");
  const id = (`${o.marque}-${o.modele}`).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-" + crypto.randomInt(100, 999);
  const { m } = await un("select coalesce(max(ordre), -1) + 1 as m from vitrine");
  await q("insert into vitrine(id, marque, modele, filigrane, accroche, vehicule_id, promo, promo_texte, ordre, actif, image, image_type) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [id, o.marque, o.modele, o.filigrane, o.accroche, o.vehicule_id, o.promo, o.promo_texte, m, o.actif, req.file?.buffer || null, req.file?.mimetype || null]);
  await journaliser(null, `Vitrine : diapositive ajoutée (${o.marque} ${o.modele}${o.promo ? ", promo" : ""})`, "parametres", "administrateur");
  res.status(201).json((await lireVitrine(true)).find(x => x.id === id));
}));
app.patch("/api/admin/vitrine/:id", uploadVitrine.single("image"), enveloppe(async (req, res) => {
  const ex = await un("select id, image is not null as a_image from vitrine where id=$1", [String(req.params.id)]);
  if (!ex) throw err(404, "INTROUVABLE", "Diapositive introuvable.");
  const o = champsVitrine({ actif: true, ...(req.body || {}) });
  if (o.vehicule_id && !(await un("select 1 from vehicules where id=$1 and not retire", [o.vehicule_id]))) throw err(400, "VEHICULE", "Véhicule introuvable.");
  if (!req.file && !ex.a_image && !o.vehicule_id) throw err(400, "IMAGE", "Ajoutez une image ou liez un véhicule qui a des photos.");
  await q(`update vitrine set marque=$2, modele=$3, filigrane=$4, accroche=$5, vehicule_id=$6, promo=$7, promo_texte=$8, actif=$9, maj_le=now()${req.file ? ", image=$10, image_type=$11" : ""} where id=$1`,
    [ex.id, o.marque, o.modele, o.filigrane, o.accroche, o.vehicule_id, o.promo, o.promo_texte, o.actif, ...(req.file ? [req.file.buffer, req.file.mimetype] : [])]);
  res.json((await lireVitrine(true)).find(x => x.id === ex.id));
}));
app.post("/api/admin/vitrine/:id/deplacer", enveloppe(async (req, res) => { // sens = -1 (vers le haut) ou 1 (vers le bas)
  const sens = Number(req.body?.sens) < 0 ? -1 : 1;
  const liste = await tous("select id from vitrine order by ordre, cree_le"); const i = liste.findIndex(x => x.id === req.params.id);
  if (i < 0) throw err(404, "INTROUVABLE", "Diapositive introuvable.");
  const j = i + sens; if (j >= 0 && j < liste.length) [liste[i], liste[j]] = [liste[j], liste[i]];
  for (const [n, x] of liste.entries()) await q("update vitrine set ordre=$2 where id=$1", [x.id, n]);
  res.json(await lireVitrine(true));
}));
app.delete("/api/admin/vitrine/:id", enveloppe(async (req, res) => {
  const r = await un("delete from vitrine where id=$1 returning marque, modele", [String(req.params.id)]);
  if (!r) throw err(404, "INTROUVABLE", "Diapositive introuvable.");
  await journaliser(null, `Vitrine : diapositive supprimée (${r.marque} ${r.modele})`, "parametres", "administrateur");
  res.json({ ok: true });
}));

/* Clients */
app.get("/api/admin/clients", enveloppe(async (_req, res) => {
  res.json(await tous(`select c.id, c.nom, c.tel, c.whatsapp, c.email, c.cree_le, c.reinit_demandee,
     (select count(*)::int from dossiers d where d.client_id=c.id) nb_dossiers,
     (select coalesce(sum(p.montant_usd),0) from paiements p join dossiers d using(ref) where d.client_id=c.id and p.statut='succeeded') total_paye_usd
     from clients c order by c.cree_le desc limit 2000`));
}));
app.post("/api/admin/clients/:id/reinitialisation", enveloppe(async (req, res) => {
  const j = crypto.randomBytes(24).toString("base64url");
  const c = await un("update clients set reinit_hash=$2, reinit_expire=now() + interval '24 hours' where id=$1 returning *", [req.params.id, crypto.createHash("sha256").update(j).digest("hex")]).catch(() => null);
  if (!c) throw err(404, "INTROUVABLE", "Client introuvable.");
  const lien = `${PUBLIC_URL}/mon-espace?reinit=${j}`;
  await journaliser(null, `Lien de réinitialisation créé pour ${c.nom}`, "client", "administrateur");
  res.json({ lien, whatsapp: c.whatsapp || c.tel, message_whatsapp: `Bonjour ${prenomDe(c.nom)}, voici votre lien pour choisir un nouveau mot de passe sur votre espace Elite Auto Deal (valable 24 h) : ${lien}` });
}));

/* Précommandes */
app.get("/api/admin/precommandes", enveloppe(async (_req, res) => {
  const rows = await tous(`select d.*, (select checkout_url from paiements where ref=d.ref and type='solde' order by id desc limit 1) lien_solde,
     (select statut from paiements where ref=d.ref and type='initial' order by id desc limit 1) pi, v.delai
     from dossiers d left join vehicules v on v.id=d.vehicule_id where d.service='precommande' order by d.cree_le desc`);
  res.json(rows.filter(r => r.pi === "succeeded").map(r => ({
    ref: r.ref, client_nom: r.client_nom, client_whatsapp: r.client_whatsapp, vehicule: r.donnees?.detail, prix_usd: r.prix_vehicule_usd,
    paye_usd: r.montant_usd + (r.statut_solde === "paye" ? arrondi2(r.prix_vehicule_usd - r.montant_usd) : 0),
    solde_usd: arrondi2(r.prix_vehicule_usd - r.montant_usd), statut_solde: r.statut_solde, arrive: r.arrive, delai: r.delai, etape: r.etape,
    checkout_url_solde: r.lien_solde || null,
  })));
}));
app.post("/api/admin/precommandes/:ref/arrivee", enveloppe(async (req, res) => {
  const d = await un("update dossiers set arrive=true, etape=greatest(etape,3), maj_le=now() where ref=$1 and service='precommande' returning ref", [req.params.ref]);
  if (!d) throw err(404, "INTROUVABLE", "Précommande introuvable.");
  await journaliser(d.ref, "Véhicule arrivé en Haïti", "dossier", "administrateur");
  res.json({ ok: true });
}));
app.post("/api/admin/precommandes/:ref/solde", enveloppe(async (req, res) => {
  const d = await un("select * from dossiers where ref=$1 and service='precommande'", [req.params.ref]);
  if (!d) throw err(404, "INTROUVABLE", "Précommande introuvable.");
  if (d.statut_solde === "paye") throw err(409, "DEJA_PAYE", "Le solde est déjà réglé.");
  const solde = arrondi2(d.prix_vehicule_usd - d.montant_usd);
  const methode = lireMethode(req.body?.methode);
  const p = await lancerPaiement({ dossier: d, type: "solde", methode, montantUsd: solde, email: d.client_email });
  await q("update dossiers set statut_solde='envoye', maj_le=now() where ref=$1", [d.ref]);
  const { messages } = await parametres();
  const montantTxt = p.devise === "USD" ? `${solde} $` : `${p.montant.toLocaleString("fr-FR")} HTG`;
  const message_whatsapp = (messages.solde || "").replace("{prenom}", prenomDe(d.client_nom)).replace("{vehicule}", d.donnees?.detail || "véhicule")
    .replace("{montant}", montantTxt).replace("{lien}", p.checkout_url).replace("{ref}", d.ref);
  res.json({ checkout_url: p.checkout_url, message_whatsapp, client_whatsapp: d.client_whatsapp });
}));

/* Paramètres */
app.get("/api/admin/parametres", enveloppe(async (_req, res) => {
  const p = await parametres();
  res.json({ taux_htg: p.taux.taux_htg, taux_date: p.taux.taux_date, tarifs: p.tarifs, messages: p.messages, banque: p.banque });
}));
app.put("/api/admin/parametres", enveloppe(async (req, res) => {
  const b = req.body || {}, p = await parametres();
  if (b.taux_htg != null) {
    if (!(Number(b.taux_htg) > 50 && Number(b.taux_htg) < 1000)) throw err(400, "TAUX", "Taux USD vers HTG invalide.");
    p.taux = { taux_htg: Number(b.taux_htg), taux_date: b.taux_date || new Date().toISOString().slice(0, 10) };
  }
  if (b.tarifs) for (const k of Object.keys(p.tarifs)) if (b.tarifs[k] != null) {
    if (!(Number(b.tarifs[k]) > 0)) throw err(400, "TARIF", `Tarif invalide : ${k}.`);
    p.tarifs[k] = Number(b.tarifs[k]);
  }
  if (b.messages) for (const k of Object.keys(p.messages)) if (typeof b.messages[k] === "string") p.messages[k] = b.messages[k].slice(0, 4000);
  if (b.banque && typeof b.banque === "object") {
    const t = (k, n) => String(b.banque[k] ?? p.banque?.[k] ?? "").trim().slice(0, n);
    const compteSaisi = t("compte", 40);
    if (compteSaisi && compteSaisi.replace(/\D/g, "").length < 6) throw err(400, "COMPTE", "Numéro de compte invalide : au moins 6 chiffres.");
    const banque = { nom: t("nom", 60), titulaire: t("titulaire", 80), compte: compteSaisi.replace(/[^\d\- ]/g, ""), succursale: t("succursale", 20), devise: t("devise", 40) };
    p.banque = banque;
  }
  for (const cle of ["taux", "tarifs", "messages", "banque"]) await q("insert into parametres(cle, valeur) values ($1,$2) on conflict (cle) do update set valeur=excluded.valeur", [cle, JSON.stringify(p[cle])]);
  await journaliser(null, "Paramètres du site mis à jour", "parametres", "administrateur");
  res.json({ taux_htg: p.taux.taux_htg, taux_date: p.taux.taux_date, tarifs: p.tarifs, messages: p.messages, banque: p.banque });
}));

/* Rapports */
app.get("/api/admin/rapports", enveloppe(async (req, res) => {
  const an = Number(req.query.annee) || new Date().getFullYear();
  const mois = await tous(`select to_char(date_trunc('month', p.confirme_le),'YYYY-MM') mois, sum(p.montant_usd) recettes_usd,
     count(*) filter (where d.service in ('achat','precommande') and p.type='initial') ventes
     from paiements p join dossiers d using(ref) where p.statut='succeeded' and extract(year from p.confirme_le)=$1 group by 1 order by 1`, [an]);
  const par_service = await tous(`select d.service, sum(p.montant_usd) total_usd, count(*) n from paiements p join dossiers d using(ref)
     where p.statut='succeeded' and extract(year from p.confirme_le)=$1 group by 1 order by 2 desc`, [an]);
  res.json({ mois, par_service });
}));

/* ---------- Fichiers statiques ---------- */
app.get("/sante", (_req, res) => res.json({ ok: true, paiement: fredaConfiguree() ? modeFreda() : "non configuré" }));
app.get(["/admin", "/admin/"], (_req, res) => res.sendFile(path.join(DOSSIER_PUBLIC, "admin.html")));
/* ---------- Vraies URL par page (SEO) ---------- */
const envoyerPage = async (res, vue, chemin, { vehicule, statut = 200, noindex } = {}) => {
  const { tarifs } = await parametres();
  const vitrine = await lireVitrine().catch(() => []);
  res.status(statut).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=0, must-revalidate" }).send(pageHtml(DOSSIER_PUBLIC, vue, { tarifs, vehicule, chemin, noindex, vitrine }));
};
for (const [vue, chemin] of Object.entries(CHEMINS)) app.get(chemin, enveloppe(async (_req, res) => envoyerPage(res, vue, chemin)));
app.get("/vehicules/:id", enveloppe(async (req, res) => {
  const v = await un(`${VUE_V} where id=$1 and not retire`, [String(req.params.id)]);
  if (!v) return envoyerPage(res, "vehicules", "/vehicules", { statut: 404, noindex: true });
  await avecPhotos(v);
  envoyerPage(res, "vehicule", `/vehicules/${encodeURIComponent(v.id)}`, { vehicule: v });
}));
app.get("/sitemap.xml", enveloppe(async (_req, res) => {
  res.set({ "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" }).send(sitemapXml(await tous("select id, maj_le from vehicules where not retire order by maj_le desc")));
}));

/* Devis : consultation et paiement par lien sécurisé (jeton non devinable ; un jeton = un seul devis) */
const vueDevisPublic = async d => {
  const p = d.dossier_ref ? await un("select statut, methode, confirme_le from paiements where ref=$1 and type='initial' order by id desc limit 1", [d.dossier_ref]) : null;
  const expire = d.expire_le && new Date(d.expire_le).getTime() < Date.now();
  const { taux, banque } = await parametres();
  return { numero: d.numero, client_nom: d.client_nom, client_email: d.client_email || "", client_tel: d.client_tel || "", lignes: d.lignes, frais_supplementaires: Number(d.frais_supplementaires), total_usd: Number(d.total_usd), cree_le: d.cree_le, expire_le: d.expire_le,
    statut: d.statut === "paye" ? "paye" : expire ? "expire" : "actif", ref: d.dossier_ref, paiement: p ? { statut: p.statut, methode: p.methode, confirme_le: p.confirme_le } : null,
    methodes: [...(CARTE_ACTIVE ? ["moncash", "natcash", "carte"] : ["moncash", "natcash"]), ...(banque?.compte ? ["virement"] : [])], banque, taux_htg: taux.taux_htg, paiement_actif: fredaConfiguree(), whatsapp: process.env.WHATSAPP_NUMERO || "50942405729" };
};
const devisParJeton = async j => { const d = await un(`select ${VUE_DEVIS} from devis where jeton=$1`, [String(j || "")]); if (!d) throw err(404, "INTROUVABLE", "Ce devis n'existe pas ou le lien n'est plus valable."); return d; };
app.get("/api/devis/:jeton", limiteur(120, 10 * 60e3), enveloppe(async (req, res) => {
  const d = await devisParJeton(req.params.jeton);
  if (d.dossier_ref) await rafraichir(d.dossier_ref);
  res.set("Cache-Control", "no-store").json(await vueDevisPublic(await devisParJeton(req.params.jeton)));
}));
app.post("/api/devis/:jeton/payer", limiteur(10, 15 * 60e3), enveloppe(async (req, res) => {
  let d = await devisParJeton(req.params.jeton);
  if (d.dossier_ref) await rafraichir(d.dossier_ref);
  d = await devisParJeton(req.params.jeton);
  if (d.statut === "paye") throw err(409, "DEJA_PAYE", "Ce devis est déjà payé. Merci !");
  if (d.expire_le && new Date(d.expire_le).getTime() < Date.now()) throw err(410, "EXPIRE", "Ce devis a expiré. Contactez-nous sur WhatsApp pour obtenir un nouveau devis.");
  const methode = lireMethode(req.body?.methode, true);
  const email = String(req.body?.client_email || d.client_email || "").trim().slice(0, 160);
  if ((methode === "carte" || methode === "virement") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err(400, "EMAIL", "Une adresse email est nécessaire pour le paiement par carte (reçu).");
  let ref = d.dossier_ref;
  if (!ref) { // le dossier de paiement est créé au premier paiement ; le montant vient uniquement du devis enregistré sur le serveur
    ref = await nouvelleRef();
    await un(`insert into dossiers(ref, service, client_nom, client_tel, client_whatsapp, client_email, donnees, montant_usd, conditions_acceptees_le, statut_solde)
      values ($1,'devis',$2,$3,$3,$4,$5,$6, now(), 'non_du') returning ref`,
      [ref, d.client_nom, d.client_tel || "", email || null, { detail: `Devis ${d.numero}`, devis: d.numero, lignes: [...d.lignes.map(l => [l.description, `${l.quantite} x ${montantDevis(l.prix_unitaire)}`]), ...(Number(d.frais_supplementaires) > 0 ? [["Frais supplémentaires", montantDevis(d.frais_supplementaires)]] : [])] }, d.total_usd]);
    await q("update devis set dossier_ref=$2, maj_le=now() where id=$1 and dossier_ref is null", [d.id, ref]);
    ref = (await devisParJeton(req.params.jeton)).dossier_ref;
    await journaliser(ref, `Dossier créé pour le paiement du devis ${d.numero}`, "dossier");
  }
  const dossier = await un("select * from dossiers where ref=$1", [ref]);
  const p = await un("select * from paiements where ref=$1 and type='initial' order by id desc limit 1", [ref]);
  if (methode === "virement") {
    if (p?.statut === "pending" && p.methode === "virement") return res.json({ ref, virement: true, jeton: dossier.preuve_jeton, ...(await virementInfo(p)) });
    const v2 = await creerVirement({ dossier, montantUsd: Number(d.total_usd), email });
    return res.json({ ref, virement: true, jeton: v2.jeton, montant: v2.montant, devise: "HTG", banque: v2.banque });
  }
  if (p?.statut === "pending" && p.methode === "virement") await q("update paiements set statut='failed', echec_raison='Remplacé par un autre moyen de paiement' where id=$1", [p.id]);
  if (p?.statut === "pending" && p.methode === methode && Date.now() - new Date(p.cree_le).getTime() < 10 * 60e3) return res.json({ ref, checkout_url: p.checkout_url });
  const r = await lancerPaiement({ dossier, type: "initial", methode, montantUsd: Number(d.total_usd), email });
  res.json({ ref, checkout_url: r.checkout_url });
}));
// Page du devis (même application, vue « devis » ; jamais indexée)
app.get("/devis/:jeton", enveloppe(async (req, res, next) => {
  if (/\.pdf$/i.test(req.params.jeton)) return next(); // /devis/<jeton>.pdf : route suivante
  await envoyerPage(res, "devis", "/devis/" + encodeURIComponent(req.params.jeton), { noindex: true });
}));
// Lien public du devis (non devinable) : utilisé pour le partage WhatsApp
app.get("/devis/:jeton.pdf", limiteur(60, 10 * 60e3), enveloppe(async (req, res) => {
  const d = await un(`select ${VUE_DEVIS} from devis where jeton=$1`, [String(req.params.jeton || "")]);
  if (!d) throw err(404, "INTROUVABLE", "Devis introuvable.");
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${nomPdf(d)}"`, "Cache-Control": "private, no-store" }).send(await genererPdf(d));
}));
// llms.txt : mêmes tarifs que l'administration. index.html brut (avec repères) n'est jamais servi.
app.get("/llms.txt", enveloppe(async (_req, res) => {
  const { tarifs } = await parametres();
  res.set({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" }).send(remplacerTarifs(readFileSync(path.join(DOSSIER_PUBLIC, "llms.txt"), "utf8"), tarifs));
}));
app.get("/index.html", (_req, res) => res.redirect(301, "/"));
app.use(express.static(DOSSIER_PUBLIC, { index: false, maxAge: "5m" }));
app.use("/api", (_req, _res, next) => next(err(404, "INTROUVABLE", "Route inconnue.")));
// Adresse inconnue : page d'accueil avec le statut 404 (non indexée)
app.use(enveloppe(async (req, res, next) => {
  if (req.method !== "GET" || /\.[a-z0-9]{2,5}$/i.test(req.path) || !req.accepts("html")) return next();
  await envoyerPage(res, "accueil", "/", { statut: 404, noindex: true });
}));

/* ---------- Erreurs ---------- */
app.use((e, _req, res, _next) => {
  if (e instanceof multer.MulterError) {
    const m = e.code === "LIMIT_FILE_SIZE" ? "Un fichier dépasse 60 Mo. Réduisez la vidéo ou envoyez-la sur WhatsApp." : "Trop de fichiers ou de champs envoyés.";
    return res.status(413).json({ error: { code: e.code, message: m } });
  }
  if (e instanceof ErreurApi) return res.status(e.statut).json({ error: { code: e.code, message: e.message } });
  console.error(e);
  res.status(500).json({ error: { code: "SERVEUR", message: "Une erreur est survenue. Réessayez ou écrivez-nous sur WhatsApp." } });
});

if (!existsSync(DOSSIER_PUBLIC)) console.warn("Dossier public introuvable :", DOSSIER_PUBLIC);
await migrer();
/* Anti-veille : le serveur s'appelle lui-même par son adresse publique toutes les 5 minutes (plan Render gratuit : arrêt après 15 min sans visite).
   Désactiver avec KEEP_ALIVE=false. KEEP_ALIVE_URL force une autre adresse, KEEP_ALIVE_MINUTES change l'intervalle. */
const URL_PING = (process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || PUBLIC_URL).replace(/\/$/, "") + "/sante";
if (process.env.KEEP_ALIVE !== "false" && (process.env.KEEP_ALIVE_URL || /^https:\/\//.test(URL_PING))) {
  const intervalle = Math.max(0.02, Number(process.env.KEEP_ALIVE_MINUTES) || 5) * 60e3;
  setInterval(async () => {
    try {
      const r = await fetch(URL_PING, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "EliteAutoDeal-KeepAlive" } });
      await q("select 1"); // garde aussi la connexion à la base active
      if (process.env.KEEP_ALIVE_VERBOSE === "true") console.log(`[keep-alive] ${URL_PING} -> ${r.status}`);
      if (!r.ok) console.warn(`[keep-alive] réponse ${r.status} de ${URL_PING}`);
    } catch (e) { console.warn("[keep-alive] échec :", e.message); }
  }, intervalle);
}
app.listen(PORT, () => console.log(`Elite Auto Deal sur ${PUBLIC_URL} (paiement : ${fredaConfiguree() ? modeFreda() : "non configuré"})`));
