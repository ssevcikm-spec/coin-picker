#!/usr/bin/env node
// K3 (12. 10. 2026) — ROZPOCET CELÉ ROADMAPY: projde KAŽDOU granuli a rekne,
// jestli se její request vejde do stropu poskytovatele.
//
// PROC TO EXISTUJE:
//   `request-budget.mjs` meri JEDEN request, ktery mu clovek popise. To staci
//   na rucni kontrolu, ale NE na plan: „vsechny granule se vejdou“ je tvrzeni
//   o CELÉ fronte, a to se neda overit jednim spustenim. Presne to je pritom
//   podminka, na ktere padl posledni den orchestry — 20 behu selhalo, protoze
//   se request nevesel a NIKDO to pred dispatchovanim nemeril.
//
//   Tahle brana proto bere roadmapu, pro kazdou granuli posklada to, co se
//   REALNE posle (zadani po hygiene + soubory k editaci + zavislosti ke cteni
//   + deklarovane sekce konvenci), a zavola na to TUTEZ funkci jako
//   `request-budget.mjs` (`rozpocet()` — jeden vzorec, ne dva opisy).
//
// DVE CISLA, DVE OTÁZKY (nesmi se slit):
//   celkem       co se posle DNES (soubor, ktery neexistuje, je v requestu
//                prazdny — workflow do nej pred volanim zapise prazdny soubor);
//                z TOHOHLE cisla se dela verdikt REQUEST_FITS/TOO_LARGE.
//   celkem_plny  co bude, az bude mit soubor deklarovanych `size_lines` radku
//                (odhad `--radku-b` B/radek). Jen VAROVANI — je to planovaci
//                odhad, ktery mereni nerika.
//
// Pouziti:
//   node .forge/node/rozpocet-granuli.mjs --poskytovatel groq --model openai/gpt-oss-120b
//   node .forge/node/rozpocet-granuli.mjs --roadmap .forge/roadmap.pilot.json --json
//   node .forge/node/rozpocet-granuli.mjs --seznam-sekci      # velikosti sekci
//   node .forge/node/rozpocet-granuli.mjs --jen core.level

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { rozpocet, rozhodni, stropPoskytovatele, tokeny, REZIE_HARNESSU, REZIE_CHATU } from './request-budget.mjs';
import { sanitizuj, ZNAKU_NA_TOKEN } from './prompt-hygiene.mjs';

const LIMIT_SEKCE_T = 1200;   // metodika `game-developer` §4.1b
const LIMIT_KONVENCE_T = 1200;
const LIMIT_ZADANI_T = 400;
const LIMIT_RADKU = 120;      // cil pilotu K3
const SEKCE_DIR = 'CONVENTIONS';

// Prumerny radek ceskeho GDScriptu. NENI to odhad z hlavy: 12 317 B / 377 radku
// (`game.gd` hry uo-shadows) = 32,7 B; `CONVENTIONS.md` 11 795 B / 276 = 42,7 B.
// Konzervativne bereme 38 B (vyssi nez kód, nizsi nez dokumentace), aby odhad
// nelhal optimismem.
const RADKU_B = 38;

const arg = (n, d = '') => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const json = process.argv.includes('--json');
const poskytovatel = arg('--poskytovatel');
const model = arg('--model');
const roadmapCesta = arg('--roadmap', '.forge/roadmap.json');
const providersCesta = arg('--providers', '.forge/providers.json');
const radkuB = Number(arg('--radku-b', '') || RADKU_B);
const jen = arg('--jen');

/** Velikosti sekci konvenci (pro `--seznam-sekci` i pro kontrolu stropu). */
function sekce() {
  if (!existsSync(SEKCE_DIR)) return [];
  return readdirSync(SEKCE_DIR).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const cesta = `${SEKCE_DIR}/${f}`;
    const znaku = readFileSync(cesta, 'utf8').length;
    return { nazev: f.replace(/\.md$/, ''), cesta, znaku, tokenu: tokeny(znaku) };
  });
}

