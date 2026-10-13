#!/usr/bin/env node
// Offline test logiky vision.mjs – bez internetu a bez skutečných klíčů.
//
// PROČ TO EXISTUJE: vision.mjs se v provozu testuje těžko (potřebuje klíč,
// kvótu a obrázek) a chyba v promptu nebo v porovnání odpovědí se projeví až
// za pochodu – tedy v CI, kde to nikdo nevidí.
//
// JAK TO TESTUJE BEZ MODELU: spustí si vlastní HTTP server na 127.0.0.1, který
// předstírá OpenAI-kompatibilní API, a profil dočasné „hry" na něj namíří.
// Tím se ověří CELÝ tok – sestavení promptu, volání, self-consistency,
// JSON výstup – bez jediného skutečného dotazu.
//
// Ověřuje se:
//   1) schéma se bere z assets/spec.json (jiná hra = jiná čísla),
//   2) očekávaný obsah se POČÍTÁ z grid/legend, neopisuje se ručně,
//   3) zákazy z profilu se dostanou do promptu,
//   4) shoda i neshoda dvou běhů se pozná (self-consistency),
//   5) chybějící klíč i chybějící soubor se ohlásí srozumitelně.
//
// Spuštění:  node .forge/node/vision.test.mjs
// Návratový kód: 0 = vše OK, 1 = chyba.

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const VISION = resolve(HERE, '..', 'vision.mjs');

let ok = 0;
let chyb = 0;
function test(nazev, podminka, detail = '') {
  if (podminka) {
    console.log(`  OK   ${nazev}`);
    ok++;
  } else {
    console.log(`  FAIL ${nazev}${detail ? ` – ${detail}` : ''}`);
    chyb++;
  }
}

// ------------------------------------------------- falešné API (mock) ------
// Odpovědi se řídí frontou: test si předem určí, co má model „říct".
//
// KAŽDÁ ODPOVĚĎ ZAVÍRÁ SPOJENÍ (`connection: close`). Není to kosmetika:
// s keep-alive drží undici v rodičovském procesu otevřené sockety a ten pak
// nikdy neskončí – test visel, i když všechny potomky doběhly.
let fronta = [];
let prijatePrompty = [];
const server = createServer((req, res) => {
  let telo = '';
  req.on('data', (c) => { telo += c; });
  req.on('end', () => {
    try {
      const b = JSON.parse(telo);
      const obsah = b.messages?.[0]?.content ?? [];
      prijatePrompty.push(obsah.find((p) => p.type === 'text')?.text ?? '');
      const obrazku = obsah.filter((p) => p.type === 'image_url').length;
      prijatePrompty.push(`__OBRAZKU__${obrazku}`);
    } catch { /* ignore */ }
    const odpoved = fronta.length ? fronta.shift() : '{"videno":[]}';
    res.writeHead(200, {
      'content-type': 'application/json',
      connection: 'close',
    });
    res.end(JSON.stringify({
      choices: [{ message: { content: odpoved } }],
      usage: { prompt_tokens: 123, completion_tokens: 45 },
    }));
  });
});
server.keepAliveTimeout = 0;

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const MOCK_URL = `http://127.0.0.1:${port}/chat/completions`;

// --------------------------------------------- dočasná „hra" v tempu ------
// Záměrně ČTVERCOVÁ projekce a dlaždice 24 px – kdyby měl nástroj „96×48"
// nebo „izometrická" napevno, test to odhalí.
const tmp = mkdtempSync(join(tmpdir(), 'vision-test-'));
// `assets/sprites` musí existovat: baseline eviduje jen sledované složky a do
// nich se v testu ukládá snímek pro ověření cache.
mkdirSync(join(tmp, 'assets', 'levels'), { recursive: true });
mkdirSync(join(tmp, 'assets', 'sprites'), { recursive: true });
mkdirSync(join(tmp, '.forge'), { recursive: true });

// Do dočasné „hry" se kopíruje i baseline.py – bez něj by nešla otestovat
// cache a test by tvrdil, že cache nefunguje, i kdyby fungovala jinde.
copyFileSync(resolve(HERE, '..', 'baseline.py'), join(tmp, '.forge', 'baseline.py'));

