extends Node2D
## Mapa úrovně: mřížka znaků, průchodnost, značky a VYKRESLENÍ dlaždic.
##
## SMLOUVA (volá ji hráč, rozmisťovač i testy):
##   nacti_mrizku(radky: Array) -> bool      · is_walkable_cell(cx, cy) -> bool
##   is_walkable_at(pozice: Vector2) -> bool · cell_center(cx, cy) -> Vector2
##   marker_positions(druh: String) -> Array
##   spawn_cell: Vector2i · width: int · height: int · cell: int
##
## `_init()` není definován — `new()` se volá bez parametrů (konvence §1g).
## `extends Node2D` (ne `Node`) proto, že mapa se KRESLÍ: kontrola
## `.forge/verify-level-render.py` srovnává snímek hry s mapou po jednotlivých
## buňkách a bez vykreslení hlásí 0/120 políček (naměřeno 12. 10. 2026).

const CELL := 32
## Dlaždice 32x32. Stejné číslo je v `assets/spec.json` (tile.sirka) i v mapě
## (`cell`); brána `.forge/check-schema.py` ta tři čísla porovnává, protože
## když se rozejdou, hra potichu kreslí jiné měřítko, než je schválené.

const ZED := "#"
const PODLAHA := "."
const ZNACKY := { "spawn": "S", "exit": "E", "coin": "o" }
const TILES_DIR := "res://assets/tiles/"
const DLAZDICE_VYCHOZI := { "#": "stone", ".": "floor" }
## Které dlaždici patří které pole mřížky. Bere se z mapy (`tiles`), aby se
## jméno dlaždice neopisovalo na dvou místech — a když v datech chybí, platí
## tenhle výchozí slovník.

var mrizka: Array = []
var width: int = 0
var height: int = 0
var cell: int = CELL
var spawn_cell: Vector2i = Vector2i(1, 1)
var _znacky: Dictionary = {}
var _nazvy_dlazdic: Dictionary = DLAZDICE_VYCHOZI.duplicate()
var _textury: Dictionary = {}


func _ready() -> void:
	add_to_group("level")
	_nacti_textury()
	if mrizka.is_empty():
		nacti_mrizku(vychozi_mrizka())
	queue_redraw()


func _nacti_textury() -> void:
	## Načte obrázky dlaždic podle jmen v datech. Chybějící dlaždici NENÍ vada
	## (kreslí se náhradní barvou) — ale musí to být vidět, proto `_draw()`.
	_textury = {}
	for nazev in _nazvy_dlazdic.values():
		var cesta := TILES_DIR + String(nazev) + ".png"
		if ResourceLoader.exists(cesta):
			_textury[nazev] = load(cesta)


func nazev_dlazdice(cx: int, cy: int) -> String:
	if cx < 0 or cy < 0 or cx >= width or cy >= height:
		return ""
	return String(_nazvy_dlazdic.get(mrizka[cy].substr(cx, 1), ""))


func _draw() -> void:
	## Vykreslí mřížku dlaždicemi, které odpovídají jménům v mapě.
	for y in range(height):
		for x in range(width):
			var nazev := nazev_dlazdice(x, y)
			var cil := Rect2(Vector2(float(x * cell), float(y * cell)),
				Vector2(float(cell), float(cell)))
			var textura: Texture2D = _textury.get(nazev)
			if textura != null:
				draw_texture_rect(textura, cil, false)
			elif nazev == "stone":
				draw_rect(cil, Color(0.27, 0.29, 0.33))
			else:
				draw_rect(cil, Color(0.49, 0.45, 0.38))


func vychozi_mrizka() -> Array:
	## Záložní mřížka pro případ, že hra neprojde načtením mapy z dat.
	## Není to „výplň": hra musí zůstat hratelná, i když data chybí (aditivní
	## migrace — konvence §3).
	var radky: Array = []
	for y in range(8):
		var radek := ""
		for x in range(15):
			radek += znak_na(x, y)
		radky.append(radek)
	return radky


