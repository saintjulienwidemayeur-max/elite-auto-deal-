// Stockage des photos, vidéos et documents envoyés par les clients.
// Supabase Storage (bucket privé) si SUPABASE_URL + SUPABASE_SERVICE_KEY, sinon disque local (UPLOAD_DIR).
import { mkdir, rename, readFile, unlink, copyFile, stat as statFichier } from "node:fs/promises";
import { q, un } from "./db.js";
import { createReadStream } from "node:fs";
import path from "node:path";

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const BUCKET = process.env.SUPABASE_BUCKET || "dossiers";
export const DOSSIER_LOCAL = path.resolve(process.env.UPLOAD_DIR || "./uploads");
export const modeStockage = () => (SB_URL && SB_KEY ? "supabase" : "local");
/** Photos de véhicules : sans Supabase ni disque persistant (UPLOAD_DIR), le disque de Render est effacé à chaque redémarrage : on les garde dans la base. */
export const photosEnBase = () => modeStockage() === "local" && !process.env.UPLOAD_DIR;
const MAX_BASE = 15 * 1024 * 1024; // au-delà, un fichier garde le disque local (perdu au redémarrage) : configurez Supabase Storage
const idBlob = f => (/^blob:(\d+)$/.exec(f.chemin || "") || [])[1];
const lireBlob = async f => (await un("select donnees from blobs where id=$1", [idBlob(f)]))?.donnees || null;

const propre = n => n.normalize("NFKD").replace(/[^\w.\-]+/g, "_").slice(-80);

export async function enregistrer(fichierTemp, ref, nomOrigine, type) {
  const chemin = `${ref}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${propre(nomOrigine)}`;
  if (photosEnBase() && (await statFichier(fichierTemp)).size <= MAX_BASE) { // pas de stockage durable : on garde le fichier dans Postgres
    const b = await un("insert into blobs(donnees) values ($1) returning id", [await readFile(fichierTemp)]);
    await unlink(fichierTemp).catch(() => {});
    return { stockage: "db", chemin: `blob:${b.id}` };
  }
  if (modeStockage() === "supabase") {
    const corps = await readFile(fichierTemp);
    const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${chemin}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY, "Content-Type": type || "application/octet-stream", "x-upsert": "false" },
      body: corps,
    });
    await unlink(fichierTemp).catch(() => {});
    if (!r.ok) throw new Error(`Stockage Supabase : ${r.status} ${await r.text()}`);
    return { stockage: "supabase", chemin };
  }
  const dest = path.join(DOSSIER_LOCAL, chemin);
  await mkdir(path.dirname(dest), { recursive: true });
  try { await rename(fichierTemp, dest); } catch { await copyFile(fichierTemp, dest); await unlink(fichierTemp).catch(() => {}); }
  return { stockage: "local", chemin };
}

/** Envoie le fichier dans la réponse HTTP (lien signé de 5 min pour Supabase). */
export async function servir(f, res) {
  if (f.stockage === "db") {
    const d = await lireBlob(f);
    if (!d) return res.status(404).json({ error: { code: "INTROUVABLE", message: "Fichier introuvable." } });
    res.setHeader("Content-Type", f.type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${propre(f.nom || "fichier")}"`);
    return res.end(d);
  }
  if (f.stockage === "supabase") {
    const r = await fetch(`${SB_URL}/storage/v1/object/sign/${BUCKET}/${f.chemin}`, {
      method: "POST", headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 300 }),
    });
    const j = await r.json();
    if (!r.ok || !j.signedURL) return res.status(502).json({ error: { code: "STOCKAGE", message: "Fichier indisponible pour le moment." } });
    return res.redirect(`${SB_URL}/storage/v1${j.signedURL}`);
  }
  const p = path.join(DOSSIER_LOCAL, f.chemin);
  if (!p.startsWith(DOSSIER_LOCAL)) return res.status(400).end();
  res.setHeader("Content-Type", f.type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${propre(f.nom)}"`);
  createReadStream(p).on("error", () => res.status(404).end()).pipe(res);
}

