#!/usr/bin/env node
// Test pripravy orchestry (K1 + K2): hygiena zadani, rozpocet requestu,
// klasifikace selhani. Bez site, bez klice, bez zapisu na disk.
//
// POZOR: test ZAMERNE obsahuje KALIBRACNI KONTROLU - pripad, ktery by podle
// STAREHO predpokladu ("znaky/4") prosel, ale podle namereneho (3,03) projit
// nesmi. Kdyby se konstanta vratila na 4, test SPADNE - jinak by jen tvrdil,
// ze neco prošlo, a to neni dukaz, ze to meri.
//
// Spousteni:  node .forge/node/priprava.test.mjs

import { sanitizuj } from './prompt-hygiene.mjs';
import { rozpocet, tokeny, rozhodni, REZIE_HARNESSU, REZIE_CHATU } from './request-budget.mjs';
import { klasifikuj, cislaZLogu, prvniChyba } from './classify-agent-log.mjs';
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// Suite se pouští z KORENE orchestry (`node repo/.forge/node/priprava.test.mjs`),
// ale nástroje se ptají na `.forge/` a `CONVENTIONS/` — tedy na kořen REPA hry.
// Proto se cwd předává explicitně; bez toho by testy měřily jiný strom.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (args, cwd = REPO) => {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  return { kod: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

let kontroly = 0;
let chyb = 0;
const test = (nazev, skutecne, ocekavane) => {
  kontroly++;
  const ok = JSON.stringify(skutecne) === JSON.stringify(ocekavane);
  if (!ok) { chyb++; console.log(`CHYBA  ${nazev}\n       ocekavano: ${JSON.stringify(ocekavane)}\n       namereno:  ${JSON.stringify(skutecne)}`); }
  else console.log(`ok     ${nazev}`);
};

// ── K1a: hygiena zadani ───────────────────────────────────────────────────────
console.log('=== K1a: hygiena zadani (cesty se nesmi dostat k aideru) ===');
const ZADANI_M0 = 'Přepiš scripts/game.gd (dnes monolit, 377 řádků) na KOSTRU podle docs/TDD.md §1.1. '
  + 'Komponenty hledají registr (naměřeno v hud.gd, save.gd, combat.gd). '
  + 'Aditivní migrace viz docs/ARCHITEKTURA.md §3. Neměň tests/, .forge/ ani project.godot.';
const h = sanitizuj(ZADANI_M0, { koren: '.' });
test('hygiena: zadani uz neobsahuje cestu k dokumentu', /docs\/TDD\.md|docs\/ARCHITEKTURA\.md/.test(h.text), false);
test('hygiena: zadani uz neobsahuje cestu ke skriptu', /scripts\/game\.gd/.test(h.text), false);
test('hygiena: dokument je oznacen', h.text.includes('[dokument]'), true);
test('hygiena: soubor je oznacen', h.text.includes('[soubor]'), true);
test('hygiena: zminky jsou pojmenovane (doklad)', h.zminky.length >= 3, true);
test('hygiena: text zustal jinak doslova', h.text.includes('na KOSTRU'), true);
const ciste = sanitizuj('Vytvoř soubor pro výpočet a vrať true.', { koren: '.' });
test('hygiena: zadani bez cest se NEMENI', ciste.text, 'Vytvoř soubor pro výpočet a vrať true.');
test('hygiena: bez cest zadna zminka', ciste.zminky.length, 0);

