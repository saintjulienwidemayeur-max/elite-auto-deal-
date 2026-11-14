// Envoi d'emails transactionnels via Brevo (https://developers.brevo.com/reference/sendtransacemail)
// Sans BREVO_API_KEY, rien n'est envoyé : l'application continue de fonctionner (le code est seulement journalisé hors production).
const API = (process.env.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email");
const expediteur = () => ({ name: process.env.EMAIL_EXPEDITEUR_NOM || "Elite Auto Deal", email: process.env.EMAIL_EXPEDITEUR || "" });
export const emailConfigure = () => !!process.env.BREVO_API_KEY && !!process.env.EMAIL_EXPEDITEUR;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function envoyerEmail({ a, nom, sujet, html, texte, pieces }) {
  if (!emailConfigure()) { console.warn(`[email] Brevo non configuré : "${sujet}" non envoyé à ${a}`); return false; }
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: expediteur(), to: [{ email: a, name: nom || undefined }], subject: sujet, htmlContent: html, textContent: texte, attachment: pieces?.length ? pieces.map(p => ({ name: p.nom, content: p.contenu.toString("base64") })) : undefined }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { console.error(`[email] Brevo a refusé (${r.status}) : ${(await r.text()).slice(0, 300)}`); return false; }
    return true;
  } catch (e) { console.error("[email] échec d'envoi :", e.message); return false; }
}

const NOIR = "#0B0B0C", ROUGE = "#D7191F", GRIS = "#6E6E75", FOND = "#F6F6F4";
const publicUrl = () => (process.env.PUBLIC_URL || "").replace(/\/$/, "");
// Logo : image PNG blanche hébergée par vous (EMAIL_LOGO_URL). Sans elle, le nom de la marque s'affiche en texte.
const urlLogo = () => process.env.EMAIL_LOGO_URL || (publicUrl().startsWith("https://") ? `${publicUrl()}/logo-email.png` : "");
const enTete = () => urlLogo()
  ? `<img src="${esc(urlLogo())}" width="190" alt="Elite Auto Deal" style="display:block;border:0;outline:none;height:auto;max-width:190px">`
  : `<span style="font-size:22px;font-weight:bold;letter-spacing:2px;color:#fff;text-transform:uppercase">Elite Auto Deal</span>`;

