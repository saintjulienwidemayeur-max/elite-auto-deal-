// Stockage des photos, vidéos et documents envoyés par les clients.
// Supabase Storage (bucket privé) si SUPABASE_URL + SUPABASE_SERVICE_KEY, sinon disque local (UPLOAD_DIR).
import { mkdir, rename, readFile, unlink, copyFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const BUCKET = process.env.SUPABASE_BUCKET || "dossiers";
export const DOSSIER_LOCAL = path.resolve(process.env.UPLOAD_DIR || "./uploads");
export const modeStockage = () => (SB_URL && SB_KEY ? "supabase" : "local");

const propre = n => n.normalize("NFKD").replace(/[^\w.\-]+/g, "_").slice(-80);

export async function enregistrer(fichierTemp, ref, nomOrigine, type) {
  const chemin = `${ref}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${propre(nomOrigine)}`;
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

export async function supprimer(f) {
  if (f.stockage === "supabase") {
    await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${f.chemin}`, { method: "DELETE", headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY } }).catch(() => {});
  } else await unlink(path.join(DOSSIER_LOCAL, f.chemin)).catch(() => {});
}