// ── K1b: rozpocet requestu ────────────────────────────────────────────────────
console.log('\n=== K1b: rozpocet requestu (strop 8000 = Groq zdarma) ===');
test('kalibrace: 30 300 znaku = 10 000 tokenu (3,03 znaku/token)', tokeny(30300), 10000);
test('rezie harnessu = namerena konstanta (aider system prompt)', REZIE_HARNESSU, 1800);
test('obal zadani = namerena konstanta (aider posila i obal requestu)', REZIE_CHATU, 2500);
const maly = rozpocet({ zadaniText: 'ahoj', strop: 8000, rezije: 0, rezijeChatu: 0 });
test('maly request se vejde', maly.vejde_se, true);
// ⚠ K3 (12. 10. 2026): kalibracni kontrola se POSUNULA, protoze pribyla DRUHA
// namerena rezie (obal zadani). Puvodni pripad 16 000 znaku prestal rozlisovat:
// s obalem zadani se nevejde ani stary odhad (znaky/4), takze by netvrdil nic
// o tom, co ma — jen ze velky request je velky. Novy pripad lezi v pasmu, kde
// se oba odhady ROZEJDOU:
//   stary odhad: 13 000/4    + 1 800 + 2 500 = 7 550  → vejde se
//   namerene:    13 000/3,03 + 1 800 + 2 500 = 8 590  → nevejde se
const KALIBRACNI_ZNAKU = 13000;
const velky = rozpocet({ zadaniText: 'x'.repeat(KALIBRACNI_ZNAKU), strop: 8000, rezije: REZIE_HARNESSU, rezijeChatu: REZIE_CHATU });
test('KALIBRACNI KONTROLA: 13 000 znaku se pri 3,03 znaku/token NEVEJDE', velky.vejde_se, false);
test('KALIBRACNI KONTROLA: pritom stary odhad (znaky/4) by se vesel',
  KALIBRACNI_ZNAKU / 4 + REZIE_HARNESSU + REZIE_CHATU <= 8000, true);
const skutecny = rozpocet({ zadaniText: 'x'.repeat(3200), strop: 8000, rezije: 0, rezijeChatu: 0 });
test('rozpocet secte zadani + rezii', skutecny.celkem, tokeny(3200));
test('rozpocet vraci zbyvajici kvotu (vztah, ne hranicni hodnota)',
  rozpocet({ zadaniText: 'x'.repeat(3000), strop: 8000, rezije: 0, rezijeChatu: 0 }).zbyva, 8000 - tokeny(3000));
// `navic_t` = konzervativni odhad souboru, ktery v requestu JESTE NENI. Ptá se
// na jinou otazku, takze se nesmi michat s `celkem` (omyl #71).
const sOdhad = rozpocet({ zadaniText: 'x'.repeat(3000), strop: 8000, rezije: 0, rezijeChatu: 0, navic_t: 1000 });
test('navic_t: dnesni request se nezmeni', sOdhad.celkem, tokeny(3000));
test('navic_t: plny odhad se pricte zvlast', sOdhad.celkem_plny, tokeny(3000) + 1000);
test('navic_t: vejde_se_plny umi spadnout i kdyz dnes se vejde',
  rozpocet({ zadaniText: 'x'.repeat(21000), strop: 8000, rezije: 0, rezijeChatu: 0, navic_t: 1500 }).vejde_se_plny, false);
// Brana: namereny strop se vynucuje, odhad jen varuje (jinak by nezmereny
// poskytovatel blokoval praci, kterou by zvladl).
const presStrop = rozpocet({ zadaniText: 'x'.repeat(30000), strop: 8000, rezije: 0, rezijeChatu: 0 });
test('namereny strop pres strop = TOO_LARGE', rozhodni(presStrop, 'mereno'), 'TOO_LARGE');
test('rucni strop pres strop = TOO_LARGE', rozhodni(presStrop, 'rucni'), 'TOO_LARGE');
test('odhadnuty strop pres strop jen VARUJE', rozhodni(presStrop, 'odhad'), 'NEZNAMY_STROP');
test('vejit se = FITS', rozhodni(rozpocet({ zadaniText: 'x'.repeat(300), strop: 8000, rezije: 0, rezijeChatu: 0 }), 'mereno'), 'FITS');

// ── K2: klasifikace selhani ───────────────────────────────────────────────────
console.log('\n=== K2: klasifikace selhani (realne texty z logu 9. 10.) ===');
const TOO_LARGE = 'litellm.RateLimitError: RateLimitError: OpenAIException - Request too large for model '
  + '`openai/gpt-oss-120b` ... tokens per minute (TPM): Limit 8000, Requested 27557, please reduce your '
  + 'message size. The API provider has rate limited you.';
const KVOTA = 'litellm.RateLimitError: RateLimitError: OpenAIException - Tokens per minute limit exceeded - '
  + 'too many tokens processed.';