if (process.argv.includes('--seznam-sekci')) {
  const s = sekce();
  console.log(`Sekce konvenci (${SEKCE_DIR}/): ${s.length}`);
  for (const x of s) {
    const pres = x.tokenu > LIMIT_SEKCE_T;
    console.log(`  ${pres ? 'PŘES STROP' : 'ok        '} ${x.cesta.padEnd(36)} ${String(x.znaku).padStart(6)} B  ${String(x.tokenu).padStart(5)} t`);
  }
  const pres = s.filter((x) => x.tokenu > LIMIT_SEKCE_T);
  console.log(`ZMĚŘENO: ${s.length} sekcí, ${pres.length} přes ${LIMIT_SEKCE_T} t, `
    + `celkem ${s.reduce((a, x) => a + x.tokenu, 0)} t (${ZNAKU_NA_TOKEN} znaku/token)`);
  process.exit(pres.length ? 1 : 0);
}

if (!existsSync(roadmapCesta)) {
  console.error(`CHYBA: roadmapa ${roadmapCesta} neexistuje (--roadmap <cesta>)`);
  process.exit(2);
}
let data;
try {
  data = JSON.parse(readFileSync(roadmapCesta, 'utf8'));
} catch (e) {
  console.error(`CHYBA: roadmapu ${roadmapCesta} nejde přečíst: ${String(e).slice(0, 160)}`);
  process.exit(2);
}
const grains = (data.grains || []).filter((g) => !jen || g.id === jen);
if (!grains.length) {
  console.error(jen ? `CHYBA: granule '${jen}' v roadmapě není` : `CHYBA: roadmapa ${roadmapCesta} nemá žádné granule`);
  process.exit(2);
}

const stropZProfilu = stropPoskytovatele(providersCesta, poskytovatel, model);
const strop = Number(arg('--strop', '') || stropZProfilu || 32000);
const zdroj = arg('--strop') ? 'rucni' : (stropZProfilu ? 'mereno' : 'odhad');

const vsechnySekce = sekce();
const podleId = Object.fromEntries((data.grains || []).map((g) => [g.id, g]));
const radky = [];
let chyb = 0;
let varovani = 0;
const tvrde = [];   // spadne (exit 1)
const mekke = [];   // jen se vypise

