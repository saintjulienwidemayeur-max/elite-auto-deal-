// Devis : validation, calcul du total (toujours côté serveur) et génération du PDF
import PDFDocument from "pdfkit";
import { readFileSync, existsSync } from "node:fs";

const arrondi2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const VALIDITE_JOURS = () => Math.max(1, Number(process.env.DEVIS_VALIDITE_JOURS) || 30);
export const montant = n => arrondi2(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ").replace(".", ",") + " $";

/** Nettoie et valide les données du formulaire. Lance une Error(message) si invalide. */
export function validerDevis(b = {}) {
  const nom = String(b.client_nom || "").trim().slice(0, 120);
  if (nom.length < 2) throw new Error("Indiquez le nom et le prénom du client.");
  const email = String(b.client_email || "").trim().toLowerCase().slice(0, 160) || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Adresse email invalide.");
  const tel = String(b.client_tel || "").trim().slice(0, 40) || null;
  const src = Array.isArray(b.lignes) ? b.lignes : [];
  if (!src.length || src.length > 30) throw new Error("Ajoutez entre 1 et 30 lignes au devis.");
  const lignes = src.map((l, i) => {
    const description = String(l?.description || "").trim().slice(0, 300);
    const quantite = Number(l?.quantite), prix = Number(l?.prix_unitaire);
    if (!description) throw new Error(`Ligne ${i + 1} : décrivez le service ou le véhicule.`);
    if (!(quantite > 0 && quantite <= 10000)) throw new Error(`Ligne ${i + 1} : quantité invalide.`);
    if (!(prix >= 0 && prix <= 10_000_000)) throw new Error(`Ligne ${i + 1} : prix unitaire invalide.`);
    return { description, quantite: arrondi2(quantite), prix_unitaire: arrondi2(prix) };
  });
  const frais = b.frais_supplementaires === "" || b.frais_supplementaires == null ? 0 : Number(b.frais_supplementaires);
  if (!(frais >= 0 && frais <= 10_000_000)) throw new Error("Frais supplémentaires invalides.");
  // Date d'expiration (AAAA-MM-JJ) : par défaut aujourd'hui + 30 jours ; fin de journée à Port-au-Prince
  let expire_le;
  if (b.expire_le) {
    const j = String(b.expire_le).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(j) || isNaN(new Date(j))) throw new Error("Date d'expiration invalide.");
    expire_le = new Date(`${j}T23:59:59-05:00`);
    if (expire_le.getTime() < Date.now()) throw new Error("La date d'expiration doit être aujourd'hui ou plus tard.");
  } else expire_le = new Date(Date.now() + VALIDITE_JOURS() * 86400e3);
  return { client_nom: nom, client_email: email, client_tel: tel, lignes, frais_supplementaires: arrondi2(frais), total_usd: totalDevis(lignes, frais), expire_le };
}
export const totalDevis = (lignes, frais) => arrondi2(lignes.reduce((s, l) => s + arrondi2(l.quantite * l.prix_unitaire), 0) + Number(frais || 0));

const NOIR = "#0B0B0C", ROUGE = "#C8102E", GRIS = "#5B5F66", FILET = "#E5E7EB", FOND = "#F7F7F8"; // palette Elite Auto Deal
const LOGO = new URL("../public/logo-email.png", import.meta.url).pathname;