const AUTH = 'litellm.AuthenticationError: OpenAIException - Incorrect API key provided: sk-***';
const DOWN = 'openai.APIConnectionError: APIConnectionError: Error code: 503 - upstream unavailable';
test('velky request = REQUEST_TOO_LARGE (ne kvota!)', klasifikuj({ log: TOO_LARGE, zmena: 'ne' }), 'REQUEST_TOO_LARGE');
test('vycerpany limit = QUOTA', klasifikuj({ log: KVOTA, zmena: 'ne' }), 'QUOTA');
test('spatny klic = AUTH', klasifikuj({ log: AUTH }), 'AUTH');
test('nedostupny poskytovatel = PROVIDER_DOWN', klasifikuj({ log: DOWN }), 'PROVIDER_DOWN');
test('nic v logu + zadna zmena = NOCHANGE', klasifikuj({ log: 'Aider v0.86.2\nModel: x', zmena: 'ne' }), 'NOCHANGE');
test('nic v logu + zmena = OK', klasifikuj({ log: 'Aider v0.86.2', zmena: 'ano' }), 'OK');
test('neparsuje se = PARSE', klasifikuj({ log: 'ok', parsovani: 'failure' }), 'PARSE');
test('testy spadly = TESTS', klasifikuj({ log: 'ok', testy: 'failure' }), 'TESTS');
test('preskoceny krok NENI selhani (jinak by conductor dostal jinou pricinu)', klasifikuj({ log: 'ok', parsovani: 'skipped', testy: 'skipped', zmena: 'ne' }), 'NOCHANGE');
test('hlaska brany rozpoctu = REQUEST_TOO_LARGE', klasifikuj({ log: 'REQUEST_TOO_LARGE: request ~12000 tokenu > strop 8000' }), 'REQUEST_TOO_LARGE');
test('SCRIPT ERROR v logu = SCRIPT_ERROR', klasifikuj({ log: 'SCRIPT ERROR: Parse Error: x', zmena: 'ano' }), 'SCRIPT_ERROR');
test('cisla z chyby: limit i requested', cislaZLogu(TOO_LARGE), { hodnoty: [8000, 27557], limit: 8000, requested: 27557 });
test('cisla z chyby: kdyz tam nejsou, nic se nevymysli', cislaZLogu(KVOTA), { hodnoty: [], limit: null, requested: null });
test('prvni chyba je pojmenovana', prvniChyba(TOO_LARGE).startsWith('RateLimitError: RateLimitError: OpenAIException - Request too large'), true);

// ── K3: konvence po sekcích + rozpočet celé roadmapy ─────────────────────────
// PROČ: request s CELÝM `CONVENTIONS.md` měl 14 097 t proti stropu 8 000, takže
// se neposlal vůbec (12. 10. 2026, 20 běhů selhalo). Konvence se proto rozdělily
// na sekce a GRANULE deklaruje, které dostane. Tyhle testy měří CELOU CESTU:
// deklarace v roadmapě → cesty pro `--read` → rozpočet.
console.log('\n=== K3: konvence po sekcích a rozpočet celé roadmapy ===');
const sekce = readdirSync(join(REPO, 'CONVENTIONS')).filter((f) => f.endsWith('.md')).sort();
test('K3: konvence jsou rozdělené na sekce (>= 6)', sekce.length >= 6, true);
const presStropSekce = sekce.filter((f) => tokeny(readFileSync(join(REPO, 'CONVENTIONS', f), 'utf8').length) > 1200);
test('K3: žádná sekce není přes 1 200 t', presStropSekce, []);
test('K3: CONVENTIONS.md je rozcestník (<= 1 200 t), ne celý dokument',
  tokeny(readFileSync(join(REPO, 'CONVENTIONS.md'), 'utf8').length) <= 1200, true);

const pilot = JSON.parse(readFileSync(join(REPO, '.forge', 'roadmap.pilot.json'), 'utf8'));
test('K3: každá pilotní granule deklaruje konvence',
  pilot.grains.filter((g) => !(g.konvence || []).length).map((g) => g.id), []);
test('K3: každá pilotní granule má jeden soubor a deklarovanou velikost',
  pilot.grains.filter((g) => (g.owns || []).length !== 1 || !g.size_lines).map((g) => g.id), []);
test('K3: pilot má 2-5 granulí', pilot.grains.length >= 2 && pilot.grains.length <= 5, true);

