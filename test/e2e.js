// Test de bout en bout (serveur sur :3000, faux Freda sur :4555)
import crypto from "node:crypto";
import assert from "node:assert/strict";
const B = "http://localhost:3000", F = "http://localhost:4555", H = { Authorization: "Bearer sk_test_local" };
const j = async (r) => ({ s: r.status, b: await r.json().catch(() => null) });
let ok = 0; const t = async (nom, fn) => { await fn(); ok++; console.log("ok -", nom); };

const fd = (o, fichiers = []) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); for (const x of fichiers) f.append("fichiers", x); return f; };
const base = { client_nom: "Jean Test", client_tel: "+509 3700 0000", conditions_acceptees: "1", donnees: JSON.stringify({ lignes: [["Marque", "Toyota"]], champs: { marque: "Toyota", modele: "Corolla" } }) };

let refR, payR, refP, payP, token;
await t("recherche mobile : montant serveur 30 $ (frais de dossier) x 132 = 3960 HTG", async () => {
  const r = await j(await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "recherche", methode: "moncash", montant: "1" }) }));
  assert.equal(r.s, 201, JSON.stringify(r.b)); assert.equal(r.b.montant, 3960); assert.equal(r.b.devise, "HTG"); assert.match(r.b.checkout_url, /^https:/);
  refR = r.b.ref; payR = r.b.paiement_id;
});
await t("conditions obligatoires", async () => {
  const r = await j(await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, conditions_acceptees: "0", service: "consultation", methode: "moncash" }) }));
  assert.equal(r.s, 400); assert.equal(r.b.error.code, "CONDITIONS");
});
await t("carte sans email refusée", async () => {
  const r = await j(await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "consultation", methode: "carte" }) }));
  assert.equal(r.s, 400); assert.equal(r.b.error.code, "EMAIL");
});
await t("type de fichier refusé", async () => {
  const r = await j(await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "vendre", methode: "moncash" }, [new File(["x"], "a.exe", { type: "application/x-msdownload" })]) }));
  assert.equal(r.s, 400); assert.equal(r.b.error.code, "FICHIER");
});
await t("vente avec photo, carte USD 200", async () => {
  const r = await j(await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "vendre", methode: "carte", client_email: "a@b.co" }, [new File([crypto.randomBytes(1000)], "photo.jpg", { type: "image/jpeg" })]) }));
  assert.equal(r.s, 201, JSON.stringify(r.b)); assert.equal(r.b.montant, 200); assert.equal(r.b.devise, "USD");
});
await t("précommande RAV4 : 90 % = 20250 $", async () => {
  const r = await j(await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "precommande", vehicule_id: "rav16", methode: "carte", client_email: "a@b.co" }) }));
  assert.equal(r.s, 201, JSON.stringify(r.b)); assert.equal(r.b.montant_usd, 20250); refP = r.b.ref; payP = r.b.paiement_id;
});
await t("achat d'un véhicule précommandable refusé", async () => {
  const r = await j(await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "achat", vehicule_id: "rav16", methode: "moncash" }) }));
  assert.equal(r.s, 409);
});
await t("suivi : en attente, pas de données perso", async () => {
  const r = await j(await fetch(B + "/api/dossiers/" + refR));
  assert.equal(r.b.paiement.statut, "pending"); assert.equal(r.b.prenom, "Jean"); assert.equal(r.b.client_tel, undefined);
});
await t("webhook signature invalide => 401", async () => {
  const r = await fetch(B + "/webhooks/freda", { method: "POST", headers: { "X-Freda-Signature": "sha256=00" }, body: "{}" });
  assert.equal(r.status, 401);
});
await t("webhook payment.succeeded signé => dossier à traiter", async () => {
  const corps = JSON.stringify({ id: "evt_1", event: "payment.succeeded", created_at: new Date().toISOString(), data: { id: payR, reference: refR + "-P1", amount: 3960, currency: "HTG", net_amount: 3802 } });
  const sig = "sha256=" + crypto.createHmac("sha256", "whsec_test").update(corps).digest("hex");
  for (let i = 0; i < 2; i++) { const r = await fetch(B + "/webhooks/freda", { method: "POST", headers: { "X-Freda-Signature": sig, "Content-Type": "application/json" }, body: corps }); assert.equal(r.status, 200); }
  await new Promise(r => setTimeout(r, 300));
  const r = await j(await fetch(B + "/api/dossiers/" + refR));
  assert.equal(r.b.paiement.statut, "succeeded"); assert.equal(r.b.etape, 1);
});
await t("vérification par interrogation (sans webhook) : précommande payée, véhicule vendu", async () => {
  await fetch(`${F}/_set/${payP}/succeeded`, { headers: H });
  const r = await j(await fetch(B + "/api/dossiers/" + refP));
  assert.equal(r.b.paiement.statut, "succeeded"); assert.equal(r.b.solde_usd, 2250);
  const v = (await (await fetch(B + "/api/vehicules")).json()).find(x => x.id === "rav16"); assert.equal(v.statut, "vendu");
});
await t("admin : mauvais mot de passe puis connexion", async () => {
  assert.equal((await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "x" }) })).status, 401);
  assert.equal((await fetch(B + "/api/admin/resume")).status, 401);
  token = (await (await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "motdepasse-test" }) })).json()).token;
});
const A = (u, o = {}) => fetch(B + u, { ...o, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(o.headers || {}) } }).then(j);
await t("admin : résumé, dossiers, paiements, fichiers", async () => {
  const r = await A("/api/admin/resume"); assert.equal(r.s, 200); assert.ok(r.b.paiements_mois_usd >= 20250 + 30);
  const ds = (await A("/api/admin/dossiers")).b; assert.ok(ds.length >= 3);
  const vente = ds.find(d => d.service === "vendre"); const det = (await A("/api/admin/dossiers/" + vente.ref)).b;
  assert.equal(det.fichiers.length, 1); const f = await fetch(B + det.fichiers[0].url, { headers: { Authorization: "Bearer " + token } }); assert.equal(f.status, 200);
  assert.equal(det.etat, "paiement_en_attente");
  const p = await A("/api/admin/dossiers/" + vente.ref, { method: "PATCH", body: JSON.stringify({ etape: 2 }) }); assert.equal(p.s, 409);
  assert.ok((await A("/api/admin/paiements")).b.length >= 3);
});
await t("admin : faire avancer un dossier payé", async () => {
  const p = await A("/api/admin/dossiers/" + refR, { method: "PATCH", body: JSON.stringify({ etape: 2, etat: "en_cours", note: "Appelé sur WhatsApp" }) });
  assert.equal(p.s, 200); assert.equal(p.b.etape, 2);
});
await t("admin : arrivée + lien de solde 10 % puis paiement du solde", async () => {
  assert.equal((await A(`/api/admin/precommandes/${refP}/arrivee`, { method: "POST" })).s, 200);
  const s = await A(`/api/admin/precommandes/${refP}/solde`, { method: "POST", body: JSON.stringify({ methode: "moncash" }) });
  assert.equal(s.s, 200, JSON.stringify(s.b)); assert.match(s.b.message_whatsapp, /297[\s\u202f]?000 HTG/u);
  const pre = (await A("/api/admin/precommandes")).b.find(x => x.ref === refP); assert.equal(pre.statut_solde, "envoye");
  const pays = (await A("/api/admin/paiements")).b.find(x => x.ref === refP && x.type === "solde");
  await fetch(`${F}/_set/${pays.freda_id}/succeeded`, { headers: H });
  await new Promise(r => setTimeout(r, 4200));
  await fetch(B + "/api/dossiers/" + refP);
  const pre2 = (await A("/api/admin/precommandes")).b.find(x => x.ref === refP); assert.equal(pre2.statut_solde, "paye");
});
await t("admin : véhicules CRUD + paramètres", async () => {
  const v = await A("/api/admin/vehicules", { method: "POST", body: JSON.stringify({ marque: "Honda", modele: "CR-V 2018", prix: 19000, statut: "disponible" }) }); assert.equal(v.s, 201);
  assert.equal((await A("/api/admin/vehicules/" + v.b.id, { method: "PATCH", body: JSON.stringify({ prix: 18500 }) })).b.prix, 18500);
  assert.equal((await A("/api/admin/vehicules/" + v.b.id, { method: "DELETE" })).s, 200);
  const p = await A("/api/admin/parametres", { method: "PUT", body: JSON.stringify({ taux_htg: 131.5, tarifs: { consultation: 160 } }) });
  assert.equal(p.b.tarifs.consultation, 160);
  const c = await (await fetch(B + "/api/config")).json(); assert.equal(c.taux_htg, 131.5);
  await A("/api/admin/parametres", { method: "PUT", body: JSON.stringify({ taux_htg: 132, tarifs: { consultation: 50 } }) });
  assert.equal((await A("/api/admin/rapports")).s, 200);
});
console.log(`\n${ok} tests réussis`);
