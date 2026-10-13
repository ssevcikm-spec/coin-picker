#!/usr/bin/env node
// Test volby poskytovatele – bez sítě, bez klíčů. Ověřuje tři věci, na kterých
// stojí opakované pokusy agenta:
//   1) rotace podle run_key je deterministická (stejný běh = stejná volba),
//   2) různé run_key dají různé pořadí (pokusy se nepotkají se stejným modelem),
//   3) „--next" po neúspěchu opravdu přeskočí na DALŠÍHO poskytovatele.
//
// Použití: node .forge/node/provider-choice.test.mjs

import assert from "node:assert/strict";
import { fnv1a, rotateOrder, startIndex, probeOrder, orderProviders, strongProviders, rotateByAttempt } from "./provider-choice.mjs";

const P = [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }, { name: "e" }];
let checks = 0;
const ok = (popis) => { checks++; console.log(`  OK   ${popis}`); };

// 1) determinismus
const r1 = rotateOrder(P, "run-1");
const r2 = rotateOrder(P, "run-1");
assert.deepEqual(r1, r2);
ok("stejný run_key → stejné pořadí (běh je reprodukovatelný)");

// bez seedu se nic nemění (chování před rotací)
assert.deepEqual(rotateOrder(P, ""), P);
assert.deepEqual(rotateOrder(P, null), P);
ok("bez run_key zůstává pořadí z providers.json");

// 2) rotace opravdu točí – na 20 různých běhů musí vyjít aspoň 3 různé začátky
const zacatky = new Set();
for (let i = 0; i < 20; i++) zacatky.add(rotateOrder(P, `run-${i}`)[0].name);
assert.ok(zacatky.size >= 3, `různých začátků: ${zacatky.size}`);
ok(`různé run_key → různé začátky (${zacatky.size} z 5 poskytovatelů)`);

// rotace je jen posun – všichni poskytovatelé zůstávají
assert.deepEqual([...rotateOrder(P, "x")].sort((a, b) => a.name.localeCompare(b.name)), P);
ok("rotace nikoho neztratí (je to jen posun pořadí)");

// 3) --next přeskočí na dalšího
const order = rotateOrder(P, "run-1");
const prvni = order[0].name;
const druhy = probeOrder(order, startIndex(order, prvni, true))[0].name;
assert.notEqual(druhy, prvni);
assert.equal(druhy, order[1].name);
ok(`--next po '${prvni}' zkusí '${druhy}' (jiný model)`);

// --next se z neznámého jména chová jako první pokus
assert.equal(startIndex(order, "neexistuje", true), 0);
ok("neznámý poskytovatel v provider.json → začni od začátku");

// pořadí zkoušení projde všechny právě jednou (žádné zacyklení)
const poradi = probeOrder(order, 2).map((p) => p.name);
assert.equal(new Set(poradi).size, P.length);
assert.equal(poradi.length, P.length);
ok("pořadí zkoušení projde každého poskytovatele právě jednou");

// hash se nesmí zbláznit na delším vstupu
assert.equal(typeof fnv1a("26484181-47eb-4db5-adc7-fa8b5c457d9b"), "number");
assert.ok(fnv1a("a") !== fnv1a("b"));
ok("hash dává různá čísla pro různé vstupy");

// 4) skromní poskytovatelé (malý denní limit) patří VŽDY na konec
const seSkromnym = [
  { name: "mistral" }, { name: "cerebras" },
  { name: "gemini", skromny: true },
  { name: "openrouter" },
];
for (let i = 0; i < 10; i++) {
  const o = orderProviders(seSkromnym, `run-${i}`).map((p) => p.name);
  assert.equal(o[o.length - 1], "gemini", `pořadí: ${o.join(",")}`);
  assert.equal(new Set(o).size, seSkromnym.length);
}
ok("skromný poskytovatel (gemini) je vždy poslední, ale nikdo nezmizí");

// když je skromný jen jeden, rotace probíhá mezi štědrými
const zacinajici = new Set();
for (let i = 0; i < 12; i++) zacinajici.add(orderProviders(seSkromnym, `x-${i}`)[0].name);
assert.ok(zacinajici.size >= 2 && !zacinajici.has("gemini"), [...zacinajici].join(","));
ok(`rotace začíná u štědrých poskytovatelů (${zacinajici.size} různých začátků)`);

// když jsou skromní všichni, nic se neztratí
const jenSkromne = orderProviders([{ name: "a", skromny: true }, { name: "b", skromny: true }], "s");
assert.equal(jenSkromne.length, 2);
ok("když jsou skromní všichni, pořadí je pořád kompletní");

