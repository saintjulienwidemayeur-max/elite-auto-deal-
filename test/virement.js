// Virement bancaire : preuve de paiement, vérification et confirmation par l'administrateur, emails (serveur :3000, faux Brevo :4556)
import assert from "node:assert/strict";
const B = "http://localhost:3000", M = "http://localhost:4556";
const fd = o => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const tok = (await (await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "motdepasse-test" }) })).json()).token;
const A = (u, o = {}) => fetch(B + u, { ...o, headers: { Authorization: "Bearer " + tok, ...(o.body ? { "Content-Type": "application/json" } : {}) } });
const png = () => new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")], { type: "image/png" });
const mails = async a => (await (await fetch(`${M}/_emails?a=${encodeURIComponent(a)}`)).json());
const dispo = (await (await fetch(B + "/api/vehicules")).json()).filter(v => v.statut === "disponible" && v.prix);
const base = v => ({ service: "achat", vehicule_id: v.id, client_nom: "Virement Test", client_tel: "+509 3700 1111", conditions_acceptees: "1", methode: "virement" });
const mel = "virement.test@example.com";
let d, jeton, ref, pid;

await t("virement : refusé sans email, refusé pour une consultation, accepté pour un achat (HTG, pas de lien Freda)", async () => {
  assert.equal((await fetch(B + "/api/dossiers", { method: "POST", body: fd(base(dispo[0])) })).status, 400);
  assert.equal((await fetch(B + "/api/dossiers", { method: "POST", body: fd({ service: "consultation", client_nom: "Virement Test", client_tel: "+509 3700 1111", conditions_acceptees: "1", methode: "virement", client_email: mel }) })).status, 400);
  const r = await fetch(B + "/api/dossiers", { method: "POST", body: fd({ ...base(dispo[0]), client_email: mel }) }); d = await r.json();
  assert.equal(r.status, 201, JSON.stringify(d)); assert.equal(d.virement, true); assert.equal(d.devise, "HTG"); assert.ok(!d.checkout_url); assert.ok(d.jeton.length >= 30); assert.equal(d.banque.compte, "1937270");
  assert.equal(d.montant, Math.round(d.montant_usd * 132)); jeton = d.jeton; ref = d.ref;
});
await t("preuve : jeton obligatoire, fichier obligatoire, type vérifié, puis dépôt accepté", async () => {
  const u = `${B}/api/dossiers/${ref}/preuve`;
  assert.equal((await fetch(u, { method: "POST", body: fd({ jeton: "faux" }) })).status, 403);
  assert.equal((await fetch(u, { method: "POST", body: fd({ jeton }) })).status, 400);
  const mauvais = fd({ jeton }); mauvais.append("fichiers", new Blob(["x"], { type: "text/plain" }), "x.txt");
  assert.equal((await fetch(u, { method: "POST", body: mauvais })).status, 400);
  const bon = fd({ jeton }); bon.append("fichiers", png(), "recu.png");
  const r = await fetch(u, { method: "POST", body: bon }); assert.equal(r.status, 201, await r.text());
  const s = await (await fetch(`${B}/api/dossiers/${ref}/virement?jeton=${jeton}`)).json(); assert.equal(s.statut, "pending"); assert.equal(s.preuves, 1);
  assert.equal((await fetch(`${B}/api/dossiers/${ref}/virement?jeton=faux`)).status, 403);
  const pub = await (await fetch(`${B}/api/dossiers/${ref}`)).json(); assert.equal(pub.paiement.methode, "virement"); assert.equal(pub.paiement.statut, "pending"); assert.equal(pub.preuves, 1);
});
await t("admin : le virement apparaît avec sa preuve (fichier lisible), le dossier reste non payé", async () => {
  const l = await (await A("/api/admin/virements")).json(); const v = l.find(x => x.ref === ref);
  assert.equal(v.statut, "pending"); assert.equal(v.preuves.length, 1); assert.equal(v.client_email, mel); pid = v.id;
  const f = await A("/api/admin/fichiers/" + v.preuves[0].id); assert.equal(f.status, 200); assert.match(f.headers.get("content-type"), /image\/png/);
  assert.equal((await fetch(B + "/api/admin/virements")).status, 401);
  assert.equal((await fetch(B + "/api/admin/virements/" + pid + "/confirmer", { method: "POST" })).status, 401);
});
await t("ouverture d'un fichier : lien temporaire signé (sans en-tête d'authentification), refusé si modifié, lien exigé par l'admin", async () => {
  const f = (await (await A("/api/admin/virements")).json()).find(x => x.ref === ref).preuves[0];
  assert.equal((await fetch(B + `/api/admin/fichiers/${f.id}/lien`)).status, 401);
  const { url } = await (await A(`/api/admin/fichiers/${f.id}/lien`)).json();
  const ok = await fetch(B + url); assert.equal(ok.status, 200); assert.match(ok.headers.get("content-type"), /image\/png/);
  assert.equal((await fetch(B + url.replace(/sig=./, "sig=x"))).status, 403);
  assert.equal((await fetch(B + url.replace(/exp=\d+/, "exp=1"))).status, 403);
});
await t("refus : motif enregistré, email au client, nouvelle preuve remet le virement en attente", async () => {
  const r = await A(`/api/admin/virements/${pid}/refuser`, { method: "POST", body: JSON.stringify({ motif: "Montant incomplet" }) }); assert.equal((await r.json()).email, true);
  assert.equal((await (await fetch(`${B}/api/dossiers/${ref}`)).json()).paiement.motif_refus, "Montant incomplet");
  const m = (await mails(mel)).find(x => /à vérifier/.test(x.sujet) && x.sujet.includes(ref)); assert.ok(m, "email de refus"); assert.match(m.html, /Montant incomplet/);
  const bon = fd({ jeton }); bon.append("fichiers", png(), "recu2.png"); assert.equal((await fetch(`${B}/api/dossiers/${ref}/preuve`, { method: "POST", body: bon })).status, 201);
  assert.equal((await (await fetch(`${B}/api/dossiers/${ref}/virement?jeton=${jeton}`)).json()).statut, "pending");
});
await t("confirmation : dossier payé, véhicule vendu, email de confirmation au client, pas de double confirmation", async () => {
  const r = await A(`/api/admin/virements/${pid}/confirmer`, { method: "POST" }); assert.equal((await r.json()).email, true);
  const pub = await (await fetch(`${B}/api/dossiers/${ref}`)).json(); assert.equal(pub.paiement.statut, "succeeded"); assert.ok(pub.etape >= 1);
  const v = (await (await fetch(B + "/api/vehicules")).json()).find(x => x.id === dispo[0].id); assert.ok(!v || v.statut === "vendu");
  const m = (await mails(mel)).find(x => /Paiement confirmé/.test(x.sujet) && x.sujet.includes(ref)); assert.ok(m, "email de confirmation"); assert.match(m.html, new RegExp(ref));
  assert.equal((await A(`/api/admin/virements/${pid}/confirmer`, { method: "POST" })).status, 409);
  const bon = fd({ jeton }); bon.append("fichiers", png(), "r3.png"); assert.equal((await fetch(`${B}/api/dossiers/${ref}/preuve`, { method: "POST", body: bon })).status, 409);
  const p = (await (await A("/api/admin/paiements")).json()).find(x => x.ref === ref); assert.equal(p.methode, "virement"); assert.equal(p.statut, "succeeded");
});
await t("devis : le virement est proposé, crée le dossier et attend la preuve", async () => {
  const dv = await (await A("/api/admin/devis", { method: "POST", body: JSON.stringify({ client_nom: "Devis Virement", lignes: [{ description: "Service", quantite: 1, prix_unitaire: 100 }] }) })).json();
  const pub = await (await fetch(B + "/api/devis/" + dv.jeton)).json(); assert.ok(pub.methodes.includes("virement"));
  assert.equal((await fetch(`${B}/api/devis/${dv.jeton}/payer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ methode: "virement" }) })).status, 400);
  const r = await fetch(`${B}/api/devis/${dv.jeton}/payer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ methode: "virement", client_email: "devis.vir@example.com" }) }); const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(j.virement, true); assert.equal(j.montant, 13200); assert.ok(j.jeton);
  const l = await (await A("/api/admin/virements")).json(); const v = l.find(x => x.ref === j.ref); assert.equal(v.statut, "pending");
  assert.equal((await A(`/api/admin/virements/${v.id}/confirmer`, { method: "POST" })).status, 200);
  assert.equal((await (await fetch(B + "/api/devis/" + dv.jeton)).json()).statut, "paye");
});
await t("site : choix « Virement bancaire », écran de dépôt de preuve et icônes du pied de page", async () => {
  const h = await (await fetch(B + "/")).text();
  for (const m of [/Virement bancaire/, /Déposez votre preuve de paiement/, /api\/dossiers\/"\+encodeURIComponent\(ref\)\+"\/preuve/]) assert.match(h, m);
  const pied = h.match(/<footer class="pied">([\s\S]*?)<\/footer>/)[1];
  for (const i of ["i-tel", "i-walogo", "i-mail", "i-pin", "i-insta", "i-fb", "i-tiktok"]) assert.match(pied, new RegExp(`#${i}"`));
  assert.equal((pied.match(/<svg class="ic[ "]/g) || []).length, 8);
  const adm = await (await fetch(B + "/admin")).text(); assert.match(adm, /Virements bancaires/); assert.match(adm, /data-vr="ok"/);
});
console.log(`${ok} scénarios virement OK`);
