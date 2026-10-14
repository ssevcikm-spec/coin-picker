extends Area2D

var vypln: int = 1

func _init():
    pass

func _ready():
    add_to_group("heart")
    monitoring = true
    var collision_shape = CollisionShape2D.new()
    var circle_shape = CircleShape2D.new()
    circle_shape.radius = 6
    collision_shape.shape = circle_shape
    add_child(collision_shape)
    body_entered.connect(_on_body_entered)

func hodnota_leceni() -> int:
    return vypln

func seber(hrac: Node) -> bool:
    if not ("hp" in hrac) or vypln == 0:
        return false
    if "max_hp" in hrac:
        hrac.hp = min(hrac.hp + vypln, hrac.max_hp)
    else:
        hrac.hp += vypln
    vypln = 0
    queue_free()
    return true

func _on_body_entered(body: Node) -> void:
    if body.is_in_group("player"):
        seber(body)
