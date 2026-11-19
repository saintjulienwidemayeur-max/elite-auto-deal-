// Paiement MonCash réussi : email de confirmation au client (une seule fois) ; page de retour sans « réessayer » automatique ; bandeau de paiement en cours
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const B = "http://localhost:3000", F = "http://localhost:4555", M = "http://localhost:4556";
const fd = o => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const mel = "confirm.test@example.com";
let ref;
await t("paiement MonCash créé puis confirmé par Freda : le client reçoit UN email « Paiement confirmé »", async () => {
  const r = await fetch(B + "/api/dossiers", { method: "POST", body: fd({ service: "consultation", client_nom: "Confirm Test", client_tel: "+509 3700 2222", client_email: mel, conditions_acceptees: "1", methode: "moncash" }) }); const d = await r.json();
  assert.equal(r.status, 201, JSON.stringify(d)); ref = d.ref;
  await fetch(`${F}/_set/${d.paiement_id}/succeeded`, { headers: { Authorization: "Bearer sk_test_local" } });
  for (let i = 0; i < 3; i++) await fetch(`${B}/api/dossiers/${ref}`); // interrogations répétées
  await new Promise(r => setTimeout(r, 600));
  const l = (await (await fetch(`${M}/_emails?a=${encodeURIComponent(mel)}`)).json()).filter(x => /Paiement confirmé/.test(x.sujet) && x.sujet.includes(ref));
  assert.equal(l.length, 1); assert.match(l[0].html, /MonCash/);
});
await t("page de retour : plus de bouton « Réessayer » après 10 minutes ; message « ne payez pas une 2e fois » ; bandeau et page de confirmation au retour", async () => {
  const h = await (await fetch(B + "/")).text();
  assert.match(h, /Paiement en cours de vérification/); assert.match(h, /ne payez pas une 2e fois/); assert.match(h, /bandeau-paiement/); assert.match(h, /verifierDernierPaiement/);
  assert.ok(!/ecranEchec\(d,true\)/.test(h));
});
console.log(`${ok} scénarios confirmation OK`);
