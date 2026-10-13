#!/usr/bin/env node
// Které soubory má agent EDITOVAT (ne jen číst)?
//
// PROČ TO EXISTUJE (root cause 0% úspěšnosti, naměřeno 30. 9. 2026):
//
// Workflow pouštěl aider jen s `--read CONVENTIONS.md`. Tím se soubory dostaly
// do repo-mapy (READ-ONLY), ale NE do chatu jako editovatelné. Aider má ve
// svém promptu pravidlo „Only create SEARCH/REPLACE blocks for files that the
// user has added to the chat!" – takže model správně odmítl editovat a napsal
// „Please add the file's content to the chat". Přesně to udělaly VŠECHNY
// modely (mistral 17–36 tokenů, cerebras 179–204 tokenů).
//
// Vysvětluje to i vzorec úspěch/neúspěch: granule, které soubor jen VYTVÁŘELY
// (attributes.gd, item.gd), prošly – na nový soubor žádný SEARCH blok není
// potřeba. Granule, které existující soubor UPRAVOVALY (skills.gd, world.gd,
// economy.gd), selhaly VŽDY, bez ohledu na model.
//
// Výstup: seznam cest (jedna na řádek) pro `aider --file <cesta>`.
//
// Použití:
//   node .forge/files-to-edit.mjs --grain core.skills
//   node .forge/files-to-edit.mjs --prompt "V scripts/skills.gd vytvoř …"
//   node .forge/files-to-edit.mjs --grain core.skills --konvence   # sekce konvencí
//
// K3 (12. 10. 2026) — REŽIM `--konvence`:
//   Dřív workflow posílal `aider --read CONVENTIONS.md` do KAŽDÉHO běhu. Celý
//   dokument má ~3 900 t a strop Groqu je 8 000 t/min, takže se 14 097 t velký
//   request neposlal vůbec (naměřeno 12. 10. 2026). Konvence se proto rozdělily
//   na sekce (`CONVENTIONS/*.md`) a **granule deklaruje, které potřebuje**:
//   `"konvence": ["01-typy", "06-soubor-granule"]`.
//   „Co se má poslat" je vlastnost GRANULE — odhadovat to podle klíčových slov
//   v zadání by bylo věštění.
//
//   Deklarace je POVINNÁ v plánu (`rozpocet-granuli.mjs` ji vynucuje). Tady je
//   kvůli zpětné kompatibilitě jen most: když granule `konvence` nemá, pošle se
//   VŠE, co je k dispozici (u starých her celý `CONVENTIONS.md`) — a rozpočet to
//   ZAPOČÍTÁ. Tichý přechod na „žádné konvence" by byl horší: model by dostal
//   zadání bez pouček a spálil běh na chybách, které konvence popisují.

import { readFileSync, existsSync, readdirSync } from 'node:fs';

const args = process.argv.slice(2);
const hodnota = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : '';
};
const prepinac = (n) => args.includes(n);
const grain = hodnota('--grain');
const prompt = hodnota('--prompt');
const readDeps = prepinac('--read-deps');
const konvenceRezim = prepinac('--konvence');
const roadmapCesta = hodnota('--roadmap') || '.forge/roadmap.json';

const vydat = (seznam, odkud) => {
  const ciste = [...new Set(seznam)]
    .map((f) => String(f).trim())
    .filter((f) => f && !f.includes('..') && !f.startsWith('/'))
    // Do chatu patří jen soubory, které smí agent měnit.
    .filter((f) => /\.(gd|json|md|cfg|tscn|tres|godot)$/.test(f));
  if (ciste.length) {
    console.error(`[files-to-edit] ${ciste.length} soubor(ů) z ${odkud}`);
    console.log(ciste.join('\n'));
  } else {
    console.error(`[files-to-edit] žádný soubor nenalezen (${odkud})`);
  }
  process.exit(0);
};

// Načtení roadmapy (potřebná pro oba režimy).
const nactiRoadmapu = () => {
  if (!existsSync(roadmapCesta)) return null;
  try {
    const data = JSON.parse(readFileSync(roadmapCesta, 'utf8'));
    return data.grains || data.tasks || [];
  } catch (e) {
    console.error(`[files-to-edit] roadmapu nejde přečíst: ${String(e).slice(0, 120)}`);
    return null;
  }
};

