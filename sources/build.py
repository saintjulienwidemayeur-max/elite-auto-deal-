"""Reconstruit public/index.html et public/admin.html depuis les sources.
Usage : python3 sources/build.py (depuis la racine du projet)."""
from pathlib import Path
S = Path(__file__).resolve().parent
P = S.parent / "public"
car = (S / "brand/car.path").read_text(); txt = (S / "brand/text.path").read_text()
import re
CHEMINS = {"accueil": "/", "vehicules": "/vehicules", "precommande": "/precommande", "achat": "/acheter", "consultation": "/consultation", "recherche": "/recherche-vehicule", "essai": "/essai-visite", "vendre": "/vendre-mon-vehicule", "financement": "/financement", "suivi": "/suivi-dossier", "conditions": "/conditions", "retour": "/retour-paiement", "compte": "/mon-espace", "compte-dossier": "/mon-espace/dossier"}
def vraies_url(html):  # href="#vue" -> href="/chemin" (liens crawlables ; le JS gère la navigation sans rechargement)
    return re.sub(r'href="#([a-z-]+)"', lambda m: f'href="{CHEMINS[m.group(1)]}"' if m.group(1) in CHEMINS else m.group(0), html)
site = (S / "site.src.html").read_text().replace("__CAR__", car).replace("__TXT__", txt).replace("__VITRINE_JSON__", (S / "photos/vitrine.json").read_text())
(P / "index.html").write_text(vraies_url(site))
logo = f'<path fill="currentColor" fill-rule="evenodd" d="{car}"/><path fill="currentColor" fill-rule="evenodd" d="{txt}"/>'
(P / "admin.html").write_text((S / "admin.src.html").read_text().replace("__LOGO__", logo).replace("__MARK__", car))
print("public/index.html et public/admin.html reconstruits")
