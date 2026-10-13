extends Area2D

# Enemy properties
var hp: int = 2
var max_hp: int = 2
var rychlost: float = 40.0

# Collision shape holder
var kolize: CollisionShape2D = CollisionShape2D.new()

func _init() -> void:
    pass

func _ready() -> void:
    # Add to enemy group
    add_to_group("enemy")
    # Enable monitoring for body entered signals
    monitoring = true
    # Set up collision shape (CircleShape2D, radius 8)
    var shape: CircleShape2D = CircleShape2D.new()
    shape.radius = 8
    kolize.shape = shape
    add_child(kolize)
    # Connect body entered signal (Godot 4 syntax)
    body_entered.connect(_on_body_entered)

func poskod(body: int) -> bool:
    # Decrease hp, never below zero
    hp = max(hp - body, 0)
    if hp <= 0:
        queue_free()
        return false
    return true

func je_zivy() -> bool:
    return hp > 0

func _on_body_entered(body) -> void:
    if body.is_in_group("player"):
        # Damage the player by 1 hp
        body.hp = body.hp - 1

func _physics_process(delta: float) -> void:
    # Move horizontally according to rychlost
    global_position.x += rychlost * delta
    # Check walkability via the level node
    var level_nodes = get_tree().get_nodes_in_group("level")
    if level_nodes.size() > 0:
        var level = level_nodes[0]
        if not level.is_walkable_at(global_position):
            # Reverse direction if movement is blocked
            rychlost = -rychlost
