"""Reconstruit public/index.html et public/admin.html depuis les sources.
Usage : python3 sources/build.py (depuis la racine du projet)."""
from pathlib import Path
S = Path(__file__).resolve().parent
P = S.parent / "public"
car = (S / "brand/car.path").read_text(); txt = (S / "brand/text.path").read_text()
site = (S / "site.src.html").read_text().replace("__CAR__", car).replace("__TXT__", txt).replace("__VITRINE_JSON__", (S / "photos/vitrine.json").read_text())
(P / "index.html").write_text(site)
logo = f'<path fill="currentColor" fill-rule="evenodd" d="{car}"/><path fill="currentColor" fill-rule="evenodd" d="{txt}"/>'
(P / "admin.html").write_text((S / "admin.src.html").read_text().replace("__LOGO__", logo).replace("__MARK__", car))
print("public/index.html et public/admin.html reconstruits")
