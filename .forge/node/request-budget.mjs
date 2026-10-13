#!/usr/bin/env node
// K1b - ROZPOCET REQUESTU: spocti, kolik tokenu se posle, a odmítni to PRED volanim.
//
// PROC TO EXISTUJE (namereno 12. 10. 2026):
//   - Groq (jediny zdroj bez karty) ma strop 8 000 tokenu za minutu (hlavicka
//     `x-ratelimit-limit-tokens`; potvrzeno i telem chyby 413).
//   - nase requesty mely 25 065 / 27 557 / 39 167 tokenu (logy behu 350/366/349).
//   - do 9. 10. se to nikde NEMERILO: pick-provider posila "ping" s
//     max_tokens=8, takze "poskytovatel odpovida" a za minutu request spadne.
//
// CO DELA: secte zadani + soubory k editaci + soubory ke cteni + konvence,
// prida fixni rezii harnessu (aider) a porovna se stropem poskytovatele.
// Kdyz se to nevejde, skonci NENULOVE a pojmenuje to (REQUEST_TOO_LARGE) -
// jeste pred tim, nez se spali pokus a kvota.
//
// Pouziti:
//   node .forge/node/request-budget.mjs --zadani-text "$ZADANI" \
//     --soubory "$DO_EDITACE" --cteni "$CIT_DEPS" --konvence CONVENTIONS.md \
//     --poskytovatel groq --model openai/gpt-oss-120b
//   node .forge/node/request-budget.mjs --zadani-text "ahoj" --strop 8000 --json

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZNAKU_NA_TOKEN } from './prompt-hygiene.mjs';

// FIXNI REZIE HARNESSU - aider posila v kazdem requestu svuj systemovy prompt.
// ZMERENO 12. 10. 2026 lokalne (aider 0.86.2, stejna verze jako v CI): aider se
// pustil proti FALESNEMU poskytovateli na localhostu, ktery si zapsal cely
// request -> systemovy prompt 5 421 znaku = ~1 789 tokenu. Konstantu drzime
// o neco vyssi, aby rozpocet nelhal optimismem.
// (Dřívější odhad 4 000 byl ODEČTEN z rozdílu v CI a byl příliš vysoký; měření
//  ho nahradilo. Nástroj: .tmp/otukani/mer-rezii-aideru.mjs - v repu orchestry.)
export const REZIE_HARNESSU = 1800;

// DRUHA REZIE — OBAL ZADANI. NENI to to same jako REZIE_HARNESSU a NESMI se
// s ni scitat pod jednim jmenem (omyl #71: „jedno jmeno nesmi znamenat dve
// veliciny“).
//
// ZMERENO 12. 10. 2026 (K3, aider 0.86.2 proti falesnemu poskytovateli,
// `_analyza/k3-mer-requestu.mjs`): krome systemoveho promptu posila aider
// v zadani jeste dalsi text, ktery se v nasem souctu NIKDE NEOBJEVIL —
// instrukce k diff formatu, seznam souboru v chatu, JSON obalka requestu
// a escapovani koncu radku a tabulatoru. Namereno na trech ruznych zadAnich
// (rozdil mezi REALNYM requestem a nasim modelem, ktery zna jen obsah souboru):
//
//   beh  souboru v chatu   realny request   model bez obalu   neobjasneno
//   A)   3 (2 sekce + prázdný)   14 897 zn.        14 102 zn.      795 zn.
//   B)   2 (cely dokument)       23 871 zn.        22 410 zn.    1 461 zn.
//   D)   4 (monolit + registry)  41 974 zn.        39 550 zn.    2 424 zn.
//   → 795–2 424 znaku navic, tedy 262–800 tokenu; kdyz se ale pocita i obsah
//   souboru, ktery model NEZNA (prislusnost k chatu), je horni odhad 2 250 t.
// Konstanta je zaokrouhlena NAHORU (2 500), aby rozpocet nelhal optimismem.
//
// DUSLEDEK, KTERY STAL ZA TO: K1 kalibracni kontrola v `priprava.test.mjs`
// („16 000 znaku se pri 3,03 znaku/token NEVEJDE“) s REZIE 1 800 VYCHAZELA
// jako „vejde se“ — byla cervena. S obalem zadani vysla spravne. Test tedy
// nebyl vadny; chybela velicina.
export const REZIE_CHATU = 2500;

export const tokeny = (znaku) => Math.ceil(znaku / ZNAKU_NA_TOKEN);

/** Nacte strop z providers.json (blok `limits`), kdyz je k dispozici. */
export function stropPoskytovatele(soubor, nazev, model) {
  if (!soubor || !existsSync(soubor)) return null;
  try {
    const cfg = JSON.parse(readFileSync(soubor, 'utf8'));
    const p = (cfg.providers || []).find((x) => x.name === nazev);
    if (!p || !p.limits) return null;
    const l = p.limits;
    if (model && l.models && l.models[model]) return l.models[model].tpm ?? l.tpm ?? null;
    return l.tpm ?? null;
  } catch {
    return null;
  }
}

/** Secte velikosti souboru ze seznamu (oddělovačem je novy radek nebo mezera). */
export function velikosti(soubory, koren = process.cwd()) {
  const out = [];
  for (const f of String(soubory || '').split(/[\s\n]+/).filter(Boolean)) {
    const cisty = f.replace(/^--(file|read)$/, '');
    if (!cisty || cisty.startsWith('--')) continue;
    let znaku = 0;
    try {
      const p = join(koren, cisty);
      if (existsSync(p)) znaku = readFileSync(p, 'utf8').length;
    } catch { /* necitelny soubor = 0 a je to videt ve vypisu */ }
    out.push({ soubor: cisty, znaku, tokenu: tokeny(znaku) });
  }
  return out;
}

