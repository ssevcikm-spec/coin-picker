#!/usr/bin/env node
// K1a - HYGIENA ZADANI: odstrani z textu zadani cesty k souborum.
//
// PROC TO EXISTUJE (namereno 12. 10. 2026 z logu behu 349, 355, 366):
// Aider si do chatu PRIDAVA soubory, ktere jsou v zadani zminene (v kodu
// `base_coder.get_file_mentions`, potvrzuje to i jeho varovani "it's best to
// only add files that need changes to the chat"). Nase zadani odkazovala na
// `docs/TDD.md §1.1` a `docs/ARCHITEKTURA.md §3` - a tim se do KAZDEHO
// requestu prilozily CELÉ dokumenty:
//
//   beh #349 (engine.input):  GDD.md 11 293 + TDD.md 16 127 tokenu
//   beh #366 (engine.shell):  ARCHITEKTURA.md 8 318 + 4 komponenty 5 596 tokenu
//
// Vysledek: request mel 25-39 tis. tokenu proti stropu 8 000 (Groq zdarma).
// Model se tedy nikdy nedozvedel zadani - a nebyla to chyba modelu.
//
// CO DELA: nahradi kazdou zminenou cestu neutralnim oznacenim:
//   [soubor]   - kod/data, ktere musi model dostat pres --file / --read
//   [dokument] - .md dokument (smlouvy, design)
// Cilem NENI zkratit text, ale ZABRANIT prilozeni. Text zustava jinak doslova.
//
// VYSTUP: sanitizovane zadani na stdout; na stderr seznam odstranenych zminek
// s velikosti souboru (kolik tokenu by se prilozilo) - to je doklad, ne dojem.
//
// ZMERENO 12. 10. 2026 (A/B lokalne, aider 0.86.2 proti falesnemu poskytovateli;
// nastroj .tmp/otukani/mer-rezii-aideru.mjs v repu orchestry):
//   A) PUVODNI zadani (s cestami): request 66 737 znaku ~ 22 025 tokenu
//   B) SANITIZOVANE zadani:        request 42 715 znaku ~ 14 097 tokenu
//   → hygiena usetri ~7 928 tokenu na request. A v CI to bylo potvrzeno:
//   artefakt behu #366 ma v logu `docs/ARCHITEKTURA.md` a `project.godot`,
//   i kdyz je workflow nikdy nepredaval - prisly z cest v zadani.
//
// Pouziti:
//   node .forge/node/prompt-hygiene.mjs "text zadani..."
//   echo "$FORGE_PROMPT" | node .forge/node/prompt-hygiene.mjs

import { readFileSync, existsSync } from 'node:fs';

// Merene poskytovatelem (Groq, 12. 10. 2026): 3,03 znaku na token na REALNEM
// textu (CONVENTIONS.md 12 290 B = 4 227 tokenu; game.gd 12 317 B = 3 899).
// Odhad "znaky/4" podhodnocuje cesky kod - a to je presne ta chyba, ktera
// poslala do CI requesty 3-5x pres strop.
export const ZNAKU_NA_TOKEN = 3.03;

const CESTA = /(?:^|[\s(„"'`])((?:docs|scripts|assets|tests|tools|\.forge|\.github)\/[\w./-]+\.\w+)/g;
const HOLY_SOUBOR = /(?:^|[\s(„"'`])([\w-]+\.(?:md|gd|json|tscn|tres|godot|cfg|yml|yaml|py|mjs))/g;

/** Roztridi zminku: dokument (.md) vs soubor. */
function druh(cesta) {
  return cesta.endsWith('.md') ? 'dokument' : 'soubor';
}

/**
 * Vrati { text, zminky: [{cesta, druh, znaku, tokenu}] }.
 * `text` je zadani bez cest; `zminky` je doklad, co by se jinak prilozilo.
 */
export function sanitizuj(zadani, { koren = process.cwd() } = {}) {
  const zminky = new Map();
  const nahrad = (cely, cesta) => {
    if (!zminky.has(cesta)) {
      let znaku = 0;
      try {
        const p = `${koren}/${cesta}`;
        if (existsSync(p)) znaku = readFileSync(p, 'utf8').length;
      } catch { /* soubor nejde precist - pocitame 0 a je to videt */ }
      zminky.set(cesta, {
        cesta, druh: druh(cesta), znaku,
        tokenu: Math.round(znaku / ZNAKU_NA_TOKEN),
      });
    }
    // Zachova uvodni znak (zavorku/mezeru), nahradi jen samotnou cestu.
    const uvod = cely.slice(0, cely.length - cesta.length);
    return `${uvod}[${druh(cesta)}]`;
  };
  let text = zadani.replace(CESTA, nahrad);
  // Podruhe: hole nazvy souboru (aider matchuje i podle basename).
  text = text.replace(HOLY_SOUBOR, (cely, cesta) => {
    if (cely.includes('[')) return cely;                      // uz nahrazeno
    return nahrad(cely, cesta);
  });
  return { text: text.trim(), zminky: [...zminky.values()] };
}

/** Text, ktery se modelu predlozi navic - aby vedel, proc v zadani nejsou cesty. */
export const VYSVETLIVKA = 'Poznamka ke zadani: nazvy souboru jsou zamerne nahrazene '
  + '([soubor]/[dokument]) - cilovy soubor mas v chatu a smlouvy ber z nej.';

function main() {
  const zArgv = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ');
  const zadani = zArgv || readFileSync(0, 'utf8');
  if (!zadani.trim()) {
    console.error('CHYBA: prazdne zadani (dej text jako argument nebo na stdin)');
    process.exit(2);
  }
  const { text, zminky } = sanitizuj(zadani);
  const usetreno = zminky.reduce((a, z) => a + z.tokenu, 0);
  if (zminky.length) {
    console.error(`[hygiena] odstraneno zminek: ${zminky.length}, usetreno ~${usetreno} tokenu (odhad ${ZNAKU_NA_TOKEN} znaku/token):`);
    for (const z of zminky.sort((a, b) => b.tokenu - a.tokenu)) {
      console.error(`[hygiena]   ${z.cesta} (${z.druh}) ${z.znaku} B ~ ${z.tokenu} tokenu`);
    }
  } else {
    console.error('[hygiena] zadani neobsahuje zadnou cestu k souboru - nic se neodstranilo');
  }
  console.log(zminky.length ? `${VYSVETLIVKA}\n\n${text}` : text);
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main();
}
