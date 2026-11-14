// Modification du code d'accès administrateur depuis l'administration
import assert from "node:assert/strict";
const B = "http://localhost:3000", ORIGINE = "motdepasse-test", NOUVEAU = "Nouveau-Code-2026!";
let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const login = async pw => { const r = await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) }); return { s: r.status, b: await r.json() }; };
const appel = (tok, u, body) => fetch(B + u, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
let tokA, tokB;
await t("deux sessions admin ouvertes (appareils A et B)", async () => { tokA = (await login(ORIGINE)).b.token; tokB = (await login(ORIGINE)).b.token; assert.equal((await appel(tokB, "/api/admin/devis")).status, 200); });
await t("refus : code actuel faux, nouveau trop court, confirmation différente, identique à l'actuel", async () => {
  for (const b of [{ actuel: "faux", nouveau: NOUVEAU, confirmation: NOUVEAU }, { actuel: ORIGINE, nouveau: "court", confirmation: "court" }, { actuel: ORIGINE, nouveau: NOUVEAU, confirmation: "autre-chose-1" }, { actuel: ORIGINE, nouveau: ORIGINE, confirmation: ORIGINE }])
    assert.equal((await appel(tokA, "/api/admin/mot-de-passe", b)).status, 400);
});
await t("changement réussi : nouveau jeton, l'autre appareil est déconnecté", async () => {
  const r = await appel(tokA, "/api/admin/mot-de-passe", { actuel: ORIGINE, nouveau: NOUVEAU, confirmation: NOUVEAU }); const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b)); tokA = b.token;
  assert.equal((await appel(tokA, "/api/admin/devis")).status, 200, "la session en cours reste ouverte");
  assert.equal((await appel(tokB, "/api/admin/devis")).status, 401, "l'autre session est coupée");
});
await t("connexion : ancien code refusé, nouveau code accepté", async () => { assert.equal((await login(ORIGINE)).s, 401); assert.equal((await login(NOUVEAU)).s, 200); });
await t("remise du code d'origine (pour les autres tests)", async () => {
  const r = await appel(tokA, "/api/admin/mot-de-passe", { actuel: NOUVEAU, nouveau: ORIGINE, confirmation: ORIGINE }); assert.equal(r.status, 200);
  assert.equal((await login(ORIGINE)).s, 200);
});
console.log(`${ok} scénarios code d'accès OK`);