// Fixtury pro negativní případy. Patří do TEMPU, ne do repa: test, který si
// píše do stromu hry, by zanechal soubory v `git status` (a `git add -A`
// v CI by je poslal do PR).
const FIX_BEZ_KONVENCI = join(tmpdir(), 'k3-test-bez-konvenci.json');
const FIX_SPATNA_SEKCE = join(tmpdir(), 'k3-test-roadmap.json');
writeFileSync(FIX_BEZ_KONVENCI, JSON.stringify({ grains: [{ ...pilot.grains[0], id: 'test.bez-konvence', konvence: [] }] }, null, 2), 'utf8');
writeFileSync(FIX_SPATNA_SEKCE, JSON.stringify({ grains: [{ ...pilot.grains[0], id: 'test.spatna-sekce', konvence: ['99-neexistuje'] }] }, null, 2), 'utf8');

const kDeklarace = run(['.forge/files-to-edit.mjs', '--grain', 'core.level', '--konvence',
  '--roadmap', '.forge/roadmap.pilot.json']);
test('K3: --konvence vrátí právě deklarované sekce', kDeklarace.out.split('\n'),
  ['CONVENTIONS/01-typy.md', 'CONVENTIONS/06-soubor-granule.md']);
const kBezDeklarace = run(['.forge/files-to-edit.mjs', '--grain', 'core.level', '--konvence',
  '--roadmap', '.forge/roadmap.json']);
test('K3: bez deklarace se ozve a pošle VŠE (most pro staré hry)',
  /NEMÁ deklarované/.test(kBezDeklarace.err) && kBezDeklarace.out.split('\n').length === sekce.length, true);
const kChybi = run(['.forge/files-to-edit.mjs', '--grain', 'test.spatna-sekce', '--konvence', '--roadmap', FIX_SPATNA_SEKCE]);
test('K3: deklarovaná sekce, která v repu není, = tvrdá chyba (exit 2)', kChybi.kod, 2);

const gPilot = run(['.forge/node/rozpocet-granuli.mjs', '--roadmap', '.forge/roadmap.pilot.json',
  '--poskytovatel', 'groq', '--model', 'openai/gpt-oss-120b']);
test('K3: všechny pilotní granule = REQUEST_FITS (brána projde)', /5 granulí, 5 REQUEST_FITS/.test(gPilot.out), true);
test('K3: brána projde i nenulově (exit 0)', gPilot.kod, 0);

const gBezKonvenci = run(['.forge/node/rozpocet-granuli.mjs', '--roadmap', FIX_BEZ_KONVENCI,
  '--poskytovatel', 'groq', '--model', 'openai/gpt-oss-120b']);
test('K3: granule bez deklarace konvencí = VADA (exit 1), ne tichý průchod',
  gBezKonvenci.kod === 1 && /nemá deklarované 'konvence'/.test(gBezKonvenci.out), true);

const nafouknuty = run(['.forge/node/request-budget.mjs', '--zadani-text', 'x'.repeat(30000), '--strop', '8000']);
test('K3: nafouknutý request = REQUEST_TOO_LARGE (exit 1, ne zelená)',
  nafouknuty.kod === 1 && /REQUEST_TOO_LARGE/.test(nafouknuty.out + nafouknuty.err), true);

// Pozitivní důkaz, že brána roadmapy měří VELIKOST souboru: granule, která si
// vezme velký existující soubor, musí spadnout. Bez tohohle testu by stačilo,
// aby `rozpocet-granuli.mjs` jen kontroloval deklarace — a velikost by neměřil.
const FIX_PRILIS_VELKA = join(tmpdir(), 'k3-test-prilis-velka.json');
writeFileSync(FIX_PRILIS_VELKA, JSON.stringify({ grains: [{ ...pilot.grains[0], id: 'test.prilis-velka',
  owns: ['.github/workflows/agent.yml'], size_lines: 800, konvence: ['01-typy'] }] }, null, 2), 'utf8');
const gVelka = run(['.forge/node/rozpocet-granuli.mjs', '--roadmap', FIX_PRILIS_VELKA,
  '--poskytovatel', 'groq', '--model', 'openai/gpt-oss-120b']);
test('K3: granule s velkým souborem = REQUEST_TOO_LARGE (exit 1) — brána měří i velikost',
  gVelka.kod === 1 && /REQUEST_TOO_LARGE/.test(gVelka.out), true);
rmSync(FIX_PRILIS_VELKA, { force: true });
rmSync(FIX_BEZ_KONVENCI, { force: true });
rmSync(FIX_SPATNA_SEKCE, { force: true });

console.log(`\n=== VYSLEDEK: ${kontroly - chyb}/${kontroly} kontrol, ${chyb} chyb ===`);
process.exit(chyb ? 1 : 0);