const cadre = (titre, corps, apercu = "") => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(titre)}</title></head>
<body style="margin:0;padding:0;background:${FOND};font-family:Arial,Helvetica,sans-serif;color:${NOIR};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${FOND}">${esc(apercu)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${FOND}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">
<tr><td style="background:${NOIR};padding:26px 30px;border-radius:12px 12px 0 0">${enTete()}</td></tr>
<tr><td style="background:${ROUGE};height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>
<tr><td style="background:#fff;padding:34px 30px 30px;font-size:16px;line-height:1.6;color:#222">
<h1 style="margin:0 0 18px;font-size:24px;line-height:1.25;color:${NOIR}">${titre}</h1>${corps}</td></tr>
<tr><td style="background:#fff;padding:0 30px"><div style="border-top:1px solid #ececec"></div></td></tr>
<tr><td style="background:#fff;padding:20px 30px 26px;font-size:13px;line-height:1.55;color:${GRIS};border-radius:0 0 12px 12px">
<b style="color:${NOIR}">Elite Auto Deal</b><br>Véhicules, précommandes et services automobiles en Haïti<br>
<a href="mailto:${esc(process.env.EMAIL_EXPEDITEUR || "")}" style="color:${GRIS}">${esc(process.env.EMAIL_EXPEDITEUR || "")}</a>${publicUrl() ? ` · <a href="${esc(publicUrl())}" style="color:${GRIS}">${esc(publicUrl().replace(/^https?:\/\//, ""))}</a>` : ""}</td></tr>
<tr><td style="padding:18px 10px;font-size:12px;line-height:1.5;color:#9a9aa0;text-align:center">Vous recevez ce message parce qu'un compte Elite Auto Deal utilise cette adresse email. Si ce n'est pas vous, vous pouvez l'ignorer.</td></tr>
</table></td></tr></table></body></html>`;

const blocCode = code => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr><td align="center" style="background:${FOND};border:1px solid #e4e4e0;border-radius:10px;padding:20px 12px">
<div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${GRIS};margin-bottom:8px">Votre code</div>
<div style="font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:bold;letter-spacing:10px;color:${NOIR};padding-left:10px">${esc(code)}</div>
<div style="font-size:13px;color:${GRIS};margin-top:10px">Valable 10 minutes</div></td></tr></table>`;

const bouton = (url, libelle) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr><td style="background:${ROUGE};border-radius:8px"><a href="${esc(url)}" style="display:inline-block;padding:14px 26px;color:#fff;text-decoration:none;font-weight:bold;font-size:16px">${esc(libelle)}</a></td></tr></table>`;

const avantage = (t, d) => `<tr><td width="26" valign="top" style="padding:7px 0;color:${ROUGE};font-size:18px;font-weight:bold">&#10003;</td><td style="padding:7px 0;font-size:15px"><b>${t}</b><br><span style="color:${GRIS}">${d}</span></td></tr>`;

export function emailBienvenue({ nom, code, publicUrl: url, whatsapp }) {
  const prenom = esc(String(nom).trim().split(/\s+/)[0]);
  return {
    sujet: "Bienvenue chez Elite Auto Deal",
    html: cadre(`Bienvenue, ${prenom} !`, `<p style="margin:0 0 14px">Votre espace Elite Auto Deal est créé. Voici ce que vous pouvez y faire :</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 6px">${avantage("Suivre vos dossiers", "L'avancement de chaque demande, étape par étape.")}${avantage("Retrouver vos reçus", "Vos paiements confirmés, consultables à tout moment.")}${avantage("Envoyer vos documents", "Photos et pièces depuis votre téléphone.")}</table>
      ${code ? `<p style="margin:22px 0 0">Pour confirmer votre adresse email, saisissez ce code dans votre espace :</p>${blocCode(code)}` : ""}
      ${bouton(`${url}/mon-espace`, "Ouvrir mon espace")}
      <p style="margin:22px 0 0;color:${GRIS};font-size:14px">Une question ? Écrivez-nous sur WhatsApp${whatsapp ? ` au <b style="color:${NOIR}">+${esc(whatsapp)}</b>` : ""}.</p>`,
      "Votre espace est prêt : suivez vos dossiers, vos reçus et vos documents."),
    texte: `Bienvenue, ${String(nom).trim().split(/\s+/)[0]} ! Votre espace Elite Auto Deal est créé.${code ? ` Code de confirmation de votre email (10 minutes) : ${code}.` : ""} Ouvrir mon espace : ${url}/mon-espace`,
  };
}

export function emailCode({ code, finalite }) {
  const reinit = finalite === "reinit";
  const titre = reinit ? "Réinitialiser votre mot de passe" : "Confirmer votre adresse email";
  return {
    sujet: `${code} : votre code Elite Auto Deal`,
    html: cadre(titre, `<p style="margin:0">${reinit ? "Vous avez demandé à changer votre mot de passe. Saisissez ce code dans votre espace pour en choisir un nouveau." : "Saisissez ce code dans votre espace pour confirmer votre adresse email."}</p>${blocCode(code)}
      <p style="margin:0 0 6px;font-size:14px;color:${GRIS}"><b style="color:${NOIR}">Ne partagez ce code avec personne</b>, pas même avec un conseiller Elite Auto Deal.${reinit ? " Si vous n'avez rien demandé, ignorez cet email : votre mot de passe reste inchangé." : ""}</p>`,
      `Votre code : ${code} (valable 10 minutes)`),
    texte: `${titre} : votre code est ${code} (valable 10 minutes). Ne le partagez avec personne.`,
  };
}

export function emailDevis({ nom, numero, total, publicUrl: url, whatsapp }) {
  const prenom = esc(String(nom).trim().split(/\s+/)[0]);
  return {
    sujet: `Votre devis ${numero} — Elite Auto Deal`,
    html: cadre(`Votre devis ${esc(numero)}`, `<p style="margin:0 0 14px">Bonjour ${prenom},</p>
      <p style="margin:0 0 14px">Merci de votre confiance. Vous trouverez votre devis en pièce jointe (PDF).</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0"><tr><td align="center" style="background:${FOND};border:1px solid #e4e4e0;border-radius:10px;padding:18px 12px">
      <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${GRIS};margin-bottom:6px">Total du devis</div>
      <div style="font-size:30px;font-weight:bold;color:${NOIR}">${esc(total)}</div></td></tr></table>
      <p style="margin:0 0 6px;color:${GRIS};font-size:14px">Pour toute question ou pour confirmer ce devis, écrivez-nous sur WhatsApp${whatsapp ? ` au <b style="color:${NOIR}">+${esc(whatsapp)}</b>` : ""}.</p>
      ${url ? bouton(url, "Visiter Elite Auto Deal") : ""}`,
      `Votre devis ${numero} d'un montant de ${total}, en pièce jointe.`),
    texte: `Bonjour ${String(nom).trim().split(/\s+/)[0]}, voici votre devis ${numero} d'un montant de ${total} (PDF en pièce jointe). Elite Auto Deal.`,
  };
}
