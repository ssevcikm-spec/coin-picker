#!/usr/bin/env node
// „Oči" pro agenta v CI – pošle obrázek modelu s viděním a vrátí text nebo JSON.
//
// PROČ TO EXISTUJE: agent v GitHub Actions nemá nativní vision, takže bez
// tohohle kroku pozná jen to, že soubor existuje. Měření (check-assets.py) řekne
// „sedí výška a nejsou díry"; tenhle krok řekne „je na tom obrázku to, co tam
// má být".
//
// ============================================================================
// DVĚ VĚCI, KTERÉ ROZHODUJÍ O PŘESNOSTI (naučeno z návrhu, viz
// PLAN-VISION-ORCHESTRA.md §2):
//
//  1) NEPOSÍLAT HODNOCENÍ, POSÍLAT OČEKÁVÁNÍ. Model, který dostane „vypiš, co
//     vidíš", je zdvořilý a vidí, co má. Model, který dostane SEZNAM
//     očekávaných objektů, jen přiřazuje přítomen/nepřítomen – snazší úloha,
//     tedy přesnější i levnější.
//
//  2) JEDEN BĚH NESTAČÍ. Výsledek se proto posílá DVAKRÁT (self-consistency)
//     a porovná se. Neshoda není chyba nástroje – je to SIGNÁL NEJISTOTY,
//     a to je přesně moment, kdy má rozhodnout člověk.
// ============================================================================
//
// SCHÉMA JE DATA HRY, NE KONSTANTA TOHOHLE SKRIPTU. Projekce, velikost dlaždice
// i styl se čtou z `assets/spec.json`; chování kontroly z `.forge/vision-profile.json`.
// Izometrická hra a side-scroller tak používají tentýž nástroj bez úprav –
// proto tu NENÍ žádné „96" ani „UO" napevno.
//
// Použití:
//   node .forge/vision.mjs <obrazek> "<dotaz>"              # volný dotaz
//   node .forge/vision.mjs --mode presence <obrazek>        # obsah proti očekávání
//   node .forge/vision.mjs --mode diff <pred.png> <po.png>  # změnový diff
//
// Návratový kód: 0 = odpověď přišla, 1 = nepodařilo se (běh se tím nezhodí,
// jen se to ohlásí – viz použití s `|| true` ve workflow).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

// ------------------------------------------------------------------ vstup ----
const argv = process.argv.slice(2);
function readSwitch(nazev, vychozi = null) {
  const i = argv.indexOf(nazev);
  if (i < 0) return vychozi;
  return argv[i + 1] ?? vychozi;
}
const rezim = readSwitch('--mode', null);
const pozice = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--mode');

if (pozice.length === 0) {
  console.error('Použití: node .forge/vision.mjs [--mode presence|diff] <obrazek> [<druhy.png>] ["<dotaz>"]');
  process.exit(2);
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};

// ------------------------------------------------------- profil a schéma ----
// Profil je volitelný: bez něj se použije rozumný výchozí režim. Načítá se
// z repa hry, takže každá hra si může určit vlastní práh a vlastní očekávání.
//
// FORGE_VISION_ROOT přepíše kořen – používá ho offline test
// (`.forge/node/vision.test.mjs`), aby šel nástroj ověřit na cizí „hře"
// s jiným schématem, než má ta skutečná.
const ROOT = process.env.FORGE_VISION_ROOT || '.';

