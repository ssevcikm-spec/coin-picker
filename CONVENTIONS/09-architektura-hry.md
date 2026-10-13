> **Sekce konvencí `09-architektura-hry`** (§3, §4).
>
> ⚠ **TAHLE SEKCE PATŘÍ HŘE, NE ŠABLONĚ.** Je to popis architektury hry
> `uo-shadows`, ze které šablona vznikla – konkrétní soubory (`scripts/game.gd`,
> `scripts/level.gd`) i API uzlu `Level`. **Nová hra si ji nahradí vlastní**
> (nebo smaže) a v granulích ji deklaruje, jen dokud její tvrzení platí.
> Dokud ji hra nemá přepsanou, je lepší ji nedeklarovat vůbec než ji poslat
> jako fakt o jiné hře.

## 3. Hra je postavená programově

Celá scéna se staví v `scripts/game.gd` (uzly se vytvářejí v kódu, žádné
ukládané `.tscn` kromě `main.tscn`). Když přidáváš uzel:

- dej mu `name` (testy a hledání podle skupin se o to opírají),
- přidej ho do skupiny (`coin`, `enemy`, `chest`, `player`), když se s ním má
  něco dít,
- nepřidávej nové soubory, když to jde udělat v `scripts/game.gd`.

## 4. Mapa (úroveň) – jak se ptát, kudy se dá chodit

Mapu spravuje uzel `Level` ve skupině `level` (`scripts/level.gd`):

| Metoda | Co vrací |
|---|---|
| `is_walkable_at(pozice: Vector2) -> bool` | je na té pozici průchozí políčko? |
| `is_walkable_cell(cx: int, cy: int) -> bool` | totéž pro políčko v mřížce |
| `cell_center(cx: int, cy: int) -> Vector2` | střed políčka ve světových souřadnicích |
| `marker_positions("coin"\|"spawn"\|"exit") -> Array` | pozice značek z mapy |
| `spawn_cell -> Vector2i`, `width`, `height`, `cell` | rozměry mřížky |

Nový předmět **nikdy neumisťuj na náhodnou pozici** – s mapou by mohl skončit ve
zdi. Použij `_safe_spot(vp)` (už v `game.gd` je) nebo `marker_positions()`.
