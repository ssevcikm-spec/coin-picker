extends Node

func _init() -> void:
    pass

func uloz(cesta: String, skore: int) -> bool:
    var dosavadni: int = nejlepsi(cesta)
    if skore > dosavadni:
        var file: FileAccess = FileAccess.open(cesta, FileAccess.WRITE)
        if file == null:
            return false
        var data: Dictionary = {"skore": skore}
        file.store_string(JSON.stringify(data))
        file.close()
        return true
    return false

func nejlepsi(cesta: String) -> int:
    if cesta.is_empty():
        return 0
    var text: String = FileAccess.get_file_as_string(cesta)
    if text.is_empty():
        return 0
    var data: Variant = JSON.parse_string(text)
    if typeof(data) != TYPE_DICTIONARY or "skore" not in data:
        return 0
    var skore: int = data["skore"]
    if typeof(skore) != TYPE_INT:
        return 0
    return skore
