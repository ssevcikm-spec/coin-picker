extends Label
## Stavová lišta: sama JE ten Label (scéna i testy ji hledají jako uzel `Hud`).
##
## SMLOUVA: `nastav_skore(body: int) -> void` · `skore: int` · text česky.
##
## `extends Label` je záměr: uzel `Hud` musí být Label (testy na něm čtou
## `.text`), takže samostatný Node s vnořeným Labelem by přidal druhou věc,
## která se může rozejít. `_init()` není definován — `new()` bez parametrů.

var skore: int = 0


func _ready() -> void:
	add_to_group("hud")
	if text.is_empty():
		text = "Skóre: 0"


func nastav_skore(body: int) -> void:
	## Přepíše text. Česky a s diakritikou (konvence §6: texty pro hráče česky).
	skore = body
	text = "Skóre: %d" % skore
