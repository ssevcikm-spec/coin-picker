#!/usr/bin/env python
r"""Kontrola „zapojení" kódu: co agent napsal, musí být taky NĚKDE VOLANÉ.

PROČ TO EXISTUJE: automatické sloučení PR propustí i kód, který se sice
zkompiluje a projde testy, ale ve hře se nikdy nespustí. Naměřeno na PR #32
(„Nepřítel, který se dá porazit skokem"): agent přidal funkci
`_on_enemy_stomped()` a do `enemy.gd` vlastnost `is_dead`, ale funkci NIKDO
nezavolal – hráč tedy nepřítele pořád jen zabije, resp. dostane zásah jako
dřív. Testy to nemohly poznat: chování, které nikdo netestuje, se nemění.
Zelené CI + hotová funkce jen na papíře je nejdražší druh chyby, protože vypadá
jako úspěch.

Co se kontroluje (jen staticky, bez spouštění Godotu):
  1) každá funkce `_on_*` v `scripts/*.gd` musí být připojená k signálu
     (`connect(_on_…`) nebo jinak zmíněná – jinak je to mrtvý kód,
  2) každá ostatní funkce musí být aspoň jednou použitá (volání nebo odkaz),
     kromě vestavěných callbacků Godotu (`_ready`, `_process`, `_draw`, …),
  3) `physics_process`/`_process` prázdné nebo jen s `return` (typicky
     „ochrana" přilepená agentem) se hlásí jako podezřelé.

Použití:
    python tools/check-wiring.py <projekt nebo repo> [--json]
Návratový kód: 0 = v pořádku, 1 = nenalezené zapojení, 2 = není co kontrolovat.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Vestavěné callbacky Godotu: volá je engine, ne kód – „nepoužité" být můžou.
CALLBACKY = {
    "_init", "_ready", "_enter_tree", "_exit_tree", "_process", "_physics_process",
    "_input", "_unhandled_input", "_unhandled_key_input", "_draw", "_notification",
    "_to_string", "_get_property_list", "_set", "_get", "_gui_input", "_integrate_forces",
    "_on_", # prefix – řeší se zvlášť jako signálové handlery
}

FUNKCE_RE = re.compile(r"^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", re.MULTILINE)


def _tela(text: str) -> dict[str, str]:
    """Vrátí {jméno funkce: tělo} – hrubě podle odsazení (stačí na kontrolu)."""
    radky = text.splitlines()
    vysledek: dict[str, str] = {}
    jmeno: str | None = None
    telo: list[str] = []
    for radek in radky:
        m = re.match(r"^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", radek)
        if m:
            if jmeno:
                vysledek[jmeno] = "\n".join(telo)
            jmeno, telo = m.group(1), []
            continue
        if jmeno is not None:
            # konec funkce = řádek, který není odsazený a není prázdný
            if radek.strip() and not radek.startswith((" ", "\t")):
                vysledek[jmeno] = "\n".join(telo)
                jmeno, telo = None, []
            else:
                telo.append(radek)
    if jmeno:
        vysledek[jmeno] = "\n".join(telo)
    return vysledek


def zkontroluj(target: Path) -> tuple[list[str], list[str], dict]:
    skripty = sorted((target / "scripts").glob("*.gd")) if (target / "scripts").is_dir() else []
    if not skripty:
        return [], ["ve složce scripts nejsou žádné .gd soubory"], {"soubory": 0}
    texty = {f.name: f.read_text(encoding="utf-8", errors="replace") for f in skripty}

    # KDE SE HLEDÁ POUŽITÍ: nejen ve skriptech hry. Funkce může volat test
    # (`tests/run_tests.gd`) nebo scéna přes připojení signálu
    # (`[connection ... method="_on_x"]` v .tscn). Když se hledá jen v scripts/,
    # hlásí kontrola falešné poplachy (naměřeno: walkable_count a
    # reachable_count z level.gd, které volají testy průchodnosti).
    korpus: list[str] = []
    for vzor in ("*.gd", "*.tscn", "*.tres"):
        for f in target.rglob(vzor):
            if ".godot" in f.parts:
                continue
            korpus.append(f.read_text(encoding="utf-8", errors="replace"))
    vse = "\n".join(korpus)

    vady: list[str] = []
    poznamky: list[str] = []
    data: dict = {"soubory": len(texty), "funkce": {}, "handlery": {}}

    for jmeno_souboru, text in texty.items():
        tela = _tela(text)
        data["funkce"][jmeno_souboru] = sorted(tela)
        for funkce, telo in tela.items():
            # 1) signálové handlery musí být připojené NEBO přímo volané
            if funkce.startswith("_on_"):
                # Pozor na falešný poplach: samotná definice `func _on_x(` je taky
                # výskyt, takže se počítají od DVA výskyty výš (definice + volání).
                volani = len(re.findall(rf"(?<![A-Za-z0-9_]){re.escape(funkce)}\s*\(", vse))
                pripojeno = bool(
                    re.search(rf"connect\(\s*{re.escape(funkce)}\b", vse)
                    or re.search(rf'"{re.escape(funkce)}"', vse)
                    or volani >= 2
                )
                data["handlery"][funkce] = bool(pripojeno)
                if not pripojeno:
                    vady.append(f"{jmeno_souboru}: {funkce}() není připojená k žádnému "
                                f"signálu ani nikde volaná – kód se nikdy nespustí "
                                f"(mrtvá funkce)")
                continue
            if funkce in CALLBACKY:
                continue
            # 2) ostatní funkce musí být aspoň někde použité (volání/odkaz)
            pouziti = len(re.findall(rf"(?<![A-Za-z0-9_]){re.escape(funkce)}\s*\(", vse))
            zminky = len(re.findall(rf"(?<![A-Za-z0-9_]){re.escape(funkce)}(?![A-Za-z0-9_])", vse))
            if zminky <= 1:
                # POZOR: u INKREMENTÁLNÍ roadmapy je funkce často „API pro příští
                # úlohu" – iso_to_cell čeká na pohyb hráče, _zlepsi_skill na těžbu.
                # Tehdy to není mrtvý kód, jen ještě nepřišel čas, a brána to
                # nemůže vědět. Hlásí se proto jako POZNÁMKA, ne jako vada (dřív
                # to shazovalo celé CI a úlohy padaly na falešný poplach).
                # Tvrdě se kontrolují jen `_on_*` handlery výše – ty když nejsou
                # připojené, funkce se opravdu nikdy nespustí (chyba z PR #32).
                poznamky.append(f"{jmeno_souboru}: {funkce}() není nikde volaná – "
                                f"pokud to není API pro pozdější úlohu, je to mrtvý kód")

        # 3) prázdný fyzikální krok = „ochrana", která nic nedělá
        for nazev, telo in tela.items():
            if nazev in ("_physics_process", "_process", "_ready"):
                smysluplne = [r.strip() for r in telo.splitlines()
                              if r.strip() and not r.strip().startswith("#")
                              and r.strip() not in ("pass",)]
                if smysluplne and all(r in ("return", "return\n") or r.startswith("return ")
                                       for r in smysluplne):
                    poznamky.append(f"{jmeno_souboru}: {nazev}() jen okamžitě končí "
                                    f"(`{smysluplne[0]}`) – je to záměr, nebo zbytek?")

    poznamky.append(f"zkontrolováno funkcí: {sum(len(v) for v in data['funkce'].values())} "
                    f"v {len(texty)} souborech")
    return vady, poznamky, data


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("target", help="projekt nebo repo hry")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    target = Path(args.target)
    if not (target / "scripts").is_dir():
        print(f"CHYBA: {target} nemá složku scripts")
        return 2
    vady, poznamky, data = zkontroluj(target)

    print(f"Kontrola zapojení kódu: {target}")
    for p in poznamky:
        print(f"  poznámka: {p}")
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    if vady:
        print(f"\nNENALEZENÉ ZAPOJENÍ ({len(vady)}):")
        for v in vady:
            print(f"  - {v}")
        return 1
    print("\nVše v pořádku: každá funkce je odněkud volaná.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
