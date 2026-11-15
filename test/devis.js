// Gestion des devis : total serveur, PDF, email avec lien, WhatsApp, page publique, expiration, paiement en ligne
import assert from "node:assert/strict";
import crypto from "node:crypto";
const B = "http://localhost:3000", M = "http://localhost:4556", F = "http://localhost:4555";
let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const tok = (await (await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "motdepasse-test" }) })).json()).token;
const A = (u, o = {}) => fetch(B + u, { ...o, headers: { Authorization: "Bearer " + tok, ...(o.body ? { "Content-Type": "application/json" } : {}) } });
const P = (u, body) => fetch(B + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const sfx = String(Date.now()).slice(-6), EMAIL = `dv${sfx}@ex.ht`;
const corps = { client_nom: "Marie Joseph", client_email: EMAIL, client_tel: "+509 37" + sfx, lignes: [{ description: "Frais de service : recherche et accompagnement", quantite: 1, prix_unitaire: 150 }, { description: "Toyota RAV4 2016", quantite: 1, prix_unitaire: 12500.5 }], frais_supplementaires: 20 };
let d;
await t("sans session admin => 401 ; jeton inconnu => 404 (API, page PDF)", async () => {
  assert.equal((await fetch(B + "/api/admin/devis")).status, 401);
  assert.equal((await fetch(B + "/api/devis/inconnu")).status, 404); assert.equal((await fetch(B + "/devis/inconnu.pdf")).status, 404);
});
await t("création : total calculé côté serveur, référence EAD-DEV-xxxx, expiration à 30 jours", async () => {
  const r = await A("/api/admin/devis", { method: "POST", body: JSON.stringify({ ...corps, total_usd: 1 }) }); d = await r.json();
  assert.equal(r.status, 201, JSON.stringify(d)); assert.equal(d.total_usd, 12670.5); assert.match(d.numero, /^EAD-DEV-\d{4}$/); assert.equal(d.statut, "brouillon");
  const jours = (new Date(d.expire_le) - Date.now()) / 864e5; assert.ok(jours > 29 && jours < 31, "expire dans ~30 jours : " + jours);
});
await t("validation : champs invalides et date d'expiration passée refusés", async () => {
  const hier = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  for (const b of [{ ...corps, client_nom: "" }, { ...corps, lignes: [] }, { ...corps, lignes: [{ description: "", quantite: 1, prix_unitaire: 5 }] }, { ...corps, lignes: [{ description: "x", quantite: 0, prix_unitaire: 5 }] }, { ...corps, lignes: [{ description: "x", quantite: 1, prix_unitaire: -5 }] }, { ...corps, client_email: "pasunemail" }, { ...corps, frais_supplementaires: -1 }, { ...corps, expire_le: hier }, { ...corps, expire_le: "n'importe quoi" }])
    assert.equal((await A("/api/admin/devis", { method: "POST", body: JSON.stringify(b) })).status, 400);
});
await t("PDF (admin) : %PDF, nom de fichier", async () => {
  const r = await A(`/api/admin/devis/${d.id}/pdf`); const b = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200); assert.equal(b.subarray(0, 5).toString(), "%PDF-"); assert.match(r.headers.get("content-disposition"), new RegExp(d.numero));
});
await t("email : lien sécurisé vers la page du devis (et non un PDF en pièce jointe)", async () => {
  const r = await A(`/api/admin/devis/${d.id}/email`, { method: "POST", body: "{}" }); const n = await r.json(); assert.equal(r.status, 200, JSON.stringify(n)); assert.equal(n.statut, "envoye");
  const m = (await (await fetch(`${M}/_emails?a=${encodeURIComponent(EMAIL)}`)).json()).at(-1);
  assert.match(m.sujet, new RegExp(d.numero)); assert.equal(m.pieces.length, 0); assert.ok(m.html.includes(`/devis/${d.jeton}`)); assert.ok(m.texte.includes(`/devis/${d.jeton}`)); assert.match(m.html, /12 670,50 \$/);
});
await t("WhatsApp : message avec le lien de la page, jamais celui d'un autre devis", async () => {
  const r = await A(`/api/admin/devis/${d.id}/whatsapp`, { method: "POST", body: "{}" }); const w = await r.json();
  assert.equal(r.status, 200, JSON.stringify(w)); assert.match(w.lien_whatsapp, /^https:\/\/wa\.me\/509/); assert.ok(w.message.includes(`/devis/${d.jeton}`) && !w.message.includes(".pdf")); assert.ok(w.message.includes("valable jusqu'au"));
});
await t("page publique du devis : HTML noindex, API sans email ni téléphone, PDF par lien", async () => {
  const page = await fetch(`${B}/devis/${d.jeton}`); const h = await page.text(); assert.equal(page.status, 200); assert.ok(h.includes('<div class="vue active" data-vue="devis">')); assert.match(h, /<meta name="robots" content="noindex/);
  const api = await (await fetch(`${B}/api/devis/${d.jeton}`)).json();
  assert.equal(api.numero, d.numero); assert.equal(api.total_usd, 12670.5); assert.equal(api.statut, "actif"); assert.equal(api.client_email, undefined); assert.equal(api.client_tel, undefined); assert.equal(api.jeton, undefined);
  const pdf = await fetch(`${B}/devis/${d.jeton}.pdf`); assert.equal(pdf.status, 200); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
});
await t("paiement : le montant vient du devis (le client ne peut rien changer), MonCash envoyé à Freda en gourdes", async () => {
  assert.equal((await P(`/api/devis/${d.jeton}/payer`, { methode: "mobile" })).status, 400);
  assert.equal((await P(`/api/devis/${d.jeton}/payer`, { methode: "carte", client_email: "pas-un-email" })).status, 400, "carte : email invalide");
  const r = await P(`/api/devis/${d.jeton}/payer`, { methode: "moncash", montant: 1, total_usd: 1 }); const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b)); assert.match(b.checkout_url, /^https:/); assert.match(b.ref, /^EAD-/);
  const p = (await (await A("/api/admin/paiements")).json()).find(x => x.ref === b.ref);
  const f = await (await fetch(`${F}/v1/payments/${p.freda_id}`, { headers: { Authorization: "Bearer sk_test_local" } })).json();
  assert.equal(f.method, "moncash"); assert.equal(f.currency, "HTG"); assert.equal(f.amount, Math.round(12670.5 * 132)); d.ref = b.ref; d.freda_id = p.freda_id;
  const r2 = await (await P(`/api/devis/${d.jeton}/payer`, { methode: "moncash" })).json(); assert.equal(r2.checkout_url, b.checkout_url, "même lien tant que le paiement est en attente");
});
await t("paiement confirmé par Freda => devis « Payé », plus modifiable ni repayable", async () => {
  await fetch(`${F}/_set/${d.freda_id}/succeeded`, { headers: { Authorization: "Bearer sk_test_local" } });
  let api; for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 1000)); api = await (await fetch(`${B}/api/devis/${d.jeton}`)).json(); if (api.statut === "paye") break; }
  assert.equal(api.statut, "paye"); assert.equal(api.paiement.statut, "succeeded");
  assert.equal((await P(`/api/devis/${d.jeton}/payer`, { methode: "moncash" })).status, 409);
  assert.equal((await A(`/api/admin/devis/${d.id}`, { method: "PATCH", body: JSON.stringify(corps) })).status, 409);
  const dossier = await (await fetch(`${B}/api/dossiers/${d.ref}`)).json(); assert.equal(dossier.service, "devis"); const pm = (await (await A("/api/admin/paiements")).json()).find(x => x.ref === d.ref); assert.equal(pm.montant_usd, 12670.5);
});
await t("devis expiré : affiché « expire » et paiement refusé (410)", async () => {
  const c = await (await A("/api/admin/devis", { method: "POST", body: JSON.stringify({ ...corps, client_email: "" }) })).json();
  assert.equal((await A("/api/admin/devis/" + c.id, { method: "PATCH", body: JSON.stringify({ ...corps, client_email: "", expire_le: new Date(Date.now() + 864e5).toISOString().slice(0, 10) }) })).status, 200);
  const { default: pg } = await import("pg"); const db = new pg.Client({ connectionString: "postgres://ead:ead@localhost:5432/ead" }); await db.connect();
  await db.query("update devis set expire_le = now() - interval '1 hour' where id=$1", [c.id]); await db.end();
  const api = await (await fetch(`${B}/api/devis/${c.jeton}`)).json(); assert.equal(api.statut, "expire");
  assert.equal((await P(`/api/devis/${c.jeton}/payer`, { methode: "moncash" })).status, 410);
  assert.equal((await A(`/api/admin/devis/${c.id}/email`, { method: "POST", body: "{}" })).status, 400, "pas d'email : refus");
});
await t("un jeton ne donne accès qu'à son devis ; suppression => lien mort", async () => {
  const c = await (await A("/api/admin/devis", { method: "POST", body: JSON.stringify({ ...corps, client_nom: "Autre Client" }) })).json();
  assert.equal((await (await fetch(`${B}/api/devis/${c.jeton}`)).json()).client_nom, "Autre Client"); assert.notEqual(c.jeton, d.jeton);
  assert.equal((await A(`/api/admin/devis/${c.id}`, { method: "DELETE" })).status, 200); assert.equal((await fetch(`${B}/api/devis/${c.jeton}`)).status, 404);
});
console.log(`${ok} scénarios devis OK`);
