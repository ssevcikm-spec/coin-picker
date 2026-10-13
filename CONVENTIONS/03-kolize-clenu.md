> **Sekce konvencí `03-kolize-clenu`** (§1f). Agent dostane jen ty sekce, které
> jeho granule deklaruje v roadmapě.

## 1f. `get()`, `set()`, `name` — kolize s vestavěnými členy uzlu

I když je název „hezký", může kolidovat s tím, co má každý uzel od enginu.
Naměřeno 30. 9. 2026 (po nasazení §1c/§1d tyhle chyby zbyly jako poslední):

```gdscript
# ŠPATNĚ – Parse Error: The method "get()" overrides a method from native
# class "Object".  (a „function signature doesn't match the parent")
func get(attr: String) -> int:
    return atributy[attr]

# ŠPATNĚ – Parse Error: Member "name" redefined (original in native class 'Node')
var name := ""

# SPRÁVNĚ – vlastní, konkrétní názvy
func hodnota(attr: String) -> int:
    return atributy[attr]

var nazev := ""
var jmeno := ""
```

**Nikdy nepoužívej jako název funkce:** `get`, `set`, `free`, `queue_free`,
`connect`, `emit`, `call`, `has`, `is_class`, `duplicate`, `print`.
**Nikdy nepoužívej jako název proměnné:** `name`, `owner`, `position`, `scale`,
`rotation`, `visible`, `modulate`, `script`, `process_mode`, `children`, `size`.
**Nikdy nepoužívej jako `class_name`:** `Item`, `Node`, `Object`, `Resource`,
`Timer`, `Camera`, `Light`, `Shape`, `Curve`, `Animation`, `Environment`,
`Material`, `Texture`, `Image`, `Font`, `Label`, `Button`, `Panel`, `Window`,
`File`, `Directory`, `JSON`, `Input`, `Engine`, `OS`, `Time`.

Když potřebuješ metodu „na získání hodnoty", pojmenuj ji česky nebo konkrétně
(`hodnota`, `vypocitej`, `get_damage`) — nikdy holé `get`.
