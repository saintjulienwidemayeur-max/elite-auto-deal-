// Génère les icônes, le logo et l'image de partage dans public/ à partir du tracé de la marque.
// Usage (Playwright installé) : node sources/assets/generate.cjs  (depuis la racine du projet)
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "../.."), OUT = path.join(ROOT, "public");
const car = fs.readFileSync(path.join(ROOT, "sources/brand/car.path"), "utf8");
const txt = fs.readFileSync(path.join(ROOT, "sources/brand/text.path"), "utf8");
const NOIR = "#0B0B0C", ROUGE = "#D7191F";
const logo = c => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 207" role="img" aria-label="Elite Auto Deal"><title>Elite Auto Deal</title><path fill="${c}" fill-rule="evenodd" d="${car}"/><path fill="${c}" fill-rule="evenodd" d="${txt}"/></svg>`;
// Icône carrée 512 : silhouette de la voiture + filet rouge. `rond` = coins arrondis ; `s` = largeur de la voiture
const icone = (rond, s) => { const k = s / 680, h = 118 * k, x = (512 - s) / 2, y = (512 - h) / 2 - 14;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" ${rond ? 'rx="104"' : ""} fill="${NOIR}"/><path transform="translate(${x} ${y}) scale(${k})" fill="#fff" fill-rule="evenodd" d="${car}"/><rect x="${x}" y="${y + h + 22}" width="${s}" height="${Math.max(8, s / 40)}" rx="4" fill="${ROUGE}"/></svg>`; };
fs.writeFileSync(path.join(OUT, "logo.svg"), logo(NOIR));
fs.writeFileSync(path.join(OUT, "logo-blanc.svg"), logo("#fff"));
fs.writeFileSync(path.join(OUT, "favicon.svg"), icone(true, 420));
const og = `<body style="margin:0;width:1200px;height:630px;background:${NOIR};font-family:Inter,Arial,Helvetica,sans-serif;color:#fff;position:relative;overflow:hidden">
<div style="position:absolute;left:0;top:0;bottom:0;width:14px;background:${ROUGE}"></div>
<div style="position:absolute;left:90px;top:110px;width:620px">${logo("#fff")}</div>
<div style="position:absolute;left:90px;top:400px;font-size:46px;font-weight:800;line-height:1.15;max-width:900px">Véhicules, précommandes et services automobiles en Haïti</div>
<div style="position:absolute;left:90px;top:545px;font-size:26px;color:#C9C9CC;letter-spacing:1px">eliteautodeal.com &nbsp;·&nbsp; Delmas, Port-au-Prince</div></body>`;
(async () => {
  const b = await chromium.launch();
  const png = async (svg, taille, fichier) => { const p = await b.newPage({ viewport: { width: taille, height: taille } });
    await p.setContent(`<body style="margin:0;background:transparent"><img width="${taille}" height="${taille}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body>`);
    const buf = await p.screenshot({ omitBackground: true }); await p.close(); if (fichier) fs.writeFileSync(path.join(OUT, fichier), buf); return buf; };
  const rond = icone(true, 420), carre = icone(false, 420), sur = icone(false, 300);
  const ico = []; for (const t of [16, 32, 48]) ico.push([t, await png(rond, t)]);
  await png(rond, 192, "icon-192.png"); await png(rond, 512, "icon-512.png");
  await png(sur, 512, "icon-maskable-512.png"); await png(carre, 180, "apple-touch-icon.png");
  // favicon.ico : 3 images PNG
  const tete = Buffer.alloc(6); tete.writeUInt16LE(1, 2); tete.writeUInt16LE(ico.length, 4);
  let off = 6 + 16 * ico.length; const dir = [], data = [];
  for (const [t, buf] of ico) { const e = Buffer.alloc(16); e[0] = t; e[1] = t; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(off, 12); off += buf.length; dir.push(e); data.push(buf); }
  fs.writeFileSync(path.join(OUT, "favicon.ico"), Buffer.concat([tete, ...dir, ...data]));
  // logo blanc pour les emails (560 x 170)
  const pe = await b.newPage({ viewport: { width: 560, height: 170 } });
  await pe.setContent(`<body style="margin:0;background:transparent"><img width="560" height="170" src="data:image/svg+xml;base64,${Buffer.from(logo("#fff")).toString("base64")}"></body>`);
  fs.writeFileSync(path.join(OUT, "logo-email.png"), await pe.screenshot({ omitBackground: true }));
  const po = await b.newPage({ viewport: { width: 1200, height: 630 } }); await po.setContent(og);
  fs.writeFileSync(path.join(OUT, "og-image.png"), await po.screenshot());
  await b.close(); console.log("assets générés dans public/");
})();