/** Sert une image publique (photos de véhicules) en flux, avec cache. */
export async function servirPublic(f, res) {
  res.setHeader("Cache-Control", "public, max-age=86400");
  if (f.stockage === "db") {
    const d = f.donnees || (idBlob(f) ? await lireBlob(f) : null);
    if (!d) return res.status(404).end();
    res.setHeader("Content-Type", f.type || "image/webp");
    return res.end(d);
  }
  if (f.stockage === "supabase") {
    const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${f.chemin}`, { headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY } });
    if (!r.ok) return res.status(404).end();
    res.setHeader("Content-Type", f.type || r.headers.get("content-type") || "image/jpeg");
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const p = path.join(DOSSIER_LOCAL, f.chemin);
  if (!p.startsWith(DOSSIER_LOCAL)) return res.status(400).end();
  res.setHeader("Content-Type", f.type || "image/jpeg");
  createReadStream(p).on("error", () => res.status(404).end()).pipe(res);
}

/** Vidéos : même chose avec les requêtes Range (lecture progressive, avance rapide). */
export async function servirPublicRange(f, req, res) {
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=86400");
  const type = f.type || "video/mp4";
  if (f.stockage === "db") {
    const d = await lireBlob(f);
    if (!d) return res.status(404).end();
    res.setHeader("Content-Type", type);
    const taille = d.length, m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (!m) { res.setHeader("Content-Length", taille); return res.end(d); }
    const debut = m[1] === "" ? Math.max(0, taille - Number(m[2])) : Number(m[1]), fin = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), taille - 1) : taille - 1;
    if (debut > fin || debut >= taille) { res.setHeader("Content-Range", `bytes */${taille}`); return res.status(416).end(); }
    res.status(206); res.setHeader("Content-Range", `bytes ${debut}-${fin}/${taille}`); res.setHeader("Content-Length", fin - debut + 1);
    return res.end(d.subarray(debut, fin + 1));
  }
  if (f.stockage === "supabase") {
    const h = { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY }; if (req.headers.range) h.Range = req.headers.range;
    const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${f.chemin}`, { headers: h });
    if (!r.ok && r.status !== 206) return res.status(r.status === 416 ? 416 : 404).end();
    res.status(r.status); res.setHeader("Content-Type", type);
    for (const k of ["content-length", "content-range"]) if (r.headers.get(k)) res.setHeader(k, r.headers.get(k));
    const { Readable } = await import("node:stream"); return Readable.fromWeb(r.body).pipe(res);
  }
  const p = path.join(DOSSIER_LOCAL, f.chemin);
  if (!p.startsWith(DOSSIER_LOCAL)) return res.status(400).end();
  const { stat } = await import("node:fs/promises");
  let taille; try { taille = (await stat(p)).size; } catch { return res.status(404).end(); }
  res.setHeader("Content-Type", type);
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (!m) { res.setHeader("Content-Length", taille); return createReadStream(p).pipe(res); }
  let debut = m[1] === "" ? Math.max(0, taille - Number(m[2])) : Number(m[1]); const fin = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), taille - 1) : taille - 1;
  if (debut > fin || debut >= taille) { res.setHeader("Content-Range", `bytes */${taille}`); return res.status(416).end(); }
  res.status(206); res.setHeader("Content-Range", `bytes ${debut}-${fin}/${taille}`); res.setHeader("Content-Length", fin - debut + 1);
  createReadStream(p, { start: debut, end: fin }).pipe(res);
}

export async function supprimer(f) {
  if (f.stockage === "db") { if (idBlob(f)) await q("delete from blobs where id=$1", [idBlob(f)]).catch(() => {}); return; }
  if (f.stockage === "supabase") {
    await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${f.chemin}`, { method: "DELETE", headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY } }).catch(() => {});
  } else await unlink(path.join(DOSSIER_LOCAL, f.chemin)).catch(() => {});
}
