// Client Freda Pay Issuing (Payment Gateway) : https://issuing.fredapay.com/docs
import crypto from "node:crypto";

const BASE = (process.env.FREDA_API_BASE || "https://api.fredapay.com").replace(/\/$/, "");
const CLE = process.env.FREDA_SECRET_KEY || "";

export const modeFreda = () => (CLE.startsWith("sk_live_") ? "live" : "sandbox");
export const fredaConfiguree = () => /^sk_(test|live)_/.test(CLE);

export class ErreurFreda extends Error {
  constructor(message, statut, corps) { super(message); this.statut = statut; this.corps = corps; }
}

async function appel(methode, chemin, corps) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(BASE + chemin, {
      method: methode,
      headers: { Authorization: `Bearer ${CLE}`, "Content-Type": "application/json", Accept: "application/json" },
      body: corps ? JSON.stringify(corps) : undefined,
      signal: ctrl.signal,
    });
    const texte = await r.text();
    let json = null; try { json = texte ? JSON.parse(texte) : null; } catch { /* non JSON */ }
    if (!r.ok) {
      const msg = json?.error?.message || json?.message || `Freda Pay Issuing a répondu ${r.status}`;
      throw new ErreurFreda(msg, r.status, json || texte);
    }
    return json;
  } finally { clearTimeout(t); }
}

/**
 * Crée un paiement. methode : "moncash" ou "natcash" (HTG, envoyée telle quelle à Freda) ou "carte" (USD).
 * La référence est unique : la renvoyer retourne le paiement existant (idempotence côté Freda).
 */
export function creerPaiement({ methode, montant, reference, client_nom, client_email, return_url }) {
  if (methode === "carte") {
    return appel("POST", "/v1/payments", {
      amount: Number(montant.toFixed(2)), method: "carte", currency: "USD", reference,
      customer_name: client_nom || undefined, customer_email: client_email || undefined,
      return_url: return_url || undefined,
    });
  }
  return appel("POST", "/v1/payments", {
    amount: Math.round(montant), method: methode, currency: "HTG", reference,
  });
}

export const lirePaiement = id => appel("GET", `/v1/payments/${encodeURIComponent(id)}`);

/** Vérifie X-Freda-Signature: sha256=<hex> = HMAC-SHA256(corps brut, whsec_...). */
export function signatureValide(corpsBrut, entete, secret = process.env.FREDA_WEBHOOK_SECRET || "") {
  if (!secret || !entete || !Buffer.isBuffer(corpsBrut)) return false;
  const attendu = crypto.createHmac("sha256", secret).update(corpsBrut).digest("hex");
  const recu = String(entete).replace(/^sha256=/, "").trim();
  const a = Buffer.from(attendu), b = Buffer.from(recu);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
