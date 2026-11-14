// Gestion des devis : total serveur, PDF, email (faux Brevo :4556), WhatsApp, lien public
import assert from "node:assert/strict";
const B = "http://localhost:3000", M = "http://localhost:4556";
let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const tok = (await (await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "motdepasse-test" }) })).json()).token;
const A = (u, o = {}) => fetch(B + u, { ...o, headers: { Authorization: "Bearer " + tok, ...(o.body ? { "Content-Type": "application/json" } : {}) } });
const sfx = String(Date.now()).slice(-6), EMAIL = `dv${sfx}@ex.ht`;
const corps = { client_nom: "Marie Joseph", client_email: EMAIL, client_tel: "+509 37" + sfx, lignes: [{ description: "Consultation automobile", quantite: 1, prix_unitaire: 50 }, { description: "Inspection d'un véhicule (Toyota RAV4 2016)", quantite: 2, prix_unitaire: 75.5 }], frais_supplementaires: 20 };
let d;
await t("sans session admin => 401, et le PDF public inconnu => 404", async () => {
  assert.equal((await fetch(B + "/api/admin/devis")).status, 401);
  assert.equal((await fetch(B + "/devis/inconnu.pdf")).status, 404);
});
await t("création : le total est calculé côté serveur (50 + 2 x 75,50 + 20 = 221)", async () => {
  const r = await A("/api/admin/devis", { method: "POST", body: JSON.stringify({ ...corps, total_usd: 1 }) }); d = await r.json();
  assert.equal(r.status, 201, JSON.stringify(d)); assert.equal(d.total_usd, 221); assert.match(d.numero, /^DV-\d{4}-\d{4}$/); assert.equal(d.statut, "brouillon");
});
await t("validation : nom, ligne vide, quantité et prix invalides refusés", async () => {
  for (const b of [{ ...corps, client_nom: "" }, { ...corps, lignes: [] }, { ...corps, lignes: [{ description: "", quantite: 1, prix_unitaire: 5 }] }, { ...corps, lignes: [{ description: "x", quantite: 0, prix_unitaire: 5 }] }, { ...corps, lignes: [{ description: "x", quantite: 1, prix_unitaire: -5 }] }, { ...corps, client_email: "pasunemail" }, { ...corps, frais_supplementaires: -1 }])
    assert.equal((await A("/api/admin/devis", { method: "POST", body: JSON.stringify(b) })).status, 400);
});
await t("PDF généré (en-tête %PDF) avec le bon nom de fichier", async () => {
  const r = await A(`/api/admin/devis/${d.id}/pdf`); const b = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "application/pdf"); assert.equal(b.subarray(0, 5).toString(), "%PDF-"); assert.ok(b.length > 2000);
  assert.match(r.headers.get("content-disposition"), new RegExp(d.numero));
});
await t("modification : le total est recalculé", async () => {
  const r = await A(`/api/admin/devis/${d.id}`, { method: "PATCH", body: JSON.stringify({ ...corps, frais_supplementaires: 0 }) }); const n = await r.json();
  assert.equal(r.status, 200); assert.equal(n.total_usd, 201); d = n;
});
await t("email : envoyé via Brevo avec le PDF en pièce jointe, statut « envoye »", async () => {
  const r = await A(`/api/admin/devis/${d.id}/email`, { method: "POST", body: "{}" }); const n = await r.json();
  assert.equal(r.status, 200, JSON.stringify(n)); assert.equal(n.statut, "envoye");
  const m = (await (await fetch(`${M}/_emails?a=${encodeURIComponent(EMAIL)}`)).json()).at(-1);
  assert.match(m.sujet, new RegExp(d.numero)); assert.equal(m.pieces.length, 1); assert.equal(m.pieces[0].nom, `Devis-${d.numero}.pdf`); assert.equal(m.pieces[0].debut, "%PDF-"); assert.match(m.html, /201,00 \$/);
});
await t("email sans adresse du client => 400", async () => {
  const c = await (await A("/api/admin/devis", { method: "POST", body: JSON.stringify({ ...corps, client_email: "" }) })).json();
  assert.equal((await A(`/api/admin/devis/${c.id}/email`, { method: "POST", body: "{}" })).status, 400);
});
await t("WhatsApp : lien wa.me avec message et lien PDF public, lisible sans session", async () => {
  const r = await A(`/api/admin/devis/${d.id}/whatsapp`, { method: "POST", body: "{}" }); const w = await r.json();
  assert.equal(r.status, 200, JSON.stringify(w)); assert.match(w.lien_whatsapp, /^https:\/\/wa\.me\/509/); assert.ok(w.message.includes(d.numero)); assert.ok(w.message.includes("201,00 $"));
  const pdf = await fetch(w.lien_pdf.replace(/^https?:\/\/[^/]+/, B)); assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-"); assert.match(pdf.headers.get("x-robots-tag"), /noindex/);
});
await t("liste puis suppression", async () => {
  const l = await (await A("/api/admin/devis")).json(); assert.ok(l.some(x => x.id === d.id));
  assert.equal((await A(`/api/admin/devis/${d.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await A(`/api/admin/devis/${d.id}/pdf`)).status, 404);
});
console.log(`${ok} scénarios devis OK`);
