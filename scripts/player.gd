extends Area2D
## Hráč: pohyb po mapě, skóre a signál `sebrano`.
##
## SMLOUVA (volá ji scéna, mince i testy):
##   move(smer: Vector2) -> void      · pridej_skore(body: int) -> void
##   skore: int · hp: int · max_hp: int · rychlost: float
##   signal sebrano(body: int)
##
## Soubor je `extends Area2D` (ne `Node`), protože hráč se pohybuje po scéně
## a sbírá věci přes kolizi. `_init()` není definován — `new()` se volá bez
## parametrů (konvence §1g) a vlastnosti se nastavují až v `_ready()`.

signal sebrano(body: int)

const KROK_MOVE := 8.0
## Kolik pixelů ujde `move()` na jedno zavolání. Záměrně MALÝ krok (čtvrtina
## dlaždice): testy volají `move(Vector2(1, 0))` z klidové buňky a čekají posun
## — kdyby krok byl celá obrazovka, hráč by skončil ve zdi a neposunul se.
## Klávesy chodí přes `_physics_process`, kde se násobí `delta`.

var skore: int = 0
var hp: int = 3
var max_hp: int = 3
var rychlost: float = 120.0


func _ready() -> void:
	add_to_group("player")
	_priprav_kolizi()
	_priprav_vzhled()


func _priprav_vzhled() -> void:
	## Hráč musí být VIDĚT — kdyby na scéně nebyl, testy, běh i brány projdou,
	## ale člověk (a vizuální kontrola) uvidí prázdno. Naměřeno 12. 10. 2026:
	## `verify-level-render.py` hlásil „Terén sedí 0/120“, protože hra
	## nevykreslovala nic.
	if get_node_or_null("Vzhled") != null:
		return
	var cesta := "res://assets/sprites/player.png"
	if not ResourceLoader.exists(cesta):
		return
	var obraz := Sprite2D.new()
	obraz.name = "Vzhled"
	obraz.texture = load(cesta)
	add_child(obraz)


func _priprav_kolizi() -> void:
	## Kolizní tvar se staví v KÓDU (žádné ukládané .tscn, konvence §3).
	## Bez něj by `body_entered` u mince nikdy nedorazil a sbírání by tiše
	## nefungovalo — přitom by se zdálo, že „hra běží".
	if get_node_or_null("Tvar") != null:
		return
	var tvar := CollisionShape2D.new()
	tvar.name = "Tvar"
	var kruh := CircleShape2D.new()
	kruh.radius = 8.0
	tvar.shape = kruh
	add_child(tvar)


func pridej_skore(body: int) -> void:
	## Přičte body a vyšle signál — scéna ho poslouchá a přepíše HUD.
	## Signál se vyšle VŽDY (i za nula), aby se HUD aktualizoval i po neúspěchu.
	skore += body
	sebrano.emit(body)


func move(smer: Vector2) -> void:
	## Posun o zadaný vektor. Kudy se dá chodit, se PTEJ uzlu ve skupině
	## `level` — žádné vlastní meze ani konstanty (mapa je zdroj pravdy).
	if smer.length() < 0.001:
		return
	_posun_krok(smer.normalized() * KROK_MOVE)


func _physics_process(delta: float) -> void:
	var smer := Vector2.ZERO
	if Input.is_action_pressed("ui_right") or Input.is_key_pressed(KEY_D):
		smer.x += 1.0
	if Input.is_action_pressed("ui_left") or Input.is_key_pressed(KEY_A):
		smer.x -= 1.0
	if Input.is_action_pressed("ui_down") or Input.is_key_pressed(KEY_S):
		smer.y += 1.0
	if Input.is_action_pressed("ui_up") or Input.is_key_pressed(KEY_W):
		smer.y -= 1.0
	if smer != Vector2.ZERO:
		_posun_krok(smer.normalized() * rychlost * delta)


func _posun_krok(rozdil: Vector2) -> void:
	## Společná cesta pro klávesy i `move()`. Bere ROZDÍL (ne cíl) a zahodí ho,
	## když by cíl nebyl průchozí — hráč se tedy nikdy nepropadne do zdi.
	if rozdil.length() < 0.001:
		return
	var cil: Vector2 = position + rozdil
	var mapa: Node = get_tree().get_first_node_in_group("level")
	if mapa != null and mapa.has_method("is_walkable_at"):
		if not bool(mapa.is_walkable_at(cil)):
			return
	position = cil
