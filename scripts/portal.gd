extends Area2D

var cil: String = "exit"

func _ready() -> void:
    add_to_group("portal")
    monitoring = true

    var collision_shape: CollisionShape2D = CollisionShape2D.new()
    var circle_shape: CircleShape2D = CircleShape2D.new()
    circle_shape.radius = 8.0
    collision_shape.shape = circle_shape
    add_child(collision_shape)

    body_entered.connect(_on_body_entered)

func nastav_cil(jmeno: String) -> void:
    cil = jmeno

func znacka() -> String:
    return cil

func prenes(hrac: Node) -> bool:
    var level: Node = get_tree().get_first_node_in_group("level")
    if level == null:
        return false

    var pozice: Array = level.marker_positions(cil)
    if pozice.is_empty():
        return false

    hrac.position = pozice[0]
    return true

func _on_body_entered(body: Node) -> void:
    if body.is_in_group("player"):
        prenes(body)