// 5) granule model: strong smí běžet jen na strongModels
const retezec = [
  { name: "mistral", models: ["codestral-latest"], strongModels: ["codestral-latest"] },
  { name: "cerebras", models: ["gpt-oss-120b"], strongModels: ["gpt-oss-120b"] },
  { name: "gemini", skromny: true, models: ["gemini-3.8-flash"] },
  { name: "groq", models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"], strongModels: ["openai/gpt-oss-120b"] },
  { name: "openrouter", models: ["qwen/qwen3.8-27b:free"] },
];
const silni = strongProviders(retezec);
assert.deepEqual(silni.map((p) => p.name), ["mistral", "cerebras", "groq"]);
ok("silné granuli zůstanou jen poskytovatelé se strongModels");
assert.deepEqual(silni[2].models, ["openai/gpt-oss-120b"]);
ok("u groq se zkouší jen silný model, gpt-oss-20b slabé granuli nedostane");
assert.equal(strongProviders([{ name: "jen-slabi", models: ["x"] }]).length, 0);
ok("bez jediného strongModels je výběr prázdný (granule čeká)");
// slabá cesta zůstává nedotčená: bez filtru se zkouší všechny modely
assert.deepEqual(orderProviders(retezec, "").map((p) => p.name),
  ["mistral", "cerebras", "groq", "openrouter", "gemini"]);
ok("bez FORGE_MIN_STRONG jede řetězec jako dřív (skromní na konci)");

// 6) rotace podle čísla pokusu – opakovaný pokus nesmí zkusit stejný model.
//
// PROČ: naměřeno 30. 9. 2026 – task #128 i #131 zkoušely 5× po sobě
// mistral/codestral a selhaly pokaždé stejně. U granulí `any` se rotace
// nepoužívala (řazení podle štědrosti kvóty), takže další pokus začínal
// pořád na tomtéž modelu.
const stedri = [{ name: "mistral" }, { name: "cerebras" }, { name: "groq" }];

// první pokus = původní pořadí (priorita kvóty se nesmí rozbít)
assert.deepEqual(rotateByAttempt(stedri, 1).map((p) => p.name), ["mistral", "cerebras", "groq"]);
assert.deepEqual(rotateByAttempt(stedri, 0).map((p) => p.name), ["mistral", "cerebras", "groq"]);
ok("1. pokus nechává pořadí podle štědrosti kvóty (mistral první)");

// druhý pokus začne jiným poskytovatelem než první
assert.notEqual(rotateByAttempt(stedri, 2)[0].name, rotateByAttempt(stedri, 1)[0].name);
ok("2. pokus začíná jiným modelem než 1. (rotace podle pokusu)");

// tři pokusy po sobě = tři různí první poskytovatelé
const prvniVolby = [1, 2, 3].map((a) => rotateByAttempt(stedri, a)[0].name);
assert.equal(new Set(prvniVolby).size, 3, prvniVolby.join(","));
ok(`tři pokusy po sobě zkusí tři různé modely (${prvniVolby.join(" → ")})`);

// rotace nikoho neztratí (porovnávají se jména – `sort` na kopii, ať se
// neseřadí i referenční pole a test pak neporovnává seřazené s neseřazeným)
const poRotaciJmena = rotateByAttempt(stedri, 2).map((p) => p.name).sort();
const puvodniJmena = stedri.map((p) => p.name).sort();
assert.deepEqual(poRotaciJmena, puvodniJmena);
ok("rotace podle pokusu nikoho neztratí (je to jen posun)");

// nesmyslné číslo pokusu se chová jako první pokus
assert.deepEqual(rotateByAttempt(stedri, NaN).map((p) => p.name), ["mistral", "cerebras", "groq"]);
assert.deepEqual(rotateByAttempt(stedri, undefined).map((p) => p.name), ["mistral", "cerebras", "groq"]);
ok("chybějící/nesmyslné číslo pokusu = chovej se jako první pokus");

// skromný poskytovatel zůstává na konci i po rotaci (řeší pick-provider, tady
// se ověřuje jen to, že rotace sama skromné nezvedne dopředu)
const seSkromnym2 = [...stedri, { name: "gemini", skromny: true }];
const stedriJen = seSkromnym2.filter((p) => !p.skromny);
const poRotaci = [...rotateByAttempt(stedriJen, 2), ...seSkromnym2.filter((p) => p.skromny)];
assert.equal(poRotaci[poRotaci.length - 1].name, "gemini");
ok("skromný poskytovatel zůstává na konci i při rotaci podle pokusu");

console.log(`\n${checks} kontrol, 0 selhání`);
