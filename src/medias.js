// Photos des véhicules : toutes ramenées au format 4:5 portrait, 1080 x 1350 px (idéal Instagram et Facebook).
// Sans déformation et sans rien couper : une photo qui n'est pas en 4:5 est posée entière, centrée, sur un fond flou de la même photo.
import sharp from "sharp";
import os from "node:os";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import crypto from "node:crypto";

export const LARGEUR = 1080, HAUTEUR = 1350; // 4:5

export async function photo45(fichierTemp) {
  const { data, info } = await sharp(fichierTemp, { failOn: "none" }).rotate().toBuffer({ resolveWithObject: true }); // applique l'orientation EXIF
  const ratio = info.width / info.height;
  let sortie;
  if (Math.abs(ratio - LARGEUR / HAUTEUR) <= 0.015) { // déjà en 4:5 (à 1,5 % près)
    sortie = sharp(data).resize(LARGEUR, HAUTEUR, { fit: "cover" });
  } else {
    const fond = await sharp(data).resize(LARGEUR, HAUTEUR, { fit: "cover" }).blur(38).modulate({ brightness: 0.92 }).toBuffer();
    const premierPlan = await sharp(data).resize(LARGEUR, HAUTEUR, { fit: "inside", withoutEnlargement: false }).toBuffer();
    sortie = sharp(fond).composite([{ input: premierPlan, gravity: "centre" }]);
  }
  const buf = await sortie.webp({ quality: 90, effort: 4 }).toBuffer();
  const chemin = path.join(os.tmpdir(), `ead-${crypto.randomBytes(6).toString("hex")}.webp`);
  await writeFile(chemin, buf);
  return { chemin, type: "image/webp", taille: buf.length };
}
