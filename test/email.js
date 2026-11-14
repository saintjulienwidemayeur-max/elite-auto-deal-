// Tests email de bienvenue + OTP (serveur :3000, faux Brevo :4556)
import assert from "node:assert/strict";
const B = "http://localhost:3000", M = "http://localhost:4556";
let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const sfx = String(Date.now()).slice(-6), TEL = "+509 38" + sfx, EMAIL = `otp${sfx}@ex.ht`;
class Nav { constructor() { this.c = ""; }
  async f(u, o = {}) { const h = {}; if (this.c) h.Cookie = this.c;
    if (o.json) { h["Content-Type"] = "application/json"; o.body = JSON.stringify(o.json); }
    const r = await fetch(B + u, { ...o, headers: h, redirect: "manual" });
    const sc = r.headers.get("set-cookie"); if (sc) this.c = sc.split(";")[0].endsWith("=") ? "" : sc.split(";")[0];
    return { s: r.status, b: await r.json().catch(() => null) }; } }
const mails = async () => (await (await fetch(`${M}/_emails?a=${encodeURIComponent(EMAIL)}`)).json());
const attendre = async n => { for (let i = 0; i < 30; i++) { const m = await mails(); if (m.length >= n) return m; await new Promise(r => setTimeout(r, 100)); } assert.fail("email non reçu"); };
const code = m => m.texte.match(/\b(\d{6})\b/)[1];
const a = new Nav(), r2 = new Nav();

let c1;
await t("inscription avec email => email de bienvenue + code, compte non vérifié", async () => {
  const r = await a.f("/api/compte/inscription", { method: "POST", json: { nom: "Olivia Code", tel: TEL, email: EMAIL, mot_de_passe: "secret123" } });
  assert.equal(r.s, 201, JSON.stringify(r.b)); assert.equal(r.b.client.email_verifie, false);
  const m = await attendre(1); assert.match(m[0].sujet, /Bienvenue/); assert.match(m[0].html, /Olivia/); c1 = code(m[0]);
});
await t("mauvais code refusé, bon code vérifie l'email, ne marche qu'une fois", async () => {
  const mauvais = c1 === "000000" ? "111111" : "000000";
  assert.equal((await a.f("/api/compte/email/verifier", { method: "POST", json: { code: mauvais } })).s, 400);
  const r = await a.f("/api/compte/email/verifier", { method: "POST", json: { code: c1 } });
  assert.equal(r.s, 200, JSON.stringify(r.b)); assert.equal(r.b.client.email_verifie, true);
  assert.equal((await a.f("/api/compte/email/verifier", { method: "POST", json: { code: c1 } })).s, 400);
  assert.equal((await a.f("/api/compte")).b.client.email_verifie, true);
});
await t("renvoi refusé si déjà vérifié", async () => assert.equal((await a.f("/api/compte/email/envoyer", { method: "POST", json: {} })).s, 400));
let cr;
await t("mot de passe oublié => code par email, réponse identique pour un compte inconnu", async () => {
  const inconnu = await r2.f("/api/compte/oubli", { method: "POST", json: { identifiant: `nobody${sfx}@ex.ht` } });
  const r = await r2.f("/api/compte/oubli", { method: "POST", json: { identifiant: EMAIL } });
  assert.equal(r.s, 200); assert.deepEqual(r.b, inconnu.b);
  const m = await attendre(2); assert.match(m[1].sujet, /votre code/); cr = code(m[1]);
});
await t("nouvel envoi dans la minute : pas de second email (anti-spam)", async () => {
  await r2.f("/api/compte/oubli", { method: "POST", json: { identifiant: EMAIL } });
  await new Promise(r => setTimeout(r, 500)); assert.equal((await mails()).length, 2);
});
await t("réinitialisation : mauvais code, mot de passe court, puis bon code", async () => {
  const mauvais = cr === "000000" ? "111111" : "000000";
  assert.equal((await r2.f("/api/compte/reinitialiser", { method: "POST", json: { identifiant: EMAIL, code: mauvais, mot_de_passe: "nouveau123" } })).s, 400);
  assert.equal((await r2.f("/api/compte/reinitialiser", { method: "POST", json: { identifiant: EMAIL, code: cr, mot_de_passe: "court" } })).s, 400);
  const r = await r2.f("/api/compte/reinitialiser", { method: "POST", json: { identifiant: EMAIL, code: cr, mot_de_passe: "nouveau123" } });
  assert.equal(r.s, 200, JSON.stringify(r.b));
  assert.equal((await r2.f("/api/compte")).s, 200); // session ouverte
  assert.equal((await new Nav().f("/api/compte/connexion", { method: "POST", json: { identifiant: EMAIL, mot_de_passe: "secret123" } })).s, 401);
  assert.equal((await new Nav().f("/api/compte/connexion", { method: "POST", json: { identifiant: EMAIL, mot_de_passe: "nouveau123" } })).s, 200);
  assert.equal((await new Nav().f("/api/compte/reinitialiser", { method: "POST", json: { identifiant: EMAIL, code: cr, mot_de_passe: "autre12345" } })).s, 400); // code déjà utilisé
});
await t("5 essais max : le bon code ne marche plus après trop d'échecs", async () => {
  const nav = new Nav(); await nav.f("/api/compte/inscription", { method: "POST", json: { nom: "Brute Force", tel: "+509 39" + sfx, email: `bf${sfx}@ex.ht`, mot_de_passe: "secret123" } });
  const m = await (await fetch(`${M}/_emails?a=${encodeURIComponent(`bf${sfx}@ex.ht`)}`)).json();
  let bon; for (let i = 0; i < 30 && !bon; i++) { await new Promise(r => setTimeout(r, 100)); const l = await (await fetch(`${M}/_emails?a=${encodeURIComponent(`bf${sfx}@ex.ht`)}`)).json(); if (l[0]) bon = code(l[0]); }
  const faux = bon === "123456" ? "654321" : "123456";
  for (let i = 0; i < 6; i++) await nav.f("/api/compte/email/verifier", { method: "POST", json: { code: faux } });
  assert.equal((await nav.f("/api/compte/email/verifier", { method: "POST", json: { code: bon } })).s, 400);
});
console.log(`${ok} scénarios email OK`);
