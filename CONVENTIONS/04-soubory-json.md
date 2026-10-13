> **Sekce konvencí `04-soubory-json`** (§1c). Agent dostane jen ty sekce, které
> jeho granule deklaruje v roadmapě.

## 1c. `File` a `json` NEEXISTUJÍ – Godot má `FileAccess` a `JSON`

Nejčastější chyba modelů, které znají Python: sáhnou po `File`, `open()` nebo
`json.load()`. V GDScriptu nic z toho není a **skript se vůbec nenačte**:

```gdscript
# ŠPATNĚ – Parse Error: Identifier "File" not declared in the current scope
var file = File.new()
file.open("res://assets/data/items.json", File.READ)
var data = json.load(file)

# SPRÁVNĚ – Godot 4
var text := FileAccess.get_file_as_string("res://assets/data/items.json")
if text.is_empty():
    push_error("items.json nejde načíst")
    return
var data: Variant = JSON.parse_string(text)
if typeof(data) != TYPE_DICTIONARY:
    push_error("items.json není objekt")
    return
```

Pozor i na `json.parse()` (Python) vs `JSON.parse_string()` (Godot) a na to, že
`JSON.parse_string()` vrací `null` při chybě – **vždy zkontroluj výsledek**,
jinak dostaneš `Cannot infer the type` nebo pád na `null`.
