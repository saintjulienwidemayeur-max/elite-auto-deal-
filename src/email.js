// Envoi d'emails transactionnels via Brevo (https://developers.brevo.com/reference/sendtransacemail)
// Sans BREVO_API_KEY, rien n'est envoyé : l'application continue de fonctionner (le code est seulement journalisé hors production).
const API = (process.env.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email");
const expediteur = () => ({ name: process.env.EMAIL_EXPEDITEUR_NOM || "Elite Auto Deal", email: process.env.EMAIL_EXPEDITEUR || "" });
export const emailConfigure = () => !!process.env.BREVO_API_KEY && !!process.env.EMAIL_EXPEDITEUR;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function envoyerEmail({ a, nom, sujet, html, texte }) {
  if (!emailConfigure()) { console.warn(`[email] Brevo non configuré : "${sujet}" non envoyé à ${a}`); return false; }
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: expediteur(), to: [{ email: a, name: nom || undefined }], subject: sujet, htmlContent: html, textContent: texte }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { console.error(`[email] Brevo a refusé (${r.status}) : ${(await r.text()).slice(0, 300)}`); return false; }
    return true;
  } catch (e) { console.error("[email] échec d'envoi :", e.message); return false; }
}

const cadre = (titre, corps) => `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px;overflow:hidden">
<tr><td style="background:#111;color:#fff;padding:18px 24px;font-size:18px;font-weight:bold">Elite Auto Deal</td></tr>
<tr><td style="padding:28px 24px;font-size:15px;line-height:1.55"><h1 style="margin:0 0 14px;font-size:20px">${titre}</h1>${corps}</td></tr>
<tr><td style="padding:16px 24px;font-size:12px;color:#777;border-top:1px solid #eee">Vous recevez ce message parce qu'un compte Elite Auto Deal utilise cette adresse. Si ce n'est pas vous, ignorez-le.</td></tr>
</table></td></tr></table></body></html>`;

const blocCode = code => `<p style="margin:18px 0;text-align:center"><span style="display:inline-block;letter-spacing:8px;font-size:30px;font-weight:bold;background:#f4f4f5;padding:12px 18px;border-radius:6px">${esc(code)}</span></p>`;

export function emailBienvenue({ nom, code, publicUrl, whatsapp }) {
  const prenom = esc(String(nom).trim().split(/\s+/)[0]);
  return {
    sujet: "Bienvenue chez Elite Auto Deal",
    html: cadre(`Bienvenue, ${prenom} !`, `<p>Votre espace Elite Auto Deal est créé. Vous y suivez l'avancement de vos dossiers, retrouvez vos reçus de paiement et ajoutez vos documents.</p>
      ${code ? `<p>Pour confirmer votre adresse email, saisissez ce code dans votre espace (valable 10 minutes) :</p>${blocCode(code)}` : ""}
      <p><a href="${esc(publicUrl)}/#compte" style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">Ouvrir mon espace</a></p>
      <p style="color:#555">Une question ? Écrivez-nous sur WhatsApp${whatsapp ? ` au +${esc(whatsapp)}` : ""}.</p>`),
    texte: `Bienvenue, ${String(nom).trim().split(/\s+/)[0]} ! Votre espace Elite Auto Deal est créé.${code ? ` Code de confirmation de votre email (10 min) : ${code}.` : ""} ${publicUrl}/#compte`,
  };
}

export function emailCode({ code, finalite }) {
  const reinit = finalite === "reinit";
  const titre = reinit ? "Réinitialiser votre mot de passe" : "Confirmer votre adresse email";
  return {
    sujet: `${code} : votre code Elite Auto Deal`,
    html: cadre(titre, `<p>${reinit ? "Utilisez ce code pour choisir un nouveau mot de passe." : "Utilisez ce code pour confirmer votre adresse email."} Il est valable 10 minutes.</p>${blocCode(code)}<p style="color:#555">Ne partagez ce code avec personne, pas même un conseiller Elite Auto Deal.</p>`),
    texte: `${titre} : votre code est ${code} (valable 10 minutes). Ne le partagez avec personne.`,
  };
}