for (const g of grains) {
  const nazev = g.id || '(bez id)';
  const poznamky = [];

  // 1) zadani — po hygiene, presne to, co dostane aider
  const prompt = String(g.prompt || '');
  if (!prompt.trim()) tvrde.push(`${nazev}: chybí 'prompt'`);
  const hy = sanitizuj(prompt, { koren: process.cwd() });
  const zadani = hy.text;
  if (zadani && tokeny(zadani.length) > LIMIT_ZADANI_T) {
    mekke.push(`${nazev}: zadání má ${tokeny(zadani.length)} t (cíl <= ${LIMIT_ZADANI_T} t) — smlouva patří do zadání krátce, ne odkazem`);
  }
  if (hy.zminky.length) {
    poznamky.push(`hygiena odstranila ${hy.zminky.length} cest (~${hy.zminky.reduce((a, z) => a + z.tokenu, 0)} t)`);
  }

  // 2) soubory k editaci (owns) + konzervativni odhad tech, ktere jeste nejsou
  const owns = Array.isArray(g.owns) ? g.owns : [];
  if (!owns.length) tvrde.push(`${nazev}: chybí 'owns' — agent neví, co editovat`);
  if (owns.length > 1) mekke.push(`${nazev}: owns má ${owns.length} souborů (pilot cílí na 1)`);
  const sizeLines = Number(g.size_lines || 0);
  if (g.model === 'strong' && !sizeLines) tvrde.push(`${nazev}: model=strong bez 'size_lines'`);
  if (sizeLines > LIMIT_RADKU) mekke.push(`${nazev}: size_lines ${sizeLines} > ${LIMIT_RADKU} (cíl pilotu)`);
  const existujici = owns.filter((f) => existsSync(f));
  const chybejici = owns.filter((f) => !existsSync(f));
  const odhad_t = chybejici.length && sizeLines
    ? tokeny(Math.round(chybejici.length * sizeLines * radkuB))
    : 0;

  // 3) zavislosti ke cteni — jen soubory, ktere v projektu SKUTECNE jsou
  //    (`--read` na neexistujici cestu aider shodi).
  //    ⚠ ALE soubor zavislosti, ktery jeste NEEXISTUJE, se musi POCITAT TAKY:
  //    pri behu te granule uz existovat bude (jeji zavislost je jen drivejsi
  //    v DAG). Naměřeno 12. 10. 2026 na `world.spawner`: dnes `cteni 0`,
  //    po `world.coin` je to ~760 t navic — a to je presne rozdil mezi
  //    „vejde se“ a „nevejde se“. Bere se konzervativni odhad ze `size_lines`
  //    te zavislosti (stejny bucket jako `odhad_t`, takze se to nikdy
  //    nevydava za mereni).
  const cteni = [];
  let odhad_zavislosti_t = 0;
  for (const idZav of g.depends_on || []) {
    const zav = podleId[idZav];
    if (!zav) { tvrde.push(`${nazev}: depends_on '${idZav}', ale taková granule v roadmapě není`); continue; }
    for (const f of zav.owns || []) {
      if (existsSync(f)) { cteni.push(f); continue; }
      const radkuZav = Number(zav.size_lines || 0);
      if (radkuZav) odhad_zavislosti_t += tokeny(Math.round(radkuZav * radkuB));
    }
  }

  // 4) konvence — POVINNA deklarace; kazda sekce musi existovat a mit <= 1200 t
  const deklar = Array.isArray(g.konvence) ? g.konvence.map((s) => String(s).trim()).filter(Boolean) : [];
  if (!deklar.length) {
    tvrde.push(`${nazev}: nemá deklarované 'konvence' — bez nich se posílá celý dokument (nebo nic)`);
  }
  const cestyKonv = [];
  for (const s of deklar) {
    const c = `${SEKCE_DIR}/${s.replace(/^CONVENTIONS\//, '').replace(/\.md$/, '')}.md`;
    const nalezena = vsechnySekce.find((x) => x.cesta === c);
    if (!nalezena) { tvrde.push(`${nazev}: deklarovaná sekce '${s}' v repu není (${c})`); continue; }
    if (nalezena.tokenu > LIMIT_SEKCE_T) tvrde.push(`${nazev}: sekce '${s}' má ${nalezena.tokenu} t > ${LIMIT_SEKCE_T} t`);
    cestyKonv.push(c);
  }
  const konvT = cestyKonv.reduce((a, c) => a + tokeny(readFileSync(c, 'utf8').length), 0);
  if (konvT > LIMIT_KONVENCE_T) {
    mekke.push(`${nazev}: deklarované konvence mají ${konvT} t > ${LIMIT_KONVENCE_T} t — uber sekci, nebo granuli rozsekni`);
  }
  if (!Array.isArray(g.acceptance) || !g.acceptance.length) mekke.push(`${nazev}: chybí 'acceptance'`);

  // 5) rozpocet — TUTÉŽ funkce jako `request-budget.mjs`
  const spolecne = {
    zadaniText: zadani, cteni: cteni.join('\n'), konvence: cestyKonv.join('\n'),
    strop, rezije: REZIE_HARNESSU, rezijeChatu: REZIE_CHATU,
  };
  // DVĚ RŮZNÉ VĚCI (a proto dva buckety):
  //   odhad_zavislosti_t – soubor ZÁVISLOSTI pri behu EXISTUJE (je jen drivejsi
  //     v DAG) → patri do „dnes“, protoze to request opravdu potka.
  //   odhad_t            – VLASTNI soubor granule je pri requestu jeste PRAZDNY
  //     (workflow do nej zapise prazdny soubor) → patri jen do „plneho“ odhadu.
  const dnes = rozpocet({ ...spolecne, soubory: existujici.join('\n'), bude_t: odhad_zavislosti_t });
  const plny = rozpocet({ ...spolecne, soubory: existujici.join('\n'),
    bude_t: odhad_zavislosti_t, navic_t: odhad_t });
  const trida = rozhodni(dnes, zdroj);
  if (trida === 'TOO_LARGE') {
    tvrde.push(`${nazev}: REQUEST_TOO_LARGE — request ~${dnes.celkem} t > strop ${strop} t`);
  }
  if (plny.vejde_se_plny === false && dnes.vejde_se !== false) {
    mekke.push(`${nazev}: DNES se vejde (${dnes.celkem} t), ale az bude mít soubor ${sizeLines} řádků, `
      + `bude request ~${plny.celkem_plny} t > strop ${strop} t — granule je na hraně`);
  }

  radky.push({
    id: nazev, trida, zadani_t: dnes.zadani.tokenu, edit_t: dnes.edit.reduce((a, x) => a + x.tokenu, 0),
    cteni_t: dnes.read.reduce((a, x) => a + x.tokenu, 0), konvence_t: konvT,
    rezie_t: dnes.rezije + dnes.rezijeChatu, rezie_chatu_t: dnes.rezijeChatu,
    celkem: dnes.celkem, celkem_plny: plny.celkem_plny, zbyva: dnes.zbyva,
    souboru: owns.length, size_lines: sizeLines, konvence: cestyKonv,
    odhad_t, odhad_zavislosti_t, poznamky, mekke: mekke.filter((m) => m.startsWith(nazev)), tvrde: tvrde.filter((m) => m.startsWith(nazev)),
  });
}