func znak_na(x: int, y: int) -> String:
	if x == 0 or y == 0 or x == 14 or y == 7:
		return ZED
	if x == 2 and y == 2:
		return ZNACKY["spawn"]
	if x == 12 and y == 6:
		return ZNACKY["exit"]
	if (x + y) % 4 == 0:
		return ZNACKY["coin"]
	return PODLAHA


func nacti_mrizku(radky: Array) -> bool:
	## Načte mřížku z pole řádků. Vrací false (a pojmenuje důvod), když data
	## nedávají smysl — tichý návrat by schoval rozbitou mapu.
	if radky.is_empty():
		push_error("mřížka je prázdná")
		return false
	var sirka: int = String(radky[0]).length()
	if sirka == 0:
		push_error("první řádek mřížky je prázdný")
		return false
	for radek in radky:
		if String(radek).length() != sirka:
			push_error("řádky mřížky nemají stejnou délku")
			return false
	mrizka = []
	_znacky = {}
	for y in range(radky.size()):
		var radek := String(radky[y])
		mrizka.append(radek)
		for x in range(radek.length()):
			var znak := radek.substr(x, 1)
			for druh in ZNACKY.keys():
				if String(ZNACKY[druh]) == znak:
					if not _znacky.has(druh):
						_znacky[druh] = []
					_znacky[druh].append(Vector2i(x, y))
					if String(druh) == "spawn":
						spawn_cell = Vector2i(x, y)
	width = sirka
	height = radky.size()
	return true


func is_walkable_cell(cx: int, cy: int) -> bool:
	if cx < 0 or cy < 0 or cx >= width or cy >= height:
		return false
	return mrizka[cy].substr(cx, 1) != ZED


func is_walkable_at(pozice: Vector2) -> bool:
	return is_walkable_cell(int(floor(pozice.x / float(cell))),
		int(floor(pozice.y / float(cell))))


func cell_center(cx: int, cy: int) -> Vector2:
	return Vector2((float(cx) + 0.5) * float(cell), (float(cy) + 0.5) * float(cell))


func marker_positions(druh: String) -> Array:
	var pozice: Array = []
	for bunka in _znacky.get(druh, []):
		pozice.append(cell_center(bunka.x, bunka.y))
	return pozice


func walkable_cells() -> Array:
	## Všechna průchozí políčka (rozmisťovač z nich vybírá deterministicky).
	var out: Array = []
	for y in range(height):
		for x in range(width):
			if is_walkable_cell(x, y):
				out.append(Vector2i(x, y))
	return out


func nacti_z_dat(data: Variant) -> bool:
	## Načte mapu z objektu JSON. Buňku bere z `data["cell"]`, ale když tam
	## není, použije VÝCHOZÍ konstantu — a to je přesně to místo, které hlídá
	## check-schema (`get("cell", N)`), aby se hra nepřekreslila na jiné měřítko.
	if typeof(data) != TYPE_DICTIONARY:
		push_error("mapa není objekt")
		return false
	cell = int(data.get("cell", 32))
	if data.has("tiles") and typeof(data["tiles"]) == TYPE_DICTIONARY:
		_nazvy_dlazdic = data["tiles"].duplicate()
		_nacti_textury()
	var radky: Array = data.get("grid", [])
	if not nacti_mrizku(radky):
		return false
	for znacka in data.get("markers", []):
		if typeof(znacka) != TYPE_DICTIONARY:
			continue
		var druh := String(znacka.get("type", ""))
		var bunka: Array = znacka.get("cell", [])
		if druh.is_empty() or bunka.size() < 2:
			continue
		if not _znacky.has(druh):
			_znacky[druh] = []
		_znacky[druh].append(Vector2i(int(bunka[0]), int(bunka[1])))
		if druh == "spawn":
			spawn_cell = Vector2i(int(bunka[0]), int(bunka[1]))
	return true
