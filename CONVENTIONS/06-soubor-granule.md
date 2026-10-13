> **Sekce konvencí `06-soubor-granule`** (§1g). Agent dostane jen ty sekce, které
> jeho granule deklaruje v roadmapě.

## 1g. Soubor granule se instancuje přes `load(...).new()` – musí to být `extends Node`

Testy berou každý soubor granule takhle:

```gdscript
var sc = load("res://scripts/item.gd")   # musí jít načíst
var obj = sc.new()                       # musí jít zavolat BEZ argumentů
obj.use()                                # smluvní metody musí existovat na té instanci
```

Z toho plynou tři pravidla, která Godot sám nezkontroluje (parse projde, testy
pak spadnou na „překročen tvrdý limit 90 s" a příčina není vidět):

1. **Soubor začíná `extends Node`.** Když je to `Resource` nebo `RefCounted`,
   `new()` sice projde, ale instance není uzel – a uvolnění v testech (`free()`)
   na RefCounted vyhodí chybu, která **přeruší celý běh testů**.
2. **`class_name` NIKDY nesmí být i jméno vnořené `class` ve stejném souboru.**

   ```gdscript
   # ŠPATNĚ – vnořená třída přebije globální jméno; new() vrátí ji,
   # ta nemá use/repair/broken a není to Node
   class_name GameItem

   class GameItem extends Resource:
       func use() -> void: …

   # SPRÁVNĚ – soubor SÁM JE ta třída
   extends Node
   class_name GameItem

   func use() -> void: …
   ```

   Naměřeno 30. 9. 2026 na granulí `entity.item` (běh #122): model napsal přesně
   první tvar, brána na parsování vrátila exit 0 **a přesto to bylo špatně**.
   Orchestr teď tenhle tvar odchytí staticky, ale psát se to nemá vůbec.
3. **`_init()` nesmí mít povinný argument.** `new()` se volá bez parametrů;
   data načítej v `_ready()` nebo vlastní metodou `nacti(cesta)`.
