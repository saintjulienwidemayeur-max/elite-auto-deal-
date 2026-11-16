// Compte bancaire (virement ou dépôt), services de la page d'accueil et palette de couleurs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const B = "http://localhost:3000"; let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const tok = (await (await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "motdepasse-test" }) })).json()).token;
const A = (u, o = {}) => fetch(B + u, { ...o, headers: { Authorization: "Bearer " + tok, ...(o.body ? { "Content-Type": "application/json" } : {}) } });
await t("le compte Capital Bank est dans la configuration publique (compte en gourdes 1937270, succursale 04)", async () => {
  const c = await (await fetch(B + "/api/config")).json(); assert.equal(c.banque.nom, "Capital Bank"); assert.equal(c.banque.compte, "1937270"); assert.equal(c.banque.succursale, "04"); assert.match(c.banque.devise, /Gourdes/); assert.ok(c.banque.titulaire.length > 3);
});
await t("modifiable dans l'administration : changement visible tout de suite, numéro invalide refusé, remise en l'état", async () => {
  const avant = (await (await A("/api/admin/parametres")).json()).banque; assert.equal(avant.compte, "1937270");
  assert.equal((await A("/api/admin/parametres", { method: "PUT", body: JSON.stringify({ banque: { ...avant, compte: "abc" } }) })).status, 400);
  const r = await A("/api/admin/parametres", { method: "PUT", body: JSON.stringify({ banque: { ...avant, compte: "7654321", titulaire: "Nouveau Titulaire" } }) }); assert.equal(r.status, 200);
  const c = await (await fetch(B + "/api/config")).json(); assert.equal(c.banque.compte, "7654321"); assert.equal(c.banque.titulaire, "Nouveau Titulaire"); assert.equal(c.banque.nom, "Capital Bank");
  assert.equal((await A("/api/admin/parametres", { method: "PUT", body: JSON.stringify({ banque: avant }) })).status, 200); assert.equal((await (await fetch(B + "/api/config")).json()).banque.compte, "1937270");
});
await t("la page d'un devis reçoit aussi les coordonnées bancaires ; le site sait les afficher (achat, précommande, devis)", async () => {
  const d = await (await A("/api/admin/devis", { method: "POST", body: JSON.stringify({ client_nom: "Banque Test", lignes: [{ description: "x", quantite: 1, prix_unitaire: 100 }] }) })).json();
  assert.equal((await (await fetch(B + "/api/devis/" + d.jeton)).json()).banque.compte, "1937270");
  const h = await (await fetch(B + "/")).text(); assert.match(h, /Payer par virement ou dépôt bancaire/); assert.match(h, /nom==="achat"\|\|nom==="precommande"\?banqueHTML\(\)/); assert.match(h, /banqueHTML\(d\.banque\)/);
});
await t("accueil : « Confiez-nous l'achat de votre véhicule », 5 services dont Financement (boutons rouges)", async () => {
  const h = await (await fetch(B + "/")).text(); const g = h.match(/<div class="services-grille">([\s\S]*?)<\/div>\s*<div class="encadre">/)[1];
  assert.equal((g.match(/<article class="service">/g) || []).length, 5); assert.match(g, /<h3>Confiez-nous l'achat de votre véhicule<\/h3>/); assert.ok(!/<h3>Recherche ou achat accompagné<\/h3>/.test(g));
  const titres = [...g.matchAll(/<h3>([^<]+)<\/h3>/g)].map(m => m[1]); assert.deepEqual(titres, ["Consultation automobile", "Confiez-nous l'achat de votre véhicule", "Visite ou essai", "Vente de votre véhicule", "Financement"]);
  assert.ok(!/btn-noir/.test(g) && (g.match(/btn btn-rouge/g) || []).length === 5);
});
await t("palette Elite Auto Deal : rouge #C8102E / #9E0B22, blanc cassé #F7F7F8, gris #5B5F66 et #E5E7EB, noir #0B0B0C ; plus l'ancien rouge", async () => {
  const site = await (await fetch(B + "/")).text(), admin = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  for (const [nom, h] of [["site", site], ["admin", admin]]) { for (const c of ["#C8102E", "#9E0B22", "#F7F7F8", "#5B5F66", "#E5E7EB", "#0B0B0C"]) assert.ok(h.includes(c), `${nom} : ${c}`); assert.ok(!/#D7191F|#A80F14/i.test(h), nom + " : ancien rouge"); }
  assert.match(site, /<meta name="theme-color" content="#C8102E">/); assert.match(site, /\.pied\{background:var\(--noir\)/); assert.match(site, /\.entete\{[^}]*border-bottom:3px solid var\(--rouge\)/);
  for (const f of ["../src/email.js", "../src/devis.js"]) assert.match(readFileSync(new URL(f, import.meta.url), "utf8"), /ROUGE = "#C8102E"/);
});
console.log(`${ok} scénarios banque et palette OK`);
