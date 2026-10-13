> **Sekce konvencí `02-reservovana-jmena`** (§1d). Agent dostane jen ty sekce,
> které jeho granule deklaruje v roadmapě.

## 1d. Rezervovaná a globální jména tříd

`class_name` vytváří **globální** jméno v celém projektu. Když se trefí do
jména, které už používá Godot, parsování skriptu selže:

```gdscript
# ŠPATNĚ – Parse Error: Class "Item" hides a global script class.
class_name Item

# SPRÁVNĚ – konkrétnější jméno
class_name GameItem
```

Naměřeno 30. 9. 2026: granule `entity.item` psala `class_name Item` a shodila
tím celý běh (testy pak hlásily jen „překročen tvrdý limit 90 s").

**Nepoužívej jako `class_name`:** `Item`, `Node`, `Object`, `Resource`, `Timer`,
`Camera`, `Light`, `Shape`, `Curve`, `Animation`, `Environment`, `Material`,
`Texture`, `Image`, `Font`, `Label`, `Button`, `Panel`, `Window`, `File`,
`Directory`, `JSON`, `Input`, `Engine`, `OS`, `Time`, `RandomNumberGenerator`.

Buď jméno projektu předřaď (`GameItem`, `UoItem`), nebo – ještě lépe – žádné
`class_name` nedávej a přistupuj k souboru přes `preload()`/`load()`.
