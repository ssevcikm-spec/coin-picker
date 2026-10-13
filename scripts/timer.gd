extends Node

signal vyprsel

var zbyva_sekund: float = 0.0
var _vyprsel: bool = false

func _init() -> void:
    pass

func nastav(sekundy: int) -> void:
    if sekundy < 1:
        sekundy = 1
    zbyva_sekund = float(sekundy)
    _vyprsel = false

func tik(delta: float) -> void:
    if zbyva_sekund <= 0.0:
        return
    zbyva_sekund = max(zbyva_sekund - delta, 0.0)
    if zbyva_sekund == 0.0 and not _vyprsel:
        _vyprsel = true
        emit_signal("vyprsel")

func zbyva() -> int:
    return int(ceil(zbyva_sekund))

func bezi() -> bool:
    return zbyva_sekund > 0.0