function nactiJson(cesta) {
  if (!existsSync(cesta)) return null;
  try {
    // BOM SE MUSÍ ODSTRANIT. PowerShell (`Set-Content -Encoding UTF8`) i různé
    // editory na Windows píšou na začátek UTF-8 BOM, a `JSON.parse` na něm
    // spadne s nesrozumitelnou hláškou („Unexpected token '\uFEFF'"). Ve hře
    // takový soubor klidně vznikne ruční editací – a nástroj by hlásil, že
    // konfigurace není platná, i když je.
    //
    // Pozor: stejná past už jednou potkala orchestra u `orchestra/.env`
    // (viz orchestra/README.md a tools/stav-conductora.mjs).
    const text = readFileSync(cesta, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch (e) {
    console.error(`[vision] ${cesta} není platné JSON: ${e.message}`);
    return null;
  }
}

const profil = nactiJson(join(ROOT, '.forge', 'vision-profile.json'));
const spec = nactiJson(join(ROOT, 'assets', 'spec.json'));
const proj = spec?.projekce ?? {};
const tile = spec?.tile ?? {};
const projekce = String(proj.typ ?? '').toLowerCase()
  || (tile.sirka && tile.vyska && Number(tile.sirka) !== Number(tile.vyska)
      ? 'izometricka' : 'ctvercova');
const tileW = proj.dlazdice_sirka ?? tile.sirka;
const tileH = proj.dlazdice_vyska ?? tile.vyska;
const viewport = proj.viewport ?? spec?.viewport;

function popisProjektu() {
  const casti = [];
  if (projekce) casti.push(`projekce: ${projekce}`);
  if (tileW && tileH) casti.push(`dlaždice ${tileW}×${tileH} px`);
  if (viewport) casti.push(`viewport ${viewport[0]}×${viewport[1]}`);
  const styl = spec?.styl?.technika;
  if (styl) casti.push(`technika: ${styl}`);
  return casti.join(', ');
}

// --------------------------------------------- očekávaný obsah z DAT HRY ----
// Očekávání se POČÍTÁ, neopisuje. Když se mapa změní, kontrola se změní s ní –
// ručně psaný seznam by zestárnul při první editaci levelu.
function ocekavanyObsah() {
  const zdroj = profil?.ocekavany_obsah;
  if (zdroj === 'z_mapy') {
    const cesta = join(ROOT, profil?.mapa ?? join('assets', 'levels', 'main.json'));
    const lvl = nactiJson(cesta);
    if (!lvl || !Array.isArray(lvl.grid)) {
      console.error(`[vision] ${cesta} nemá 'grid' – očekávaný obsah nelze spočítat`);
      return null;
    }
    const leg = lvl.legend ?? {};
    const til = lvl.tiles ?? {};
    const pocty = new Map();
    for (const radek of lvl.grid) {
      for (const znak of radek) pocty.set(znak, (pocty.get(znak) ?? 0) + 1);
    }
    return [...pocty.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([znak, n]) => `${n}× ${leg[znak] ?? til[znak] ?? znak}`)
      .join(', ');
  }
  if (Array.isArray(zdroj)) return zdroj.join(', ');
  if (typeof zdroj === 'string') return zdroj;
  return null;
}

// -------------------------------------------------------------- prompty ----
function sestavPrompt() {
  // POZOR NA DVĚ JMÉNA TÉHOŽ POLE (opraveno 1. 10. 2026):
  // starší profily mají `styl_popis`, nová šablona používá `popis_stylu`
  // (neutrálnější jméno, ať pole neodkazuje na jednu hru). Kdyby kód znal jen
  // jedno, hra s tím druhým by o svůj styl TICHE přišla – a to je přesně ta
  // třída chyby, kterou tenhle projekt řeší pořád. Čtou se proto obě.
  const styl = profil?.styl_popis ?? profil?.popis_stylu ?? spec?.styl?._popis?.[0] ?? '';
  const zakazy = (profil?.zakazy_v_promptu ?? []).join(' ');
  const otazkaUzivatele = pozice.length > 1 && !pozice[1].endsWith('.png') ? pozice[1] : null;

  if (rezim === 'presence') {
    const ocekavane = ocekavanyObsah();
    if (!ocekavane) {
      console.error('[vision] režim presence potřebuje očekávaný obsah – '
        + 'nastav v .forge/vision-profile.json "ocekavany_obsah": "z_mapy" nebo seznam');
      return null;
    }
    return `Jsi kontrolor herního screenshotu. ${popisProjektu() ? `Kontext: ${popisProjektu()}.` : ''}
${styl ? `Záměr hry: ${styl}` : ''}

Mapa obsahuje: ${ocekavane}

Odpověz POUZE validním JSON, bez textu okolo:
{"videno": ["co je na snímku skutečně vidět"], "chybi": ["co podle mapy chybí"], "navic": ["co je navíc"], "popis": "jedna věta"}

Pravidla:
- Vypisuj, co vidíš. Nedělej estetický posudek a nic si nevymýšlej.
- Když si nejsi jistý, dej to do "popis", ne do "chybi" – falešné "chybí" je horší než nejistota.
${zakazy}`;
  }

  if (rezim === 'diff') {
    if (pozice.length < 2) {
      console.error('[vision] režim diff potřebuje dva obrázky');
      return null;
    }
    return `Obrázek 1 = schválený stav, obrázek 2 = nový stav.
${popisProjektu() ? `Kontext: ${popisProjektu()}.` : ''}
${styl ? `Záměr hry: ${styl}` : ''}

Porovnej je a odpověz POUZE validním JSON:
{"zmeny": ["co se změnilo"], "zustalo": ["co zůstalo stejné"], "regrese": ["co vypadá hůř nebo nekonzistentně"]}

Pravidla:
- Jen porovnávej, nehodnoť, co by mělo být lepší.
- Do "regrese" dej jen to, co je vidět; když nic, nech prázdné pole.
${zakazy}`;
  }

  return otazkaUzivatele ?? 'Co je na obrázku? Odpověz česky a stručně.';
}

// ------------------------------------------------------------ poskytovatelé ----
// Řetěz se bere z profilu; když tam není, sestaví se z klíčů, které v prostředí
// jsou. Pořadí je záměrné (viz PLAN-VISION-ORCHESTRA.md §3): levný „dělník"
// dělá rutinu, dražší „rozhodčí" se šetří na těžké otázky.
function sestavRetez() {
  const zProfilu = profil?.poskytovatele;
  if (Array.isArray(zProfilu) && zProfilu.length) {
    // `strict_poskytovatele` je důležité pro testy a pro hry, které chtějí
    // přesně daný řetěz: bez něj by se při chybějícím klíči tiše přidali
    // poskytovatelé detekovaní z prostředí a výsledek by závisel na tom, jaké
    // klíče má zrovna stroj v env (přesně to shodilo offline test do zaseknutí).
    const vybrane = zProfilu.filter((p) => process.env[p.keyEnv]);
    if (profil?.strict_poskytovatele) return vybrane;
    return vybrane.length ? vybrane : sestavRetezZProstredi();
  }
  return sestavRetezZProstredi();
}

function sestavRetezZProstredi() {
  const auto = [];
  if (process.env.DEEPSEEK_API_KEY) {
    auto.push({
      nazev: 'deepseek', keyEnv: 'DEEPSEEK_API_KEY',
      url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash',
    });
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    auto.push({
      nazev: 'gemini',
      keyEnv: process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 'GOOGLE_API_KEY',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      model: 'gemini-3.8-flash',
    });
  }
  return auto;
}

function naDataUrl(cesta) {
  const mime = MIME[extname(cesta).toLowerCase()] || 'image/png';
  const b64 = readFileSync(cesta).toString('base64');
  return `data:${mime};base64,${b64}`;
}

async function zavolej(poskytovatel, prompt, obrazky) {
  const obsah = [{ type: 'text', text: prompt }];
  for (const o of obrazky) {
    obsah.push({ type: 'image_url', image_url: { url: naDataUrl(o), detail: 'high' } });
  }
  // TIMEOUT JE POVINNÝ. Bez něj visí volání do nekonečna a v CI spálí celý krok
  // (naměřeno: offline test se zasekl, protože mock server zavřel spojení a
  // fetch čekal dál). Volání vision modelu umí viset i v provozu – poskytovatel
  // drží spojení a neodpovídá.
  const strop = Number(process.env.FORGE_VISION_TIMEOUT_MS || 60_000);
  const res = await fetch(poskytovatel.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env[poskytovatel.keyEnv]}`,
    },
    body: JSON.stringify({
      model: poskytovatel.model,
      messages: [{ role: 'user', content: obsah }],
      temperature: 0.3,
      max_tokens: 900,
    }),
    signal: AbortSignal.timeout(strop),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${poskytovatel.nazev}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const odpoved = json?.choices?.[0]?.message?.content;
  if (!odpoved) throw new Error(`${poskytovatel.nazev}: odpověď bez textu`);
  return { odpoved: String(odpoved).trim(), usage: json?.usage ?? null };
}

// ------------------------------------------------------ self-consistency ----
// Dvě volání týmž modelem a porovnání. Shoda = věř tomu. Neshoda = nejistota,
// kterou je potřeba ohlásit, ne zamlčet. (Jeden běh má u vision modelů
// chybovost v jednotkách až desítkách procent – na bránu to nestačí.)
function normalizuj(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

function shodujiSe(a, b) {
  if (a === b) return true;
  try {
    const ja = JSON.parse(a);
    const jb = JSON.parse(b);
    const klice = ['videno', 'chybi', 'navic', 'zmeny', 'zustalo', 'regrese'];
    const mnozina = (o, k) => new Set((o?.[k] ?? []).map(normalizuj));
    for (const k of klice) {
      if (k in ja || k in jb) {
        const ma = mnozina(ja, k);
        const mb = mnozina(jb, k);
        if (ma.size !== mb.size) return false;
        for (const x of ma) if (!mb.has(x)) return false;
      }
    }
    return true;
  } catch {
    // Ne-JSON odpovědi se porovnávají volně – stačí, že se nerozcházejí v hrubém obrysu.
    return normalizuj(a).slice(0, 200) === normalizuj(b).slice(0, 200);
  }
}

// ------------------------------------------------------------------ běh ----
const prompt = sestavPrompt();
if (!prompt) process.exit(2);

const obrazky = rezim === 'diff' ? pozice.slice(0, 2) : [pozice[0]];
for (const o of obrazky) {
  if (!existsSync(o)) {
    console.error(`[vision] soubor nenalezen: ${o}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- cache ----
// Než se obrázek pošle modelu, zkontroluje se, jestli není SCHVÁLENÝ a
// nezměněný. Šetří to kvótu i čas a je to jediná obrana proti tomu, aby se
// platilo opakovaně za totéž.
//
// Pozor: cache se ptá na KAŽDÝ obrázek, ale u režimu `diff` stačí, když se
// změnil jeden z nich – proto stačí jediné „není v cache" a pokračuje se.
function vCache(obrazek) {
  // Interpret se hledá: na Windows je `python`, v CI runneru `python3`
  // (a `python` tam být nemusí). Když se nenajde, cache se prostě nepoužije.
  const skript = join(ROOT, '.forge', 'baseline.py');
  if (!existsSync(skript)) return { v_cache: false, duvod: 'baseline.py není' };
  // FORGE_VISION_PYTHON umožní interpret vnutit (testy a exotická prostředí).
  const kandidati = process.env.FORGE_VISION_PYTHON
    ? [process.env.FORGE_VISION_PYTHON]
    : ['python', 'python3', 'py'];
  const chyby = [];
  for (const interp of kandidati) {
    try {
      const v = execFileSync(interp,
        [skript, '--koren', ROOT, '--json', 'kontrola', obrazek],
        { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
      return JSON.parse(v);
    } catch (e) {
      // ENOENT = interpret není, zkusí se další. Jiná chyba = baseline chybí
      // nebo je rozbitá; i tak se pokračuje dalším interpretem, ale DŮVOD SE
      // ZAZNAMENÁ – bez toho se ladí naslepo (přesně to se stalo napoprvé).
      chyby.push(`${interp}: ${e?.code ?? ''} ${String(e?.stderr ?? e?.message ?? e).slice(0, 120)}`
        .replace(/\s+/g, ' ').trim());
    }
  }
  return { v_cache: false, duvod: `baseline nešla spustit – ${chyby.join(' | ')}` };
}

const kontroly = obrazky.map((o) => ({ obrazek: o, ...vCache(o) }));
const vsechnySchvalene = kontroly.every((k) => k.v_cache === true);

if (vsechnySchvalene && !argv.includes('--force')) {
  console.log(`Schváleno (LGTM) a nezměněno – kontrola se přeskakuje.`);
  console.log('---JSON---');
  console.log(JSON.stringify({
    rezim: rezim ?? 'ask', projekce, dlazdice: [tileW, tileH], obrazky,
    z_cache: true, kontroly, text: null,
    poznamka: 'Obrázek je v baseline a vizuálně se nezměnil, model se nevolal. '
      + 'Pro vynucení kontroly přidej --force.',
  }, null, 2));
  process.exit(0);
}

const retez = sestavRetez();
if (retez.length === 0) {
  console.error('Chybí klíč pro vision – nastav DEEPSEEK_API_KEY nebo GEMINI_API_KEY.');
  process.exit(1);
}

const dvojite = profil?.self_consistency !== false;
const vystup = { rezim: rezim ?? 'ask', projekce, dlazdice: [tileW, tileH], obrazky,
                 // Kontroly cache se vypisují VŽDY – bez nich není vidět, proč
                 // se model volal (nebo nevolal), a ladí se naslepo.
                 kontroly,
                 // Prompt se vypisuje záměrně: bez něj se ladí naslepo a v CI
                 // není vidět, CO se modelu vlastně poslalo.
                 prompt, pokusy: [] };
let posledniChyba = '';

for (const p of retez) {
  try {
    const prvni = await zavolej(p, prompt, obrazky);
    vystup.poskytovatel = p.nazev;
    vystup.model = p.model;
    vystup.text = prvni.odpoved;
    vystup.usage = prvni.usage;
    vystup.pokusy.push({ poskytovatel: p.nazev, ok: true });

    if (dvojite) {
      const druhy = await zavolej(p, prompt, obrazky);
      vystup.shoda = shodujiSe(prvni.odpoved, druhy.odpoved);
      vystup.druhy_text = druhy.odpoved;
      if (!vystup.shoda) {
        // Nezhodilo to běh – jen to nahlas řeklo, že je potřeba lidské oko.
        vystup.poznamka = 'Dva běhy se neshodly – verdikt je nejistý, rozhodni lidsky.';
      }
    }

    console.log(vystup.text);
    console.log('---JSON---');
    console.log(JSON.stringify(vystup, null, 2));
    process.exit(0);
  } catch (e) {
    posledniChyba = String(e).slice(0, 300);
    vystup.pokusy.push({ poskytovatel: p.nazev, ok: false, chyba: posledniChyba });
  }
}

console.error(`Vision selhala u všech poskytovatelů. Poslední chyba: ${posledniChyba}`);
console.log('---JSON---');
console.log(JSON.stringify(vystup, null, 2));
process.exit(1);
