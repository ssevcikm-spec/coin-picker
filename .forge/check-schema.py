#!/usr/bin/env python
r"""Kontrola, že si hra neodporuje ve vizuálním schématu.

PROČ TO EXISTUJE — naměřeno 30. 9. 2026 na hře, kde se rozešly ČTYŘI zdroje
pravdy a každý tvrdil jiné číslo:

    deklarace   assets/spec.json          dlaždice a viewport podle specu
    vykreslení  vstupní bod vykreslování  vlastní konstanty buňky
    dlaždice    assets/tiles/*.png        skutečná velikost obrázků
    logika      druhá logika světa        třetí názor na totéž číslo

Změřený rozptyl byl 16 px, 32 px a 96×48 px — čtyři čísla pro jednu věc.
Důsledek: `spec.json` slibuje izometrii 2:1, ale vykreslování kreslí osově
zarovnané čtverce – takže izometrický pohled nemůže vzniknout, ať se sebevíc
ladí sprity. Nikdo si toho nevšiml, protože se to NIKDE neporovnávalo.

PROČ PER-GAME: schéma není globální konstanta. Izometrická hra má jiné dlaždice
než side-scroller nebo top-down. Zdroj pravdy je proto `assets/spec.json`
KAŽDÉ hry; tenhle nástroj ho jen čte a porovnává se skutečností. Nepředepisuje
žádné konkrétní číslo – jen to, že všechny vrstvy musí říkat totéž.

KONKRÉTNÍ DŮKAZ PATŘÍ HŘE, NE SEM: která vrstva tvrdila co, má vypsané
konkrétní hra (v `docs/` nebo v commitu, který migraci dělal). Sem se neopisuje,
aby šablona netvrdila nic o projektu, který ještě neexistuje.

Použití:
    python .forge/check-schema.py <cesta k repu hry>
    python .forge/check-schema.py . --json
Návratový kód: 0 = v pořádku, 1 = rozpory, 2 = chybí spec (nedá se měřit).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _popis_bunky(h: dict | None) -> str:
    """Lidsky popíše naměřenou buňku – a PRÁZDNO pojmenuje jako nezměřené."""
    if not h:
        return "nezměřeno (v kódu není)"
    if h.get("sirka") == h.get("vyska"):
        return f"{h['sirka']}px"
    return f"{h.get('sirka')}×{h.get('vyska')}px"


def _nacti_json(cesta: Path):
    try:
        # `utf-8-sig` odstraňuje BOM. PowerShell (`Set-Content -Encoding UTF8`)
        # i některé editory na Windows ho přidávají na začátek souboru a
        # `json.loads` na něm spadne s nesrozumitelnou hláškou. Stejná past už
        # jednou potkala `orchestra/.env` (viz orchestra/README.md).
        return json.loads(cesta.read_text(encoding="utf-8-sig"))
    except Exception as e:
        return {"_chyba": str(e)}


def _cisla_z_gd(text: str, vzor: str) -> list[int]:
    """Vytáhne čísla z deklarace v GDScriptu (např. `var cell := 16`).

    POŘADÍ JE VZESTUPNÉ a volající bere POSLEDNÍ prvek. V GDScriptu platí
    pozdější deklarace, takže když soubor nese obojí (historii i dnešní stav),
    musí vyhrát ta pozdější. Kdyby se bral první výskyt, hlásila by kontrola
    vadu i po opravě – a to je falešný poplach, který nutí „opravovat" správný
    kód (přesně tahle past se už jednou stala u izometrie).
    """
    out = []
    for m in re.finditer(vzor, text):
        try:
            out.append(int(m.group(1)))
        except (TypeError, ValueError):
            pass
    return out


def _deklarace_cell(text: str) -> list[tuple[str, int]]:
    """Najde deklarace `var`/`const` s buňkou a vrátí [(jméno, číslo), …].

    Vrací i JMÉNO, protože podle něj se určuje osa. Je to schválně: určovat osu
    lookaheadem uvnitř vzorce se ukázalo jako past (čtyři verze a každá lhala
    jinak – `\\b` po `_h` neplatí, protože podtržítko je „word char“, a vložený
    přepínač `(?i:…)` se vnořenému lookaheadu nedaří předat). Jméno je
    jednoznačné a dá se na něm i testovat.

    Chytá tvary:
        `const CELL_W_DEFAULT := 96` · `var cell := 16` · `const cell: int = 32`
    NEchytá (a je to záměr):
        `cell_w = int(w)`  – PŘIŘAZENÍ bez `var`/`const`; `= int(w)` navíc není
                             číslo, takže by se stejně nevyhodnotilo
    """
    vzor = (r"(?:var|const)\s+(?P<jmeno>\w*cell\w*)\s*"
            r"(?::\s*int\s+)?:?=\s*(?P<hodnota>\d+)\b")
    out = []
    # IGNORECASE je POVINNÝ: jména jsou v GDScriptu i VELKÁ (`CELL_W_DEFAULT`)
    # a bez přepínače projde jen malá varianta – kontrola by zase tiše neměřila.
    for m in re.finditer(vzor, text, re.IGNORECASE):
        out.append((m.group("jmeno"), int(m.group("hodnota"))))
    return out


def _cisla_wh_z_gd(text: str, vzor_sirka: str | None = None,
                   vzor_vyska: str | None = None,
                   doplnit_vysku: bool = True) -> dict[str, int]:
    """Vytáhne výchozí ŠÍŘKU a VÝŠKU buňky z level.gd.

    Tvar A (čtverec) – jedno číslo platí pro obě osy:
        `var cell := 16` · `const cell := 16` · `const CELL := 16`
    Tvar B (kosočtverec) – dvě čísla, protože 96×48:
        `const CELL_W_DEFAULT := 96` · `const CELL_H_DEFAULT := 48`

    Osa se určuje podle JMÉNA: končí-li na `_h`, je to výška, jinak šířka.
    Platí POSLEDNÍ deklarace v souboru (v GDScriptu pozdější přebíjí starší) –
    kdyby se brala první, hlásila by kontrola vadu i po opravě a nutila by
    „opravovat“ správný kód.

    Vrací jen to, co v souboru skutečně je. Prázdný slovník je SIGNÁL, že se
    číst nedalo – volající to musí vyhodnotit jako „kontrola neproběhla“,
    ne jako „je to v pořádku“ (viz komentář u volání).
    """
    out: dict[str, int] = {}
    if vzor_sirka is not None or vzor_vyska is not None:
        # Volající si dodal vlastní vzorce (fallback `get("cell", N)`) – tam
        # jméno k dispozici není, takže se bere, co vzorec vrátí.
        if vzor_sirka is not None:
            w = _cisla_z_gd(text, vzor_sirka)
            if w:
                out["sirka"] = w[-1]
        if vzor_vyska is not None:
            h = _cisla_z_gd(text, vzor_vyska)
            if h:
                out["vyska"] = h[-1]
        return out

    for jmeno, hodnota in _deklarace_cell(text):
        # Osa podle ZNAČKY ve jménu, ne podle konce jména: `CELL_H_DEFAULT`
        # končí na `_DEFAULT`, takže `endswith("_h")` by výšku minulo a obě osy
        # by se hlásily jako šířka (naměřeno: 96×48 → 48×48).
        osa = "vyska" if "_h" in jmeno.lower() else "sirka"
        out[osa] = hodnota          # poslední deklarace vyhrává
    # Tvar A: jediné číslo platí pro obě osy (dokud ho tvar B nepřebije).
    if doplnit_vysku and "sirka" in out and "vyska" not in out:
        out["vyska"] = out["sirka"]
    return out


def zkontroluj(repo: Path) -> tuple[list[str], list[str], list[str], dict]:
    """Vrátí (vady, varování, poznámky, naměřeno)."""
    vady: list[str] = []
    varovani: list[str] = []
    poznamky: list[str] = []
    data: dict = {}

    # ---------------------------------------------------------- deklarace ----
    spec_cesta = repo / "assets" / "spec.json"
    if not spec_cesta.is_file():
        return ([f"chybí {spec_cesta} – bez specu se schéma měřit nedá"], [], [], {})
    spec = _nacti_json(spec_cesta)
    if "_chyba" in spec:
        return ([f"{spec_cesta} není platné JSON: {spec['_chyba']}"], [], [], {})

    # Schéma může být zapsané dvěma způsoby – bere se, co hra má:
    #   A) `tile: {sirka, vyska}` + `viewport`   (konkrétní dlaždice + okno)
    #   B) `projekce: {...}`                      (obecnější, pro jiné hry)
    proj = spec.get("projekce", {})
    tile = spec.get("tile", {})
    projekce = str(proj.get("typ") or spec.get("projekce_typ") or "").lower()
    if not projekce:
        # odvození z dlaždice: 2:1 znamená izometrii, 1:1 čtverec
        sirka, vyska = tile.get("sirka"), tile.get("vyska")
        if sirka and vyska:
            projekce = "izometricka" if int(sirka) != int(vyska) else "ctvercova"
    tile_w = proj.get("dlazdice_sirka") or tile.get("sirka")
    tile_h = proj.get("dlazdice_vyska") or tile.get("vyska")
    viewport = proj.get("viewport") or spec.get("viewport")

    data["deklarace"] = {"projekce": projekce, "dlazdice": [tile_w, tile_h],
                         "viewport": viewport}

    if not tile_w or not tile_h:
        vady.append("spec.json nedeklaruje velikost dlaždice (tile.sirka/vyska "
                    "nebo projekce.dlazdice_sirka/vyska) – není co porovnávat")
    if projekce not in ("izometricka", "izometrická", "iso", "ctvercova", "čtvercová", "square"):
        varovani.append(f"neznámý typ projekce '{projekce}' – porovnávám jen čísla")

    # ------------------------------------------------------------ mapy -------
    urovne = sorted((repo / "assets" / "levels").glob("*.json"))
    urovne = [p for p in urovne if p.name != "manifest.json"]
    data["urovne"] = {}
    for u in urovne:
        d = _nacti_json(u)
        if "_chyba" in d:
            vady.append(f"{u.name} není platné JSON: {d['_chyba']}")
            continue
        cell = d.get("cell")
        data["urovne"][u.name] = {"cell": cell, "viewport": d.get("viewport"),
                                  "velikost": [d.get("width"), d.get("height")]}
        if cell is None:
            vady.append(f"{u.name}: chybí 'cell' – mapa neurčuje velikost buňky")
            continue
        # TADY se láme izometrie: buňka mapy musí odpovídat dlaždici ze specu.
        if tile_w and int(cell) != int(tile_w):
            vady.append(
                f"{u.name}: buňka mapy je {cell}px, ale spec.json deklaruje dlaždici "
                f"{tile_w}px – hra by kreslila jiné měřítko, než je schválené")
        if d.get("viewport") and viewport and list(d["viewport"]) != list(viewport):
            varovani.append(
                f"{u.name}: viewport {d['viewport']} vs. spec {viewport}")
    if not urovne:
        poznamky.append("v assets/levels nejsou žádné mapy – kontrola map přeskočena")

    # --------------------------------------------------------- vykreslení ----
    lg = repo / "scripts" / "level.gd"
    wg = repo / "scripts" / "world.gd"   # potřeba i v izometrické kontrole níž
    if lg.is_file():
        t = lg.read_text(encoding="utf-8", errors="replace")
        # KOMENTÁŘE SE ODSTRANÍ, NEŽ SE HLEDAJÍ VZORCE. Soubor v hlavičce cituje
        # STARÝ chybný vzorec jako historii – a statická kontrola ho pak najde
        # a hlásí vadu i po opravě (přesně to se stalo). Komentář popisující
        # vadu nesmí vypadat jako vada.
        t = "\n".join(radek.split("#", 1)[0] for radek in t.splitlines())
        data["level_gd"] = {}
        # VÝCHOZÍ HODNOTY SE HLEDAJÍ VE DVOU TVARECH, protože se vzorec mění
        # s migrací na izometrii:
        #   A) čtvercová buňka (původní): `var cell := 16`, `const cell := 16`
        #   B) kosočtverec (izometrie):    `const CELL_W_DEFAULT := 96` + `_H_`
        # Past, kterou to zavírá (naměřeno 1. 10. 2026): kontrola hledala JEN
        # tvar A. Po migraci se z `var cell := 16` stalo `const CELL_W_DEFAULT`,
        # regexy nenašly nic, cyklus níž proběhl nad prázdným seznamem – a
        # kontrola tiše hlásila `výchozí cell=[], fallback=[]` a ZELENOU.
        # Nula bez dat není úspěch: když kontrola nemá co měřit, musí to říct.
        vychozi_wh = _cisla_wh_z_gd(t)
        # Fallback se hledá pro KAŽDOU OSU ZVLÁŠŤ a klíč musí být konkrétní:
        # `get("cell", N)` je jen šířka (kdyby to bylo společné číslo, výška
        # se doplní z deklarace výš, ne odsud).
        fallback_wh = _cisla_wh_z_gd(
            t, r'get\(\s*"(?:cell|cell_w|sirka)"\s*,\s*(\d+)\s*\)',
            r'get\(\s*"(?:cell_h|vyska)"\s*,\s*(\d+)\s*\)',
            doplnit_vysku=False)
        vychozi = list(vychozi_wh.values())
        fallback = list(fallback_wh.values())
        data["level_gd"]["vychozi"] = vychozi_wh
        data["level_gd"]["fallback"] = fallback_wh
        # Ploché seznamy zůstávají kvůli zpětné shodě s `--json` spotřebiteli.
        data["level_gd"]["vychozi_cell"] = vychozi
        data["level_gd"]["fallback_cell"] = fallback
        # DVĚ RŮZNÉ VĚCI, které se nesmí slít do jedné:
        #   a) výchozí buňku nejde přečíst → kontrola NEPROBĚHLA (vada),
        #   b) fallback v kódu není          → není co měřit, ale to je stav
        #      kódu, ne selhání kontroly (poznámka).
        # Případ (b) je běžný: vstupní bod má výchozí konstanty buňky, ale
        # `data.get("cell", [0, 0])` u markerů fallback nemá.
        if not vychozi and not fallback:
            vady.append(
                "scripts/level.gd: výchozí/fallback buňku se NEPODAŘILO přečíst "
                "(hledány tvary `var cell := N`, `const CELL_W_DEFAULT := N`, "
                "`get('cell', N)`) – kontrola zabudovaného měřítka tedy "
                "NEPROBĚHLA. Není to totéž jako „je to v pořádku“")
        elif not vychozi:
            vady.append(
                "scripts/level.gd: VÝCHOZÍ buňku se nepodařilo přečíst – když "
                "bude chybět 'cell' v datech, není podle čeho poznat, na jaké "
                "měřítko se hra překreslí")
        elif not fallback:
            poznamky.append(
                "level.gd nemá fallback buňky (`get(\"cell\", N)`) – kontrola "
                "fallbacku tedy nemá co měřit (výchozí buňka změřená je)")
        # Šířka a výška se porovnávají ZVLÁŠŤ: u izometrie se liší (96×48),
        # takže jedno společné číslo by u kosočtverce hlásilo falešnou vadu.
        for kde, hodnoty in (("výchozí", vychozi_wh), ("fallback", fallback_wh)):
            for osa, c in hodnoty.items():
                cil = tile_w if osa == "sirka" else tile_h
                if cil and c != int(cil):
                    vady.append(
                        f"scripts/level.gd má {kde} {osa} buňky {c}px, spec "
                        f"deklaruje {cil}px – při chybějícím 'cell' v datech se "
                        f"hra potichu překreslí na jiné měřítko")
        # Izometrie se v datech pozná tak, že buňka má různou šířku a výšku.
        # Čtvercová buňka + deklarovaná izometrie = izometrie nemůže vzniknout.
        if projekce.startswith("izo") and tile_w and tile_h and int(tile_w) == int(tile_h):
            poznamky.append("spec deklaruje izometrii se čtvercovou dlaždicí – "
                            "ovzorkování je na specu, ne na téhle kontrole")
        if projekce.startswith("izo") and tile_w and tile_h and int(tile_w) != int(tile_h):
            # Izometrie se ověřuje TŘEMI nezávislými znaky, protože hledat
            # jeden konkrétní vzorec je křehké: kontrola pak hlásí vadu i po
            # opravě (přesně to se stalo – `level.gd` se přepsal na izometrii
            # a kontrola dál tvrdila, že kreslí čtvercově, protože hledala
            # starý text). Falešný poplach nutí „opravovat" správný kód.
            stary_ctverec = bool(re.search(r"Vector2\(\s*\w+\s*\*\s*cell\s*,", t))
            cte_spec = bool(re.search(r"SPEC_PATH|spec\.json|projekce", t))
            ma_iso_metodu = bool(re.search(r"je_izometricka|iso_position|iso_z", t))
            if stary_ctverec:
                vady.append(
                    "spec.json deklaruje IZOMETRICKOU projekci (dlaždice "
                    f"{tile_w}×{tile_h}), ale scripts/level.gd staví dlaždice osově "
                    "zarovnaně (Vector2(x * cell, y * cell)) – izometrický pohled "
                    "takto nemůže vzniknout, ať se sprity ladí jakkoli")
            elif not cte_spec and not ma_iso_metodu:
                # „NEDÁ SE POSOUDIT" NENÍ VADA. Když kód neumíme přečíst, řekne
                # se to jako poznámka – vymyslet z toho vadu by bylo horší.
                poznamky.append(
                    "level.gd nevypadá ani čtvercově, ani izometricky – projekci "
                    "nejde z kódu posoudit (zkontroluj to očima)")
            if not ma_iso_metodu:
                wg_txt = ""
                if wg.is_file():
                    wg_txt = wg.read_text(encoding="utf-8", errors="replace")
                if re.search(r"iso_position", wg_txt):
                    vady.append(
                        "izometrická projekce je jen v scripts/world.gd (iso_position), "
                        "ale level.gd ji nepoužívá – izometrie tedy v projektu NENÍ, "
                        "jen v komentáři")
    else:
        poznamky.append("scripts/level.gd není – kontrola vykreslování přeskočena")

    # ------------------------------------------- druhá logika (riziko dvou) --
    if wg.is_file():
        t = wg.read_text(encoding="utf-8", errors="replace")
        t = "\n".join(radek.split("#", 1)[0] for radek in t.splitlines())
        # Stejná past jako u level.gd: jeden konkrétní vzorec znamená, že po
        # přejmenování konstanty kontrola tiše přestane měřit (a mlčí).
        wcell = _cisla_z_gd(t, r"(?:var|const)\s+cell\w*\s*(?::\s*int\s+)?:?=\s*(\d+)")
        wcell = wcell[-1:]   # poslední deklarace platí (viz `_cisla_z_gd`)
        ma_iso = bool(re.search(r"iso_position", t))
        data["world_gd"] = {"cell": wcell, "iso": ma_iso}
        if not wcell:
            poznamky.append(
                "scripts/world.gd existuje, ale jeho buňku se NEPODAŘILO přečíst "
                "– kontrola „dvě různé představy o mřížce“ NEPROBĚHLA")
        for c in wcell:
            if tile_w and c != int(tile_w):
                vady.append(
                    f"scripts/world.gd má cell={c}px, spec deklaruje {tile_w}px "
                    f"– DVĚ různé představy o mřížce v jednom projektu")
        if ma_iso and tile_w:
            if int(tile_w) % 4 != 0:
                vady.append(
                    f"izometrický vzorec v world.gd dělí cell/4; {tile_w} není "
                    f"dělitelné 4 → celočíselné dělení potichu zkreslí projekci")
            # Text se skládá z NAMĚŘENÝCH hodnot, ne z natvrdo psané věty:
            # po migraci na izometrii level.gd izometrii MÁ, a neměnná věta by
            # lhala („level.gd kreslí čtvercově“) i po opravě.
            poznamky.append(
                "world.gd nese izometrickou projekci; level.gd dnes deklaruje "
                f"projekci '{projekce}' (zabudovaná buňka "
                f"{data.get('level_gd', {}).get('vychozi', {})}) – ověř, který "
                f"soubor je skutečně zapojený")

    # ------------------------------------- mrtvá kontrola (po smazání souboru) --
    # Když soubor zmizel, ale kód na něj má větev, je to SLEPÉ MÍSTO: kontrola
    # už nikdy neproběhne, a přesto se tváří jako součást brány. Naměřeno
    # 30. 9. 2026: `world.gd` se smazal při migraci na izometrii a větve
    # `iso_position` v tomhle souboru i v `verify-level-render.py` zůstaly.
    if not wg.is_file():
        poznamky.append(
            "scripts/world.gd neexistuje – na jeho větve se NEDOSTANE (kontrola "
            "druhé logiky mřížky i izometrie v něm je mrtvá, ne splněná)")

    # ----------------------------------------------------------- dlaždice ----
    tm = repo / "assets" / "tiles" / "manifest.json"
    if tm.is_file():
        d = _nacti_json(tm)
        ts = d.get("tile_size")
        data["tiles_manifest"] = {"tile_size": ts}
        # `tile_size` může být ČÍSLO (čtvercová dlaždice: 32) i SEZNAM
        # (kosočtverec: [96, 48]). První verze kontroly počítala jen s číslem
        # a na seznam spadla na TypeError – což je něco jiného než „našla vadu".
        if isinstance(ts, (list, tuple)):
            ts_w = int(ts[0]) if len(ts) > 0 else None
            ts_h = int(ts[1]) if len(ts) > 1 else ts_w
        elif ts is not None:
            ts_w = ts_h = int(ts)
        else:
            ts_w = ts_h = None
        if ts_w and tile_w and tile_h:
            if ts_w != int(tile_w) or ts_h != int(tile_h):
                vady.append(
                    f"assets/tiles/manifest.json: tile_size {ts_w}×{ts_h}, spec "
                    f"deklaruje {tile_w}×{tile_h} – dlaždice se ve hře škálují")
    else:
        poznamky.append("assets/tiles/manifest.json není – dlaždice nelze ověřit")

    # ------------------------------------------------------------ sprity -----
    role = spec.get("role", {})
    sp = repo / "assets" / "sprites"
    if role and sp.is_dir():
        from PIL import Image  # lokální import: bez spritů není potřeba
        mismatched = []
        for jmeno, pozadovano in role.items():
            f = sp / f"{jmeno}.png"
            if not f.is_file():
                continue
            canvas = pozadovano.get("canvas")
            if not canvas:
                continue
            w, h = Image.open(f).size
            if w != int(canvas) or h != int(canvas):
                mismatched.append(f"{jmeno}.png je {w}×{h}, spec chce plátno {canvas}×{canvas}")
        # Klíč ve výstupu zůstává `nesedi` (malé s) – čte ho `:445` téhož
        # souboru a je to součást strojového výstupu, ne identifikátor v kódu.
        data["sprity"] = {"zkontrolovano": len(role), "nesedi": mismatched}
        vady += mismatched

    return vady, varovani, poznamky, data


def main() -> int:
    ap = argparse.ArgumentParser(description="Kontrola vizuálního schématu hry")
    ap.add_argument("repo", nargs="?", default=".",
                    help="cesta k repu hry (výchozí: aktuální složka)")
    ap.add_argument("--json", action="store_true", help="vypsat i naměřená data")
    args = ap.parse_args()

    repo = Path(args.repo)
    if not repo.is_dir():
        print(f"CHYBA: {repo} není složka")
        return 2

    vady, varovani, poznamky, data = zkontroluj(repo)

    d = data.get("deklarace", {})
    print(f"Kontrola schématu: {repo}")
    print(f"  spec.json deklaruje: projekce={d.get('projekce') or '?'}, "
          f"dlaždice={d.get('dlazdice')}, viewport={d.get('viewport')}")
    for jmeno, m in data.get("urovne", {}).items():
        print(f"  mapa {jmeno:14s} cell={m['cell']}  viewport={m['viewport']}  "
              f"mřížka={m['velikost']}")
    if data.get("level_gd"):
        lg = data["level_gd"]
        # Prázdno se MUSÍ vypsat jako „nepodařilo se přečíst“, ne jako `[]`:
        # `[]` vypadá jako naměřená nula, tedy jako úspěch. Přesně tímhle
        # způsobem kontrola 1. 10. 2026 tiše přestala měřit a nikdo si toho
        # nevšiml – brána byla zelená a nic nezkontrolovala.
        print(f"  level.gd: výchozí buňka={_popis_bunky(lg.get('vychozi'))}, "
              f"fallback={_popis_bunky(lg.get('fallback'))}")
    if data.get("world_gd"):
        print(f"  world.gd: cell={data['world_gd']['cell']}, "
              f"izometrie={'ano' if data['world_gd']['iso'] else 'ne'}")
    if data.get("tiles_manifest"):
        print(f"  tiles/manifest.json: tile_size={data['tiles_manifest']['tile_size']}")
    if data.get("sprity"):
        print(f"  sprity: zkontrolováno {data['sprity']['zkontrolovano']}, "
              f"nesedí {len(data['sprity']['nesedi'])}")

    for p in poznamky:
        print(f"  poznámka: {p}")
    for v in varovani:
        print(f"  VAROVÁNÍ: {v}")
    if vady:
        print(f"\nROZPORY ({len(vady)}):")
        for v in vady:
            print(f"  - {v}")
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))

    if vady:
        print("\nSCHÉMA SI ODPORUJE – vizuální kontroly nemají proti čemu měřit.")
        return 1
    print("\nSchéma je v souladu: deklarace, mapy, vykreslení i dlaždice říkají totéž.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
