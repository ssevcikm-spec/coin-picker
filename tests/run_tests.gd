extends SceneTree
## Testy Coin-Pickeru — spouští se bez okna i bez grafické karty:
##
##     godot --headless --path <projekt> --script res://tests/run_tests.gd
##
## Když všechny kontroly projdou, skončí s kódem 0. Každé selhání kód zvýší,
## takže se výsledek dá použít v CI i v ručním ověření.
##
## FORMÁT ŘÁDKŮ JE SMLOUVA (čte ho CI i brána g3):
##     [test] OK   <popis>            · [test] FAIL <popis>
##     [test] N kontrol, M selhání    ← souhrn, podle něj se pozná výsledek
##
## POZOR – HLÍDAČ: testy musí skončit VŽDY. Když se nepodaří načíst skript hry
## (typická chyba od agenta), GDScript přeruší běh _run() a na quit() se nikdy
## nedostane — proces pak visí, dokud ho nezabije CI (naměřeno: 14 minut místo
## okamžitého selhání).
##
## KONTROLY SE ZAPÍNAJÍ SAMY: co v projektu ještě není (mince, nepřítel,
## rozmisťovač), se netestuje — ale jakmile soubor granule existuje, jeho
## kontroly se rozsvítí. Proto počet kontrol s každou granulí roste.

const HARD_LIMIT_SECONDS := 90.0

var failures := 0
var checks := 0
var _deadline := 0.0
var _done := false


func _initialize() -> void:
	_deadline = Time.get_ticks_msec() / 1000.0 + HARD_LIMIT_SECONDS
	_run()


func _process(_delta: float) -> bool:
	"""Hlídač: kdyby se _run() zasekl nebo přerušil, stejně se skončí."""
	if _done:
		return true
	if Time.get_ticks_msec() / 1000.0 > _deadline:
		print("[test] FAIL překročen tvrdý limit %.0f s – testy se zasekly."
			% HARD_LIMIT_SECONDS)
		print("[test]      Nejpravděpodobnější příčina: skript hry se nepodařilo "
			+ "načíst (chyba v kódu), takže se _run() přerušil.")
		failures += 1
		_finish()
	return false


func _check(ok: bool, label: String) -> void:
	checks += 1
	if ok:
		print("[test] OK   ", label)
	else:
		failures += 1
		print("[test] FAIL ", label)


func _cti_json(cesta: String) -> Variant:
	"""Načte JSON z res:// (konvence §1c: FileAccess + JSON, ne File/json)."""
	if not FileAccess.file_exists(cesta):
		return null
	var text := FileAccess.get_file_as_string(cesta)
	if text.is_empty():
		return null
	return JSON.parse_string(text)


func _nova(cesta: String) -> Node:
	"""Soubor granule se bere přes `load(...).new()` (konvence §1g).

	Vrací null, když soubor není nebo nejde načíst — volající to musí ohlásit
	jako vadu, ne přeskočit (jinak by test mlčel nad chybějícím souborem).
	"""
	if not ResourceLoader.exists(cesta):
		return null
	var skript: GDScript = load(cesta)
	if skript == null:
		return null
	var uzel: Variant = skript.new()
	if uzel is Node:
		return uzel
	return null


