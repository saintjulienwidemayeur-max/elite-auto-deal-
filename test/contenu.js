// Contenu corrigé : financement (sans « refus »), visite 30 $, mesure WhatsApp sans questionnaire vide
import assert from "node:assert/strict";
const B = "http://localhost:3000"; let ok = 0; const t = async (n, fn) => { await fn(); ok++; console.log("ok -", n); };
const h = await (await fetch(B + "/financement")).text();
await t("financement : nouveau texte (ouverture, vérification, examen initial, décision finale), plus de « refus » dans l'encadré", async () => {
  const box = h.match(/<b>Ce que couvrent les 25 \$ :<\/b>([\s\S]*?)<\/p>/)[1];
  assert.match(box, /l'ouverture, à la vérification et à l'examen initial de votre dossier de financement/); assert.match(box, /demande reçue, vérification des documents, dossier en cours d'examen, puis décision finale de financement/); assert.ok(!/refus/i.test(box));
});
await t("statuts du dossier de financement côté serveur (suivi client)", async () => {
  const fd = new FormData(); for (const [k, v] of Object.entries({ service: "financement", methode: "moncash", client_nom: "Test Fin", client_tel: "+509 3700 1111", conditions_acceptees: "1" })) fd.append(k, v);
  const d = await (await fetch(B + "/api/dossiers", { method: "POST", body: fd })).json(); const s = await (await fetch(B + "/api/dossiers/" + d.ref)).json();
  assert.deepEqual(s.statuts, ["Demande reçue", "Vérification des documents", "Dossier en cours d'examen", "Décision finale de financement"]);
});
const e = await (await fetch(B + "/essai-visite")).text();
await t("visite ou essai : 30 $ partout, et plus de « trouvé ailleurs »", async () => {
  assert.match(e, /<b>30 \$<\/b>/); assert.match(e, /Vous payez 30 \$ de frais de service/); assert.match(e, /<p class="muted">Pour un véhicule déjà en Haïti\.<\/p>/); assert.ok(!/y compris un véhicule que vous avez trouvé ailleurs/.test(e));
});
await t("message WhatsApp du client : sans questionnaire vide (Marque : / Année : …)", async () => {
  const m = h.match(/const MSG_CLIENT=`([\s\S]*?)`;/)[1]; assert.match(m, /Bonjour Elite Auto Deal/); assert.ok(!/Marque :|Année :|Budget :/.test(m));
});
const r = await (await fetch(B + "/recherche-vehicule")).text();
await t("essai : plus de choix « véhicule trouvé ailleurs » (inventaire seulement)", async () => {
  const f = e.match(/<div class="vue active" data-vue="essai">[\s\S]*?<\/form>/)[0];
  assert.ok(!/name="origine"|trouvé ailleurs|es-ext|name="lieu"/.test(f)); assert.match(f, /name="vehicule"[^>]*required/);
});
await t("recherche : nouveau titre et accroche, une seule option « Type de demande », nouveau texte d'encadré", async () => {
  assert.match(r, /<h1>Confiez-nous l'achat de votre véhicule<\/h1>/); assert.ok(!/Votre recherche automobile/.test(r)); assert.match(r, /Vous souhaitez acheter un véhicule, mais vous manquez de temps ou vous ne savez pas où chercher \? Elite Auto Deal s'occupe de tout pour vous !/);
  assert.equal((r.match(/name="type"/g) || []).length, 1); assert.ok(!/inspecter un véhicule déjà en Haïti/.test(r));
  assert.match(r, /Notre équipe effectue les recherches nécessaires afin de trouver le véhicule qui correspond à vos besoins et à votre budget\./); assert.match(r, /Frais de service : <b data-tarif="service_recherche">150 \$<\/b> US\./); assert.match(r, /Le paiement du véhicule s'effectue uniquement après la confirmation de votre dossier\./);
});
await t("accueil : nouveau texte de l'encadré des frais de service, « Financement disponible » prévu pour les véhicules disponibles", async () => {
  const h = await (await fetch(B + "/")).text();
  assert.match(h, /<b>Les frais de service couvrent l'accompagnement, l'analyse, la préparation des documents, les démarches administratives et le suivi du client\.<\/b> Ils ne sont pas le prix du véhicule : ils ne constituent ni un acompte de réservation ni des frais de financement\. Le dossier de financement coûte 25 \$ \(ou l'équivalent en gourdes\)\. <a/);
  assert.ok(!/de 50 \$ couvrent/.test(h) && !/et ne garantit pas l'approbation\. <a href="\/conditions">Lire/.test(h)); assert.match(h, /Financement disponible/);
});
console.log(`${ok} scénarios contenu OK`);
