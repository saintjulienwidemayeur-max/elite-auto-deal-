// Photos des véhicules en 4:5 (1080 x 1350), vidéos de tout format, lecture par morceaux (Range), mises à jour immédiates
import assert from "node:assert/strict";
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const B = "http://localhost:3000"; let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const tok = (await (await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "motdepasse-test" }) })).json()).token;
const A = (u, o = {}) => fetch(B + u, { ...o, headers: { Authorization: "Bearer " + tok, ...(o.body && !(o.body instanceof FormData) ? { "Content-Type": "application/json" } : {}) } });
const vehicule = (await (await fetch(B + "/api/vehicules")).json()).find(v => v.statut === "disponible"); const VID = vehicule.id;
const img = (w, h, fmt = "jpeg", fond = "#c33") => sharp({ create: { width: w, height: h, channels: 3, background: fond } })[fmt]().toBuffer();
const envoyer = async (champ, fichiers) => { const f = new FormData(); for (const [nom, buf, type] of fichiers) f.append(champ, new File([buf], nom, { type })); return A(`/api/admin/vehicules/${VID}/${champ}`, { method: "POST", body: f }); };
const dims = async url => { const r = await fetch(B + url); const b = Buffer.from(await r.arrayBuffer()); const m = await sharp(b).metadata(); return { ct: r.headers.get("content-type"), w: m.width, h: m.height, f: m.format }; };
await t("toute photo est ramenée à 1080 x 1350 (4:5), en WebP : paysage, portrait 4:5 et petit carré", async () => {
  const r = await envoyer("photos", [["paysage.jpg", await img(1600, 900), "image/jpeg"], ["portrait.png", await img(1000, 1250, "png"), "image/png"], ["carre.jpg", await img(300, 300), "image/jpeg"]]);
  const v = await r.json(); assert.equal(r.status, 201, JSON.stringify(v)); const nouvelles = v.photos.slice(-3);
  for (const p of nouvelles) assert.deepEqual(await dims(p.url), { ct: "image/webp", w: 1080, h: 1350, f: "webp" });
});
await t("la photo paysage n'est ni déformée ni coupée : l'image entière est au centre sur un fond flou", async () => {
  const v = await (await A(`/api/admin/vehicules`)).json(); const p = v.find(x => x.id === VID).photos.at(-3);
  const buf = Buffer.from(await (await fetch(B + p.url)).arrayBuffer()); const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
  const milieu = px(540, 675), haut = px(540, 5); assert.ok(milieu[0] > 150 && milieu[1] < 90, "centre = photo rouge"); assert.ok(haut[0] > 100, "haut : fond flou de la même photo");
});
await t("fichier qui n'est pas une image : refusé (400), rien n'est enregistré", async () => {
  const avant = (await (await fetch(B + "/api/vehicules")).json()).find(v => v.id === VID).photos.length;
  assert.equal((await envoyer("photos", [["faux.jpg", Buffer.from("pas une image du tout"), "image/jpeg"]])).status, 400);
  assert.equal((await (await fetch(B + "/api/vehicules")).json()).find(v => v.id === VID).photos.length, avant);
});
let ffmpeg = true; try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { ffmpeg = false; }
const dossier = mkdtempSync(path.join(os.tmpdir(), "vid-")); const videos = {};
if (ffmpeg) for (const [nom, taille] of [["vertical", "360x640"], ["horizontal", "640x360"], ["carree", "360x360"]]) { const f = path.join(dossier, nom + ".mp4"); execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `testsrc=size=${taille}:rate=10:duration=1`, "-pix_fmt", "yuv420p", "-movflags", "+faststart", f], { stdio: "ignore" }); videos[nom] = readFileSync(f); }
await t(ffmpeg ? "vidéos verticale, horizontale et carrée acceptées (format libre)" : "vidéos : ffmpeg absent, test ignoré", async () => {
  if (!ffmpeg) return;
  const avant = (await (await fetch(B + "/api/vehicules")).json()).find(x => x.id === VID).videos.length;
  const r = await envoyer("videos", Object.entries(videos).map(([n, b]) => [n + ".mp4", b, "video/mp4"])); const v = await r.json(); assert.equal(r.status, 201, JSON.stringify(v)); assert.equal(v.videos.length, avant + 3);
  const pub = (await (await fetch(B + "/api/vehicules")).json()).find(x => x.id === VID); assert.equal(pub.videos.length, avant + 3); assert.match(pub.videos[0], /^\/api\/videos\/\d+$/);
});
await t(ffmpeg ? "lecture par morceaux (Range) : 206 avec Content-Range, 416 si hors limites, tout le fichier sinon" : "range : ignoré", async () => {
  if (!ffmpeg) return;
  const url = (await (await fetch(B + "/api/vehicules")).json()).find(x => x.id === VID).videos[0];
  const plein = await fetch(B + url); assert.equal(plein.status, 200); assert.equal(plein.headers.get("accept-ranges"), "bytes"); assert.equal(plein.headers.get("content-type"), "video/mp4"); const total = Buffer.from(await plein.arrayBuffer()).length;
  const part = await fetch(B + url, { headers: { Range: "bytes=0-99" } }); assert.equal(part.status, 206); assert.equal(part.headers.get("content-range"), `bytes 0-99/${total}`); assert.equal(Buffer.from(await part.arrayBuffer()).length, 100);
  const fin = await fetch(B + url, { headers: { Range: "bytes=-50" } }); assert.equal(fin.status, 206); assert.equal(Buffer.from(await fin.arrayBuffer()).length, 50);
  assert.equal((await fetch(B + url, { headers: { Range: `bytes=${total + 10}-` } })).status, 416);
});
await t("format de vidéo non accepté refusé ; suppression d'une vidéo", async () => {
  assert.equal((await envoyer("videos", [["x.avi", Buffer.from("x"), "video/x-msvideo"]])).status, 400);
  if (!ffmpeg) return;
  const admin = (await (await A("/api/admin/vehicules")).json()).find(x => x.id === VID); const id = admin.videos[0].id;
  assert.equal((await A(`/api/admin/vehicules/${VID}/videos/${id}`, { method: "DELETE" })).status, 200); assert.equal((await fetch(B + `/api/videos/${id}`)).status, 404);
});
await t("modifications de l'administration visibles tout de suite : aucune réponse de l'API n'est mise en cache", async () => {
  for (const u of ["/api/vehicules", "/api/vitrine", "/api/config"]) { const c = (await fetch(B + u)).headers.get("cache-control") || ""; assert.match(c, /no-cache/, u); assert.ok(!/max-age=[1-9]/.test(c), u + " : " + c); }
  const html = await fetch(B + "/"); assert.match(html.headers.get("cache-control"), /max-age=0/); assert.match(html.headers.get("cache-control"), /must-revalidate/);
  const a = await (await fetch(B + "/api/vehicules")).json(); const prix = a.find(v => v.id === VID).prix;
  assert.equal((await A(`/api/admin/vehicules/${VID}`, { method: "PATCH", body: JSON.stringify({ prix: prix + 111 }) })).status, 200);
  assert.equal((await (await fetch(B + "/api/vehicules")).json()).find(v => v.id === VID).prix, prix + 111, "prix modifié visible immédiatement");
  await A(`/api/admin/vehicules/${VID}`, { method: "PATCH", body: JSON.stringify({ prix }) });
});
console.log(`${ok} scénarios médias OK`);