/** Vypocet rozpoctu - cista funkce, aby ji test VOLAL, ne opisoval.
 *
 *  `bude_t` je obsah, ktery v requestu BUDE, i kdyz dnes na disku neni: soubor
 *  ZAVISLOSTI, ktera je jen drivejsi v DAG (pri behu te granule uz existuje) —
 *  POCITA SE DO ROZPOCTU, jinak by planovaci brana lhala optimismem (naměřeno
 *  12. 10. 2026 na `world.spawner`: 5 477 t bez ni vs 6 355 t s ni).
 *
 *  `navic_t` je KONZERVATIVNI ODHAD souboru, ktere v requestu jeste NEJSOU
 *  (nove soubory granul: workflow do nich pred volanim zapise prazdny soubor).
 *  Ptá se tim na JINOU otazku nez zbytek funkce — „co bude, az soubor bude mit
 *  deklarovanych N radku“ — a proto se vystup hlasi ZVLAST (`celkem_plny`),
 *  ne jako by to bylo mereni. Kdo to slije dohromady, dostane cislo, ktere
 *  neodpovida ani jednomu stavu (omyl #71: dve veliciny pod jednim jmenem).
 */
export function rozpocet({ zadaniText = '', soubory = '', cteni = '', konvence = '', strop, rezije = REZIE_HARNESSU, rezijeChatu = REZIE_CHATU, koren = process.cwd(), bude_t = 0, navic_t = 0 }) {
  const zadani = { znaku: zadaniText.length, tokenu: tokeny(zadaniText.length) };
  const edit = velikosti(soubory, koren);
  const read = velikosti(cteni, koren);
  const konv = velikosti(konvence, koren);
  const soucet = zadani.tokenu + edit.reduce((a, x) => a + x.tokenu, 0)
    + read.reduce((a, x) => a + x.tokenu, 0) + konv.reduce((a, x) => a + x.tokenu, 0);
  const celkem = soucet + rezije + rezijeChatu + bude_t;
  const celkem_plny = celkem + navic_t;
  return {
    zadani, edit, read, konvence: konv, rezije, rezijeChatu, bude_t,
    soucet_obsahu: soucet, celkem, navic_t, celkem_plny,
    strop: strop ?? null,
    vejde_se: strop ? celkem <= strop : null,
    vejde_se_plny: strop ? celkem_plny <= strop : null,
    zbyva: strop ? strop - celkem : null,
  };
}

/**
 * Rozhodnuti brany. NAMERENY strop se VYNUCUJE (request se neposle), odhad
 * jen VARUJE - jinak by nezmereny poskytovatel blokoval praci, kterou by
 * zvladl (a to je presne ta chyba, kterou hledame v opacnem smeru).
 */
export function rozhodni(r, zdroj) {
  if (r.vejde_se) return 'FITS';
  return zdroj === 'odhad' ? 'NEZNAMY_STROP' : 'TOO_LARGE';
}

function arg(n, d = '') { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; }

function main() {
  const json = process.argv.includes('--json');
  const poskytovatel = arg('--poskytovatel');
  const model = arg('--model');
  const rucni = arg('--strop', '');
  const zProfilu = stropPoskytovatele(arg('--providers', '.forge/providers.json'), poskytovatel, model);
  const strop = Number(rucni || zProfilu || 32000);
  const zdroj = rucni ? 'rucni' : (zProfilu ? 'mereno' : 'odhad');
  const r = rozpocet({
    zadaniText: arg('--zadani-text'),
    soubory: arg('--soubory'),
    cteni: arg('--cteni'),
    konvence: arg('--konvence'),
    strop,
    rezije: Number(arg('--rezije', '') || REZIE_HARNESSU),
    rezijeChatu: Number(arg('--rezije-chatu', '') || REZIE_CHATU),
  });
  r.strop_zdroj = zdroj;
  const trida = rozhodni(r, zdroj);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    // POZOR: i JSON vetev musi koncit nenulove, jinak by se z ni stal "gate",
    // ktery nema jak selhat (vada, kterou projekt zna jako S27).
    if (trida === 'TOO_LARGE') process.exit(1);
  } else {
    console.log(`ROZPOCET: ~${r.celkem} tokenu (zadani ${r.zadani.tokenu} + editace ${r.edit.reduce((a, x) => a + x.tokenu, 0)}` +
      ` + cteni ${r.read.reduce((a, x) => a + x.tokenu, 0)} + konvence ${r.konvence.reduce((a, x) => a + x.tokenu, 0)}` +
      ` + rezie ${r.rezije} + obal zadani ${r.rezijeChatu})`);
    console.log(`STROP (${poskytovatel || 'rucni'}/${model || '-'}, ${zdroj}): ${strop} tokenu | zbyva ${r.zbyva}`);
    console.log(`TRIDA=REQUEST_${trida}`);
    if (trida === 'TOO_LARGE') {
      console.error(`::error::REQUEST_TOO_LARGE: request ~${r.celkem} tokenu > strop ${strop}. ` +
        `Zmensi kontext (mene souboru, kratsi zadani, konvence jen sekce), nebo vyber poskytovatele s vetsim stropem.`);
      process.exit(1);
    }
    if (trida === 'NEZNAMY_STROP') {
      console.error(`::warning::strop poskytovatele ${poskytovatel || '?'} NENI ZMERENY – request ~${r.celkem} tokenu ` +
        `posilam, ale muze spadnout. Zmer ho: .forge/node/probe-provider.mjs --jen ${poskytovatel || '<nazev>'}`);
    }
  }
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  main();
}
