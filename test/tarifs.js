// Les tarifs modifiés dans l'administration changent partout sur le site (pages, JSON-LD, llms.txt, scripts)
import assert from "node:assert/strict";
const B = "http://localhost:3000"; let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const tok = (await (await fetch(B + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "motdepasse-test" }) })).json()).token;
const A = (u, o = {}) => fetch(B + u, { ...o, headers: { Authorization: "Bearer " + tok, ...(o.body ? { "Content-Type": "application/json" } : {}) } });
const ORIGINE = { consultation: 50, recherche: 30, service_recherche: 150, essai: 30, vendre: 200, financement: 25 };
const NOUVEAU = { consultation: 45, recherche: 28, service_recherche: 175, essai: 35, vendre: 100, financement: 20 };
const maj = tarifs => A("/api/admin/parametres", { method: "PUT", body: JSON.stringify({ tarifs }) });
const page = async u => (await fetch(B + u)).text();
await t("aucun repère {{T:…}} ni {{N:…}} ne reste dans les pages ni dans llms.txt", async () => {
  for (const u of ["/", "/consultation", "/recherche-vehicule", "/essai-visite", "/vendre-mon-vehicule", "/financement", "/conditions", "/llms.txt", "/inconnue"]) assert.ok(!/\{\{[TN]:/.test(await page(u)), u);
  assert.equal((await fetch(B + "/index.html", { redirect: "manual" })).status, 301);
});
await t("tarifs par défaut affichés (50 / 30 / 150 / 30 / 200 / 25)", async () => {
  const v = await page("/vendre-mon-vehicule"); assert.match(v, /<div class="etiquette-prix"><b>200 \$<\/b>/); assert.match(v, /const TARIFS = \{consultation:50,recherche:30,service_recherche:150,essai:30,vendre:200,financement:25\}/);
});
await t("modification dans l'administration : le site entier suit (vente 200 $ -> 100 $, etc.)", async () => {
  assert.equal((await maj(NOUVEAU)).status, 200);
  const v = await page("/vendre-mon-vehicule"); assert.match(v, /<div class="etiquette-prix"><b>100 \$<\/b>/); assert.match(v, /vendre:100/); assert.ok(!/<b>200 \$<\/b>/.test(v));
  const h = await page("/"); assert.match(h, /Vendre mon véhicule <small>100 \$<\/small>/); assert.match(h, /Consultation <small>45 \$<\/small>/); assert.match(h, /Réserver un essai <small>35 \$<\/small>/);
  assert.match(h, /La vente d'un véhicule confié coûte 100 \$/); assert.match(h, /frais de service de 175 \$/); assert.ok(!/\b200 \$/.test(h), "plus de 200 $ nulle part");
  const ld = JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])["@graph"].find(x => x["@type"] === "AutoDealer").hasOfferCatalog.itemListElement.map(o => o.price);
  assert.deepEqual(ld, ["45", "28", "35", "100", "20"]);
  assert.match(await page("/essai-visite"), /<div class="etiquette-prix"><b>35 \$<\/b>/); assert.match(await page("/financement"), /Ce que couvrent les 20 \$/);
  const l = await page("/llms.txt"); assert.match(l, /vendre-mon-vehicule\) : 100 \$/); assert.ok(!/\b200 \$/.test(l));
  const c = await page("/conditions"); assert.match(c, /vente d'un véhicule confié \(100 \$\)/); assert.match(c, /dossier de financement \(20 \$/);
});
await t("les montants réellement payés suivent aussi (vente 100 $ x 132 = 13 200 HTG)", async () => {
  const f = new FormData(); for (const [k, v] of Object.entries({ service: "vendre", methode: "moncash", client_nom: "Tarif Test", client_tel: "+509 3700 3333", conditions_acceptees: "1" })) f.append(k, v);
  const d = await (await fetch(B + "/api/dossiers", { method: "POST", body: f })).json(); assert.equal(d.montant_usd, 100); assert.equal(d.montant, 13200);
});
await t("remise des tarifs d'origine", async () => { assert.equal((await maj(ORIGINE)).status, 200); assert.match(await page("/vendre-mon-vehicule"), /<div class="etiquette-prix"><b>200 \$<\/b>/); });
console.log(`${ok} scénarios tarifs OK`);
