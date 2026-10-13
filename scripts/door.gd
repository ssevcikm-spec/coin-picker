extends Area2D

signal proslo

var odemcene: bool = false

func _init():
    pass

func _ready():
    add_to_group("door")
    monitoring = true
    var collision_shape = CollisionShape2D.new()
    var shape = RectangleShape2D.new()
    shape.size = Vector2(24, 24)
    collision_shape.shape = shape
    add_child(collision_shape)
    body_entered.connect(_on_body_entered)

func odemkni() -> void:
    odemcene = true

func je_odemcena() -> bool:
    return odemcene

func projit(hrac: Node) -> bool:
    if not odemcene:
        return false
    proslo.emit()
    return true

func _on_body_entered(body: Node) -> void:
    if body.is_in_group("player"):
        projit(body)
