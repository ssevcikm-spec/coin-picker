extends Node

# Number of coins created by the last call to `rozmistni`
var _pocet_minci: int = 0

func _init() -> void:
    pass

# Rozmístí `pocet` mincí na průchozí políčka úrovně.
# Vrací pole pozic (Vector2) vytvořených mincí.
func rozmistni(pocet: int) -> Array:
    var pozice_minci: Array = []
    if pocet < 1:
        return pozice_minci

    var level_node: Node = get_tree().get_first_node_in_group("level")
    if level_node == null:
        return pozice_minci

    var walkable: Array = level_node.walkable_cells()
    if walkable.is_empty():
        return pozice_minci

    # Vybereme průchozí buňky rovnoměrně – každé k‑té.
    var krok: int = max(1, int(walkable.size() / pocet))
    var idx: int = 0
    while pozice_minci.size() < pocet and idx < walkable.size():
        var bunka: Vector2 = walkable[idx]
        var cx: int = int(bunka.x)
        var cy: int = int(bunka.y)
        var stred: Vector2 = level_node.cell_center(cx, cy)

        var mince: Area2D = Area2D.new()
        mince.set_script(load("res://scripts/coin.gd"))
        mince.position = stred
        add_child(mince)

        pozice_minci.append(stred)
        idx += krok

    _pocet_minci = pozice_minci.size()
    return pozice_minci

# Vrací počet mincí, které rozmistni vytvořil.
func pocet_minci() -> int:
    var level_node: Node = get_tree().get_first_node_in_group("level")
    if level_node == null:
        return 0
    return _pocet_minci
