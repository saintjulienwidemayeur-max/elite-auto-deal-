// Vitrine du site (diapositives gérées dans l'admin) et véhicules en promo
import assert from "node:assert/strict";
const B = "http://localhost:3000"; let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const tok = (await (await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "motdepasse-test" }) })).json()).token;
const A = (u, o = {}) => fetch(B + u, { ...o, headers: { Authorization: "Bearer " + tok, ...(o.body && !(o.body instanceof FormData) ? { "Content-Type": "application/json" } : {}) } });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const form = (o, img = true) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, String(v)); if (img) f.append("image", new File([PNG], "voiture.png", { type: "image/png" })); return f; };
let pub, nouvelle;
await t("diapositives d'origine chargées en base : 8 modèles dans l'ordre, images servies avec cache long", async () => {
  pub = await (await fetch(B + "/api/vitrine")).json(); assert.equal(pub.length, 8); assert.equal(pub[0].id, "mercedes-gle-coupe"); assert.equal(pub.at(-1).id, "jetour-x70");
  const r = await fetch(B + pub[0].image); assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/webp"); assert.match(r.headers.get("cache-control"), /immutable/); assert.ok((await r.arrayBuffer()).byteLength > 5000);
});
await t("les diapositives sont injectées dans le HTML (pas d'appel réseau en plus) et plus d'images embarquées", async () => {
  const h = await (await fetch(B + "/")).text(); const m = h.match(/window\.__VITRINE__=(\[.*?\]);<\/script>/s); assert.ok(m); assert.equal(JSON.parse(m[1]).length, 8); assert.ok(h.length < 300 * 1024, "page légère : " + h.length);
});
await t("admin : ajout d'une diapositive avec image, en dernier ; sans image ni véhicule => refusé", async () => {
  assert.equal((await fetch(B + "/api/admin/vitrine")).status, 401);
  assert.equal((await A("/api/admin/vitrine", { method: "POST", body: form({ marque: "Kia", modele: "Sportage" }, false) })).status, 400);
  const r = await A("/api/admin/vitrine", { method: "POST", body: form({ marque: "Kia", modele: "Sportage", filigrane: "KIA", accroche: "SUV moderne", promo: true, promo_texte: "-10 %" }) }); nouvelle = await r.json();
  assert.equal(r.status, 201, JSON.stringify(nouvelle)); assert.equal(nouvelle.promo, true); assert.equal(nouvelle.promo_texte, "-10 %");
  const l = await (await fetch(B + "/api/vitrine")).json(); assert.equal(l.length, 9); assert.equal(l.at(-1).id, nouvelle.id);
  assert.equal((await fetch(B + l.at(-1).image)).headers.get("content-type"), "image/png");
});
await t("admin : monter, masquer (disparaît du site), réafficher, modifier, supprimer", async () => {
  let l = await (await A(`/api/admin/vitrine/${nouvelle.id}/deplacer`, { method: "POST", body: JSON.stringify({ sens: -1 }) })).json(); assert.equal(l.findIndex(x => x.id === nouvelle.id), 7);
  assert.equal((await A(`/api/admin/vitrine/${nouvelle.id}`, { method: "PATCH", body: form({ marque: "Kia", modele: "Sportage", actif: false }, false) })).status, 200);
  assert.ok(!(await (await fetch(B + "/api/vitrine")).json()).some(x => x.id === nouvelle.id), "masquée");
  assert.ok((await (await A("/api/admin/vitrine")).json()).some(x => x.id === nouvelle.id && x.actif === false), "toujours visible dans l'admin");
  const m = await (await A(`/api/admin/vitrine/${nouvelle.id}`, { method: "PATCH", body: form({ marque: "Kia", modele: "Sportage GT", accroche: "Nouveau texte", actif: true }, false) })).json(); assert.equal(m.modele, "Sportage GT");
  assert.equal((await A(`/api/admin/vitrine/${nouvelle.id}`, { method: "DELETE" })).status, 200); assert.equal((await A(`/api/admin/vitrine/${nouvelle.id}`, { method: "DELETE" })).status, 404);
});
let veh;
await t("véhicule en promo : prix promo < prix normal, prix barré côté public, prix réel côté admin", async () => {
  const l = await (await fetch(B + "/api/vehicules")).json(); veh = l.find(v => v.statut === "disponible" && v.prix > 1000); assert.ok(veh);
  const promo = Math.round(veh.prix * 0.9);
  assert.equal((await A(`/api/admin/vehicules/${veh.id}`, { method: "PATCH", body: JSON.stringify({ prix_promo: veh.prix + 1 }) })).status, 400, "promo >= prix refusée");
  const r = await A(`/api/admin/vehicules/${veh.id}`, { method: "PATCH", body: JSON.stringify({ prix_promo: promo }) }); const a = await r.json(); assert.equal(r.status, 200, JSON.stringify(a)); assert.equal(a.prix, veh.prix); assert.equal(Number(a.prix_promo), promo);
  const p = (await (await fetch(B + "/api/vehicules")).json()).find(v => v.id === veh.id); assert.equal(p.prix, promo); assert.equal(p.prix_normal, veh.prix);
  veh.promo = promo;
});
await t("le client paie le prix promo (achat comptant, MonCash en gourdes)", async () => {
  const f = form({ service: "achat", methode: "moncash", vehicule_id: veh.id, client_nom: "Promo Test", client_tel: "+509 3700 2222", conditions_acceptees: "1" }, false);
  const r = await fetch(B + "/api/dossiers", { method: "POST", body: f }); const d = await r.json(); assert.equal(r.status, 201, JSON.stringify(d)); assert.equal(d.montant_usd, veh.promo); assert.equal(d.montant, Math.round(veh.promo * 132));
});
await t("diapositive liée à un véhicule en promo : badge promo, prix barré, photo du véhicule ou image perso", async () => {
  const r = await A("/api/admin/vitrine", { method: "POST", body: form({ marque: "Promo", modele: "Liée", vehicule_id: veh.id, promo: false }) }); const s = await r.json(); assert.equal(r.status, 201, JSON.stringify(s));
  const l = (await (await fetch(B + "/api/vitrine")).json()).find(x => x.id === s.id); assert.equal(l.promo, true, "promo auto : le véhicule a un prix promo"); assert.equal(l.prix, veh.promo); assert.equal(l.prix_normal, veh.prix); assert.equal(l.vehicule_id, veh.id);
  await A(`/api/admin/vitrine/${s.id}`, { method: "DELETE" });
});
await t("retirer le prix promo (0 ou vide) : retour au prix normal", async () => {
  const a = await (await A(`/api/admin/vehicules/${veh.id}`, { method: "PATCH", body: JSON.stringify({ prix_promo: "" }) })).json(); assert.equal(a.prix_promo, null);
  const p = (await (await fetch(B + "/api/vehicules")).json()).find(v => v.id === veh.id); assert.equal(p.prix, veh.prix); assert.equal(p.prix_normal, null);
});
console.log(`${ok} scénarios vitrine OK`);
