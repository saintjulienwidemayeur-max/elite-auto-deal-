// Vraies URL par page : titre, description, canonical, Open Graph, JSON-LD et vue initiale injectés côté serveur.
import { readFileSync } from "node:fs";
import path from "node:path";

export const SITE = (process.env.SITE_URL || "https://eliteautodeal.com").replace(/\/$/, "");
// vue (nom interne) -> chemin
export const CHEMINS = {
  accueil: "/", vehicules: "/vehicules", precommande: "/precommande", achat: "/acheter", consultation: "/consultation",
  recherche: "/recherche-vehicule", essai: "/essai-visite", vendre: "/vendre-mon-vehicule", financement: "/financement",
  suivi: "/suivi-dossier", conditions: "/conditions", retour: "/retour-paiement", compte: "/mon-espace", "compte-dossier": "/mon-espace/dossier",
};
export const CHEMINS_FIXES = Object.values(CHEMINS);
const NOINDEX = new Set(["retour", "compte", "compte-dossier", "devis"]);
const STATUT_LIB = { disponible: "Disponible en Haïti", transit: "En transit", precommande: "Disponible en précommande", vendu: "Vendu", indisponible: "Indisponible" };
const DISPO = { disponible: "https://schema.org/InStock", transit: "https://schema.org/PreOrder", precommande: "https://schema.org/PreOrder", vendu: "https://schema.org/SoldOut", indisponible: "https://schema.org/OutOfStock" };

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = n => `${Math.round(Number(n)).toLocaleString("fr-FR").replace(/[  ]/g, " ")} $`;

// Tarifs : le HTML contient des repères {{T:cle}} (« 50 $ ») et {{N:cle}} (« 50 ») remplacés par les tarifs enregistrés dans l'administration.
const nombre = n => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, " ");
export const remplacerTarifs = (txt, t) => txt.replace(/\{\{([TN]):([a-z_]+)\}\}/g, (m, type, cle) => t[cle] == null ? m : type === "T" ? `${nombre(t[cle])} $` : String(Number(t[cle])));

let MODELE = null; // public/index.html lu une fois
const modele = dossier => MODELE ??= readFileSync(path.join(dossier, "index.html"), "utf8");

