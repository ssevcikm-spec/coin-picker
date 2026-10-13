> **Sekce konvencí `05-godot3-konstanty`** (§1h). Agent dostane jen ty sekce,
> které jeho granule deklaruje v roadmapě.

## 1h. Konstanty z Godotu 3 v Godotu 4 NEEXISTUJÍ (a je to častá chyba)

Model má v trénovacích datech spoustu Godotu 3 a píše jeho konstanty. Godot 4
je přejmenoval na delší a významově jiná jména – a **parse to odhalí**:

```
# ŠPATNĚ – Parse Error: Cannot find member "ALIGN_LEFT" in base "Label".
label.align = Label.ALIGN_LEFT
label.valign = Label.VALIGN_TOP
label.autowrap = true

# SPRÁVNĚ – Godot 4
label.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
label.vertical_alignment = VERTICAL_ALIGNMENT_TOP
label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
```

| Godot 3 | Godot 4 |
|---|---|
| `ALIGN_LEFT` / `ALIGN_CENTER` / `ALIGN_RIGHT` | `HORIZONTAL_ALIGNMENT_LEFT` / `…_CENTER` / `…_RIGHT` |
| `VALIGN_TOP` / `VALIGN_CENTER` / `VALIGN_BOTTOM` | `VERTICAL_ALIGNMENT_TOP` / `…_CENTER` / `…_BOTTOM` |
| `Label.align` / `Label.valign` | `Label.horizontal_alignment` / `Label.vertical_alignment` |
| `Label.autowrap` (bool) | `Label.autowrap_mode` (`TextServer.AUTOWRAP_*`) |
| `connect("signal", self, "_on_x")` | `signal.connect(_on_x)` |
| `yield(x, "signal")` / `yield(x, "completed")` | `await x.signal` / `await x.completed` |
| `export var` / `onready var` | `@export var` / `@onready var` |
| `OS.get_ticks_msec()` | `Time.get_ticks_msec()` |
| `instance()` | `instantiate()` |
| `PoolStringArray` a ostatní `Pool*Array` | `PackedStringArray` a ostatní `Packed*Array` |

**Naměřeno 1. 10. 2026:** granule `ui.hud` (běh #241) na tomhle spadla –
`Cannot find member "ALIGN_LEFT" in base "Label"` na `scripts/hud.gd:8` a
`VALIGN_TOP` na `:9`. Soubor se kvůli tomu **nikdy nedostal do repa** a HUD
nemá stavovou lištu.

**Pravidlo: nepoužívej konstantu, kterou jsi neviděl v tomto repu.** Když si
nejsi jistý jménem, sáhni po tématu, které v repu UŽ JE (`scripts/level.gd`,
`scripts/player.gd`) a napiš to stejně. Když tam není, napiš kód tak, aby
konstantu nepotřeboval (např. nastav vlastnost jen číslem nebo vynech).

**Pozor na past, která to zhoršuje:** tyhle chyby vypadají jako „vada brány",
protože jich model udělá víc najednou a první z nich je často jen následek
(`Identifier X not declared`). **Oprav vždy první chybu v souboru** — další
často zmizí samy.