/** Retourne un Buffer PDF (A4). */
export function genererPdf(d) {
  return new Promise((ok, ko) => {
    const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: `Devis ${d.numero}`, Author: "Elite Auto Deal", Subject: `Devis pour ${d.client_nom}` } });
    const morceaux = []; doc.on("data", c => morceaux.push(c)); doc.on("end", () => ok(Buffer.concat(morceaux))); doc.on("error", ko);
    const L = 48, R = 595.28 - 48, W = R - L;
    const bandeau = () => {
      doc.rect(0, 0, 595.28, 92).fill(NOIR); doc.rect(0, 92, 595.28, 4).fill(ROUGE);
      if (existsSync(LOGO)) doc.image(LOGO, L, 26, { width: 150 }); else doc.fillColor("#fff").font("Helvetica-Bold").fontSize(20).text("ELITE AUTO DEAL", L, 34);
      doc.fillColor("#fff").font("Helvetica-Bold").fontSize(26).text("DEVIS", L, 28, { width: W, align: "right" });
      doc.fillColor("#C9C9CC").font("Helvetica").fontSize(10).text(d.numero, L, 60, { width: W, align: "right" });
    };
    bandeau();
    const date = new Date(d.cree_le || Date.now()).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    let y = 122;
    doc.fillColor(GRIS).font("Helvetica-Bold").fontSize(8.5).text("ÉMETTEUR", L, y).text("CLIENT", L + W / 2 + 10, y);
    doc.fillColor(NOIR).font("Helvetica-Bold").fontSize(11).text("Elite Auto Deal", L, y + 14, { width: W / 2 - 10 }).text(d.client_nom, L + W / 2 + 10, y + 14, { width: W / 2 - 10 });
    doc.fillColor("#333").font("Helvetica").fontSize(9.5);
    const emetteur = ["33, Rue Faustin 1er, Delmas 33", "Port-au-Prince, Haïti", "+509 4240 5729", process.env.EMAIL_EXPEDITEUR || "", "eliteautodeal.com"].filter(Boolean);
    const client = [d.client_email, d.client_tel].filter(Boolean);
    doc.text(emetteur.join("\n"), L, y + 31, { width: W / 2 - 10, lineGap: 2 });
    doc.text(client.join("\n") || " ", L + W / 2 + 10, y + 31, { width: W / 2 - 10, lineGap: 2 });
    y += 31 + 5 * 14 + 14;
    doc.fillColor(GRIS).font("Helvetica").fontSize(9.5).text(`Date d'émission : ${date}`, L, y);
    if (d.expire_le) doc.text(`Valable jusqu'au ${new Date(d.expire_le).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Port-au-Prince" })}`, L, y, { width: W, align: "right" });
    y += 26;

    const col = { desc: L + 10, qte: L + W * 0.56, pu: L + W * 0.67, tot: L + W * 0.84 }, largeurs = { desc: W * 0.54 - 14, qte: W * 0.09, pu: W * 0.15, tot: W * 0.16 - 10 };
    const entete = () => {
      doc.rect(L, y, W, 26).fill(NOIR); doc.fillColor("#fff").font("Helvetica-Bold").fontSize(9);
      doc.text("DESCRIPTION", col.desc, y + 9, { width: largeurs.desc }); doc.text("QTÉ", col.qte, y + 9, { width: largeurs.qte, align: "right" });
      doc.text("PRIX UNIT.", col.pu, y + 9, { width: largeurs.pu, align: "right" }); doc.text("TOTAL", col.tot, y + 9, { width: largeurs.tot, align: "right" });
      y += 26;
    };
    entete();
    const ligne = (desc, qte, pu, tot, pair, gras) => {
      doc.font(gras ? "Helvetica-Bold" : "Helvetica").fontSize(10);
      const h = Math.max(26, doc.heightOfString(desc, { width: largeurs.desc }) + 16);
      if (y + h > 760) { doc.addPage(); bandeau(); y = 122; entete(); }
      if (pair) doc.rect(L, y, W, h).fill(FOND);
      doc.fillColor(NOIR).text(desc, col.desc, y + 8, { width: largeurs.desc });
      if (qte != null) doc.text(String(qte).replace(".", ","), col.qte, y + 8, { width: largeurs.qte, align: "right" });
      if (pu != null) doc.text(montant(pu), col.pu, y + 8, { width: largeurs.pu, align: "right" });
      doc.font("Helvetica-Bold").text(montant(tot), col.tot, y + 8, { width: largeurs.tot, align: "right" });
      doc.moveTo(L, y + h).lineTo(R, y + h).lineWidth(0.5).strokeColor(FILET).stroke();
      y += h;
    };
    d.lignes.forEach((l, i) => ligne(l.description, l.quantite, l.prix_unitaire, l.quantite * l.prix_unitaire, i % 2 === 1));
    if (Number(d.frais_supplementaires) > 0) ligne("Frais supplémentaires", null, null, d.frais_supplementaires, d.lignes.length % 2 === 1);

    if (y + 90 > 780) { doc.addPage(); bandeau(); y = 122; }
    y += 16;
    doc.rect(L + W * 0.5, y, W * 0.5, 46).fill(ROUGE);
    doc.fillColor("#fff").font("Helvetica-Bold").fontSize(11).text("TOTAL À PAYER", L + W * 0.5 + 14, y + 17, { width: W * 0.25 });
    doc.fontSize(17).text(montant(d.total_usd), L + W * 0.5, y + 14, { width: W * 0.5 - 14, align: "right" });
    y += 70;
    doc.fillColor(GRIS).font("Helvetica").fontSize(8.5).text("Montants en dollars américains (USD).", L, y, { width: W, lineGap: 2 });
    doc.rect(0, 812, 595.28, 30).fill(NOIR);
    doc.fillColor("#C9C9CC").font("Helvetica").fontSize(8.5).text("Elite Auto Deal · Delmas 33, Port-au-Prince, Haïti · +509 4240 5729 · eliteautodeal.com", L, 822, { width: W, align: "center" });
    doc.end();
  });
}