func _run() -> void:
	await process_frame

	# ── soubory, které musí být (jádro hry) ─────────────────────────────────
	_check(FileAccess.file_exists("res://main.tscn"), "main.tscn existuje")
	_check(FileAccess.file_exists("res://scripts/game.gd"), "skript hry existuje")
	_check(FileAccess.file_exists("res://assets/spec.json"), "spec vzhledu existuje")

	var mapa_data: Variant = _cti_json("res://assets/levels/main.json")
	_check(typeof(mapa_data) == TYPE_DICTIONARY, "mapa úrovně jde načíst jako objekt")
	if typeof(mapa_data) != TYPE_DICTIONARY:
		_finish()
		return
	_check(int(mapa_data.get("cell", 0)) == 32, "mapa má buňku 32 px (shoda se spec.json)")
	_check(String(mapa_data.get("grid", [""])[0]).length() == int(mapa_data.get("width", 0)),
		"řádky mřížky odpovídají deklarované šířce")

	# ── scéna se musí načíst a postavit ─────────────────────────────────────
	var packed: PackedScene = load("res://main.tscn")
	_check(packed != null, "main.tscn jde načíst")
	if packed == null:
		_finish()
		return
	var main: Node = packed.instantiate()
	root.add_child(main)
	await process_frame
	await process_frame

	# Když se skript hry vůbec nenačetl (parse error), nemá cenu pokračovat:
	# volání na null by přerušilo tenhle běh a testy by nikdy neskončily.
	_check(main.get_script() != null, "skript hry jde načíst (žádná chyba v kódu)")
	if main.get_script() == null:
		_finish()
		return

	var mapa: Node = main.get_node_or_null("Level")
	_check(mapa != null, "scéna vytvořila uzel Level")
	var hrac: Node = main.get_node_or_null("Player")
	_check(hrac != null, "scéna vytvořila uzel Player")
	var lista: Node = main.get_node_or_null("Hud")
	_check(lista != null, "scéna vytvořila uzel Hud")
	_check(hrac != null and hrac.is_in_group("player"), "hráč je ve skupině player")
	_check(mapa != null and mapa.is_in_group("level"), "mapa je ve skupině level")
	if lista != null:
		_check(String(lista.get("text")).contains("0"),
			"HUD ukazuje počáteční skóre: '%s'" % str(lista.get("text")))

	# ── mapa: smlouva pro ostatní komponenty ────────────────────────────────
	if mapa != null:
		_check(mapa.has_method("is_walkable_cell"), "mapa umí is_walkable_cell()")
		_check(mapa.has_method("is_walkable_at"), "mapa umí is_walkable_at()")
		_check(mapa.has_method("cell_center"), "mapa umí cell_center()")
		_check(mapa.has_method("marker_positions"), "mapa umí marker_positions()")
		var stred: Vector2 = mapa.cell_center(1, 1)
		_check(int(stred.x) == 48 and int(stred.y) == 48,
			"cell_center(1,1) je střed buňky: %s" % str(stred))
		_check(mapa.is_walkable_cell(0, 0) == false, "okraj mapy je zeď")
		var spawny: Array = mapa.marker_positions("spawn")
		_check(spawny.size() >= 1, "mapa má značku spawn")
		var pruchozi: Array = mapa.walkable_cells()
		_check(pruchozi.size() >= 20,
			"mapa má aspoň 20 průchozích políček (%d)" % pruchozi.size())

	# ── hráč: smlouva (pohyb a skóre) ───────────────────────────────────────
	if hrac != null:
		_check(hrac.has_method("move"), "hráč umí move()")
		_check(hrac.has_method("pridej_skore"), "hráč umí pridej_skore()")
		_check(hrac.has_signal("sebrano"), "hráč má signál sebrano")
		var pred: Vector2 = hrac.position
		hrac.move(Vector2(1, 0))
		await process_frame
		_check(hrac.position.x > pred.x,
			"pohyb vpravo posune hráče (%.1f -> %.1f)" % [pred.x, hrac.position.x])
		# Skóre teče signálem: hráč → game.gd → HUD.
		hrac.pridej_skore(1)
		await process_frame
		_check(int(main.get("skore")) == 1,
			"sebrání zvýší skóre hry (skore=%s)" % str(main.get("skore")))
		if lista != null:
			_check(String(lista.get("text")).contains("1"),
				"HUD přepsal skóre: '%s'" % str(lista.get("text")))

	# ── komponenty, které v projektu JSOU (jinak se netestují) ──────────────
	# Mince: soubor zakládá granule `world.coin`.
	if FileAccess.file_exists("res://scripts/coin.gd"):
		var mince: Node = _nova("res://scripts/coin.gd")
		_check(mince != null, "coin.gd jde vytvořit přes load(...).new()")
		if mince != null:
			_check(mince.has_method("hodnota_body"), "mince umí hodnota_body()")
			_check(mince.has_method("seber"), "mince umí seber()")
			root.add_child(mince)
			await process_frame
			_check(mince.is_in_group("coin"), "mince je ve skupině coin")
			var zisk: int = mince.hodnota_body()
			_check(zisk >= 1, "mince dává aspoň 1 bod (dává %d)" % zisk)
			mince.queue_free()
			await process_frame

	# Rozmisťovač: soubor zakládá granule `world.spawner`.
	if FileAccess.file_exists("res://scripts/spawner.gd"):
		var roz: Node = _nova("res://scripts/spawner.gd")
		_check(roz != null, "spawner.gd jde vytvořit přes load(...).new()")
		if roz != null:
			_check(roz.has_method("rozmistni"), "rozmisťovač umí rozmistni()")
			root.add_child(roz)
			await process_frame
			var rozm: Array = roz.rozmistni(3)
			await process_frame
			_check(rozm.size() == 3, "rozmistni(3) vrátí 3 pozice (vrátil %d)" % rozm.size())
			_check(roz.get_child_count() == 3,
				"rozmístěné mince jsou v scéně (%d)" % roz.get_child_count())

	# Nepřítel: soubor zakládá granule `entity.enemy`.
	if FileAccess.file_exists("res://scripts/enemy.gd"):
		var nepritel: Node = _nova("res://scripts/enemy.gd")
		_check(nepritel != null, "enemy.gd jde vytvořit přes load(...).new()")
		if nepritel != null:
			_check(nepritel.has_method("poskod"), "nepřítel umí poskod()")
			root.add_child(nepritel)
			await process_frame
			_check(nepritel.is_in_group("enemy"), "nepřítel je ve skupině enemy")
			var zivy: bool = nepritel.poskod(1)
			_check(zivy == true, "nepřítel po prvním zásahu žije")
			root.remove_child(nepritel)
			nepritel.free()

	_finish()


func _finish() -> void:
	_done = true
	print("\n[test] %d kontrol, %d selhání" % [checks, failures])
	quit(failures)