writeFileSync(join(tmp, 'assets', 'spec.json'), JSON.stringify({
  projekce: { typ: 'ctvercova', dlazdice_sirka: 24, dlazdice_vyska: 24, viewport: [768, 432] },
  styl: { technika: 'ručně kreslený top-down' },
}, null, 2));

writeFileSync(join(tmp, 'assets', 'levels', 'main.json'), JSON.stringify({
  name: 'test', cell: 24, width: 4, height: 2,
  legend: { 0: 'wall', 1: 'floor' },
  tiles: { 0: 'brick', 1: 'stone' },
  // POZOR na počty: '0011' + '1111' = šest jedniček a dvě nuly.
  // (První verze testu čekala 5× floor / 3× wall a hlásila chybu nástroje,
  //  i když nástroj počítal správně – chyba byla v testu.)
  grid: ['0011', '1111'],   // → 6× floor, 2× wall
}, null, 2));

const profilCesta = join(tmp, '.forge', 'vision-profile.json');
function zapisProfil(upravy = {}) {
  writeFileSync(profilCesta, JSON.stringify({
    verze: 1, hra: 'test-hra',
    ocekavany_obsah: 'z_mapy', mapa: 'assets/levels/main.json',
    styl_popis: 'top-down ručně kreslená fantasy',
    zakazy_v_promptu: ['Nesud počet barev, kvantizace je zakázaná.'],
    // strict: test nesmí sáhnout na skutečné API, ani kdyby měl stroj klíče
    // v prostředí. Bez toho se při prázdném MOCK_API_KEY tiše přidá Gemini
    // z env a test visí na síti – přesně to se stalo napoprvé.
    strict_poskytovatele: true,
    poskytovatele: [{
      nazev: 'mock', keyEnv: 'MOCK_API_KEY', url: MOCK_URL, model: 'mock-vl-1',
    }],
    self_consistency: true,
    ...upravy,
  }, null, 2));
}
zapisProfil();

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');
writeFileSync(join(tmp, 'snimek.png'), PNG);
writeFileSync(join(tmp, 'po.png'), PNG);
// Snímek pro test cache musí ležet ve SLEDOVANÉ složce (`assets/sprites`),
// protože baseline eviduje jen to, co patří do hry – obrázek v kořeni repa by
// správně hlásil „mimo repo hry" a cache by se nikdy neuplatnila.
writeFileSync(join(tmp, 'assets', 'sprites', 'snimek.png'), PNG);

// ASYNCHRONNÍ spouštění je POVINNÉ, ne stylistická volba.
//
// Mock server běží v TOMTO procesu. `execFileSync` blokuje event loop, takže
// rodič nemůže obsloužit požadavek, na který dítě čeká – a dítě čeká na rodiče.
// Vznikne deadlock a test visí navěky (naměřeno: 3× zaseknutý běh, než se to
// našlo). S `execFile` + await event loop běží dál a server odpovídá.
function spust(args, env = {}) {
  return new Promise((vyres) => {
    const dite = execFile(process.execPath, [VISION, ...args], {
      cwd: tmp, encoding: 'utf8',
      timeout: 45_000,
      env: { ...process.env, MOCK_API_KEY: 'test', DEEPSEEK_API_KEY: '',
             GEMINI_API_KEY: '', GOOGLE_API_KEY: '', ...env },
    }, (chyba, stdout, stderr) => {
      vyres({
        kod: chyba ? (chyba.code ?? chyba.status ?? 1) : 0,
        out: stdout ?? '',
        err: stderr ?? '',
      });
    });
    dite.stdin?.end();
  });
}
function jsonZe(vystup) {
  const i = vystup.indexOf('---JSON---');
  return i < 0 ? null : JSON.parse(vystup.slice(i + 10).trim());
}

// Pojistka: kdyby cokoli drželo event loop (keep-alive socket, otevřený
// server), test se ukončí sám. Bez toho by v CI „visel" do timeoutu jobu.
const POJISTKA = setTimeout(() => {
  console.log('\n[test] POJISTKA: test neukončil sám sebe, končím s chybou.');
  process.exit(1);
}, 120_000);
POJISTKA.unref?.();

