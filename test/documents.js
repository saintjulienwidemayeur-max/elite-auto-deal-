// Lien unique « documents manquants » et financement « indisponible pour le moment » (serveur :3000, faux Freda :4555)
import assert from "node:assert/strict";
const B = "http://localhost:3000", F = "http://localhost:4555";
const fd = o => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const tok = (await (await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "motdepasse-test" }) })).json()).token;
const A = (u, o = {}) => fetch(B + u, { ...o, headers: { Authorization: "Bearer " + tok, ...(o.body ? { "Content-Type": "application/json" } : {}) } });
const png = () => new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")], { type: "image/png" });
const base = { service: "financement", client_nom: "Doc Test", client_tel: "+509 3700 6666", client_email: "doc@example.com", conditions_acceptees: "1", methode: "moncash", donnees: "{}" };
let ref, jeton;
await t("l'administrateur crée UN lien par dossier (le même lien à chaque mise à jour), protégé par l'accès admin", async () => {
  const d = await (await fetch(B + "/api/dossiers", { method: "POST", body: fd(base) })).json(); ref = d.ref;
  assert.equal((await fetch(B + `/api/admin/dossiers/${ref}/lien-documents`, { method: "POST" })).status, 401);
  const a = await (await A(`/api/admin/dossiers/${ref}/lien-documents`, { method: "POST", body: JSON.stringify({ documents: ["Pièce d'identité", "Preuve de revenus"], message: "Photos nettes" }) })).json();
  assert.match(a.url, /\/documents\/[0-9a-f]{36}$/); jeton = a.url.split("/").pop();
  const b = await (await A(`/api/admin/dossiers/${ref}/lien-documents`, { method: "POST", body: JSON.stringify({ documents: ["Pièce d'identité", "Preuve de revenus", "Preuve d'adresse"] }) })).json();
  assert.equal(b.url, a.url); assert.equal(b.documents.length, 3);
  assert.equal((await A(`/api/admin/dossiers/${ref}/lien-documents`, { method: "POST", body: JSON.stringify({ documents: [] }) })).status, 400);
  assert.equal((await (await A("/api/admin/dossiers/" + ref)).json()).lien_documents.url, a.url);
});
await t("le client ouvre le lien, voit ce qui manque, dépose ses documents ; ils arrivent dans le dossier", async () => {
  assert.equal((await fetch(B + "/api/documents/" + "0".repeat(36))).status, 404);
  const v = await (await fetch(B + "/api/documents/" + jeton)).json(); assert.equal(v.ref, ref); assert.equal(v.demandes.length, 3); assert.ok(v.demandes.every(x => x.recus.length === 0));
  const f = new FormData(); f.append("champs", JSON.stringify(["d0", "d2"])); f.append("fichiers", png(), "identite.png"); f.append("fichiers", png(), "adresse.png");
  const r = await fetch(B + "/api/documents/" + jeton, { method: "POST", body: f }); const apres = await r.json(); assert.equal(r.status, 201, JSON.stringify(apres)); assert.equal(apres.demandes[0].recus.length, 1); assert.equal(apres.demandes[1].recus.length, 0); assert.equal(apres.demandes[2].recus.length, 1);
  const bad = new FormData(); bad.append("fichiers", new Blob(["x"], { type: "text/plain" }), "x.txt"); assert.equal((await fetch(B + "/api/documents/" + jeton, { method: "POST", body: bad })).status, 400);
  const det = await (await A("/api/admin/dossiers/" + ref)).json(); assert.deepEqual(det.fichiers.map(x => x.champ).sort(), ["Pièce d'identité", "Preuve d'adresse"]);
  assert.ok(det.journal.some(j => /Documents reçus via le lien/.test(j.texte)));
  const page = await (await fetch(B + "/documents/" + jeton)).text(); assert.match(page, /rendreDocuments/); assert.match(page, /noindex/);
});
await t("financement indisponible : bloqué côté serveur (409), annoncé au site, réactivable ; les autres services ne changent pas", async () => {
  assert.equal((await (await fetch(B + "/api/config")).json()).financement_disponible, true);
  assert.equal((await fetch(B + "/api/admin/financement", { method: "PUT", body: JSON.stringify({ disponible: false }) })).status, 401);
  assert.equal((await A("/api/admin/financement", { method: "PUT", body: JSON.stringify({ disponible: false }) })).status, 200);
  assert.equal((await (await fetch(B + "/api/config")).json()).financement_disponible, false);
  const r = await fetch(B + "/api/dossiers", { method: "POST", body: fd(base) }); assert.equal(r.status, 409); assert.equal((await r.json()).error.code, "FINANCEMENT_INDISPONIBLE");
  assert.equal((await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base, service: "consultation" }) })).status, 201);
  assert.equal((await A("/api/admin/financement", { method: "PUT", body: JSON.stringify({ disponible: true }) })).status, 200);
  assert.equal((await fetch(B + "/api/dossiers", { method: "POST", body: fd(base) })).status, 201);
  const h = await (await fetch(B + "/financement")).text(); assert.match(h, /Financement indisponible pour le moment/); assert.match(h, /quelques heures ou dans quelques jours/);
});
console.log(`${ok} scénarios documents et financement OK`);