// 0) Režim `--konvence`: které SEKCE konvencí má granule dostat (jen KE ČTENÍ).
//    Výstup jde do `aider --read <cesta>` a do rozpočtu (`--konvence`), takže
//    se do requestu počítá přesně to, co se pošle.
const SEKCE_DIR = 'CONVENTIONS';
if (konvenceRezim) {
  const vsechny = nactiRoadmapu();
  const g = vsechny && grain ? vsechny.find((x) => x.id === grain) : null;
  const deklarovane = (g && Array.isArray(g.konvence) ? g.konvence : [])
    .map((s) => String(s).trim().replace(/^CONVENTIONS\//, '').replace(/\.md$/, ''))
    .filter(Boolean);

  if (deklarovane.length) {
    const cesty = deklarovane.map((s) => `${SEKCE_DIR}/${s}.md`);
    // Chybějící sekce NENÍ varování: `aider --read` na neexistující cestu spadne
    // a příčina by se v logu hledala těžko. Pojmenuje se to hned.
    const chybi = cesty.filter((c) => !existsSync(c));
    if (chybi.length) {
      console.error(`CHYBA: granule ${grain} deklaruje sekce, které v repu nejsou: ${chybi.join(', ')}`);
      console.error(`       (deklarováno: ${JSON.stringify(g.konvence)}; složka ${SEKCE_DIR}/)`);
      process.exit(2);
    }
    console.error(`[files-to-edit] konvence: ${cesty.length} sekce(í) deklarovaných granulí ${grain}`);
    console.log(cesty.join('\n'));
    process.exit(0);
  }

  // Most pro roadmapy bez deklarace (staré hry) — a JE VIDĚT.
  const vSekcich = existsSync(SEKCE_DIR)
    ? readdirSync(SEKCE_DIR).filter((f) => f.endsWith('.md')).sort().map((f) => `${SEKCE_DIR}/${f}`)
    : [];
  const poCem = vSekcich.length ? vSekcich : (existsSync('CONVENTIONS.md') ? ['CONVENTIONS.md'] : []);
  console.error(`[files-to-edit] POZOR: granule ${grain || '(bez --grain)'} NEMÁ deklarované 'konvence' `
    + `→ posílám VŠE, co je k dispozici (${poCem.length} souborů). `
    + `Doplň do roadmapy "konvence": [...] — rozpočet to jinak započítá celé.`);
  if (poCem.length) console.log(poCem.join('\n'));
  process.exit(0);
}

// 0) Režim `--read-deps`: soubory granulí z `depends_on` (jen KE ČTENÍ).
//    Naměřeno 30. 9. 2026 (běh #131, granule entity.npc): model pojmenoval typ
//    podle závislé granule (`Economy`), ale její soubor neviděl → Parse Error
//    „Could not find type Economy". Smlouvy závislostí má přitom dostat – jen
//    je nesmí měnit, a to zajišťuje `--read` místo `--file`.
if (readDeps) {
  const vsechny = nactiRoadmapu();
  const g = vsechny && grain ? vsechny.find((x) => x.id === grain) : null;
  if (!g) {
    console.error(`[files-to-edit] granule ${grain || '(bez --grain)'} v roadmapě není`);
    process.exit(0);
  }
  const soubory = [];
  for (const idZav of g.depends_on || []) {
    const zav = vsechny.find((x) => x.id === idZav);
    for (const f of (zav && zav.owns) || []) soubory.push(f);
  }
  // Jen to, co v projektu skutečně je – `--read` na neexistující cestu aider shodí.
  vydat(soubory.filter((f) => existsSync(f)), `depends_on granule ${grain}`);
}

// 1) Nejpřesnější: `owns` granule z roadmapy (conductor podle něj zamyká souběh,
//    takže je to i deklarace „tenhle soubor granule vlastní").
if (grain) {
  const vsechny = nactiRoadmapu();
  const g = vsechny ? vsechny.find((x) => x.id === grain) : null;
  if (g && Array.isArray(g.owns) && g.owns.length) {
    vydat(g.owns, `owns granule ${grain} v ${roadmapCesta}`);
  }
}

// 2) Záloha: cesty zmíněné v zadání. Modely i roadmapa je píšou jako
//    `scripts/neco.gd`, takže se hledá tenhle tvar.
if (prompt) {
  const najdene = prompt.match(/\b(?:scripts|assets|tests|tools)\/[\w./-]+\.\w+/g) || [];
  if (najdene.length) vydat(najdene, 'zadání (prompt)');
}

console.error('[files-to-edit] nic k editaci – agent dostane jen zadání');
process.exit(0);
