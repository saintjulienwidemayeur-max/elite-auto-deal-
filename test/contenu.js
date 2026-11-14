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
console.log(`${ok} scénarios contenu OK`);
