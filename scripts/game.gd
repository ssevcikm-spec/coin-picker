extends Node2D
## Coin-Picker — staví scénu PROGRAMOVĚ. Uzly vznikají v kódu, jediná ukládaná
## scéna je `main.tscn` (konvence §3). Díky tomu se celá hra dá generovat
## a upravovat textem, bez klikání v editoru.
##
## SMLOUVA (drží ji testy):
##   uzel `Level`  ve skupině `level`  — mapa (scripts/level.gd)
##   uzel `Player` ve skupině `player` — hráč (scripts/player.gd)
##   uzel `Hud`    ve skupině `hud`    — Label se skóre (scripts/hud.gd)
##   skore: int                        — skóre hry (roste signálem od hráče)
##   _on_sebrano(body: int) -> void    — příjem signálu `sebrano`

const MAPA_CESTA := "res://assets/levels/main.json"

var skore: int = 0
var mapa: Node = null
var hrac: Node = null
var lista: Node = null


func _ready() -> void:
	mapa = _vytvor_komponentu("res://scripts/level.gd", "Level")
	hrac = _vytvor_komponentu("res://scripts/player.gd", "Player")
	lista = _vytvor_komponentu("res://scripts/hud.gd", "Hud")
	for uzel in [mapa, hrac, lista]:
		if uzel != null:
			add_child(uzel)
	if hrac != null and hrac.has_signal("sebrano"):
		hrac.sebrano.connect(_on_sebrano)
	_nacti_mapu()
	_postav_hrace()
	_aktualizuj_listu()
	# ── ROZŠIŘOVACÍ BOD ────────────────────────────────────────────────────
	# Sem patří další komponenty (mince, rozmisťovač, nepřítel). Platí pravidlo
	# projektu: soubor, který v repu NENÍ, se PŘESKOČÍ a hra zůstane hratelná
	# (aditivní migrace) — proto `_vytvor_komponentu()` vrací null a nic nespadne.


func _vytvor_komponentu(cesta: String, jmeno: String) -> Node:
	## Vytvoří uzel ze skriptu granule. Když soubor v repu není, vrátí `null`
	## a POVÍ TO — tichý `null` by vypadal jako hotová komponenta.
	if not ResourceLoader.exists(cesta):
		return null
	var skript: GDScript = load(cesta)
	if skript == null:
		return null
	var uzel: Variant = skript.new()
	if not (uzel is Node):
		push_error("skript %s nevrací uzel" % cesta)
		return null
	uzel.name = jmeno
	return uzel


func _nacti_mapu() -> void:
	## Mapa se čte z DAT (konvence §1c: FileAccess + JSON, ne `File`/`json`).
	## Když data chybí nebo nedávají smysl, zůstane záložní mřížka z `level.gd`
	## a hra je dál hratelná — rozbitá data nesmí zastavit celou hru.
	if mapa == null or not mapa.has_method("nacti_z_dat"):
		return
	var text := FileAccess.get_file_as_string(MAPA_CESTA)
	if text.is_empty():
		push_warning("mapa %s nejde načíst – používám záložní mřížku" % MAPA_CESTA)
		return
	var data: Variant = JSON.parse_string(text)
	if typeof(data) != TYPE_DICTIONARY:
		push_warning("mapa %s není objekt – používám záložní mřížku" % MAPA_CESTA)
		return
	if not bool(mapa.nacti_z_dat(data)):
		push_warning("mapa %s se nepodařila načíst – používám záložní mřížku" % MAPA_CESTA)


func _postav_hrace() -> void:
	## Hráč startuje na značce `spawn` z mapy — nikdy na náhodné pozici
	## (mohl by skončit ve zdi, konvence §4).
	if hrac == null or mapa == null:
		return
	var spawny: Array = mapa.marker_positions("spawn")
	if spawny.size() > 0:
		hrac.position = spawny[0]
	else:
		hrac.position = mapa.cell_center(mapa.spawn_cell.x, mapa.spawn_cell.y)


func _on_sebrano(body: int) -> void:
	## Signál od hráče: skóre hry roste a HUD se přepíše.
	skore += body
	_aktualizuj_listu()


func _aktualizuj_listu() -> void:
	if lista != null and lista.has_method("nastav_skore"):
		lista.nastav_skore(skore)
