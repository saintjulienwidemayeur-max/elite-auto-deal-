// MonCash et Natcash sont envoyés séparément à Freda (serveur :3000, faux Freda :4555)
import assert from "node:assert/strict";
const B = "http://localhost:3000", F = "http://localhost:4555";
const fd = o => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const tok = (await (await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "motdepasse-test" }) })).json()).token;
const base = { service: "consultation", client_nom: "Moyen Test", client_tel: "+509 3700 0000", conditions_acceptees: "1" };
const cote = async ref => { // méthode reçue par Freda pour ce dossier
  const p = (await (await fetch(B + "/api/admin/paiements", { headers: { Authorization: "Bearer " + tok } })).json()).find(x => x.ref === ref);
  const r = await (await fetch(`${F}/v1/payments/${p.freda_id}`, { headers: { Authorization: "Bearer sk_test_local" } })).json();
  return { freda: r.method, base: p.methode, devise: r.currency };
};
await t("config : moncash, natcash et carte séparés", async () => {
  const c = await (await fetch(B + "/api/config")).json(); assert.deepEqual(c.methodes.slice(0, 2), ["moncash", "natcash"]);
});
for (const m of ["moncash", "natcash"]) await t(`${m} => Freda reçoit "${m}" en HTG`, async () => {
  const r = await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, methode: m }) }); const b = await r.json();
  assert.equal(r.status, 201, JSON.stringify(b)); assert.deepEqual(await cote(b.ref), { freda: m, base: m, devise: "HTG" });
});
await t("visite ou essai : 30 $ x 132 = 3960 HTG ; consultation : 50 $ = 6600 HTG", async () => {
  const dispo = (await (await fetch(B + "/api/vehicules")).json()).find(v => v.statut === "disponible");
  const e = await (await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "essai", methode: "natcash", vehicule_id: dispo.id }) })).json(); assert.equal(e.montant_usd, 30); assert.equal(e.montant, 3960);
  const c = await (await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "consultation", methode: "moncash" }) })).json(); assert.equal(c.montant_usd, 50); assert.equal(c.montant, 6600);
});
await t("visite ou essai : seulement un véhicule de l'inventaire, disponible en Haïti", async () => {
  const l = await (await fetch(B + "/api/vehicules")).json(); const transit = l.find(v => v.statut === "transit");
  assert.equal((await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "essai", methode: "moncash" }) })).status, 400, "sans véhicule");
  assert.equal((await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "essai", methode: "moncash", vehicule_id: "autre" }) })).status, 400, "véhicule « autre »");
  assert.equal((await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "essai", methode: "moncash", vehicule_id: transit.id }) })).status, 409, "véhicule en transit");
});
await t("« mobile », « all » ou vide refusés", async () => {
  for (const m of ["mobile", "all", ""]) assert.equal((await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, methode: m }) })).status, 400);
});
console.log(`${ok} scénarios moyens de paiement OK`);
