// Vraies URL par page : titre, canonical, JSON-LD, vue initiale, 404, sitemap
import assert from "node:assert/strict";
const B = "http://localhost:3000", SITE = "https://eliteautodeal.com";
let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const get = async u => { const r = await fetch(B + u); return { s: r.status, h: await r.text(), r }; };
const un = (h, re) => (h.match(re) || [])[1];
const ld = h => JSON.parse(un(h, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/));
const PAGES = { "/": "accueil", "/vehicules": "vehicules", "/precommande": "precommande", "/acheter": "achat", "/consultation": "consultation", "/recherche-vehicule": "recherche", "/essai-visite": "essai", "/vendre-mon-vehicule": "vendre", "/financement": "financement", "/suivi-dossier": "suivi", "/conditions": "conditions" };
await t("chaque page a son URL, son titre unique, son canonical et sa vue active", async () => {
  const titres = new Set();
  for (const [u, vue] of Object.entries(PAGES)) {
    const { s, h } = await get(u); assert.equal(s, 200, u);
    const titre = un(h, /<title>([^<]*)<\/title>/); assert.ok(titre.length > 20 && !titres.has(titre), `titre unique ${u}`); titres.add(titre);
    assert.equal(un(h, /<link rel="canonical" href="([^"]*)">/), SITE + u, "canonical " + u);
    assert.ok(h.includes(`<div class="vue active" data-vue="${vue}">`), "vue active " + u);
    assert.ok(un(h, /<meta name="description" content="([^"]*)">/).length > 60, "description " + u);
    assert.match(un(h, /<meta name="robots" content="([^"]*)">/), /^index/);
    JSON.parse(un(h, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/));
  }
});
await t("les tarifs viennent de la base (50 $, 200 $, 25 $) et pas de 150 $", async () => {
  assert.match((await get("/consultation")).h, /<title>[^<]*50 \$/); assert.match((await get("/recherche-vehicule")).h, /<title>[^<]*30 \$/); assert.match((await get("/vendre-mon-vehicule")).h, /<title>[^<]*200 \$/); assert.match((await get("/financement")).h, /<title>[^<]*25 \$/);
  assert.match((await get("/essai-visite")).h, /<title>[^<]*30 \$/); const g = ld((await get("/essai-visite")).h)["@graph"]; assert.equal(g.find(x => x["@type"] === "Service").offers.price, "30");
});
await t("JSON-LD : fil d'Ariane et FAQ seulement sur l'accueil", async () => {
  const a = ld((await get("/")).h)["@graph"].map(x => x["@type"]); assert.ok(a.includes("FAQPage") && a.includes("BreadcrumbList") && a.includes("AutoDealer"));
  const c = ld((await get("/consultation")).h)["@graph"].map(x => x["@type"]); assert.ok(!c.includes("FAQPage") && c.includes("BreadcrumbList") && c.includes("Service"));
});
await t("fiche véhicule : titre, prix, JSON-LD Car + Offer, contenu lisible sans JavaScript", async () => {
  const { s, h } = await get("/vehicules/rav16"); assert.equal(s, 200);
  assert.match(un(h, /<title>([^<]*)<\/title>/), /RAV4 2016/); assert.equal(un(h, /<link rel="canonical" href="([^"]*)">/), SITE + "/vehicules/rav16");
  const g = ld(h)["@graph"], car = g.find(x => x["@type"] === "Car"); assert.equal(car.brand.name, "Toyota"); assert.equal(car.offers.priceCurrency, "USD"); assert.ok(Number(car.offers.price) > 0);
  assert.ok(g.find(x => x["@type"] === "BreadcrumbList").itemListElement.length === 3);
  assert.ok(h.includes('<div class="vue active" data-vue="vehicule">')); assert.match(h, /<div class="detail" id="detail"><h2>Toyota/);
});
await t("véhicule inconnu et adresse inconnue : 404 non indexés", async () => {
  for (const u of ["/vehicules/nexiste-pas", "/page-inconnue"]) { const { s, h } = await get(u); assert.equal(s, 404, u); assert.match(un(h, /<meta name="robots" content="([^"]*)">/), /noindex/); }
});
await t("pages privées (espace client, retour de paiement) : noindex", async () => {
  for (const u of ["/mon-espace", "/mon-espace/dossier", "/retour-paiement"]) { const { s, h } = await get(u); assert.equal(s, 200); assert.match(un(h, /<meta name="robots" content="([^"]*)">/), /noindex/); }
});
await t("sitemap dynamique : pages publiques + véhicules, sans pages privées", async () => {
  const { s, h, r } = await get("/sitemap.xml"); assert.equal(s, 200); assert.match(r.headers.get("content-type"), /xml/);
  for (const u of Object.keys(PAGES)) assert.ok(h.includes(`<loc>${SITE}${u === "/" ? "/" : u}</loc>`), u);
  assert.ok(h.includes(`${SITE}/vehicules/rav16`)); for (const u of ["/mon-espace", "/retour-paiement"]) assert.ok(!h.includes(u));
});
await t("liens internes du HTML : vraies URL (plus de #consultation)", async () => {
  const { h } = await get("/"); assert.ok(h.includes('href="/consultation"') && h.includes('href="/precommande"')); assert.ok(!/href="#(consultation|precommande|vehicules|conditions)"/.test(h));
});
await t("l'administration et les fichiers statiques restent accessibles", async () => {
  assert.equal((await get("/admin")).s, 200); assert.equal((await fetch(B + "/robots.txt")).status, 200); assert.equal((await fetch(B + "/favicon.ico")).status, 200); assert.equal((await fetch(B + "/api/config")).status, 200);
});
console.log(`${ok} scénarios URL OK`);
