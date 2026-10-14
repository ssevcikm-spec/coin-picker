extends Node

signal restart_pozadan

var vyhral: bool = false
var zprava: String = ""

func _init() -> void:
    pass

func nastav(vyhral: bool) -> void:
    self.vyhral = vyhral
    if vyhral:
        zprava = "Gratulujeme! Vyhrál jsi hru."
    else:
        zprava = "Bohužel, prohrál jsi. Zkus to znovu."

func je_vyhra() -> bool:
    return vyhral

func text_zpravy() -> String:
    # Vrací neprázdný text v češtině
    if zprava.is_empty():
        return ""
    return zprava

func restart() -> void:
    restart_pozadan.emit()