console.log('=== vision.mjs – offline testy (mock API) ===');

// 1) Schéma se bere ze hry, ne z nástroje.
{
  fronta = ['{"videno":["podlaha"],"chybi":[],"navic":[],"popis":"ok"}',
            '{"videno":["podlaha"],"chybi":[],"navic":[],"popis":"ok"}'];
  prijatePrompty = [];
  const r = await spust(['--mode', 'presence', 'snimek.png']);
  const j = jsonZe(r.out);
  test('proběhne celý tok (exit 0)', r.kod === 0, `exit=${r.kod} ${r.err.slice(0, 100)}`);
  test('projekce ze spec.json je ctvercova', j?.projekce === 'ctvercova', String(j?.projekce));
  test('dlaždice ze spec.json jsou 24×24 (ne napevno 96×48)',
    JSON.stringify(j?.dlazdice) === '[24,24]', JSON.stringify(j?.dlazdice));
  test('self-consistency proběhla (shoda=true)', j?.shoda === true, String(j?.shoda));
  test('poslal právě 1 obrázek', prijatePrompty.includes('__OBRAZKU__1'),
    prijatePrompty.join(' | ').slice(0, 120));
}

// 2) Očekávaný obsah se POČÍTÁ z grid/legend.
{
  const prompt = prijatePrompty.find((p) => p.includes('kontrolor')) ?? '';
  test('prompt obsahuje spočítaný obsah z mapy (6× floor, 2× wall)',
    prompt.includes('6× floor') && prompt.includes('2× wall'),
    prompt.slice(0, 220));
  test('prompt nese styl hry z profilu', prompt.includes('top-down ručně kreslená fantasy'));
  test('prompt nese zákaz z profilu', prompt.includes('Nesud počet barev'));
  test('prompt neobsahuje jiná čísla dlaždic (žádné 96×48)',
    !prompt.includes('96×48') && !prompt.includes('960×540'),
    prompt.slice(0, 200));
}

// 2b) DVĚ JMÉNA TÉHOŽ POLE: `styl_popis` (starší profily) i `popis_stylu`
//     (nová šablona). Kdyby kód znal jen jedno, hra s tím druhým by o styl
//     TICHE přišla – a to je přesně ta třída chyby, kterou tenhle projekt řeší.
//     Testuje se OBOJÍ, protože „funguje to" u jednoho jména nic neříká o druhém.
{
  prijatePrompty = [];
  zapisProfil({ styl_popis: undefined, popis_stylu: 'styl z nového jména pole' });
  await spust(['--mode', 'presence', 'snimek.png']);
  const novy = prijatePrompty.find((p) => p.includes('kontrolor')) ?? '';
  test('profil s `popis_stylu` (nové jméno) styl NESMÍ ztratit',
    novy.includes('styl z nového jména pole'),
    novy.slice(0, 220));

  // A když není ani jedno, použije se styl ze spec.json – nesmí spadnout.
  prijatePrompty = [];
  zapisProfil({ styl_popis: undefined, popis_stylu: '' });
  await spust(['--mode', 'presence', 'snimek.png']);
  const prazdny = prijatePrompty.find((p) => p.includes('kontrolor')) ?? '';
  test('profil bez stylu nespadne a prompt pošle (styl ze spec, nebo prázdný)',
    prazdny.length > 0,
    'prompt se vůbec neposlal – prázdný styl nesmí vision zastavit');
  zapisProfil(); // vrátit výchozí profil pro další testy
}

// 3) Neshoda dvou běhů se pozná a NEZHODÍ to běh.
{
  fronta = ['{"videno":["hráč","podlaha"],"chybi":[],"navic":[],"popis":"a"}',
            '{"videno":["podlaha"],"chybi":["hráč"],"navic":[],"popis":"b"}'];
  const r = await spust(['--mode', 'presence', 'snimek.png']);
  const j = jsonZe(r.out);
  test('neshoda dvou běhů je detekována (shoda=false)', j?.shoda === false, String(j?.shoda));
  test('neshoda NEZHODÍ běh (exit 0) – je to signál, ne chyba', r.kod === 0, `exit=${r.kod}`);
  test('neshoda je pojmenovaná v poznámce',
    /neshodly|nejistý/i.test(j?.poznamka ?? ''), String(j?.poznamka));
  test('druhý běh je ve výstupu k dohledání', typeof j?.druhy_text === 'string');
}

