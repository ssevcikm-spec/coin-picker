> **Sekce konvencí `07-uzel-a-kostra`** (§1b, §1e, §2). Agent dostane jen ty
> sekce, které jeho granule deklaruje v roadmapě.

## 1b. Do uzlu vytvořeného `Area2D.new()` nejde přidat vlastní vlastnost

```gdscript
# ŠPATNĚ – runtime chyba a nepřítel se vůbec nepřidá do scény
var e := Area2D.new()
e.smer = Vector2(1, 0)      # Invalid assignment of property or key 'smer' …

# SPRÁVNĚ – vlastnost deklaruje vlastní skript (scripts/enemy.gd)
var e := Area2D.new()
e.set_script(load("res://scripts/enemy.gd"))
e.smer = Vector2(1, 0)
```

Chyba uvnitř `_make_*` funkce **přeruší celou funkci**, takže se uzel nevrátí
a ve hře prostě chybí. Testy to poznají jen díky kontrole „hra vytvořila
nepřátele" – kdyby v projektu chyběla, vypadá to jako úspěch.

Alternativa bez nového souboru je `e.set_meta("smer", …)` / `e.get_meta("smer")`,
ale vlastní skript je čitelnější.

## 1e. Než začneš psát, zkontroluj, že soubor není jen kostra

Když granule říká „vytvoř `scripts/x.gd`", **nejdřív zjisti, jestli už
existuje** a co v něm je. Přepisovat existující funkční soubor je zakázané
(viz sekce `08-meze-a-overeni`) – a slepé `class_name` do souboru, který ho už má,
je okamžitá chyba.

## 2. Když se skript hry nenačte, poznáš to hned

Testy to řeknou („skript hry jde načíst"), ale **spustit si je musí CI** – ty
sám Godot nemáš. Proto: změnu dělej malou, v jednom souboru, a nikdy
nepřepisuj celý soubor, když měníš pár řádků.
