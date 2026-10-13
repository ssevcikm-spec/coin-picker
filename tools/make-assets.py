#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Vygeneruje assety Coin-Pickeru: mapu úrovně a dva sprity.

PROČ GENERÁTOR A NE RUČNÍ SOUBORY: mapa má v sobě STATISTIKY (kolik políček je
průchozích, kolik je dosažitelných ze spawnu) — kdyby se psaly ručně, rozejdou
se s mřížkou a nikdo si toho nevšimne. Tady se počítají z mřížky.

Spouštění (z kořene repa hry):
    python tools/make-assets.py
Výstup:
    assets/levels/main.json      (mřížka + značky + spočítané statistiky)
    assets/sprites/player.png    (32x32, postava vysoká 30 px)
    assets/sprites/coin.png      (16x16, mince vysoká 12 px)

Meze, které musí výsledek splnit (vynucuje `.forge/check-assets.py` a
`.forge/check-schema.py`):
  * plátno sprity == `role.<jmeno>.canvas` ve spec.json,
  * výška postavy v siluetě ± `gates.height_tolerance` (15 %),
  * okraj plátna neprůhledný z <= 5 % (žádné zbytky pozadí),
  * nula děr uvnitř siluety,
  * poměr coin/player <= 0,45.
"""
from __future__ import annotations

import json
import pathlib

from PIL import Image, ImageDraw

REPO = pathlib.Path(__file__).resolve().parents[1]
CELL = 32
WIDTH, HEIGHT = 15, 8
VIEWPORT = [480, 270]

# Mřížka: okraj jsou zdi, uvnitř pár vnitřních zdí, zbytek podlaha.
# `#` = zeď · `.` = podlaha · značky se přidají zvlášť (níž).
VZOR = [
    "###############",
    "#.............#",
    "#..##.........#",
    "#..##.....##..#",
    "#.........##..#",
    "#.....##......#",
    "#.....##......#",
    "###############",
]
ZED, PODLAHA = "#", "."
MARKERY = [
    {"type": "spawn", "cell": [2, 2]},
    {"type": "exit", "cell": [12, 6]},
    {"type": "coin", "cell": [4, 5]},
    {"type": "coin", "cell": [11, 1]},
    {"type": "coin", "cell": [9, 6]},
]


def _walkable(mrizka: list[str], x: int, y: int) -> bool:
    if x < 0 or y < 0 or y >= len(mrizka) or x >= len(mrizka[0]):
        return False
    return mrizka[y][x] != ZED


def _statistiky(mrizka: list[str]) -> dict:
    """Spočítá statistiky z MŘÍŽKY (ne opisem) — včetně dosažitelnosti."""
    spawn = next((m["cell"] for m in MARKERY if m["type"] == "spawn"), [1, 1])
    videno = {tuple(spawn)}
    fronta = [tuple(spawn)]
    while fronta:
        x, y = fronta.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if (nx, ny) not in videno and _walkable(mrizka, nx, ny):
                videno.add((nx, ny))
                fronta.append((nx, ny))
    vsechny = [(x, y) for y in range(len(mrizka)) for x in range(len(mrizka[0]))
               if _walkable(mrizka, x, y)]
    nedosazitelne = [m["cell"] for m in MARKERY
                     if tuple(m["cell"]) not in videno]
    return {
        "width": len(mrizka[0]),
        "height": len(mrizka),
        "cells": len(mrizka) * len(mrizka[0]),
        "walkable": len(vsechny),
        "floor_ratio": round(len(vsechny) / float(len(mrizka) * len(mrizka[0])), 4),
        "reachable": len(videno),
        "connectivity": round(len(videno) / float(len(vsechny)), 4) if vsechny else 0.0,
        "spawn_walkable": _walkable(mrizka, spawn[0], spawn[1]),
        "markers": len(MARKERY),
        "markers_unreachable": nedosazitelne,
    }


def zapis_mapu() -> None:
    mrizka = list(VZOR)
    assert len(mrizka) == HEIGHT, f"mřížka má {len(mrizka)} řádků, čekám {HEIGHT}"
    for radek in mrizka:
        assert len(radek) == WIDTH, f"řádek má {len(radek)} znaků, čekám {WIDTH}"
    for m in MARKERY:
        x, y = m["cell"]
        assert mrizka[y][x] == PODLAHA, f"značka {m['type']} leží na znaku {mrizka[y][x]!r}"
    data = {
        "_popis": [
            "Mapa úrovně Coin-Pickeru. GENEROVANÁ: `python tools/make-assets.py`.",
            "`cell` musí odpovídat `tile.sirka` v assets/spec.json a konstantě CELL",
            "v scripts/level.gd — brána .forge/check-schema.py ta čísla porovnává.",
            "Statistiky níž se POČÍTAJÍ z mřížky, neopisují se (ruční číslo by se",
            "s mřížkou rozešlo a nikdo by si toho nevšiml).",
        ],
        "name": "main",
        "cell": CELL,
        "width": WIDTH,
        "height": HEIGHT,
        "viewport": VIEWPORT,
        "offset": [0, 0],
        "legend": {"#": "wall", ".": "floor"},
        "tiles": {"#": "stone", ".": "floor"},
        "grid": mrizka,
        "markers": MARKERY,
        "stats": _statistiky(mrizka),
    }
    cesta = REPO / "assets" / "levels" / "main.json"
    cesta.parent.mkdir(parents=True, exist_ok=True)
    cesta.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  {cesta.relative_to(REPO)}: {WIDTH}x{HEIGHT} polí, "
          f"{data['stats']['walkable']} průchozích, spojitost {data['stats']['connectivity']}")


def zapis_hrace() -> None:
    """Postava 32x32 s viditelnou výškou 30 px a čistým okrajem."""
    img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    obrys = (28, 32, 48, 255)
    kůže = (232, 190, 150, 255)
    tunic = (58, 108, 190, 255)
    nohy = (72, 72, 92, 255)
    # hlava (kruh) — horní okraj siluety v y=2
    d.ellipse([11, 2, 20, 11], fill=kůže, outline=obrys)
    # trup
    d.rectangle([11, 11, 20, 22], fill=tunic, outline=obrys)
    # nohy (dvě, bez mezery -> žádná díra uvnitř siluety)
    d.rectangle([11, 23, 15, 30], fill=nohy, outline=obrys)
    d.rectangle([16, 23, 20, 30], fill=nohy, outline=obrys)
    cesta = REPO / "assets" / "sprites" / "player.png"
    cesta.parent.mkdir(parents=True, exist_ok=True)
    img.save(cesta)
    _zkontroluj(img, "player", 30)
    print(f"  {cesta.relative_to(REPO)}: {img.size[0]}x{img.size[1]}, silueta {_vyska(img)} px")


def zapis_minci() -> None:
    """Mince 16x16 s viditelnou výškou 12 px."""
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([2, 2, 13, 13], fill=(240, 200, 60, 255), outline=(176, 132, 24, 255))
    cesta = REPO / "assets" / "sprites" / "coin.png"
    img.save(cesta)
    _zkontroluj(img, "coin", 12)
    print(f"  {cesta.relative_to(REPO)}: {img.size[0]}x{img.size[1]}, silueta {_vyska(img)} px")


def zapis_dlazdice() -> None:
    """Dlaždice 32x32 — JEDNA barva musí v obrázku převládat.

    PROČ: `.forge/verify-level-render.py` si z každé dlaždice odvodí paletu
    (8 nejčastějších barev) a snímek hry srovnává po BUŇKÁCH podle barvy
    ve středu políčka. Kdyby dlaždice byla šum, paleta by byla náhodná a
    kontrola by hlásila vadu i na správně vykreslené mapě.
    """
    tvary = {
        "stone": ((70, 74, 84), (52, 56, 64)),    # zeď: tmavší, chladná
        "floor": ((126, 116, 96), (108, 99, 82)),  # podlaha: světlejší, teplá
    }
    for jmeno, (zaklad, linka) in tvary.items():
        img = Image.new("RGBA", (CELL, CELL), zaklad + (255,))
        d = ImageDraw.Draw(img)
        # Jen jemná spára po okraji (1 px) — plocha zůstává jednolitá.
        d.rectangle([0, 0, CELL - 1, CELL - 1], outline=linka + (255,))
        cesta = REPO / "assets" / "tiles" / f"{jmeno}.png"
        cesta.parent.mkdir(parents=True, exist_ok=True)
        img.save(cesta)
        print(f"  {cesta.relative_to(REPO)}: {CELL}x{CELL}, základ {zaklad}")


def _vyska(img: Image.Image) -> int:
    bb = img.getbbox()
    return (bb[3] - bb[1]) if bb else 0


def _zkontroluj(img: Image.Image, jmeno: str, cil: int) -> None:
    """Rychlá sebekontrola generátoru: co vyrobím, musí projít branou.

    Není to náhrada brány (ta měří víc) — je to proto, aby vada vznikla
    u ZDROJE a ne až v CI.
    """
    vyska = _vyska(img)
    if abs(vyska - cil) > cil * 0.15:
        raise SystemExit(f"CHYBA: {jmeno} má výšku {vyska} px, cíl {cil} px (±15 %)")
    px = img.load()
    w, h = img.size
    okraj = [px[x, 0][3] for x in range(w)] + [px[x, h - 1][3] for x in range(w)]
    okraj += [px[0, y][3] for y in range(h)] + [px[w - 1, y][3] for y in range(h)]
    podil = sum(1 for a in okraj if a > 128) / float(len(okraj))
    if podil > 0.05:
        raise SystemExit(f"CHYBA: {jmeno} má neprůhledný okraj z {podil * 100:.0f} % (limit 5 %)")


if __name__ == "__main__":
    print("Generuji assety Coin-Pickeru:")
    zapis_mapu()
    zapis_dlazdice()
    zapis_hrace()
    zapis_minci()
    print("Hotovo.")