// Métadonnées de chaque page (les tarifs viennent de la base : jamais de prix en dur)
function meta(vue, t) {
  const m = {
    accueil: ["Elite Auto Deal — Véhicules, précommandes et services automobiles en Haïti", "Elite Auto Deal : véhicules sélectionnés, précommandes, financement, recherche personnalisée et vente accompagnée à Delmas, Port-au-Prince, Haïti."],
    vehicules: ["Véhicules à Port-au-Prince : en Haïti, en transit et en précommande | Elite Auto Deal", "Parcourez les véhicules d'Elite Auto Deal à Delmas, Port-au-Prince : déjà en Haïti, en transit ou à précommander. Prix, kilométrage et statut affichés avant tout paiement."],
    precommande: ["Précommander un véhicule en Haïti : 90 % maintenant, 10 % à l'arrivée | Elite Auto Deal", "Précommandez un véhicule publié par Elite Auto Deal : vous versez 90 % du prix en ligne, suivez l'expédition et réglez les 10 % restants à l'arrivée en Haïti."],
    achat: ["Acheter un véhicule à Port-au-Prince : comptant ou financement | Elite Auto Deal", "Achetez un véhicule disponible en Haïti, au comptant ou avec un dossier de financement. Réservez une visite ou un essai avec Elite Auto Deal à Delmas."],
    consultation: [`Consultation automobile à Delmas, Port-au-Prince — ${usd(t.consultation)} | Elite Auto Deal`, `Un échange personnalisé pour choisir le bon véhicule, définir votre budget et vos critères. ${usd(t.consultation)} de frais de service : accompagnement, analyse, préparation des documents, démarches administratives et suivi.`],
    recherche: [`Recherche et achat accompagné de véhicule en Haïti — dossier à ${usd(t.recherche)} | Elite Auto Deal`, `Vous souhaitez acheter un véhicule mais manquez de temps ou ne savez pas où chercher ? Elite Auto Deal s'occupe de tout pour vous. ${usd(t.recherche)} de frais de dossier à l'ouverture ; ${usd(t.service_recherche)} de frais de service seulement lorsque le véhicule est trouvé.`],
    essai: [`Visite ou essai routier d'un véhicule à Port-au-Prince — ${usd(t.essai)} | Elite Auto Deal`, `Réservez la visite, l'essai routier ou l'inspection d'un véhicule disponible en Haïti, avec confirmation du rendez-vous selon sa disponibilité réelle. ${usd(t.essai)} de frais de service, pas un acompte.`],
    vendre: [`Vendre mon véhicule en Haïti avec Elite Auto Deal — ${usd(t.vendre)} | Elite Auto Deal`, `Confiez-nous la vente de votre véhicule : photos, vidéos et fiche détaillée, puis vérification avant toute publication. ${usd(t.vendre)}, non remboursable.`],
    financement: [`Financement automobile en Haïti : dossier à ${usd(t.financement)} | Elite Auto Deal`, `Ouvrez un dossier de financement automobile pour ${usd(t.financement)} (ou l'équivalent en gourdes). L'approbation n'est pas garantie. Elite Auto Deal, Delmas, Port-au-Prince.`],
    suivi: ["Suivre mon dossier | Elite Auto Deal", "Suivez l'avancement de votre demande Elite Auto Deal avec votre référence : paiement, étapes et prochaines actions."],
    conditions: ["Conditions des services : frais, remboursement, précommande | Elite Auto Deal", "Conditions des services Elite Auto Deal : frais de service, remboursement, précommande, paiements et données personnelles."],
    devis: ["Votre devis | Elite Auto Deal", "Consultez et réglez votre devis Elite Auto Deal en ligne."],
    retour: ["Retour de paiement | Elite Auto Deal", "Statut de votre paiement Elite Auto Deal."],
    compte: ["Mon espace | Elite Auto Deal", "Connectez-vous à votre espace client Elite Auto Deal."],
    "compte-dossier": ["Mon dossier | Elite Auto Deal", "Détail de votre dossier Elite Auto Deal."],
  };
  return m[vue] || m.accueil;
}

const SERVICES_LD = { consultation: "Consultation automobile", recherche: "Recherche ou achat accompagné de véhicule", essai: "Visite ou essai d'un véhicule", vendre: "Vente accompagnée de votre véhicule", financement: "Dossier de financement automobile" };

