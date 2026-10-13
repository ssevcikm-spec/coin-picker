extends Area2D

var poskozeni: int = 1
var obnovit_sekundy: float = 2.0
var cekani: float = 0.0

func _init() -> void:
    pass

func _ready() -> void:
    add_to_group("trap")
    monitoring = true

    var tvar: CollisionShape2D = CollisionShape2D.new()
    var shape: CircleShape2D = CircleShape2D.new()
    shape.radius = 8
    tvar.shape = shape
    add_child(tvar)

    # Connect signal using Godot 4 syntax
    body_entered.connect(_on_body_entered)

func poskod(cel: Node) -> bool:
    if cekani > 0.0:
        return false
    if not ("hp" in cel):
        return false

    cel.hp = max(cel.hp - poskozeni, 0)
    cekani = obnovit_sekundy
    return true

func tik(delta: float) -> void:
    cekani = max(cekani - delta, 0.0)

func obnovit() -> void:
    cekani = 0.0

func _on_body_entered(body: Node) -> void:
    if body.is_in_group("player"):
        poskod(body)
