extends Node

signal hotovo

var cil_hry: int = 1
var soucet: int = 0
var serie_hry: int = 0
var ohlaseno: bool = false

func _init() -> void:
    pass

func nastav_cil(pocet: int) -> void:
    cil_hry = max(pocet, 1)

func cil() -> int:
    return cil_hry

func pridej_body(body: int) -> int:
    soucet += body
    serie_hry += 1
    if not ohlaseno and splneno():
        ohlaseno = true
        hotovo.emit()
    return soucet

func celkem() -> int:
    return soucet

func serie() -> int:
    return serie_hry

func nasobic() -> int:
    if serie_hry < 5:
        return 1
    elif serie_hry < 10:
        return 2
    else:
        return 3

func splneno() -> bool:
    return soucet >= cil_hry

func zbyva_do_cile() -> int:
    return max(cil_hry - soucet, 0)

func reset() -> void:
    soucet = 0
    serie_hry = 0
    ohlaseno = false