function jsonLd(modeleJson, { vue, chemin, titre, description, tarifs, vehicule }) {
  const url = SITE + (chemin === "/" ? "/" : chemin);
  const g = modeleJson["@graph"].filter(x => x["@type"] !== "WebPage" && x["@type"] !== "FAQPage" || (vue === "accueil" && x["@type"] === "FAQPage"));
  const fil = [{ "@type": "ListItem", position: 1, name: "Accueil", item: SITE + "/" }];
  if (vue === "vehicule") { fil.push({ "@type": "ListItem", position: 2, name: "Véhicules", item: SITE + "/vehicules" }, { "@type": "ListItem", position: 3, name: `${vehicule.marque} ${vehicule.modele}`, item: url }); }
  else if (vue !== "accueil") fil.push({ "@type": "ListItem", position: 2, name: titre.split(/ [—|] /)[0], item: url });
  g.push({ "@type": vue === "vehicule" ? "ItemPage" : "WebPage", "@id": url + "#webpage", url, name: titre, description, isPartOf: { "@id": SITE + "/#website" }, about: { "@id": SITE + "/#business" }, breadcrumb: { "@id": url + "#fil" }, inLanguage: "fr", primaryImageOfPage: { "@type": "ImageObject", url: SITE + "/og-image.png", width: 1200, height: 630 } });
  g.push({ "@type": "BreadcrumbList", "@id": url + "#fil", itemListElement: fil });
  if (SERVICES_LD[vue]) g.push({ "@type": "Service", "@id": url + "#service", name: SERVICES_LD[vue], serviceType: SERVICES_LD[vue], description, provider: { "@id": SITE + "/#business" }, areaServed: { "@type": "City", name: "Port-au-Prince" }, offers: { "@type": "Offer", price: String(tarifs[vue]), priceCurrency: "USD", url } });
  if (vue === "vehicule") {
    const v = vehicule;
    g.push({ "@type": "Car", "@id": url + "#vehicule", name: `${v.marque} ${v.modele}`, brand: { "@type": "Brand", name: v.marque }, model: v.modele, vehicleModelDate: v.annee ? String(v.annee) : undefined, color: v.couleur || undefined,
      mileageFromOdometer: v.km != null ? { "@type": "QuantitativeValue", value: v.km, unitCode: "KMT" } : undefined, vehicleEngine: v.moteur ? { "@type": "EngineSpecification", name: v.moteur } : undefined,
      vehicleTransmission: v.trans || undefined, driveWheelConfiguration: v.traction || undefined, vehicleSeatingCapacity: v.places || undefined, description,
      image: v.photos?.length ? v.photos.map(p => SITE + p) : [SITE + "/og-image.png"],
      offers: v.prix != null ? { "@type": "Offer", price: String(v.prix), priceCurrency: "USD", availability: DISPO[v.statut] || DISPO.disponible, url, seller: { "@id": SITE + "/#business" } } : undefined });
  }
  return JSON.stringify({ "@context": "https://schema.org", "@graph": g }, null, 1).replace(/</g, "\\u003c");
}