// 4) Shodné odpovědi v jiném pořadí jsou pořád shoda (porovnává se množina).
{
  fronta = ['{"videno":["a","b"],"chybi":[],"navic":[],"popis":"x"}',
            '{"videno":["b","a"],"chybi":[],"navic":[],"popis":"y"}'];
  const r = await spust(['--mode', 'presence', 'snimek.png']);
  const j = jsonZe(r.out);
  test('shoda se pozná i při jiném pořadí položek', j?.shoda === true, String(j?.shoda));
}

// 5) Režim diff posílá dva obrázky a ptá se na změny.
{
  fronta = ['{"zmeny":["větší hlava"],"zustalo":["tělo"],"regrese":[]}',
            '{"zmeny":["větší hlava"],"zustalo":["tělo"],"regrese":[]}'];
  prijatePrompty = [];
  const r = await spust(['--mode', 'diff', 'snimek.png', 'po.png']);
  const j = jsonZe(r.out);
  test('diff proběhl (exit 0)', r.kod === 0, `exit=${r.kod}`);
  test('diff poslal 2 obrázky', prijatePrompty.includes('__OBRAZKU__2'),
    prijatePrompty.join(' | ').slice(0, 120));
  const prompt = prijatePrompty.find((p) => p.includes('schválený stav')) ?? '';
  test('diff prompt mluví o změnách a regresích',
    prompt.includes('zmeny') && prompt.includes('regrese'), prompt.slice(0, 160));
}

// 6) self_consistency=false udělá jen jedno volání.
{
  zapisProfil({ self_consistency: false });
  fronta = ['{"videno":["x"],"chybi":[],"navic":[],"popis":"p"}'];
  prijatePrompty = [];
  const r = await spust(['--mode', 'presence', 'snimek.png']);
  const j = jsonZe(r.out);
  const volani = prijatePrompty.filter((p) => p.includes('kontrolor')).length;
  test('vypnutá self-consistency = 1 volání', volani === 1, `volání=${volani}`);
  test('shoda není vyplněná, když se neporovnává', j?.shoda === undefined,
    String(j?.shoda));
  zapisProfil();
}

// 7) Chybové stavy musí být srozumitelné.
{
  const r = await spust(['--mode', 'presence', 'snimek.png'], { MOCK_API_KEY: '' });
  test('bez klíče hlásí chybějící klíč (exit 1)', r.kod === 1, `exit=${r.kod}`);
  test('v chybě je jméno proměnné', /MOCK_API_KEY|DEEPSEEK_API_KEY|GEMINI_API_KEY/.test(r.err),
    r.err.slice(0, 140));
}
{
  const r = await spust(['--mode', 'presence', 'neexistuje.png']);
  test('chybějící obrázek hlásí nenalezeno (exit 1)', r.kod === 1, `exit=${r.kod}`);
  test('hláška obsahuje cestu', /neexistuje\.png/.test(r.err), r.err.slice(0, 140));
}
{
  const r = await spust(['--mode', 'diff', 'snimek.png']);
  test('diff s jedním obrázkem hlásí chybu (exit 2)', r.kod === 2, `exit=${r.kod}`);
}
{
  // Model, který vrátí nesmysl (ne JSON) – nesmí to shodit nástroj.
  fronta = ['úplně volný text bez JSONu', 'úplně volný text bez JSONu'];
  const r = await spust(['--mode', 'presence', 'snimek.png']);
  test('ne-JSON odpověď se přijme a porovná volně (exit 0)', r.kod === 0, `exit=${r.kod}`);
}

