import pg from "pg";
import { readFileSync } from "node:fs";
import { PARAMETRES_DEFAUT, VEHICULES_INITIAUX, COLS_VEHICULE, VITRINE_INITIALE } from "./catalogue.js";

pg.types.setTypeParser(1700, v => (v == null ? null : Number(v))); // numeric -> number
pg.types.setTypeParser(20, v => (v == null ? null : Number(v)));   // bigint -> number

const ssl = /sslmode=disable|localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "") ? false : { rejectUnauthorized: false };
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 10 });

export const q = (text, params) => pool.query(text, params);
export const un = async (text, params) => (await pool.query(text, params)).rows[0] || null;
export const tous = async (text, params) => (await pool.query(text, params)).rows;

export async function transaction(fn) {
  const c = await pool.connect();
  try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback"); throw e; }
  finally { c.release(); }
}

export async function migrer() {
  await q(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  for (const [cle, valeur] of Object.entries(PARAMETRES_DEFAUT))
    await q("insert into parametres(cle, valeur) values ($1,$2) on conflict (cle) do nothing", [cle, JSON.stringify(valeur)]);
  // Vitrine : première installation = les diapositives d'origine (images lues dans sources/photos/vitrine.json)
  if (!(await un("select 1 from vitrine limit 1"))) {
    let images = {}; try { images = JSON.parse(readFileSync(new URL("../sources/photos/vitrine.json", import.meta.url), "utf8")); } catch { /* sans images : la vitrine reste vide */ }
    let ordre = 0;
    for (const [id, marque, modele, filigrane, accroche] of VITRINE_INITIALE) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(images[id] || ""); if (!m) continue;
      await q("insert into vitrine(id, marque, modele, filigrane, accroche, ordre, image, image_type) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing", [id, marque, modele, filigrane, accroche, ordre++, Buffer.from(m[2], "base64"), m[1]]);
    }
  }
  // Nouveaux frais de service (50 $ au lieu de 150 $) : appliqués une seule fois aux bases existantes qui avaient encore l'ancien tarif
  if (!(await un("select 1 from parametres where cle='migration_tarifs_50'"))) {
    const t = await un("select valeur from parametres where cle='tarifs'");
    if (t) { const v = t.valeur; let change = false; for (const k of ["consultation", "recherche", "essai"]) if (Number(v[k]) === 150) { v[k] = 50; change = true; }
      if (change) await q("update parametres set valeur=$1 where cle='tarifs'", [JSON.stringify(v)]); }
    await q("insert into parametres(cle, valeur) values ('migration_tarifs_50', 'true') on conflict (cle) do nothing");
  }
  // Visite ou essai : 30 $ (appliqué une seule fois aux bases qui avaient encore 50 $)
  if (!(await un("select 1 from parametres where cle='migration_essai_30'"))) {
    const t = await un("select valeur from parametres where cle='tarifs'");
    if (t && Number(t.valeur.essai) === 50) { t.valeur.essai = 30; await q("update parametres set valeur=$1 where cle='tarifs'", [JSON.stringify(t.valeur)]); }
    await q("insert into parametres(cle, valeur) values ('migration_essai_30', 'true') on conflict (cle) do nothing");
  }
  // Recherche : 30 $ de frais de dossier (au lieu de 50 $), appliqué une seule fois aux bases existantes
  if (!(await un("select 1 from parametres where cle='migration_recherche_30'"))) {
    const t = await un("select valeur from parametres where cle='tarifs'");
    if (t) { const v = t.valeur; if (Number(v.recherche) === 50) v.recherche = 30; if (v.service_recherche == null) v.service_recherche = 150; await q("update parametres set valeur=$1 where cle='tarifs'", [JSON.stringify(v)]); }
    await q("insert into parametres(cle, valeur) values ('migration_recherche_30', 'true') on conflict (cle) do nothing");
  }
  const { n } = await un("select count(*)::int n from vehicules");
  if (n === 0) {
    const ph = COLS_VEHICULE.map((_, i) => "$" + (i + 1)).join(",");
    for (const v of VEHICULES_INITIAUX) await q(`insert into vehicules(${COLS_VEHICULE.join(",")}) values (${ph})`, v);
  }
}

export async function parametres() {
  const rows = await tous("select cle, valeur from parametres");
  const p = Object.fromEntries(rows.map(r => [r.cle, r.valeur]));
  return { ...PARAMETRES_DEFAUT, ...p, tarifs: { ...PARAMETRES_DEFAUT.tarifs, ...(p.tarifs || {}) }, messages: { ...PARAMETRES_DEFAUT.messages, ...(p.messages || {}) }, banque: { ...PARAMETRES_DEFAUT.banque, ...(p.banque || {}) } };
}

export const journaliser = (ref, texte, type = "info", par = "système") =>
  q("insert into journal(ref, texte, type, par) values ($1,$2,$3,$4)", [ref, texte, type, par]);
