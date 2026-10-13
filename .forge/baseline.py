#!/usr/bin/env python
r"""Baseline a LGTM: co je vizuálně SCHVÁLENÉ a co se od té doby změnilo.

PROČ TO EXISTUJE — bez baseline nelze měřit drift. „Vypadá to jinak" je tvrzení,
které se nedá ověřit, dokud není s čím porovnávat. Baseline je ten referenční
bod a **schvaluje ho člověk**, ne model.

CO TO ŘEŠÍ KONKRÉTNĚ:

  1. **Cache.** Nezměněný obrázek se znovu neposílá modelu (ušetří kvótu i čas).
     Klíčem je `phash` (percepční hash), NE `sha256` – PNG se dá přeuložit
     s jinými metadaty a stejný obrázek má pak jiný `sha256`. `phash` pozná
     „je to vizuálně totéž".
  2. **Schválení.** Co jsi odklepl, se znovu nekontroluje. A co v baseline
     NENÍ, se nesmí sloučit samo – tím zůstává kontrola u tebe.
  3. **Zamítnuté.** Co už neprošlo, se nemá zkoušet znovu se stejným seedem.

FORMÁT SOUBORŮ (`.forge/vision/`):

    baseline.json   – schválené položky: sha256, phash, seed, kdo a kdy schválil
    verdicts.jsonl  – historie verdiktů vision (audit, jen se přidává)
    rejected.jsonl  – zamítnuté s důvodem (aby se nezkoušely pořád dokola)

JAK SE TO VOLÁ Z NODE (`vision.mjs`):
    python .forge/baseline.py --json kontrola <obrazek>
        → {"v_cache": true|false, "duvod": "...", "verdikt": {...}}
      `v_cache: true` znamená „tenhle obrázek je SCHVÁLENÝ a nezměněný –
      neposílej ho modelu, ušetři kvótu".

Použití:
    python .forge/baseline.py stav                  # co je změněné / neschválené
    python .forge/baseline.py init                  # baseline = dnešní stav (LGTM)
    python .forge/baseline.py schval <slozka|soubor> [--poznamka "..."]
    python .forge/baseline.py zamitni <soubor> --duvod "..."
    python .forge/baseline.py kontrola <obrazek>    # je v cache? (pro vision.mjs)
    python .forge/baseline.py zapis-verdikt --verdikt ok --obrazek a.png
    python .forge/baseline.py testy                 # offline testy vlastní logiky

Návratový kód: 0 = v pořádku / operace provedena, 1 = neschválené změny
(u `stav` je 1 očekávaný stav, ne chyba nástroje), 2 = chyba vstupu.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Složky, které se evidují. Jsou dvě a je to záměr:
#   assets/sprites        – to, co vidí HRA (složené sprity)
#   tools/blender/sprites – VRSTVY z Blenderu, ze kterých se skládá
# Když se změní jen vrstva, hra vypadá jinak, i když je `assets/sprites` stejná.
SLEDOVANE = ["assets/sprites", "tools/blender/sprites"]

SLOZKA_EVIDENCE = Path(".forge") / "vision"

# Kvantizace barevného podpisu: 16 úrovní na kanál. Malá změna jasu (přeuložení,
# jiný encoder) podpis nezmění, změna barvy ano.
KROK_KVANTIZACE = 16


def barevny_podpis(cesta: Path) -> str | None:
    """Podpis BARVY – chytá to, na co je phash slepý.

    PROČ TO MUSÍ EXISTOVAT (naměřeno 30. 9. 2026): `phash` je DCT přes
    ODSTUPŇOVOU ŠKÁLU (`convert("L")`), takže **nerozezná barvu**. Dva obrázky
    se stejným rozložením světla a jinou barvou mají IDENTICKÝ phash:

        červená + bílé/černé bloky → f8f8f8f0f0070707
        modrá   + bílé/černé bloky → f8f8f8f0f0070707   ← stejné!

    Důsledek bez tohohle podpisu: **přebarvený asset by se tvářil jako
    nezměněný** a nikdy by se nedostal k vizuální kontrole. Přitom přebarvení
    (týmové barvy, jiný materiál, jiná varianta) je v herní grafice běžná věc.

    Podpis = průměrné RGB zmenšené na 4×4 dlaždice, kvantované. Není to hash
    pro rovnost, ale pro PODOBNOST.
    """
    try:
        from PIL import Image, ImageStat
        with Image.open(cesta) as im:
            mala = im.convert("RGB").resize((4, 4), Image.LANCZOS)
        st = ImageStat.Stat(mala)
        return "-".join(f"{int(round(v)) // KROK_KVANTIZACE}"
                        for v in (st.mean[0], st.mean[1], st.mean[2]))
    except Exception:
        return None


def phash(cesta: Path) -> str | None:
    """Percepční hash STRUKTURY – pozná vizuálně stejný obrázek i po přeuložení PNG.

    DVĚ ZMĚŘENÉ MEZERY, které se musí ošetřit:

    1. **Odstupňová škála** – phash je slepý na barvu (viz `barevny_podpis`).
       Proto se v cache porovnává phash **a** barevný podpis.
    2. **Jednolité obrázky** – DCT zdegeneruje. Naměřeno: plná červená
       (200,30,30) a plná modrá (30,30,210) mají STEJNÝ phash
       `8000000000000000`. U takového obrázku se vrací `None` a porovnává se
       přesným `sha256`, který změnu pozná vždy.

    Reálné assety mez č. 2 nemají (naměřeno na `uo-shadows`: dlaždice std 12–41,
    sprity std 47–94), ale jednolitá textura je běžná – a tichá chyba
    „nezměněno" u změněného assetu je přesně to, čemu má baseline bránit.
    """
    try:
        import imagehash
        from PIL import Image, ImageStat
        with Image.open(cesta) as im:
            rgba = im.convert("RGBA")
            # Práh 1.0 je záměrně nízko: vylučujeme jen skutečně jednolité
            # obrázky, ne „málo kontrastní". Falešné vyloučení znamená jen
            # přesnější (a dražší) porovnání, což je bezpečný směr.
            if ImageStat.Stat(rgba.convert("L")).stddev[0] < 1.0:
                return None
            return str(imagehash.phash(rgba))
    except Exception:
        return None


def sha256(cesta: Path) -> str:
    return hashlib.sha256(cesta.read_bytes()).hexdigest()


def cas() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def nacti_json(cesta: Path, vychozi=None):
    if not cesta.is_file():
        return vychozi
    try:
        # `utf-8-sig` kvůli BOM – PowerShell ho na Windows přidává a `json.loads`
        # na něm spadne (stejná past jako u `orchestra/.env`).
        return json.loads(cesta.read_text(encoding="utf-8-sig"))
    except Exception as e:
        print(f"CHYBA: {cesta} není platné JSON: {e}")
        return vychozi


class Evidence:
    """Drží baseline, verdikty a zamítnuté. Načítá se jednou, zapisuje po akci."""

    def __init__(self, koren: Path):
        self.koren = koren
        self.slozka = koren / SLOZKA_EVIDENCE
        self.baseline_cesta = self.slozka / "baseline.json"
        self.verdikty_cesta = self.slozka / "verdicts.jsonl"
        self.zamitnute_cesta = self.slozka / "rejected.jsonl"
        self.baseline = nacti_json(
            self.baseline_cesta,
            {"verze": 1, "prompt_verze": None, "schvaleno": None, "polozky": {}}) or {}

    def uloz(self) -> None:
        self.slozka.mkdir(parents=True, exist_ok=True)
        self.baseline_cesta.write_text(
            json.dumps(self.baseline, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")

    def _pripis(self, cesta: Path, zaznam: dict) -> None:
        self.slozka.mkdir(parents=True, exist_ok=True)
        with cesta.open("a", encoding="utf-8") as f:
            f.write(json.dumps(zaznam, ensure_ascii=False) + "\n")

    def zapis_verdikt(self, zaznam: dict) -> None:
        self._pripis(self.verdikty_cesta, {"cas": cas(), **zaznam})

    def zamitni(self, klic: str, duvod: str) -> None:
        self._pripis(self.zamitnute_cesta,
                     {"cas": cas(), "polozka": klic, "duvod": duvod})

    def zamitnute_klice(self) -> set[str]:
        if not self.zamitnute_cesta.is_file():
            return set()
        out = set()
        for radek in self.zamitnute_cesta.read_text(encoding="utf-8").splitlines():
            if not radek.strip():
                continue
            try:
                out.add(json.loads(radek)["polozka"])
            except Exception:
                continue
        return out

    # ------------------------------------------------------------- cache ----
    def kontrola(self, obrazek: Path) -> dict:
        """Je obrázek v cache (schválený a nezměněný)? Podklad pro vision.mjs.

        MUSÍ SE SHODOVAT OBOJÍ – struktura (phash) i barva (barevný podpis).
        Kdyby stačil phash, přebarvený asset by prošel jako nezměněný: phash je
        jen odstupňová škála a červená s modrou mají stejný hash (naměřeno).
        """
        try:
            k = klic(self.koren, obrazek)
        except ValueError:
            return {"v_cache": False, "duvod": "mimo repo hry"}
        zaznam = (self.baseline.get("polozky") or {}).get(k)
        if zaznam is None:
            return {"v_cache": False, "duvod": "není v baseline (neschváleno)"}
        if k in self.zamitnute_klice():
            return {"v_cache": False, "duvod": "v historii zamítnuté"}

        ph = phash(obrazek)
        barva = barevny_podpis(obrazek)

        # Jednolité obrázky (phash je None) se porovnávají PŘESNĚ. Je to dražší
        # a přísnější, ale nikdy to nelže – což je u cache to hlavní.
        if ph is None:
            if zaznam.get("sha256") == sha256(obrazek):
                return {"v_cache": True, "duvod": "schváleno a nezměněno (přesná shoda)",
                        "schvalil": zaznam.get("schvalil"),
                        "schvaleno": zaznam.get("schvaleno")}
            return {"v_cache": False, "duvod": "změnil se (jednolítý obrázek, "
                                               "phash nepoužitelný → přesná shoda nesedí)"}

        if not zaznam.get("phash"):
            return {"v_cache": False, "duvod": "záznam nemá phash (starší formát)"}
        if ph != zaznam["phash"]:
            return {"v_cache": False, "duvod": "vizuálně se změnil (struktura/phash jiný)",
                    "byl": zaznam["phash"], "je": ph}
        # Barevný podpis chytá to, na co je phash slepý (přebarvení).
        if zaznam.get("barva") and barva and zaznam["barva"] != barva:
            return {"v_cache": False, "duvod": "změnila se BARVA (phash je slepý na barvu)",
                    "byl": zaznam["barva"], "je": barva}
        # Schváleno a vizuálně totéž → model se ptát nemusí.
        return {"v_cache": True, "duvod": "schváleno a nezměněno",
                "schvalil": zaznam.get("schvalil"), "schvaleno": zaznam.get("schvaleno")}


def sledovane_soubory(koren: Path) -> list[Path]:
    out: list[Path] = []
    for rel in SLEDOVANE:
        slozka = koren / rel
        if not slozka.is_dir():
            continue
        for p in sorted(slozka.rglob("*.png")):
            # Pomocné soubory tvůrce (náhledy, montáže) se needvidují – nejsou
            # součástí hry a jejich změna nic neznamená.
            if p.name.startswith("_"):
                continue
            out.append(p)
    return out


def klic(koren: Path, cesta: Path) -> str:
    return str(Path(cesta).resolve().relative_to(Path(koren).resolve())).replace("\\", "/")


def popis_stavu(ev: Evidence) -> tuple[list[dict], list[dict], list[dict]]:
    """Vrátí (nove, zmenene, schvalene) podle porovnání phash+barva/sha256."""
    nove, zmenene, schvalene = [], [], []
    for p in sledovane_soubory(ev.koren):
        k = klic(ev.koren, p)
        zaznam = (ev.baseline.get("polozky") or {}).get(k)
        ph = phash(p)
        barva = barevny_podpis(p)
        if zaznam is None:
            nove.append({"klic": k, "phash": ph, "barva": barva})
            continue
        # Jednolítý obrázek → přesná shoda.
        if ph is None:
            if zaznam.get("sha256") != sha256(p):
                zmenene.append({"klic": k, "phash": None, "barva": barva,
                                "poznamka": "jednolítý obrázek – porovnáno přesně"})
            else:
                schvalene.append({"klic": k})
            continue
        if zaznam.get("phash") and zaznam["phash"] != ph:
            zmenene.append({"klic": k, "phash": ph, "byl": zaznam["phash"]})
        elif zaznam.get("barva") and barva and zaznam["barva"] != barva:
            zmenene.append({"klic": k, "barva": barva, "byl": zaznam["barva"],
                            "poznamka": "změnila se barva (phash je na barvu slepý)"})
        elif zaznam.get("sha256") != sha256(p):
            # Obsah se lišil, ale vizuálně je to totéž (přeuložené PNG).
            zmenene.append({"klic": k, "phash": ph, "byl": zaznam.get("phash"),
                            "poznamka": "jen metadata (phash i barva stejné)"})
        else:
            schvalene.append({"klic": k})
    return nove, zmenene, schvalene


def zapis_polozky(ev: Evidence, soubor: Path, kdo: str, poznamka: str | None,
                  seed: int | None = None) -> None:
    ev.baseline.setdefault("polozky", {})[klic(ev.koren, soubor)] = {
        "sha256": sha256(soubor),
        # Struktura I barva – samotný phash je na barvu slepý (viz
        # `barevny_podpis`), takže bez druhého údaje by přebarvený asset prošel.
        "phash": phash(soubor),
        "barva": barevny_podpis(soubor),
        "seed": seed,
        "schvalil": kdo,
        "schvaleno": cas(),
        **({"poznamka": poznamka} if poznamka else {}),
    }


# ------------------------------------------------------------------ testy ----
def _png_barva(cesta: Path, rgb: tuple[int, int, int], velikost=(64, 64)) -> None:
    """Jednolity PNG – záměrně BEZ struktury (testuje se na něm mez phash)."""
    from PIL import Image
    cesta.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGBA", velikost, (*rgb, 255)).save(cesta)


def _png_skvrny(cesta: Path, zaklad: tuple[int, int, int],
                skvrny: list[tuple[int, int, int]], velikost=(64, 64)) -> None:
    """PNG se STRUKTUROU (bloky různých barev) – na tom phash funguje.

    Testovací vzorek musí mít strukturu, jinak se netestuje to, co se testovat
    má: jednolitý obrázek je pro phash degenerovaný případ (viz `phash`).
    """
    from PIL import Image
    cesta.parent.mkdir(parents=True, exist_ok=True)
    im = Image.new("RGBA", velikost, (*zaklad, 255))
    w, h = velikost
    for i, rgb in enumerate(skvrny):
        # bloky 16×16 do mřížky – dost struktury na to, aby DCT něco viděla
        x = (i % 4) * (w // 4)
        y = (i // 4) * (h // 4)
        for dx in range(w // 4):
            for dy in range(h // 4):
                im.putpixel((x + dx, y + dy), (*rgb, 255))
    im.save(cesta)


def testy() -> int:
    """Offline testy vlastní logiky. Bez sítě, bez modelu, bez klíčů."""
    ok = chyb = 0

    def t(nazev, podminka, detail=""):
        nonlocal ok, chyb
        if podminka:
            print(f"  OK   {nazev}")
            ok += 1
        else:
            print(f"  FAIL {nazev}{f' – {detail}' if detail else ''}")
            chyb += 1

    tmp = Path(tempfile.mkdtemp(prefix="baseline-test-"))
    (tmp / ".forge").mkdir(parents=True)
    zprava = tmp / "assets" / "sprites"
    # Fixtures MAJÍ STRUKTURU – na jednolitých obrázcích phash degeneruje
    # (a netestovalo by se to, co se testovat má; mez phash má vlastní test níž).
    _png_skvrny(zprava / "hrdina.png", (200, 30, 30),
                [(255, 255, 255), (0, 0, 0), (200, 30, 30), (90, 90, 90)])
    _png_skvrny(zprava / "mince.png", (240, 200, 40),
                [(255, 255, 255), (120, 90, 10), (240, 200, 40), (60, 60, 60)])
    # Pomocný soubor s podtržítkem se evidovat NEMÁ.
    _png_skvrny(zprava / "_nahléd.png", (10, 10, 10),
                [(90, 90, 90), (200, 200, 200), (10, 10, 10), (40, 40, 40)])
    vrstvy = tmp / "tools" / "blender" / "sprites"
    _png_skvrny(vrstvy / "body_d0_f0.png", (30, 200, 30),
                [(255, 255, 255), (0, 60, 0), (30, 200, 30), (150, 150, 150)])

    ev = Evidence(tmp)

    print("=== baseline.py – offline testy ===")

    # 1) První stav: všechno je nové, pomocný soubor se neeviduje.
    nove, zmenene, schvalene = popis_stavu(ev)
    # Diagnostika vypisuje SKUTEČNÝ obsah, ne jen počet – bez toho se u selhání
    # nepozná, co nástroj vzal navíc.
    t("prázdná baseline = všechny sledované soubory jsou nové", len(nove) == 3,
      f"nových={len(nove)}: {[n['klic'] for n in nove]}")
    # POZOR: kontroluje se POMLČKA NA ZAČÁTKU JMÉNA, ne podtržítko kdekoliv
    # v cestě. První verze testu hledala `_` v celé cestě a selhávala na
    # `body_d0_f0.png` – tedy na názvu, který podtržítka legitimně má (jsou to
    # oddělovače směrů a framů). Chyba byla v testu, ne ve filtru.
    t("soubor s podtržítkem na začátku jména se needviduje",
      all(not Path(n["klic"]).name.startswith("_") for n in nove),
      f"klíče={[n['klic'] for n in nove]}")
    t("evidují se i vrstvy z Blenderu",
      any("tools/blender" in n["klic"] for n in nove),
      str([n["klic"] for n in nove]))

    # 2) init + stav → vše schválené.
    for p in sledovane_soubory(tmp):
        zapis_polozky(ev, p, "clovek", "test")
    ev.baseline["schvaleno"] = cas()
    ev.uloz()
    nove, zmenene, schvalene = popis_stavu(ev)
    t("po init je vše schválené", len(schvalene) == 3 and not nove and not zmenene,
      f"schvalene={len(schvalene)} nove={len(nove)} zmenene={len(zmenene)}")

    # 3) Cache: schválený a nezměněný se pozná.
    k = ev.kontrola(zprava / "hrdina.png")
    t("schválený a nezměněný obrázek je v cache", k.get("v_cache") is True, str(k))
    t("cache nese, kdo schválil", k.get("schvalil") == "clovek", str(k))

    # 4) ZMĚNA OBSAHU: phash se musí lišit a cache musí pustit dál.
    _png_skvrny(zprava / "hrdina.png", (30, 30, 210),
                [(255, 255, 255), (0, 0, 0), (30, 30, 210), (90, 90, 90)])
    k2 = ev.kontrola(zprava / "hrdina.png")
    t("vizuálně změněný obrázek NENÍ v cache", k2.get("v_cache") is False, str(k2))
    t("důvod změny je pojmenovaný", "změnil" in str(k2.get("duvod")), str(k2))
    nove, zmenene, schvalene = popis_stavu(ev)
    t("změna se objeví ve stavu jako ZMENA", len(zmenene) == 1, f"zmenene={len(zmenene)}")

    # 5) PŘEULOŽENÍ PNG (jiná metadata, stejný obraz) = jen metadata, ne změna
    #    vzhledu. Tohle je celý důvod, proč se používá phash a ne sha256.
    #
    #    POZOR: používá se `mince.png`, ne `hrdina.png` – ta se v testu 4
    #    ZÁMĚRNĚ přebarvila, takže by proti baseline správně selhala. První verze
    #    testu si toho nevšimla a hlásila chybu nástroje, i když nástroj měřil
    #    správně. (Test, který si plete „změnil jsem to schválně" s „nástroj
    #    selhal", je horší než žádný test.)
    from PIL import Image
    cesta = zprava / "mince.png"
    with Image.open(cesta) as im:
        im.save(cesta, "PNG", optimize=True, compress_level=1)
    k3 = ev.kontrola(cesta)
    t("přeuložené PNG zůstane v cache (phash i barva jsou stejné)",
      k3.get("v_cache") is True, str(k3))

    # 6) Zamítnuté: i schválený soubor se má znovu zkontrolovat, když je zamítnutý.
    ev.zamitni("assets/sprites/mince.png", "testovací důvod")
    k4 = ev.kontrola(zprava / "mince.png")
    t("zamítnutý obrázek NENÍ v cache", k4.get("v_cache") is False, str(k4))
    t("důvod je v historii zamítnutých", "zamítnut" in str(k4.get("duvod")), str(k4))

    # 7) Mimo repo: kontrola nesmí spadnout, jen vrátit „ne".
    mimo = Path(tempfile.mkdtemp(prefix="baseline-mimo-")) / "cizi.png"
    _png_barva(mimo, (1, 2, 3))
    k5 = ev.kontrola(mimo)
    t("obrázek mimo repo hry = není v cache (bez výjimky)",
      k5.get("v_cache") is False, str(k5))

    # 8) Historie verdiktů se jen přidává (audit).
    ev.zapis_verdikt({"verdikt": "ok", "obrazek": "a.png"})
    ev.zapis_verdikt({"verdikt": "chybi", "obrazek": "b.png"})
    radky = [l for l in ev.verdikty_cesta.read_text(encoding="utf-8").splitlines() if l.strip()]
    t("historie verdiktů má 2 záznamy", len(radky) == 2, f"řádků={len(radky)}")
    t("záznam verdiktu má čas", "cas" in json.loads(radky[0]))

    # 9) BOM v baseline.json nesmí nástroj shodit (PowerShell ho přidává).
    ev.baseline_cesta.write_text(
        "\ufeff" + json.dumps({"verze": 1, "polozky": {}}, ensure_ascii=False),
        encoding="utf-8")
    ev2 = Evidence(tmp)
    t("baseline.json s BOM se načte", ev2.baseline.get("verze") == 1,
      str(ev2.baseline)[:80])

    # 10) MEZ phash: jednolitý obrázek má phash degenerovaný (naměřeno: plná
    #     červená i plná modrá dávají STEJNÝ hash `8000000000000000`). Nástroj
    #     se na to nesmí spolehnout – u takového obrázku musí phash vrátit None,
    #     aby se porovnávalo přesným sha256 a změna se vždy poznala.
    jednolita = tmp / "assets" / "sprites" / "plocha.png"
    _png_barva(jednolita, (200, 30, 30))
    t("jednolité barvě se phash nevěří (vrací None)", phash(jednolita) is None,
      f"phash={phash(jednolita)}")
    # A teď to hlavní: změna jednolitého obrázku musí být POZNANÁ.
    zapis_polozky(ev, jednolita, "clovek", "jednolita")
    ev.uloz()
    _png_barva(jednolita, (30, 30, 210))
    k6 = ev.kontrola(jednolita)
    t("změna jednolitého obrázku se POZNÁ (přes sha256)", k6.get("v_cache") is False,
      str(k6))
    _png_skvrny(jednolita, (200, 30, 30),
                [(255, 255, 255), (0, 0, 0), (200, 30, 30), (90, 90, 90)])
    zapis_polozky(ev, jednolita, "clovek", "se strukturou")
    ev.uloz()
    _png_skvrny(jednolita, (30, 30, 210),
                [(255, 255, 255), (0, 0, 0), (30, 30, 210), (90, 90, 90)])
    k7 = ev.kontrola(jednolita)
    t("změna strukturovaného obrázku se pozná přes phash",
      k7.get("v_cache") is False and "změnil" in str(k7.get("duvod")), str(k7))

    # 11) MEZ phash NA BARVU: phash je jen odstupňová škála, takže přebarvený
    #     obrázek má STEJNÝ phash. Naměřeno: červená i modrá se stejnými bloky
    #     dávají `f8f8f8f0f0070707`. Cache to musí poznat přes barevný podpis,
    #     jinak by se přebarvený asset nikdy nedostal ke kontrole.
    prebarveny = tmp / "assets" / "sprites" / "varianta.png"
    vzor = [(255, 255, 255), (0, 0, 0), (90, 90, 90), (40, 40, 40)]
    _png_skvrny(prebarveny, (200, 30, 30), vzor)
    zapis_polozky(ev, prebarveny, "clovek", "cervena varianta")
    ev.uloz()
    ph_cervena = phash(prebarveny)
    _png_skvrny(prebarveny, (30, 30, 210), vzor)
    ph_modra = phash(prebarveny)
    t("phash je na barvu SLEPÝ (doklad mezery: stejný hash pro jinou barvu)",
      ph_cervena == ph_modra, f"cervena={ph_cervena} modra={ph_modra}")
    k8 = ev.kontrola(prebarveny)
    t("přebarvení se PŘESTO pozná (barevný podpis)", k8.get("v_cache") is False, str(k8))
    t("důvod pojmenovává barvu", "BARVA" in str(k8.get("duvod")), str(k8))

    # 12) CLI kontrakt pro vision.mjs: `--json kontrola` musí vrátit v_cache.
    #     Bere se soubor, který NENÍ zamítnutý (mince.png zamítnutá je – a to je
    #     správně; první verze testu si toho nevšimla a hlásila chybu parsování).
    #
    #     POZOR na parsování: výstup je VÍCEŘÁDKOVÝ JSON, takže se parsuje CELÝ,
    #     ne po řádcích. `splitlines()[-1]` vzalo jen `}` a spadlo to na
    #     „Expecting value: line 1 column 1" – chyba testu, ne nástroje.
    v = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--koren", str(tmp),
         "--json", "kontrola", "assets/sprites/hrdina.png"],
        capture_output=True, text=True, encoding="utf-8")
    try:
        data = json.loads(v.stdout)
        t("CLI `kontrola` vrací JSON s v_cache", "v_cache" in data, v.stdout[:120])
        t("CLI `kontrola` končí s exit 0", v.returncode == 0, f"exit={v.returncode}")
    except Exception as e:
        t("CLI `kontrola` vrací JSON s v_cache", False, f"{e}: {v.stdout[:160]}")

    print()
    print(f"Testů OK: {ok}, chyb: {chyb}")
    print("VŠE OK" if chyb == 0 else "NALEZENY CHYBY")
    return 0 if chyb == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Baseline a LGTM pro vizuální kontrolu")
    ap.add_argument("--koren", default=".", help="kořen hry (výchozí: aktuální složka)")
    ap.add_argument("--json", action="store_true", help="strojový výstup")
    sub = ap.add_subparsers(dest="prikaz", required=True)
    sub.add_parser("stav", help="co je nové / změněné / schválené")
    sub.add_parser("init", help="nastav baseline na dnešní stav (tvrdí, že je LGTM)")
    sub.add_parser("testy", help="offline testy vlastní logiky")
    pSch = sub.add_parser("schval", help="schval složku nebo soubor (LGTM)")
    pSch.add_argument("cesta")
    pSch.add_argument("--kdo", default="clovek", help="kdo schválil (clovek/agent)")
    pSch.add_argument("--poznamka")
    pZam = sub.add_parser("zamitni", help="zapiš zamítnutí s důvodem")
    pZam.add_argument("cesta")
    pZam.add_argument("--duvod", required=True)
    pK = sub.add_parser("kontrola", help="je obrázek v cache? (pro vision.mjs)")
    pK.add_argument("obrazek")
    pV = sub.add_parser("zapis-verdikt", help="zapiš verdikt vision do historie")
    pV.add_argument("--verdikt", required=True)
    pV.add_argument("--obrazek")
    pV.add_argument("--poskytovatel")
    pV.add_argument("--shoda", choices=["true", "false"])
    pV.add_argument("--text")

    args = ap.parse_args()

    if args.prikaz == "testy":
        return testy()

    koren = Path(args.koren).resolve()
    if not (koren / ".forge").is_dir():
        print(f"CHYBA: {koren} nevypadá jako repo hry (chybí .forge/)")
        return 2
    ev = Evidence(koren)

    if args.prikaz == "stav":
        nove, zmenene, schvalene = popis_stavu(ev)
        if args.json:
            print(json.dumps({"nove": nove, "zmenene": zmenene,
                              "schvalene": len(schvalene)}, ensure_ascii=False, indent=2))
        else:
            print(f"Baseline: {ev.baseline_cesta}")
            print(f"  schváleno {ev.baseline.get('schvaleno') or '(nikdy)'}, "
                  f"položek {len(ev.baseline.get('polozky') or {})}")
            print(f"  dnes: schválených {len(schvalene)}, "
                  f"změněných {len(zmenene)}, nových {len(nove)}")
            for z in zmenene:
                print(f"  ZMENA  {z['klic']}  ({z.get('poznamka') or 'vizuálně jiné'})")
            for n in nove[:20]:
                print(f"  NOVE   {n['klic']}")
            if len(nove) > 20:
                print(f"  ... a dalších {len(nove) - 20}")
            zam = ev.zamitnute_klice()
            if zam:
                print(f"  zamítnutých v historii: {len(zam)}")
            if nove or zmenene:
                print("\nCo s tím:")
                print("  python .forge/baseline.py schval <slozka>   # LGTM (schvaluješ ty)")
                print("  python .forge/baseline.py zamitni <soubor> --duvod \"...\"")
        # Exit 1 = jsou neschválené změny. Není to chyba nástroje, ale stav,
        # na který se dá navěsit brána.
        return 1 if (nove or zmenene) else 0

    if args.prikaz == "init":
        for p in sledovane_soubory(koren):
            zapis_polozky(ev, p, "clovek", "init – převzato ze schváleného stavu")
        ev.baseline["schvaleno"] = cas()
        ev.uloz()
        print(f"Baseline zapsán: {ev.baseline_cesta}")
        print(f"  položek {len(ev.baseline['polozky'])}")
        print("  POZOR: `init` jen PŘEBÍRÁ dnešní stav. Je to tvrzení, že je"
              " schválený – ověř, že opravdu je.")
        return 0

    if args.prikaz == "schval":
        cesta = Path(args.cesta)
        if not cesta.is_absolute():
            cesta = koren / cesta
        cesta = cesta.resolve()
        if cesta.is_dir():
            soubory = [p for p in sorted(cesta.rglob("*.png")) if not p.name.startswith("_")]
        elif cesta.is_file():
            soubory = [cesta]
        else:
            print(f"CHYBA: {cesta} neexistuje")
            return 2
        if not soubory:
            print(f"CHYBA: v {cesta} nejsou žádné PNG")
            return 2
        for p in soubory:
            zapis_polozky(ev, p, args.kdo, args.poznamka)
        ev.baseline["schvaleno"] = cas()
        ev.uloz()
        print(f"Schváleno (LGTM): {len(soubory)} souborů, kdo={args.kdo}")
        for p in soubory[:5]:
            print(f"  + {klic(koren, p)}")
        if len(soubory) > 5:
            print(f"  ... a dalších {len(soubory) - 5}")
        return 0

    if args.prikaz == "zamitni":
        k = args.cesta.replace("\\", "/")
        ev.zamitni(k, args.duvod)
        print(f"Zamítnuto: {k}\n  důvod: {args.duvod}")
        return 0

    if args.prikaz == "kontrola":
        obrazek = Path(args.obrazek)
        if not obrazek.is_absolute():
            obrazek = koren / obrazek
        v = ev.kontrola(obrazek.resolve())
        print(json.dumps(v, ensure_ascii=False, indent=2))
        return 0

    if args.prikaz == "zapis-verdikt":
        ev.zapis_verdikt({
            "verdikt": args.verdikt,
            "obrazek": args.obrazek,
            "poskytovatel": args.poskytovatel,
            "shoda": None if args.shoda is None else args.shoda == "true",
            "text": (args.text or "")[:500],
        })
        print(f"Verdikt zapsán do {ev.verdikty_cesta}")
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