// 8) CACHE: schválený a nezměněný obrázek se modelu VŮBEC NEPOSÍLÁ.
//
// Tohle je jádro LGTM cache a musí se ověřit měřením, ne dojmem: kontroluje se,
// že počet přijatých promptů na mock serveru zůstal NULOVÝ. Kdyby se jen
// zkontroloval exit kód, prošel by i případ, kdy se model zavolal zbytečně.
{
  const { execFileSync } = await import('node:child_process');
  let vCacheOk = false;
  let phashPng = null;
  try {
    // Baseline se zapíše přes skutečný nástroj – test tím zároveň ověřuje,
    // že rozhraní mezi vision.mjs a baseline.py sedí.
    const v = execFileSync('python', [
      join(tmp, '.forge', 'baseline.py'), '--koren', tmp, 'init',
    ], { cwd: tmp, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    vCacheOk = v.includes('Baseline zapsán');
    phashPng = v;
  } catch (e) {
    phashPng = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  test('baseline.py init proběhl (rozhraní pro cache funguje)', vCacheOk,
    String(phashPng).slice(0, 160));

  fronta = ['{"videno":["x"],"chybi":[],"navic":[],"popis":"p"}',
            '{"videno":["x"],"chybi":[],"navic":[],"popis":"p"}'];
  prijatePrompty = [];
  const r = await spust(['--mode', 'presence', 'assets/sprites/snimek.png']);
  const j = jsonZe(r.out);
  const volani = prijatePrompty.filter((p) => p.includes('kontrolor')).length;
  test('schválený obrázek: model se NEVOLÁ (0 promptů)', volani === 0, `volání=${volani}`);
  test('schválený obrázek: výstup to řekne (z_cache)', j?.z_cache === true, String(j?.z_cache));
  test('schválený obrázek: exit 0', r.kod === 0, `exit=${r.kod}`);
  test('schválený obrázek: důvod je pojmenovaný',
    /schváleno a nezměněno/i.test(j?.kontroly?.[0]?.duvod ?? ''),
    JSON.stringify(j?.kontroly ?? null).slice(0, 160));

  // A druhá strana: `--force` musí cache obejít (nutné, když chceš re-check).
  prijatePrompty = [];
  const rf = await spust(['--mode', 'presence', '--force', 'assets/sprites/snimek.png']);
  const volaniF = prijatePrompty.filter((p) => p.includes('kontrolor')).length;
  test('--force cache obejde a model se zavolá', volaniF === 2, `volání=${volaniF}`);
}

// 9) Selhání všech poskytovatelů = exit 1, ale s JSONem k dohledání.
{
  server.closeAllConnections?.();
  server.close();
  await new Promise((r) => setTimeout(r, 100));
  fronta = [];
  const r = await spust(['--mode', 'presence', 'snimek.png']);
  test('nedostupné API = exit 1', r.kod === 1, `exit=${r.kod}`);
  test('i při selhání je ve výstupu JSON s pokusy', jsonZe(r.out)?.pokusy?.length >= 1,
    r.out.slice(0, 120));
}

// 10) Bez profilu se řetěz sestaví z prostředí (a bez klíčů to řekne).
{
  const bezProfilu = mkdtempSync(join(tmpdir(), 'vision-noprofile-'));
  mkdirSync(join(bezProfilu, '.forge'), { recursive: true });
  writeFileSync(join(bezProfilu, 'snimek.png'), PNG);
  const v = await new Promise((vyres) => {
    execFile(process.execPath, [VISION, 'snimek.png', 'Co je na obrázku?'], {
      cwd: bezProfilu, encoding: 'utf8', timeout: 45_000,
      env: { ...process.env, DEEPSEEK_API_KEY: '', GEMINI_API_KEY: '',
             GOOGLE_API_KEY: '', MOCK_API_KEY: '' },
    }, (chyba, stdout, stderr) => vyres({ kod: chyba ? 1 : 0, stdout, stderr }));
  });
  test('bez profilu se řetěz bere z prostředí a chyba je srozumitelná',
    v.kod === 1 && /Chybí klíč/.test(`${v.stdout}${v.stderr}`),
    `${v.stdout}${v.stderr}`.slice(0, 160));
}

console.log();
console.log(`Testů OK: ${ok}, chyb: ${chyb}`);
console.log(chyb === 0 ? 'VŠE OK' : 'NALEZENY CHYBY');
// Explicitní exit: kdyby cokoli drželo event loop, test by visel navěky.
process.exit(chyb === 0 ? 0 : 1);
