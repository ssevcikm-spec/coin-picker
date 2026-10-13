#!/usr/bin/env python
r"""Ověří, že hra opravdu vykreslila mapu z JSON – buňku po buňce, měřením.

PROČ: screenshot se dá „zkontrolovat očima", jenže to je dojem a nedá se to
pustit v CI. Tenhle skript porovná snímek hry s mřížkou v .json: u každého
políčka zjistí barvu pixelu v jeho středu a přiřadí ji k nejbližší dlaždicové
paletě (kámen = podlaha, cihla = zeď, hlína = chodba). Když mapa sedí, souhlasí
skoro všechno; když se vykreslí špatně (posun, přehozené vrstvy, chybějící
dlaždice), je to hned vidět v číslech.

Použití:
    python tools/verify-level-render.py <snimek.png> <uroven.json> [--tolerance N]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

# Palety jsou stejné jako v pipeline/tiles.py (drží hru pohromadě).
PALETTES = {
    "stone": [(64, 66, 74), (84, 86, 94), (104, 106, 114), (126, 128, 136)],
    "brick": [(96, 46, 40), (120, 58, 48), (142, 74, 58), (70, 70, 76)],
    "dirt": [(72, 52, 38), (92, 68, 48), (112, 84, 58), (132, 102, 70)],
    "grass": [(34, 78, 42), (48, 104, 54), (64, 130, 66), (86, 154, 78), (110, 176, 92)],
    "sand": [(168, 142, 96), (190, 164, 116), (210, 186, 138), (228, 206, 162)],
    "water": [(24, 60, 108), (32, 82, 140), (44, 108, 170), (62, 136, 198)],
}

# Entity stojí NA dlaždicích, takže jejich pixely k terénu nepatří. Když se
# buňka netrefí do dlaždice, ale do některé z těchto barev, není to chyba mapy.
ENTITY_COLORS = {
    "mince": (255, 217, 51),
    "hráč (fallback)": (89, 217, 255),
    "nepřítel (fallback)": (255, 0, 0),
    "truhla (fallback)": (204, 128, 51),
}


def palettes_from_tiles(tile_dir: Path, jmena, max_colors: int = 8) -> dict:
    """Odvodí paletu každé dlaždice z jejího obrázku.

    PROČ: dřív byly barvy dlaždic zapsané natvrdo v tomhle souboru. To fungovalo,
    dokud existovala jediná sada (kámen/cihla/hlína), ale katalog dílů znamená
    různé sady – a s jinými barvami by kontrola hlásila, že se mapa vykreslila
    špatně, i když by byla v pořádku. Paleta se proto čte z PNG: vezme se
    nejčastějších N barev (průhledné pixely se ignorují).
    """
    from collections import Counter

    out: dict = {}
    for jmeno in jmena:
        cesta = tile_dir / f"{jmeno}.png"
        if not cesta.is_file():
            continue
        img = Image.open(cesta).convert("RGBA")
        pocty: Counter = Counter()
        for px in img.getdata():
            if px[3] < 200:      # průhledné pozadí do palety nepatří
                continue
            pocty[px[:3]] += 1
        barvy = [c for c, _ in pocty.most_common(max_colors)]
        if barvy:
            out[jmeno] = barvy
    return out


def nearest_palette(rgb: tuple[int, int, int],
                    palety: dict | None = None) -> tuple[str, float]:
    zdroj = palety if palety else PALETTES
    best, best_d = "?", 1e9
    for name, colors in zdroj.items():
        for c in colors:
            d = sum((a - b) ** 2 for a, b in zip(rgb, c)) ** 0.5
            if d < best_d:
                best, best_d = name, d
    return best, best_d


def auto_ignore(level_path: Path, level: dict) -> list[tuple[int, int, int, int]]:
    """Sám najde oblasti, které dlaždice legitimně překrývají.

    Konkrétně miniaturu mapy: když vedle úrovně leží `../scripts/game.gd`
    a mluví o uzlu Minimap, vyjme se její obdélník (120×64 v pravém dolním
    rohu). Díky tomu se nemusí rozměry opisovat do CI workflow – a když hru
    miniaturu nemá, nic se nevyjímá.
    """
    # Hru hledáme směrem nahoru od úrovně: v repu je to <repo>/scripts/game.gd,
    # v projektu <projekt>/scripts/game.gd, ale úroveň může být i hlouběji.
    hra = None
    for predchudce in (level_path.parent, *level_path.parents):
        kandidat = predchudce / "scripts" / "game.gd"
        if kandidat.is_file():
            hra = kandidat
            break
    if hra is None:
        return []
    try:
        kod = hra.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    if "Minimap" not in kod:
        return []
    vp = level.get("viewport") or [480, 270]
    return [(int(vp[0]) - 124, int(vp[1]) - 68, 124, 68)]


def stred_bunky(x: int, y: int, projekce: str, cell: int, cell_h: int,
                off_x: float, off_y: float) -> tuple[int, int]:
    """Střed dlaždice (x, y) na snímku – podle projekce, ne natvrdo čtvercově.

    Izometrie kreslí na ((x-y)*w/2, (x+y)*h/2); obdélník na (x*w, y*h).
    Když se to splete, kontrola hlásí chybu na SPRÁVNĚ vykreslené mapě.
    """
    if projekce.startswith("izo"):
        return (int(round(off_x + (x - y) * cell / 2.0)),
                int(round(off_y + (x + y) * cell_h / 2.0)))
    return (int(off_x + x * cell + cell / 2.0),
            int(off_y + y * cell_h + cell_h / 2.0))


def porovnej(img, grid, cell, off_x, off_y, want, palety, ignorovat, marker_cells,
             wrong_limit: int = 8, projekce: str = "ctvercova", cell_h: int = 0):
    """Projde políčka mapy a spočítá, kolik jich sedí s dlaždicemi na snímku.

    Vrací (ok, total, entities, overlays, outside, wrong). Vytáhl jsem to do
    funkce kvůli hledání posunutí: hra umí **třes obrazovky**, který celou mapu
    posune o pár pixelů – bez hledání zarovnání by kontrola hlásila chybu
    i na správně vykreslené mapě.
    """
    ok = 0
    total = 0
    entities = 0
    overlays = 0
    outside = 0
    wrong: list[str] = []
    for y, row in enumerate(grid):
        for x, znak in enumerate(row):
            px, py = stred_bunky(x, y, projekce, cell, cell_h or cell, off_x, off_y)
            if px < 0 or py < 0 or px >= img.width or py >= img.height:
                outside += 1
                continue
            # Oblasti, které dlaždice legitimně překrývají (miniatura mapy, HUD)
            if any(rx <= px < rx + rw and ry <= py < ry + rh
                   for rx, ry, rw, rh in ignorovat):
                overlays += 1
                continue
            total += 1
            rgb = img.getpixel((px, py))
            seen, dist = nearest_palette(rgb, palety)
            expected = want.get(znak, "?")
            if seen == expected:
                ok += 1
                continue
            # Je to entita? (kreslí se nad dlaždicí, takže ji překryje)
            entity = min(ENTITY_COLORS.items(),
                         key=lambda kv: sum((a - b) ** 2 for a, b in zip(rgb, kv[1])))
            entity_d = sum((a - b) ** 2 for a, b in zip(rgb, entity[1])) ** 0.5
            if entity_d <= 60.0:
                entities += 1
                if (x, y) not in marker_cells and len(wrong) < wrong_limit:
                    wrong.append(f"({x},{y}) {entity[0]} mimo značku mapy")
                continue
            if len(wrong) < wrong_limit:
                wrong.append(f"({x},{y}) čekáno {expected}, vidím {seen} "
                             f"vzdálenost {dist:.0f}px")
    return ok, total, entities, overlays, outside, wrong


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("shot")
    ap.add_argument("level")
    ap.add_argument("--tolerance", type=float, default=40.0,
                    help="jak daleko může být barva od palety, aby se ještě uznala")
    ap.add_argument("--min-agreement", type=float, default=0.75,
                    help="minimální podíl políček, která musí sedět")
    ap.add_argument("--ignore-rect", action="append", default=[],
                    metavar="X,Y,W,H",
                    help="oblast, která se nepočítá (např. miniatura mapy v rohu); "
                         "lze zadat vícekrát")
    ap.add_argument("--max-shift", type=int, default=8,
                    help="o kolik pixelů se smí mapa posunout (třes obrazovky); "
                         "0 = nehledat zarovnání")
    args = ap.parse_args()

    ignorovat: list[tuple[int, int, int, int]] = []
    for spec in args.ignore_rect:
        try:
            x, y, w, h = (int(v) for v in spec.split(","))
        except ValueError:
            print(f"CHYBA: --ignore-rect má být 'X,Y,W,H', ne '{spec}'")
            return 2
        ignorovat.append((x, y, w, h))

    img = Image.open(args.shot).convert("RGB")
    level_path = Path(args.level)
    level = json.loads(level_path.read_text(encoding="utf-8"))
    # Co si nástroj najde sám (miniatura mapy) – k ručním oblastem se přidá.
    auto = auto_ignore(level_path, level)
    if auto:
        print(f"Automaticky vyjímám oblasti: {auto} (miniatura mapy)")
    ignorovat += auto
    grid = level["grid"]
    # PROJEKCE SE ČTE ZE SPECU HRY, ne z levelu: schéma je vlastnost hry.
    spec_cesta = level_path.parent.parent / "spec.json"
    projekce, cell, cell_h = "ctvercova", int(level["cell"]), 0
    if spec_cesta.is_file():
        try:
            spec = json.loads(spec_cesta.read_text(encoding="utf-8-sig"))
            proj = spec.get("projekce", {})
            tile = spec.get("tile", {})
            projekce = str(proj.get("typ") or "").lower()
            cw = proj.get("dlazdice_sirka") or tile.get("sirka")
            ch = proj.get("dlazdice_vyska") or tile.get("vyska")
            if cw:
                cell = int(cw)
            if ch:
                cell_h = int(ch)
            if not projekce:
                projekce = "izometricka" if cell != cell_h else "ctvercova"
        except Exception as e:
            print(f"VAROVÁNÍ: {spec_cesta} nejde přečíst ({e}) – beru obdélníkovou mřížku")
    if not cell_h:
        cell_h = cell

    off_x, off_y = level.get("offset", [0, 0])
    # IZOMETRICKÝ OFFSET SE POČÍTÁ, NEHÁDÁ: hra mapu vystřeďuje na spawn
    # (`level.gd::vystredni_na_spawn`), takže `offset` v datech nezná skutečné
    # posunutí. Bere se stejný vzorec jako ve hře – a hledání posunutí níž ho
    # jen doladí (třes obrazovky).
    if projekce.startswith("izo"):
        spawn = None
        for m in level.get("markers", []):
            if str(m.get("type")) == "spawn":
                spawn = (int(m["cell"][0]), int(m["cell"][1]))
        vp = spec.get("viewport") if spec_cesta.is_file() else None
        if spawn and vp:
            sx = (spawn[0] - spawn[1]) * cell / 2.0
            sy = (spawn[0] + spawn[1]) * cell_h / 2.0
            off_x = int(vp[0]) / 2.0 - sx
            off_y = int(vp[1]) / 2.0 - sy
            print(f"Izometrie: offset počítán z viewportu a spawnu {spawn} "
                  f"→ ({off_x:.0f}, {off_y:.0f})")
    want = {k: v for k, v in level["tiles"].items()}  # "0" -> brick, "1" -> stone, "2" -> dirt
    # Palety dlaždic se čtou z obrázků projektu – díky tomu kontrola funguje
    # s jakoukoli sadou z katalogu dílů, ne jen s tou, která byla dřív natvrdo.
    tile_dir = level_path.parent.parent / "tiles"
    if not tile_dir.is_dir():
        tile_dir = level_path.parent / "tiles"
    palety = palettes_from_tiles(tile_dir, sorted(set(want.values())))
    if palety:
        print(f"Palety dlaždic načteny z {tile_dir.as_posix()}: {', '.join(sorted(palety))}")
    else:
        print("Palety dlaždic se nenačetly – používám vestavěné (starší sady)")
        palety = None

    ok = 0
    total = 0
    entities = 0
    overlays = 0
    wrong: list[str] = []
    outside = 0
    # Entity mívají sprite větší než jedno políčko, takže povolíme i sousedy
    # značky. (HUD text nahoře zůstává jako zbytková odchylka – proto se
    # porovnává s tolerancí, ne na 100 %.)
    marker_cells = set()
    for m in level.get("markers", []):
        mx, my = int(m["cell"][0]), int(m["cell"][1])
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                marker_cells.add((mx + dx, my + dy))

    # Hledání zarovnání: třes obrazovky posune mapu, takže se zkusí okolní
    # posuny a bere se ten nejlepší. Bez toho by kontrola hlásila chybu na
    # správné mapě (naměřeno u funkce „Třes obrazovky při zásahu").
    nejlepsi = None
    for dx in range(-args.max_shift, args.max_shift + 1):
        for dy in range(-args.max_shift, args.max_shift + 1):
            v = porovnej(img, grid, cell, off_x + dx, off_y + dy, want, palety,
                         ignorovat, marker_cells, projekce=projekce, cell_h=cell_h)
            ter = v[1] - v[2]
            podil = v[0] / ter if ter else 0.0
            if nejlepsi is None or podil > nejlepsi[0]:
                nejlepsi = (podil, dx, dy, v)
    podil, ddx, ddy, v = nejlepsi
    ok, total, entities, overlays, outside, wrong = v
    if (ddx, ddy) != (0, 0):
        print(f"Mapa je na snímku posunutá o ({ddx},{ddy}) px (třes obrazovky?) "
              f"– porovnává se s tímto zarovnáním")

    terrain = total - entities
    ratio = ok / terrain if terrain else 0.0
    rozmer = f"{cell}×{cell_h}px" if cell != cell_h else f"{cell}px"
    print(f"Snímek {img.width}×{img.height}, úroveň {len(grid[0])}×{len(grid)} "
          f"{projekce} po {rozmer}, offset {[round(off_x + ddx), round(off_y + ddy)]}")
    print(f"Terén sedí {ok}/{terrain} políček = {ratio * 100:.1f}% "
          f"(překrytých entitami: {entities}, ignorovaných oblastí: {overlays}, "
          f"mimo snímek: {outside})")
    for w in wrong:
        print(f"  chyba: {w}")
    if ratio < args.min_agreement:
        print(f"SELHÁNÍ: pod {args.min_agreement * 100:.0f}% – mapa se nevykreslila podle JSON")
        return 1
    print("OK: vykreslená mapa odpovídá mřížce v JSON")
    return 0


if __name__ == "__main__":
    sys.exit(main())
