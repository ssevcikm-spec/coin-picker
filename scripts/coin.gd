extends Area2D

# Property declaration
var hodnota: int = 1
var _sebrano: bool = false

func _init() -> void:
    pass

func _ready() -> void:
    # Add to the "coin" group
    add_to_group("coin")
    # Enable monitoring for body entered signals
    monitoring = true
    # Connect the body_entered signal using Godot 4 syntax
    body_entered.connect(_on_body_entered)
    # Create a CollisionShape2D with a CircleShape2D of radius 6
    var collision_shape := CollisionShape2D.new()
    var circle := CircleShape2D.new()
    circle.radius = 6
    collision_shape.shape = circle
    add_child(collision_shape)

func hodnota_body() -> int:
    return hodnota

func seber(hrac: Node) -> bool:
    if _sebrano:
        return false
    if hrac.has_method("pridej_skore"):
        hrac.pridej_skore(hodnota)
    _sebrano = true
    queue_free()
    return true

func _on_body_entered(body: Node) -> void:
    if body.is_in_group("player"):
        seber(body)