/** Retourne le HTML complet de la page. `vehicule` n'est utilisé que pour la vue « vehicule ». */
export function pageHtml(dossierPublic, vue, { tarifs, vehicule, chemin, noindex: forcer, vitrine }) {
  let html = remplacerTarifs(modele(dossierPublic), tarifs);
  let [titre, description] = meta(vue === "vehicule" ? "vehicules" : vue, tarifs);
  if (vue === "vehicule") {
    const v = vehicule, nom = [v.marque, v.modele, v.annee && !String(v.modele).includes(String(v.annee)) ? v.annee : ""].filter(Boolean).join(" ");
    titre = `${nom}${v.prix != null ? ` — ${usd(v.prix)}` : ""} à Port-au-Prince | Elite Auto Deal`;
    description = [`${nom} : ${(STATUT_LIB[v.statut] || "").toLowerCase()}.`, v.km != null ? `${Number(v.km).toLocaleString("fr-FR").replace(/[  ]/g, " ")} km.` : "", v.couleur ? `Couleur ${v.couleur.toLowerCase()}.` : "", [v.moteur, v.trans, v.traction].filter(Boolean).join(", ") + (v.moteur || v.trans || v.traction ? "." : ""), v.prix != null ? `Prix : ${usd(v.prix)}.` : "", "Elite Auto Deal, Delmas, Port-au-Prince."].filter(Boolean).join(" ");
  }
  const url = SITE + (chemin === "/" ? "/" : chemin), noindex = forcer || NOINDEX.has(vue);
  const rem = (re, par) => { if (!re.test(html)) console.warn("[seo] motif introuvable :", re); html = html.replace(re, () => par); };
  rem(/<title>[^<]*<\/title>/, `<title>${esc(titre)}</title>`);
  rem(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`);
  rem(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${esc(url)}">`);
  rem(/<link rel="alternate" hreflang="fr" href="[^"]*">/, `<link rel="alternate" hreflang="fr" href="${esc(url)}">`);
  rem(/<link rel="alternate" hreflang="x-default" href="[^"]*">/, `<link rel="alternate" hreflang="x-default" href="${esc(url)}">`);
  rem(/<meta name="robots" content="[^"]*">/, noindex ? `<meta name="robots" content="noindex,nofollow">` : `<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1">`);
  rem(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${esc(url)}">`);
  rem(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(titre)}">`);
  rem(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(description)}">`);
  rem(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${esc(titre)}">`);
  rem(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(description)}">`);
  if (vue === "vehicule" && vehicule.photos?.length) {
    const img = esc(SITE + vehicule.photos[0]);
    html = html.replace(/<meta property="og:image" content="[^"]*">/, () => `<meta property="og:image" content="${img}">`).replace(/<meta property="og:image:secure_url" content="[^"]*">/, () => `<meta property="og:image:secure_url" content="${img}">`)
      .replace(/<meta name="twitter:image" content="[^"]*">/, () => `<meta name="twitter:image" content="${img}">`).replace(/<meta property="og:image:(width|height|type)" content="[^"]*">\n?/g, "");
  }
  // JSON-LD : on part du graphe de base de la page, on l'adapte à la page demandée
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/;
  const base = JSON.parse(html.match(re)[1]);
  html = html.replace(re, () => `<script type="application/ld+json">\n${jsonLd(base, { vue, chemin, titre, description, tarifs, vehicule })}\n</script>`);
  // diapositives de la première page (données injectées : pas d'appel réseau supplémentaire)
  html = html.replace("</head>", () => `<script>window.__VITRINE__=${JSON.stringify(vitrine || []).replace(/</g, "\\u003c")};</script>\n</head>`);
  // vue initiale visible dès le premier affichage (et pour les robots sans JavaScript)
  const cible = vue === "vehicule" ? "vehicule" : vue;
  html = html.replace(new RegExp(`<div class="vue" data-vue="${cible}">`), () => `<div class="vue active" data-vue="${cible}">`);
  if (vue === "vehicule") { // fiche lisible sans JavaScript, remplacée par le rendu dynamique
    const v = vehicule, li = [["Année", v.annee], ["Kilométrage", v.km != null ? `${Number(v.km).toLocaleString("fr-FR")} km` : null], ["Moteur", v.moteur], ["Transmission", v.trans], ["Traction", v.traction], ["Couleur", v.couleur], ["Places", v.places], ["Statut", STATUT_LIB[v.statut]], ["Prix", v.prix != null ? usd(v.prix) : null]].filter(x => x[1] != null && x[1] !== "");
    html = html.replace('<div class="detail" id="detail"></div>', () => `<div class="detail" id="detail"><h2>${esc(v.marque)} ${esc(v.modele)}</h2><ul>${li.map(([k, x]) => `<li><b>${esc(k)} :</b> ${esc(x)}</li>`).join("")}</ul></div>`);
  }
  return html;
}

export function sitemapXml(vehicules) {
  const hors = new Set(["retour", "compte", "compte-dossier"]);
  const fixes = Object.entries(CHEMINS).filter(([v]) => !hors.has(v)).map(([v, c]) => `  <url><loc>${SITE}${c}</loc><changefreq>${v === "accueil" || v === "vehicules" ? "weekly" : "monthly"}</changefreq><priority>${v === "accueil" ? "1.0" : v === "vehicules" ? "0.9" : v === "conditions" || v === "suivi" ? "0.3" : "0.8"}</priority>${v === "accueil" ? `<image:image><image:loc>${SITE}/og-image.png</image:loc><image:title>Elite Auto Deal</image:title></image:image>` : ""}</url>`);
  const vs = vehicules.map(v => `  <url><loc>${SITE}/vehicules/${encodeURIComponent(v.id)}</loc>${v.maj_le ? `<lastmod>${new Date(v.maj_le).toISOString()}</lastmod>` : ""}<changefreq>weekly</changefreq><priority>0.7</priority></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${[...fixes, ...vs].join("\n")}\n</urlset>\n`;
}
