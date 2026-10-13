#!/data/data/com.termux/files/usr/bin/bash
# Orchestra – bootstrap telefonu jako domácího uzlu (FÁZE 1).
#
# Spouštět V TERMUXU (ne v proot-distro). Je idempotentní – dá se pustit víckrát.
#
# Co udělá:
#   • doinstaluje potřebné balíčky (Node, git, sshd, proot-distro)
#   • připraví ~/forge (workdir + .env pro workera)
#   • nastaví Termux:Boot, aby služby naskočily po restartu telefonu
#   • vypíše, co ještě musíš dodělat ručně (tajemství, Tailscale, Termux:Boot app)
#
# DŮLEŽITÉ: Termux musí být z F-DROIDu, ne z Google Play (ta verze je mrtvá).
#           Termux:Boot taky z F-Droidu (bez něj se služby po restartu nespustí).

set -euo pipefail

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

say "1/6 Kontrola prostředí"
if [ ! -d /data/data/com.termux ]; then
  warn "Tohle nevypadá jako Termux. Skript je dělaný pro Termux na Androidu."
fi
echo "architektura: $(uname -m)   android: $(getprop ro.build.version.release 2>/dev/null || echo '?')"

say "2/6 Instalace balíčků"
pkg update -y
pkg upgrade -y
# nodejs-lts = stabilnější řada; git na klonování; openssh = sshd; proot-distro
# kvůli nástrojům, které potřebují glibc (Godot, wheelů pro Python).
pkg install -y nodejs-lts git openssh proot-distro termux-tools wget

# Python balíčky pro zpracování obrázků jsou v Termuxu jako hotové balíčky
pkg install -y python python-numpy 2>/dev/null || warn "python-numpy není v repu – použij proot (viz níže)"
pkg install -y python-pillow 2>/dev/null || warn "python-pillow není v repu – použij proot (viz níže)"

say "3/6 Příprava pracovní složky"
mkdir -p ~/forge/phone ~/forge/work
if [ ! -f ~/forge/phone/.env ]; then
  cat > ~/forge/phone/.env <<'EOF'
# Doplň hodnoty! Soubor drž jen v telefonu, necommituj ho.
FORGE_URL=
FORGE_SECRET=
FORGE_WORKER=redmi-note8
# Co tenhle uzel umí vykonávat (druhy úkolů z fronty):
FORGE_KINDS=test,build,assets
EOF
  chmod 600 ~/forge/phone/.env
  warn "Vytvořil jsem ~/forge/phone/.env – doplň FORGE_URL a FORGE_SECRET."
else
  echo ".env už existuje, nechávám být"
fi

say "4/6 SSH server (port 8022)"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
[ -f ~/.ssh/authorized_keys ] || : > ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
if [ ! -s ~/.ssh/authorized_keys ]; then
  warn "~/.ssh/authorized_keys je prázdný. Vlož do něj veřejný klíč z PC:"
  echo "    (na PC)  type \$env:USERPROFILE\\.ssh\\id_ed25519.pub"
  echo "    (tady)   nano ~/.ssh/authorized_keys"
fi
# sshd v Termuxu poslouchá na 8022 (na 22 by potřeboval root)
pgrep -f sshd >/dev/null || sshd || warn "sshd se nespustil (uvidíš důvod výše)"

say "5/6 Proot distribuce (glibc nástroje: Godot, pip wheelů)"
if ! proot-distro list --installed 2>/dev/null | grep -q ubuntu; then
  proot-distro install ubuntu
else
  echo "ubuntu už je nainstalované"
fi

say "6/6 Termux:Boot – ať služby naskočí po restartu telefonu"
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/10-forge.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
# Spouští se po startu telefonu (vyžaduje aplikaci Termux:Boot z F-Droidu).
termux-wake-lock
sshd
cd "$HOME/forge/phone" || exit 0
if [ -f .env ] && ! pgrep -f "node worker.mjs" >/dev/null; then
  nohup node worker.mjs >> "$HOME/forge/worker.log" 2>&1 &
fi
EOF
chmod +x ~/.termux/boot/10-forge.sh
echo "vytvořeno: ~/.termux/boot/10-forge.sh"

cat <<'EOF'

---------------------------------------------------------------
HOTOVO (fáze 1). Co ještě ručně:

 1) Doplň ~/forge/phone/.env   (FORGE_URL a FORGE_SECRET)
 2) Nainstaluj aplikaci Termux:Boot z F-Droidu a jednou ji otevři
 3) Zkopíruj workera do telefonu (až bude repo na GitHubu):
      cd ~/forge/phone
      # buď z repa (NAZEV-REPA nahraď repem hry, na které orchestra pracuje):
      #   git clone --depth 1 https://github.com/ssevcikm-spec/NAZEV-REPA /tmp/hra
      #   cp /tmp/hra/.forge/node/worker.mjs ~/forge/phone/   (worker je v repu hry)
      # nebo ho sem přenes přes Tailscale/scp z PC
 4) Test bez připojení:
      node worker.mjs --info
 5) Test jednoho cyklu:
      node worker.mjs --once
 6) Naostro (na pozadí):
      termux-wake-lock
      nohup node worker.mjs >> ~/forge/worker.log 2>&1 &

Poznámka k výkonu: Termux je Bionic libc, takže oficiální Godot (glibc) v něm
NEBĚŽÍ. Godot a pip wheelů pouštěj uvnitř prootu:
    proot-distro login ubuntu
    # ... tam: apt install -y wget unzip python3-pip && pip install pillow numpy
---------------------------------------------------------------
EOF
