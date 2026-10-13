extends Node2D

var rychlost: float = 60.0
var body: Array = []
var index: int = 0

func nastav_body(seznam: Array) -> void:
    body = []
    for bod in seznam:
        if bod is Vector2:
            body.append(bod)
    index = 0

func pocet_bodu() -> int:
    return body.size()

func dalsi_bod() -> Vector2:
    if body.is_empty():
        return Vector2.ZERO
    return body[index]

func tik(delta: float) -> void:
    if body.is_empty():
        return

    var cil: Vector2 = dalsi_bod()
    var smer: Vector2 = (cil - position).normalized()
    var krok: float = rychlost * delta
    var vzdalenost: float = position.distance_to(cil)

    if krok >= vzdalenost:
        position = cil
        index = (index + 1) % body.size()
    else:
        position += smer * krok
