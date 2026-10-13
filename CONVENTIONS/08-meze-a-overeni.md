> **Sekce konvencí `08-meze-a-overeni`** (§5, §6, §7). Agent dostane jen ty
> sekce, které jeho granule deklaruje v roadmapě.

## 5. Co agent nesmí měnit

`tests/`, `.github/`, `.forge/`, `project.godot` – to jsou pravidla hry
a automatického sloučení. Když agent sáhne na testy, ztratí tím páku, která
hlídá jeho vlastní práci. Automatické sloučení navíc pustí jen změny
v `scripts/` a `assets/` do 60 řádků. Výjimka: granule s deklarovaným
`size_lines > 60` (`model: strong`) smí být větší — limit se bere z granule
(vstup `max_lines`), a když orchestr nic nepředá, PR z takové granule čeká
na ruční sloučení (záměr, ne chyba).

## 6. Styl

- Komentáře a texty v UI **česky** (HUD, hlášky), kód anglicky podle okolí.
- Změna musí být **aditivní**: nic nemaž a nepřejmenovávej, co funguje.
- Když si nejsi jistý, udělej méně – malý správný krok je lepší než velký
  rozbitý.

## 7. Ověření

Testy běží v CI na každý PR (`Godot --headless`). Počet kontrol roste
s každou granulí (kontroly na komponenty se zapínají samy, až soubor granule
v projektu je) – **skutečný počet si přečti z výstupu běhu**, nikdy ho
nepřebírej z dokumentace ani z téhle konvence. Když něco nevyjde, je to vidět
v logu jako `[test] FAIL …` – čti ten řádek, ne celý log.
