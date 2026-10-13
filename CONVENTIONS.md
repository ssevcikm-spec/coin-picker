# Konvence pro agenty — ROZCESTNÍK (tenhle soubor se agentovi NEPOSÍLÁ)

> **Co tenhle soubor JE:** rozcestník k **sekcím** v `CONVENTIONS/`. Vznikl
> 12. 10. 2026 rozdělením jednoho dokumentu, protože **celý se do stropu
> poskytovatele nevejde**: Groq zdarma pustí **8 000 tokenů za minutu** a request
> s celým dokumentem měl **14 097 t** — model se tedy zadání nikdy nedozvěděl
> (naměřeno 12. 10. 2026, `usage.prompt_tokens` + tělo chyby 413).
>
> **Jak se sekce dostanou k agentovi:** granule je **deklaruje v roadmapě**
> (`"konvence": ["01-typy", "06-soubor-granule"]`). Workflow z deklarace udělá
> `aider --read CONVENTIONS/<sekce>.md` a `request-budget.mjs` je **započítá do
> rozpočtu** — co se nevejde, se neposílá. „Co se má poslat" je vlastnost
> **granule**, ne odhad podle klíčových slov v zadání (odhad = věštění).
>
> **Pravidla (brána, ne doporučení):**
> - každá sekce má **≤ 1 200 t**,
> - součet sekcí deklarovaných jednou granulí je **≤ 1 200 t**,
> - každá granule musí projít
>   `node .forge/node/request-budget.mjs --poskytovatel groq --model openai/gpt-oss-120b`
>   → `TRIDA=REQUEST_FITS`.
>
> **Velikosti sekcí se NEOPISUJÍ** (zastarají): vypíše je
> `node .forge/node/rozpocet-granuli.mjs --seznam-sekci`.

## Která sekce co řeší (a které § původního dokumentu obsahuje)

| Sekce | § | Co řeší |
|---|---|---|
| `01-typy.md` | 1 | výslovné typy (`:=` jen se známým typem) |
| `02-reservovana-jmena.md` | 1d | `class_name` nesmí kolidovat s globálním jménem |
| `03-kolize-clenu.md` | 1f | `get()`, `set()`, `name`, `position` — kolize s enginem |
| `04-soubory-json.md` | 1c | `File`/`json` neexistují → `FileAccess`/`JSON` |
| `05-godot3-konstanty.md` | 1h | konstanty Godotu 3 v Godotu 4 neexistují |
| `06-soubor-granule.md` | 1g | `extends Node`, `load(...).new()`, vnořená `class`, `_init()` |
| `07-uzel-a-kostra.md` | 1b, 1e, 2 | vlastnosti uzlu z kódu, kostra souboru, „nenačetl se" |
| `08-meze-a-overeni.md` | 5, 6, 7 | co agent nesmí měnit, styl, jak se ověřuje |
| `09-architektura-hry.md` | 3, 4 | architektura hry — **PATŘÍ HŘE, nová hra si ji přepíše** |

**Poznámka k číslům §:** zůstala z původního dokumentu záměrně — odkazuje se na
ně workflow (TIPy k parse chybám) i starší zadání granulí. Nový text je čísluje
jen kvůli dohledatelnosti; **autorita je soubor v `CONVENTIONS/`**.

**Co v sekcích NENÍ:** pravidla, která se týkají jen jedné hry (její soubory,
její API, její počet testů). Ta patří do granule (do zadání) nebo do sekce
`09-architektura-hry`, kterou si hra přepíše.