chyb = tvrde.length;
varovani = mekke.length;

if (json) {
  console.log(JSON.stringify({
    roadmapa: roadmapCesta, poskytovatel, model, strop, strop_zdroj: zdroj,
    rezije: REZIE_HARNESSU, radku_b: radkuB, grains: radky,
    tvrde, mekke, verdikt: chyb ? 'REQUEST_TOO_LARGE' : 'REQUEST_FITS',
  }, null, 2));
} else {
  console.log(`Roadmapa: ${roadmapCesta} | granulí: ${radky.length} | strop: ${strop} t `
    + `(${poskytovatel || 'ruční'}/${model || '-'}, ${zdroj}) | režie: ${REZIE_HARNESSU} + obal zadání ${REZIE_CHATU} t`);
  console.log('');
  console.log('  granule                 zadání  edit  čtení  konv  režie  CELKEM  (+plný)  zbývá  třída');
  for (const r of radky) {
    console.log(`  ${r.id.padEnd(22)} ${String(r.zadani_t).padStart(6)} ${String(r.edit_t).padStart(5)} `
      + `${String(r.cteni_t).padStart(6)} ${String(r.konvence_t).padStart(5)} ${String(r.rezie_t).padStart(6)} `
      + `${String(r.celkem).padStart(7)} ${String(r.celkem_plny).padStart(8)} ${String(r.zbyva).padStart(6)}  REQUEST_${r.trida}`);
    for (const p of r.poznamky) console.log(`      · ${p}`);
    for (const m of r.mekke) console.log(`      VAROVÁNÍ: ${m}`);
  }
  console.log('');
  if (tvrde.length) {
    console.log(`=== VADY (${tvrde.length}) ===`);
    for (const t of tvrde) console.log(`  ${t}`);
  } else {
    console.log('Všechny granule se vejdou (žádná vada).');
  }
  if (mekke.length) {
    console.log('');
    console.log(`=== VAROVÁNÍ (${mekke.length}; neshazují bránu) ===`);
    for (const m of mekke) console.log(`  ${m}`);
  }
  console.log('');
  console.log(`ZMĚŘENO: ${radky.length} granulí, ${radky.filter((r) => r.trida === 'FITS').length} REQUEST_FITS, `
    + `${radky.filter((r) => r.trida === 'TOO_LARGE').length} REQUEST_TOO_LARGE, `
    + `${radky.filter((r) => r.konvence_t > LIMIT_KONVENCE_T).length} nad ${LIMIT_KONVENCE_T} t konvencí, `
    + `${tvrde.length} vad, ${mekke.length} varování`);
}

// Brana, ktera nema jak selhat, neni brana — nenulovy kód je PODSTATNY.
process.exit(chyb ? 1 : 0);
