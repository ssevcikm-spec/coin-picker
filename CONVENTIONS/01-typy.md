> **Sekce konvencí `01-typy`** (§1). Agent dostane jen ty sekce, které jeho
> granule deklaruje v roadmapě (`"konvence": ["01-typy"]`) — celý dokument se
> neposílá, protože se nevejde do stropu poskytovatele.

## 1. GDScript: typy piš výslovně, `:=` jen když je typ známý

Nejčastější chyba free modelů: `var cil := uzel.position + uzel.smer * 40 * delta`.
Uzel z `get_nodes_in_group()` **nemá typ**, takže Godot ohlásí
`Cannot infer the type of "cil" variable because the value doesn't have a set type`,
skript hry se vůbec nenačte a **celá hra přestane existovat** (testy pak hlásí
„skript hry jde načíst" jako FAIL).

```gdscript
# ŠPATNĚ – spadne na parsování
for uzel in get_tree().get_nodes_in_group("enemy"):
    var cil := uzel.position + uzel.smer * 40.0 * delta

# SPRÁVNĚ – výslovný typ, uzel zůstává bez typu
for uzel in get_tree().get_nodes_in_group("enemy"):
    var cil: Vector2 = uzel.position + uzel.smer * 40.0 * delta
    uzel.position = cil
```

Platí to i pro `get_tree().get_first_node_in_group(...)`, `get_node_or_null(...)`
a cokoli dalšího, co vrací `Node`/`Variant` bez konkrétního typu.
