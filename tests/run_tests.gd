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

	# ════════════════════════════════════════════════════════════════════════
	# K5 (13. 10. 2026): DRUHÁ VLNA GRANULÍ — jde o TUNING ORCHESTRY, ne o graf.
	# Každý blok se rozsvítí, až jeho soubor vznikne (stejný mechanismus jako
	# výš); dokud soubor není, počet kontrol se nemění a hra zůstává zelená.
	# Cíle vln: (a) větší zadání a víc konvencí naráz, (b) cesty orchestra,
	# které se ještě nikdy živě nespustily (auto-merge odmitnuty PR → awaiting_human,
	# rotace poskytovatele po neúspěchu, čtení závislostí do requestu).
	# ════════════════════════════════════════════════════════════════════════

	# ── granule `sim.progress`: cíl hry, součet, série a násobič ────────────
	if FileAccess.file_exists("res://scripts/progress.gd"):
		var pr: Node = _nova("res://scripts/progress.gd")
		_check(pr != null, "progress.gd jde vytvořit přes load(...).new()")
		if pr != null:
			for m in ["nastav_cil", "cil", "pridej_body", "celkem", "serie",
					"nasobic", "splneno", "zbyva_do_cile", "reset"]:
				_check(pr.has_method(String(m)), "průběh umí %s()" % str(m))
			_check(pr.has_signal("hotovo"), "průběh má signál hotovo")
			root.add_child(pr)
			await process_frame
			pr.nastav_cil(3)
			var c3: int = pr.cil()
			_check(c3 == 3, "nastav_cil(3) se projeví (cil=%d)" % c3)
			_check(pr.splneno() == false, "na začátku cíl splněn není")
			var zb3: int = pr.zbyva_do_cile()
			_check(zb3 == 3, "do cíle zbývají 3 (zbývá %d)" % zb3)
			var v1: int = pr.pridej_body(1)
			_check(v1 == 1, "pridej_body(1) vrátí nový součet (vrátil %d)" % v1)
			var s1: int = pr.serie()
			_check(s1 == 1, "série je 1 (je %d)" % s1)
			var n1: int = pr.nasobic()
			_check(n1 == 1, "násobič je 1 (je %d)" % n1)
			# Cíl se zvedne vysoko, aby se série měřila BEZ překročení cíle
			# (jinak by `hotovo` vyšlo dřív, než se na něj test připojí).
			pr.nastav_cil(50)
			for _i in range(4):
				pr.pridej_body(1)
			var s5: int = pr.serie()
			_check(s5 == 5, "pět sebraní = série 5 (je %d)" % s5)
			var n2: int = pr.nasobic()
			_check(n2 == 2, "od pátého sebraní je násobič 2 (je %d)" % n2)
			_check(pr.splneno() == false, "při součtu 5 z 50 cíl splněn není")
			pr.hotovo.connect(func() -> void: pr.set_meta("hotovo_emit", true))
			pr.nastav_cil(6)
			pr.pridej_body(1)
			await process_frame
			_check(pr.splneno() == true, "po dosažení cíle je splneno() true")
			var zb0: int = pr.zbyva_do_cile()
			_check(zb0 == 0, "do cíle nezbývá nic (zbývá %d)" % zb0)
			_check(bool(pr.get_meta("hotovo_emit", false)) == true,
				"signál hotovo se při dosažení cíle vyšle")
			pr.reset()
			var po_reset: int = pr.celkem()
			var serie_reset: int = pr.serie()
			var cil_reset: int = pr.cil()
			_check(po_reset == 0 and serie_reset == 0, "reset vynuluje součet i sérii")
			_check(cil_reset == 6, "reset nemění cíl (cil=%d)" % cil_reset)
			_check(pr.splneno() == false, "po resetu cíl zase splněn není")
			root.remove_child(pr)
			pr.free()

	# ── granule `ui.timer`: odpočet s deterministickým tikem ────────────────
	if FileAccess.file_exists("res://scripts/timer.gd"):
		var tm: Node = _nova("res://scripts/timer.gd")
		_check(tm != null, "timer.gd jde vytvořit přes load(...).new()")
		if tm != null:
			for m in ["nastav", "tik", "zbyva", "bezi"]:
				_check(tm.has_method(String(m)), "odpočet umí %s()" % str(m))
			_check(tm.has_signal("vyprsel"), "odpočet má signál vyprsel")
			tm.vyprsel.connect(func() -> void: tm.set_meta("vyprsel_emit", true))
			root.add_child(tm)
			await process_frame
			tm.nastav(2)
			var z2: int = tm.zbyva()
			_check(z2 == 2, "nastav(2) → zbývají 2 (zbývá %d)" % z2)
			_check(tm.bezi() == true, "po nastavení odpočet běží")
			tm.tik(0.5)
			tm.tik(0.5)
			var z1: int = tm.zbyva()
			_check(z1 == 1, "po 1,0 s zbývá 1 (zbývá %d)" % z1)
			_check(tm.bezi() == true, "odpočet po 1,0 s ještě běží")
			tm.tik(5.0)
			var z0: int = tm.zbyva()
			_check(z0 == 0, "odpočet nespadne pod nulu (zbývá %d)" % z0)
			_check(tm.bezi() == false, "po vypršení odpočet neběží")
			_check(bool(tm.get_meta("vyprsel_emit", false)) == true,
				"signál vyprsel se při vypršení vyšle")
			root.remove_child(tm)
			tm.free()

	# ── granule `world.trap`: past s cooldownem ─────────────────────────────
	if FileAccess.file_exists("res://scripts/trap.gd"):
		var past: Node = _nova("res://scripts/trap.gd")
		_check(past != null, "trap.gd jde vytvořit přes load(...).new()")
		if past != null:
			for m in ["poskod", "tik", "obnovit"]:
				_check(past.has_method(String(m)), "past umí %s()" % str(m))
			root.add_child(past)
			await process_frame
			_check(past.is_in_group("trap"), "past je ve skupině trap")
			var bez_hp := Node.new()
			root.add_child(bez_hp)
			_check(past.poskod(bez_hp) == false, "past neubere uzel, který hp nemá")
			root.remove_child(bez_hp)
			bez_hp.free()
			var obet: Node = _nova("res://scripts/player.gd")
			if obet != null:
				root.add_child(obet)
				await process_frame
				obet.hp = 3
				_check(past.poskod(obet) == true, "past ubere hráči hp")
				var h2: int = obet.hp
				_check(h2 == 2, "hp kleslo na 2 (je %d)" % h2)
				_check(past.poskod(obet) == false, "druhý zásah v cooldownu neprojde")
				var h2b: int = obet.hp
				_check(h2b == 2, "hp se v cooldownu nemění (je %d)" % h2b)
				past.obnovit()
				_check(past.poskod(obet) == true, "po obnovit() past znovu ubere")
				var h1: int = obet.hp
				_check(h1 == 1, "hp kleslo na 1 (je %d)" % h1)
				root.remove_child(obet)
				obet.free()
			past.tik(1.0)
			root.remove_child(past)
			past.free()

	# ── granule `save.best`: nejlepší skóre v user:// (JSON) ────────────────
	if FileAccess.file_exists("res://scripts/best.gd"):
		var rek: Node = _nova("res://scripts/best.gd")
		_check(rek != null, "best.gd jde vytvořit přes load(...).new()")
		if rek != null:
			for m in ["uloz", "nejlepsi"]:
				_check(rek.has_method(String(m)), "rekord umí %s()" % str(m))
			var cesta := "user://best_test.json"
			var dir: DirAccess = DirAccess.open("user://")
			if dir != null and dir.file_exists("best_test.json"):
				dir.remove("best_test.json")
			var prazdno: int = rek.nejlepsi(cesta)
			_check(prazdno == 0, "bez souboru je nejlepší skóre 0 (je %d)" % prazdno)
			_check(rek.uloz(cesta, 7) == true, "první uložení projde")
			var po7: int = rek.nejlepsi(cesta)
			_check(po7 == 7, "uložené skóre se přečte (je %d)" % po7)
			_check(rek.uloz(cesta, 3) == false, "horší skóre se neukládá")
			var porad7: int = rek.nejlepsi(cesta)
			_check(porad7 == 7, "horší skóre rekord nepřepíše (je %d)" % porad7)
			_check(rek.uloz(cesta, 9) == true, "lepší skóre se uloží")
			var po9: int = rek.nejlepsi(cesta)
			_check(po9 == 9, "lepší skóre rekord přepíše (je %d)" % po9)
			_check(FileAccess.file_exists(cesta), "soubor rekordu v user:// existuje")

	# ── granule `entity.heart`: sbíratelné srdce (léčení) ───────────────────
	if FileAccess.file_exists("res://scripts/heart.gd"):
		var srdce: Node = _nova("res://scripts/heart.gd")
		_check(srdce != null, "heart.gd jde vytvořit přes load(...).new()")
		if srdce != null:
			for m in ["seber", "hodnota_leceni"]:
				_check(srdce.has_method(String(m)), "srdce umí %s()" % str(m))
			root.add_child(srdce)
			await process_frame
			_check(srdce.is_in_group("heart"), "srdce je ve skupině heart")
			var leceni: int = srdce.hodnota_leceni()
			_check(leceni >= 1, "srdce léčí aspoň 1 hp (léčí %d)" % leceni)
			var hrac_s: Node = _nova("res://scripts/player.gd")
			if hrac_s != null:
				root.add_child(hrac_s)
				await process_frame
				hrac_s.hp = 1
				var sebrano: bool = srdce.seber(hrac_s)
				_check(sebrano == true, "seber() na srdci vrátí true")
				var hp_po: int = hrac_s.hp
				_check(hp_po == 1 + leceni, "srdce přidá %d hp (hp=%d)" % [leceni, hp_po])
				_check(srdce.is_queued_for_deletion(), "sebrané srdce se uklidí")
				root.remove_child(hrac_s)
				hrac_s.free()

	# ── granule `world.door`: dveře, které se dají odemknout ────────────────
	if FileAccess.file_exists("res://scripts/door.gd"):
		var dvere: Node = _nova("res://scripts/door.gd")
		_check(dvere != null, "door.gd jde vytvořit přes load(...).new()")
		if dvere != null:
			for m in ["odemkni", "je_odemcena", "projit"]:
				_check(dvere.has_method(String(m)), "dveře umí %s()" % str(m))
			_check(dvere.has_signal("proslo"), "dveře mají signál proslo")
			root.add_child(dvere)
			await process_frame
			_check(dvere.is_in_group("door"), "dveře jsou ve skupině door")
			_check(dvere.je_odemcena() == false, "na začátku jsou dveře zamčené")
			var hrac_d: Node = _nova("res://scripts/player.gd")
			if hrac_d != null:
				root.add_child(hrac_d)
				await process_frame
				_check(dvere.projit(hrac_d) == false, "zamčenými dveřmi se neprojde")
				dvere.odemkni()
				_check(dvere.je_odemcena() == true, "odemkni() dveře odemkne")
				dvere.proslo.connect(func() -> void: dvere.set_meta("proslo_emit", true))
				_check(dvere.projit(hrac_d) == true, "odemčenými dveřmi se projde")
				await process_frame
				_check(bool(dvere.get_meta("proslo_emit", false)) == true,
					"signál proslo se při průchodu vyšle")
				root.remove_child(hrac_d)
				hrac_d.free()

	# ── granule `world.portal`: přenos na značku z mapy ─────────────────────
	if FileAccess.file_exists("res://scripts/portal.gd"):
		var portal: Node = _nova("res://scripts/portal.gd")
		_check(portal != null, "portal.gd jde vytvořit přes load(...).new()")
		if portal != null:
			for m in ["nastav_cil", "znacka", "prenes"]:
				_check(portal.has_method(String(m)), "portál umí %s()" % str(m))
			root.add_child(portal)
			await process_frame
			_check(portal.is_in_group("portal"), "portál je ve skupině portal")
			portal.nastav_cil("exit")
			var zn: String = portal.znacka()
			_check(zn == "exit", "portál si pamatuje značku (znacka='%s')" % zn)
			var hrac_p: Node = _nova("res://scripts/player.gd")
			if hrac_p != null:
				root.add_child(hrac_p)
				await process_frame
				hrac_p.position = Vector2(4, 4)
				_check(portal.prenes(hrac_p) == true, "prenes() najde značku a přesune hráče")
				_check(hrac_p.position != Vector2(4, 4),
					"hráč po přenosu stojí jinde (%s)" % str(hrac_p.position))
				portal.nastav_cil("neexistujici_znacka")
				_check(portal.prenes(hrac_p) == false,
					"neznámá značka → false a hráč zůstane stát")
				root.remove_child(hrac_p)
				hrac_p.free()

	# ── granule `entity.patrol`: hlídka po bodech ───────────────────────────
	if FileAccess.file_exists("res://scripts/patrol.gd"):
		var hlidka: Node = _nova("res://scripts/patrol.gd")
		_check(hlidka != null, "patrol.gd jde vytvořit přes load(...).new()")
		if hlidka != null:
			for m in ["nastav_body", "dalsi_bod", "pocet_bodu", "tik"]:
				_check(hlidka.has_method(String(m)), "hlídka umí %s()" % str(m))
			root.add_child(hlidka)
			await process_frame
			var body: Array = [Vector2(50, 0), Vector2(150, 0), "nesmysl"]
			hlidka.nastav_body(body)
			var pb: int = hlidka.pocet_bodu()
			_check(pb == 2, "nastav_body bere jen Vector2 (vzala %d body)" % pb)
			hlidka.position = Vector2(50, 0)
			_check(hlidka.dalsi_bod() == Vector2(50, 0), "cíl je první bod")
			hlidka.tik(0.1)
			_check(hlidka.dalsi_bod() == Vector2(150, 0),
				"po dosažení bodu jde hlídka na další (%s)" % str(hlidka.dalsi_bod()))
			hlidka.tik(10.0)
			_check(hlidka.position.is_equal_approx(Vector2(150, 0)),
				"hlídka dojde přesně na bod (%s)" % str(hlidka.position))
			_check(hlidka.dalsi_bod() == Vector2(50, 0), "hlídka se vrací na první bod")
			hlidka.nastav_body([])
			_check(hlidka.dalsi_bod() == Vector2.ZERO, "bez bodů je cíl (0,0)")
			root.remove_child(hlidka)
			hlidka.free()

	# ── granule `ui.gameover`: obrazovka konce hry ──────────────────────────
	if FileAccess.file_exists("res://scripts/gameover.gd"):
		var konec: Node = _nova("res://scripts/gameover.gd")
		_check(konec != null, "gameover.gd jde vytvořit přes load(...).new()")
		if konec != null:
			for m in ["nastav", "je_vyhra", "text_zpravy", "restart"]:
				_check(konec.has_method(String(m)), "konec hry umí %s()" % str(m))
			_check(konec.has_signal("restart_pozadan"), "konec hry má signál restart_pozadan")
			root.add_child(konec)
			await process_frame
			konec.nastav(true)
			_check(konec.je_vyhra() == true, "nastav(true) znamená výhru")
			var text_vyhra: String = konec.text_zpravy()
			_check(text_vyhra.length() > 0, "výhra má text ('%s')" % text_vyhra)
			konec.nastav(false)
			_check(konec.je_vyhra() == false, "nastav(false) znamená prohru")
			var text_prohra: String = konec.text_zpravy()
			_check(text_prohra.length() > 0 and text_prohra != text_vyhra,
				"prohra má jiný text než výhra ('%s')" % text_prohra)
			konec.restart_pozadan.connect(func() -> void: konec.set_meta("restart_emit", true))
			konec.restart()
			await process_frame
			_check(bool(konec.get_meta("restart_emit", false)) == true,
				"restart() vyšle signál restart_pozadan")
			root.remove_child(konec)
			konec.free()

	# ── granule `core.wiring2`: zapojení druhé vlny do scény ────────────────
	# Blok je ZÁMĚRNĚ vázaný na metodu granule (`_zapoj_nove_komponenty`), ne na
	# existenci komponent: kdyby visel na souborech, spadl by hned po první
	# komponentě a do `core.wiring2` by CI bylo červené (a auto-merge by ho
	# nikdy nepustil). Takhle se rozsvítí až ve chvíli, kdy zapojení existuje.
	if main.has_method("_zapoj_nove_komponenty"):
		var ocekavane: Array = [
			["res://scripts/progress.gd", "Progress"],
			["res://scripts/timer.gd", "Timer"],
			["res://scripts/patrol.gd", "Patrol"],
			["res://scripts/portal.gd", "Portal"],
			["res://scripts/door.gd", "Door"],
			["res://scripts/heart.gd", "Heart"],
		]
		for dvojice in ocekavane:
			var cesta: String = String(dvojice[0])
			var jmeno: String = String(dvojice[1])
			if FileAccess.file_exists(cesta):
				_check(main.get_node_or_null(jmeno) != null,
					"zapojení: scéna vytvořila uzel %s" % jmeno)
		_check(main.get_node_or_null("Level") != null,
			"zapojení: mapa po přidání komponent zůstala ve scéně")
		_check(main.get_node_or_null("Player") != null,
			"zapojení: hráč po přidání komponent zůstal ve scéně")

	_finish()


func _finish() -> void:
	_done = true
	print("\n[test] %d kontrol, %d selhání" % [checks, failures])
	quit(failures)
