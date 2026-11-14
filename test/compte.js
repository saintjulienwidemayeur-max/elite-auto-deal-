// Tests de l'espace client (serveur :3000, faux Freda :4555)
import assert from "node:assert/strict";
const B = "http://localhost:3000", F = "http://localhost:4555";
let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const sfx = String(Date.now()).slice(-6), TEL = "+509 36" + sfx, TEL2 = "+509 47" + sfx;
class Nav { constructor() { this.c = ""; }
  async f(u, o = {}) { const h = { ...(o.headers || {}) }; if (this.c) h.Cookie = this.c;
    if (o.json) { h["Content-Type"] = "application/json"; o.body = JSON.stringify(o.json); }
    const r = await fetch(B + u, { ...o, headers: h, redirect: "manual" });
    const sc = r.headers.get("set-cookie"); if (sc) this.c = sc.split(";")[0].endsWith("=") ? "" : sc.split(";")[0];
    return { s: r.status, b: await r.json().catch(() => null), r }; } }
const a = new Nav(), b = new Nav(), anon = new Nav();
const fd = o => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
let refA, refAnon, tokA;

await t("sans session => 401", async () => assert.equal((await anon.f("/api/compte")).s, 401));
await t("inscription + cookie httpOnly", async () => {
  const r = await a.f("/api/compte/inscription", { method: "POST", json: { nom: "Paul Client", tel: TEL, email: `p${sfx}@ex.ht`, mot_de_passe: "secret123" } });
  assert.equal(r.s, 201, JSON.stringify(r.b)); assert.match(r.r.headers.get("set-cookie"), /HttpOnly/); assert.equal(r.b.client.mdp_hash, undefined);
});
await t("doublon refusé, mot de passe court refusé", async () => {
  assert.equal((await b.f("/api/compte/inscription", { method: "POST", json: { nom: "X Y", tel: TEL, mot_de_passe: "secret123" } })).s, 409);
  assert.equal((await b.f("/api/compte/inscription", { method: "POST", json: { nom: "X Y", tel: TEL2, mot_de_passe: "court" } })).s, 400);
});
await t("dossier créé connecté => rattaché, nom complété depuis le profil", async () => {
  const r = await a.f("/api/dossiers", { method: "POST", body: fd({ service: "consultation", methode: "moncash", conditions_acceptees: "1" }) });
  assert.equal(r.s, 201, JSON.stringify(r.b)); refA = r.b.ref;
  const c = await a.f("/api/compte"); assert.equal(c.s, 200); assert.equal(c.b.dossiers[0].ref, refA); assert.equal(c.b.dossiers[0].prenom, "Paul");
});
await t("un autre compte ne voit pas le dossier", async () => {
  assert.equal((await b.f("/api/compte/inscription", { method: "POST", json: { nom: "Bea Autre", tel: TEL2, mot_de_passe: "secret123" } })).s, 201);
  assert.equal((await b.f("/api/compte/dossiers/" + refA)).s, 404);
  assert.equal((await b.f("/api/compte")).b.dossiers.length, 0);
});
await t("paiement confirmé => reçu disponible", async () => {
  let d = (await a.f("/api/compte/dossiers/" + refA)).b; assert.equal(d.paiements.length, 1);
  assert.equal((await a.f(`/api/compte/paiements/${d.paiements[0].id}/recu`)).s, 404); // pas encore payé
  const tok = (await (await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "motdepasse-test" }) })).json()).token; tokA = tok;
  const fid = (await (await fetch(B + "/api/admin/paiements", { headers: { Authorization: "Bearer " + tok } })).json()).find(p => p.ref === refA).freda_id;
  await fetch(`${F}/_set/${fid}/succeeded`, { headers: { Authorization: "Bearer sk_test_local" } });
  await new Promise(r => setTimeout(r, 4200));
  d = (await a.f("/api/compte/dossiers/" + refA)).b; assert.equal(d.paiement.statut, "succeeded");
  const r = await a.f(`/api/compte/paiements/${d.paiements[0].id}/recu`); assert.equal(r.s, 200); assert.equal(r.b.prestataire, "Freda Pay Issuing");
  assert.equal((await b.f(`/api/compte/paiements/${d.paiements[0].id}/recu`)).s, 404);
});
await t("envoi de documents par le client + accès fichier", async () => {
  const f = new FormData(); f.append("fichiers", new File([new Uint8Array(500)], "piece.pdf", { type: "application/pdf" }));
  const r = await a.f(`/api/compte/dossiers/${refA}/fichiers`, { method: "POST", body: f }); assert.equal(r.s, 201, JSON.stringify(r.b));
  const id = r.b.fichiers.at(-1).id;
  assert.equal((await a.f("/api/compte/fichiers/" + id)).r.status, 200);
  assert.equal((await b.f("/api/compte/fichiers/" + id)).s, 404);
});
await t("rattacher : mauvais téléphone refusé, bon téléphone accepté, déjà pris refusé", async () => {
  const r = await anon.f("/api/dossiers", { method: "POST", body: fd({ service: "recherche", methode: "moncash", conditions_acceptees: "1", client_nom: "Bea Autre", client_tel: TEL2 }) });
  refAnon = r.b.ref;
  assert.equal((await b.f("/api/compte/rattacher", { method: "POST", json: { ref: refAnon, tel: TEL } })).s, 404);
  assert.equal((await b.f("/api/compte/rattacher", { method: "POST", json: { ref: refAnon, tel: TEL2.replace(/\s/g, "") } })).s, 200);
  assert.equal((await a.f("/api/compte/rattacher", { method: "POST", json: { ref: refAnon, tel: TEL2 } })).s, 409);
});
await t("solde impossible avant arrivée", async () => assert.equal((await a.f(`/api/compte/dossiers/${refA}/solde`, { method: "POST", json: { methode: "moncash" } })).s, 409));
await t("profil + changement de mot de passe + déconnexion + connexion par téléphone", async () => {
  assert.equal((await a.f("/api/compte", { method: "PATCH", json: { whatsapp: "+509 4000 0000" } })).b.client.whatsapp, "+509 4000 0000");
  assert.equal((await a.f("/api/compte/mot-de-passe", { method: "POST", json: { actuel: "faux", nouveau: "nouveau123" } })).s, 400);
  assert.equal((await a.f("/api/compte/mot-de-passe", { method: "POST", json: { actuel: "secret123", nouveau: "nouveau123" } })).s, 200);
  await a.f("/api/compte/deconnexion", { method: "POST" }); assert.equal((await a.f("/api/compte")).s, 401);
  assert.equal((await a.f("/api/compte/connexion", { method: "POST", json: { identifiant: TEL, mot_de_passe: "secret123" } })).s, 401);
  assert.equal((await a.f("/api/compte/connexion", { method: "POST", json: { identifiant: TEL.replace("+509 ", ""), mot_de_passe: "nouveau123" } })).s, 200);
});
await t("cookie falsifié refusé", async () => {
  const x = new Nav(); x.c = a.c.replace(/.$/, c => c === "A" ? "B" : "A"); assert.equal((await x.f("/api/compte")).s, 401);
});
await t("oubli => alerte admin => lien => nouveau mot de passe (usage unique)", async () => {
  assert.equal((await anon.f("/api/compte/oubli", { method: "POST", json: { identifiant: TEL2 } })).b.ok, true);
  const H = { Authorization: "Bearer " + tokA, "Content-Type": "application/json" };
  const cl = (await (await fetch(B + "/api/admin/clients", { headers: H })).json()).find(c => c.tel === TEL2);
  assert.equal(cl.reinit_demandee, true); assert.equal(cl.nb_dossiers, 1);
  const res = await (await fetch(B + "/api/admin/resume", { headers: H })).json(); assert.ok(res.alertes.some(x => x.type === "reinitialisation_demandee"));
  const l = await (await fetch(`${B}/api/admin/clients/${cl.id}/reinitialisation`, { method: "POST", headers: H })).json();
  const jeton = new URL(l.lien).searchParams.get("reinit");
  const n = new Nav(); assert.equal((await n.f("/api/compte/reinitialiser", { method: "POST", json: { jeton, mot_de_passe: "remis1234" } })).s, 200);
  assert.equal((await n.f("/api/compte")).b.client.tel, TEL2);
  assert.equal((await new Nav().f("/api/compte/reinitialiser", { method: "POST", json: { jeton, mot_de_passe: "encore1234" } })).s, 400);
  const det = await (await fetch(B + "/api/admin/dossiers/" + refAnon, { headers: H })).json(); assert.equal(det.client_compte.nom, "Bea Autre");
});
console.log(`\n${ok} tests espace client réussis`);
