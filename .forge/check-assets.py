#!/usr/bin/env python
r"""Změří assety hry proti specu a pojmenuje vady, které vidí člověk.

PROČ TO EXISTUJE: pipeline uměla ověřit, že něco FUNGUJE (testy, běh, mapa),
ale ne že to VYPADÁ dobře. Naměřeno na skutečné hře: mince 30 px vs truhla
45 px (mince měla 67 % šířky truhly), hráč jen 0,87× šířky truhly, animace
chůze měnila mezi framy pohled (shoda siluet 21–41 %, správná chůze má 70–95 %)
a v truhle prosvítalo pozadí dírou uvnitř siluety. Všechno to prošlo, protože
se to nikde neměřilo.

Spec (`assets/spec.json`) je ta chybějící část: čísla, která drží vzhled
pohromadě. Tenhle nástroj je vynucuje – a je použitelný i v CI, takže se
„ošklivý" asset nedostane do hry.

Použití:
    python tools/check-assets.py <projekt nebo repo> [--json]
Návratový kód: 0 = v pořádku, 1 = nalezené vady, 2 = chybí spec/assety.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

# Windows konzole umí cp1252 a na české výpisy („výška postavy", „děry") by
# spadla na UnicodeEncodeError. Nástroj se proto ptá na UTF-8 výstup sám.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _nacti_spec(target: Path) -> dict | None:
    """Spec hry; když v repu není, zkusí výchozí z pipeline (mimo ni vrátí None).

    POZOR: v CI (GitHub Actions) pipeline není – dřív by `import packs` spadl na
    ImportError a kontrola by skončila tracebackem. Hra bez `assets/spec.json`
    je ale sama o sobě chyba: spec je součástí hry (zapisuje ho `forge pack
    install`), takže chybějící spec = jasná zpráva, ne výjimka.
    """
    cesta = target / "assets" / "spec.json"
    if cesta.is_file():
        return json.loads(cesta.read_text(encoding="utf-8"))
    # výchozí spec z pipeline (když hra ještě žádný nemá)
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "pipeline"))
        import packs  # noqa: PLC0415

        return packs.SPEC
    except ImportError:
        return None


def _bbox(img: Image.Image):
    return img.getbbox()


def _holy(img: Image.Image) -> int:
    """Průhledné pixely obklopené postavou (prosvítá jimi pozadí hry)."""
    px = img.load()
    w, h = img.size
    videno: set[tuple[int, int]] = set()
    fronta = [(0, 0)]
    while fronta:
        x, y = fronta.pop()
        if (x, y) in videno or not (0 <= x < w and 0 <= y < h):
            continue
        if px[x, y][3] > 128:
            continue
        videno.add((x, y))
        fronta += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    pruhledne = sum(1 for y in range(h) for x in range(w) if px[x, y][3] <= 128)
    return max(0, pruhledne - len(videno))


def _okraj(img: Image.Image) -> float:
    px = img.load()
    w, h = img.size
    okraj = [px[x, 0][3] for x in range(w)] + [px[x, h - 1][3] for x in range(w)]
    okraj += [px[0, y][3] for y in range(h)] + [px[w - 1, y][3] for y in range(h)]
    return sum(1 for a in okraj if a > 128) / float(len(okraj))


def _silueta(img: Image.Image) -> set[tuple[int, int]]:
    px = img.load()
    return {(x, y) for y in range(img.size[1]) for x in range(img.size[0]) if px[x, y][3] > 128}


# ---------------------------------------------------------------- hudba ----
# PROČ SE HUDBA MĚŘÍ Z MANIFESTU: melodii nelze spolehlivě poznat ze vzorků
# (rozpoznávání výšky v mixu je nespolehlivé). Skladatel proto při kompozici
# zapisuje, co zahrál (`melody_stats`) a k tomu zvukový důkaz z vedoucího hlasu
# (`motif_audio`). Brána kontroluje obojí: čísla by se dala „nakreslit", ale
# korelace taktů se počítá až ze skutečných vzorků.
def _zkontroluj_hudbu(target: Path, brany: dict) -> tuple[list[str], list[str], dict]:
    vady: list[str] = []
    poznamky: list[str] = []
    data: dict = {"tracks": {}}
    slozka = target / "assets" / "audio" / "music"
    manifest = slozka / "manifest.json"
    if not manifest.is_file():
        if any(slozka.glob("*.wav")) if slozka.is_dir() else False:
            poznamky.append("hudba ve hře je, ale chybí manifest – hudbu nelze změřit")
        else:
            poznamky.append("hudba ve hře není – měření hudby přeskočeno")
        return vady, poznamky, data

    obsah = json.loads(manifest.read_text(encoding="utf-8"))
    for t in obsah.get("tracks", []):
        jmeno = t.get("track", "?")
        m = t.get("melody_stats")
        a = t.get("motif_audio", {})
        if not m or not m.get("notes"):
            vady.append(f"hudba '{jmeno}': chybí měření melodie – skladba je ze staršího "
                        f"skladatele bez motivu (spusť `forge music`)")
            continue
        data["tracks"][jmeno] = {
            "kroky": m["stepwise_ratio"], "skoky": m["leap_ratio"],
            "motiv": m["motif_share"], "vzoru": m["distinct_bar_patterns"],
            "rozsah": m["range_semitones"], "dlouhe": m["long_note_share"],
            "audio_opakovani": a.get("repetition"), "smycka": t.get("loop_score"),
            "sev": t.get("energy_seam"),
        }
        if m["stepwise_ratio"] < brany.get("min_stepwise_ratio", 0.45):
            vady.append(f"hudba '{jmeno}': jen {m['stepwise_ratio'] * 100:.0f} % intervalů jsou "
                        f"kroky (minimum {brany.get('min_stepwise_ratio', 0.45) * 100:.0f} %) "
                        f"– melodie spíš skáče, než aby šla po stupnici")
        if m["leap_ratio"] > brany.get("max_leap_ratio", 0.25):
            vady.append(f"hudba '{jmeno}': {m['leap_ratio'] * 100:.0f} % intervalů jsou skoky "
                        f"≥ 5 půltónů (limit {brany.get('max_leap_ratio', 0.25) * 100:.0f} %) "
                        f"– zní to jako náhodný výběr tónů")
        if m["motif_share"] < brany.get("min_motif_share", 0.35):
            vady.append(f"hudba '{jmeno}': nejčastější taktový vzor má jen "
                        f"{m['motif_share'] * 100:.0f} % taktů (minimum "
                        f"{brany.get('min_motif_share', 0.35) * 100:.0f} %) – chybí motiv, "
                        f"který by se vracel")
        if m["distinct_bar_patterns"] > brany.get("max_bar_patterns", 8):
            vady.append(f"hudba '{jmeno}': {m['distinct_bar_patterns']} různých taktových vzorů "
                        f"(limit {brany.get('max_bar_patterns', 8)}) – každý takt je jiný")
        if not (brany.get("min_range_semitones", 4) <= m["range_semitones"]
                <= brany.get("max_range_semitones", 20)):
            vady.append(f"hudba '{jmeno}': rozsah melodie {m['range_semitones']} půltónů "
                        f"(chceme {brany.get('min_range_semitones', 4)}–"
                        f"{brany.get('max_range_semitones', 20)})")
        if m["long_note_share"] < brany.get("min_long_note_share", 0.30):
            vady.append(f"hudba '{jmeno}': jen {m['long_note_share'] * 100:.0f} % not je delších "
                        f"než osmina (minimum {brany.get('min_long_note_share', 0.30) * 100:.0f} %) "
                        f"– melodie nedýchá")
        if a.get("repetition") is None or a["repetition"] < brany.get("min_motif_repetition", 0.80):
            vady.append(f"hudba '{jmeno}': takty, které mají znít stejně, se shodují jen z "
                        f"{100 * max(0.0, a.get('repetition') or 0):.0f} % (minimum "
                        f"{brany.get('min_motif_repetition', 0.80) * 100:.0f} %) – motiv "
                        f"v nahrané stopě není")
        if a.get("contrast") is not None and a["contrast"] > brany.get("max_motif_contrast", 0.40):
            vady.append(f"hudba '{jmeno}': otázka a odpověď splývají (korelace "
                        f"{a['contrast']:.2f}, limit {brany.get('max_motif_contrast', 0.40)})")
        if (t.get("energy_seam") or 0) < brany.get("min_energy_seam", 0.30):
            vady.append(f"hudba '{jmeno}': konec skladby má jen {100 * (t.get('energy_seam') or 0):.0f} % "
                        f"energie začátku (minimum {brany.get('min_energy_seam', 0.30) * 100:.0f} %) "
                        f"– ve smyčce bude slyšet pauza")
        if (t.get("loop_score") or 0) > brany.get("max_loop_score", 3.0):
            vady.append(f"hudba '{jmeno}': smyčka skáče {t['loop_score']:.2f}× víc než běžné "
                        f"změny vzorků (limit {brany.get('max_loop_score', 3.0)})")
    return vady, poznamky, data


def zkontroluj(target: Path) -> tuple[list[str], list[str], dict]:
    """Vrátí (vady, poznámky, naměřená data)."""
    spec = _nacti_spec(target)
    if spec is None:
        return ([f"chybí {target / 'assets' / 'spec.json'} – bez specu se vzhled "
                 f"měřit nedá (zapisuje ho `forge pack install`)"], [], {})
    role = spec.get("role", {})
    brany = spec.get("gates", {})
    sp = target / "assets" / "sprites"
    vady: list[str] = []
    poznamky: list[str] = []
    data: dict = {"spec": spec, "sprites": {}, "animation": {}, "pomer": {}}

    if not sp.is_dir():
        # Bez spritů se přeskočí jen sprity – hudba se měřit dá a má se
        # (u sad bez postav, např. knihovny hudby a dlaždic, je to jediná
        # kontrolovatelná část vzhledu).
        vady.append(f"chybí složka {sp}")
        poznamky.append("sprity ve hře nejsou – měří se jen hudba")

    vysky: dict[str, int] = {}
    for jmeno, pozadovano in (role.items() if sp.is_dir() else ()):
        f = sp / f"{jmeno}.png"
        if not f.is_file():
            vady.append(f"chybí sprite {jmeno}.png (spec ho čeká)")
            continue
        img = Image.open(f).convert("RGBA")
        bb = _bbox(img)
        vyska = (bb[3] - bb[1]) if bb else 0
        sirka = (bb[2] - bb[0]) if bb else 0
        vysky[jmeno] = vyska
        okraj = _okraj(img)
        diry = _holy(img)
        px = img.load()
        barev = len({px[x, y][:3] for y in range(img.size[1]) for x in range(img.size[0])
                     if px[x, y][3] > 128})
        data["sprites"][jmeno] = {"vyska": vyska, "sirka": sirka, "okraj": round(okraj, 3),
                                  "diry": diry, "barev": barev,
                                  "canvas": img.size[0]}
        cil = pozadovano.get("visual_height", 0)
        tolerance = brany.get("height_tolerance", 0.25)
        if cil and abs(vyska - cil) > cil * tolerance:
            vady.append(f"{jmeno}: výška postavy {vyska} px, spec chce {cil} px "
                        f"(±{tolerance * 100:.0f} %)")
        if okraj > brany.get("max_border_opaque", 0.15):
            vady.append(f"{jmeno}: okraj je z {okraj * 100:.0f} % neprůhledný "
                        f"(zbytky pozadí, limit {brany.get('max_border_opaque', 0.15) * 100:.0f} %)")
        if diry > brany.get("max_holes", 0):
            vady.append(f"{jmeno}: {diry} děr uvnitř siluety – prosvítá pozadí hry")
        max_barev = pozadovano.get("colors")
        if max_barev and barev > max_barev:
            vady.append(f"{jmeno}: {barev} barev, spec dovoluje {max_barev}")

    # Poměry mezi rolemi: to je to, co člověk vidí jako „mince je obrovská".
    for mensi, vetsi, max_podil in (("coin", "chest", 0.6), ("coin", "player", 0.45),
                                    ("chest", "player", 0.85)):
        if mensi in vysky and vetsi in vysky and vysky[vetsi]:
            podil = vysky[mensi] / vysky[vetsi]
            data["pomer"][f"{mensi}/{vetsi}"] = round(podil, 2)
            if podil > max_podil:
                vady.append(f"měřítko: {mensi} je {podil:.2f}× výšky {vetsi} "
                            f"(má být nejvýš {max_podil}×)")

    # Animace: framy se nesmí lišit pohledem (jinak postava „bliká"/rotuje).
    framy = sorted(sp.glob("walk_*.png"))
    if framy:
        sil = [_silueta(Image.open(f).convert("RGBA")) for f in framy]
        shody = []
        for i in range(len(sil) - 1):
            a, b = sil[i], sil[i + 1]
            iou = len(a & b) / len(a | b) if (a | b) else 0.0
            ta = (sum(x for x, _ in a) / len(a), sum(y for _, y in a) / len(a)) if a else (0, 0)
            tb = (sum(x for x, _ in b) / len(b), sum(y for _, y in b) / len(b)) if b else (0, 0)
            posun = ((ta[0] - tb[0]) ** 2 + (ta[1] - tb[1]) ** 2) ** 0.5
            shody.append({"iou": round(iou, 3), "posun": round(posun, 2)})
            if iou < brany.get("min_silhouette_iou", 0.6):
                vady.append(f"animace: frame {i}→{i + 1} má shodu siluet {iou * 100:.0f} % "
                            f"(minimum {brany.get('min_silhouette_iou', 0.6) * 100:.0f} %) "
                            f"– mění se pohled, postava bude blikat")
            if posun > brany.get("max_centroid_shift", 4.0):
                vady.append(f"animace: frame {i}→{i + 1} posune těžiště o {posun:.1f} px "
                            f"(limit {brany.get('max_centroid_shift', 4.0)})")
        data["animation"] = {"frames": len(framy), "shody": shody}
    else:
        poznamky.append("animace chůze v projektu není – přeskočeno")

    # Hudba: měří se z manifestu skladatele + zvukový důkaz motivu.
    h_vady, h_poznamky, h_data = _zkontroluj_hudbu(target, spec.get("music", {}))
    vady += h_vady
    poznamky += h_poznamky
    data["music"] = h_data
    return vady, poznamky, data


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("target", help="projekt nebo repo hry")
    ap.add_argument("--json", action="store_true", help="vypsat i naměřená data")
    args = ap.parse_args()

    target = Path(args.target)
    if not (target / "assets").is_dir():
        print(f"CHYBA: {target} nemá složku assets")
        return 2
    vady, poznamky, data = zkontroluj(target)

    print(f"Kontrola assetů: {target}")
    for jmeno, m in data["sprites"].items():
        print(f"  {jmeno:7s} postava {m['sirka']:3d}×{m['vyska']:3d} px na plátně "
              f"{m['canvas']}  barev {m['barev']:2d}  okraj {m['okraj'] * 100:3.0f} %  "
              f"děr {m['diry']}")
    if data["pomer"]:
        print("  poměry: " + ", ".join(f"{k} {v:.2f}×" for k, v in data["pomer"].items()))
    if data["animation"]:
        shody = ", ".join(f"{100 * s['iou']:.0f} %" for s in data["animation"]["shody"])
        print(f"  animace: {data['animation']['frames']} framů, shoda siluet {shody}")
    for jmeno, m in data.get("music", {}).get("tracks", {}).items():
        # záporná korelace je taky „žádná shoda" – do výpisu ji nechceme jako -0 %
        opakovani = max(0.0, m["audio_opakovani"] or 0.0)
        print(f"  hudba {jmeno:9s} kroky {m['kroky'] * 100:3.0f} %  skoky {m['skoky'] * 100:3.0f} %  "
              f"motiv {m['motiv'] * 100:3.0f} % z {m['vzoru']} vzorů  rozsah {m['rozsah']:2d}  "
              f"opakování v audiu {100 * opakovani:3.0f} %")
    for p in poznamky:
        print(f"  poznámka: {p}")
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))

    if vady:
        print(f"\nNALEZENÉ VADY ({len(vady)}):")
        for v in vady:
            print(f"  - {v}")
        return 1
    print("\nVše v pořádku: assety odpovídají specu.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
