#!/usr/bin/env bash
# ===========================================================================
#  FileHelper – legt auf dem Proxmox-Host einen LXC-Container an und installiert FileHelper darin.
#
#  Auf dem Proxmox-Server als root (z. B. Rechenzentrum → Knoten → Shell):
#    bash -c "$(curl -fsSL https://raw.githubusercontent.com/Tillhnz/FileHelper/main/proxmox/create-lxc.sh)"
#
#  Läuft der FileHelper schon, bietet dasselbe Skript das Update an.
#
#  Anpassen per Umgebungsvariablen (alle optional), z. B.:
#    CTID=150 IP=192.168.1.50/24 GW=192.168.1.1 bash -c "$(curl -fsSL …/create-lxc.sh)"
#
#    CTID=<frei>            Container-ID (Standard: nächste freie)
#    CT_HOSTNAME=filehelper
#    STORAGE=<auto>         Speicher für die Container-Festplatte (local-lvm, local-zfs, …)
#    TEMPLATE_STORAGE=local
#    DEBIAN=12              Debian-Version der Vorlage (12 oder 13)
#    DISK_GB=6  CORES=2  MEMORY_MB=1024
#    BRIDGE=vmbr0  IP=dhcp  GW=  VLAN=
#    PORT=8080              Port der Oberfläche
#    SHARES=                Ordner des Hosts, die gleich angezeigt werden sollen, z. B.
#                           SHARES="/mnt/pve/nas-fotos,/mnt/pve/nas-dokumente"
#    NONINTERACTIVE=1       keine Rückfragen
# ===========================================================================
set -euo pipefail

REPO="${FH_REPO:-Tillhnz/FileHelper}"
BRANCH="${FH_BRANCH:-main}"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

C_OK=$'\e[1;32m'; C_ERR=$'\e[1;31m'; C_INFO=$'\e[1;36m'; C_DIM=$'\e[2m'; C_WARN=$'\e[1;33m'; C_OFF=$'\e[0m'
step() { echo "${C_INFO}›${C_OFF} $*"; }
ok()   { echo "${C_OK}✔${C_OFF} $*"; }
warn() { echo "${C_WARN}!${C_OFF} $*"; }
die()  { echo "${C_ERR}✘ $*${C_OFF}" >&2; exit 1; }

# Rückfragen funktionieren auch bei "bash -c $(curl …)" und "curl | bash"
TTY=""
if [[ -z "${NONINTERACTIVE:-}" ]]; then
  if [[ -t 0 ]]; then TTY=/dev/stdin; elif (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi
fi
ask() { # Frage, Standard
  local a=""
  if [[ -n "$TTY" ]]; then read -r -p "$1 [$2]: " a <"$TTY" || a=""; fi
  printf '%s' "${a:-$2}"
}

command -v pct >/dev/null 2>&1 || die "Dieses Skript läuft auf dem Proxmox-Host (pct nicht gefunden)."
[[ $EUID -eq 0 ]] || die "Bitte als root ausführen."

echo
echo "  ${C_INFO}FileHelper${C_OFF} ${C_DIM}– deine Dateien im Browser, als Container auf Proxmox${C_OFF}"
echo

# ---------------------------------------------------------------------------
# Gibt es schon einen FileHelper-Container? → Update anbieten
# ---------------------------------------------------------------------------
EXISTING=""
for conf in /etc/pve/lxc/*.conf; do
  [[ -f "$conf" ]] || continue
  if grep -qE '^tags:.*\bfilehelper\b' "$conf"; then EXISTING="$(basename "$conf" .conf)"; break; fi
done
if [[ -n "$EXISTING" && -z "${CTID:-}" ]]; then
  echo "  Es gibt schon einen FileHelper-Container: ${C_INFO}#${EXISTING}${C_OFF} ($(pct config "$EXISTING" | awk '/^hostname:/{print $2}'))"
  a="$(ask "  Diesen aktualisieren? (j = aktualisieren, n = zusätzlich einen neuen anlegen)" "j")"
  if [[ "$a" =~ ^[jJyY]$ ]]; then
    pct status "$EXISTING" | grep -q running || { step "Starte Container #$EXISTING …"; pct start "$EXISTING"; sleep 5; }
    step "Aktualisiere FileHelper in #$EXISTING …"
    pct exec "$EXISTING" -- bash -c "command -v filehelper >/dev/null && filehelper update || bash /opt/filehelper/install.sh --update"
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Einstellungen
# ---------------------------------------------------------------------------
CTID="${CTID:-$(pvesh get /cluster/nextid)}"
CT_HOSTNAME="${CT_HOSTNAME:-filehelper}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
DEBIAN="${DEBIAN:-12}"
DISK_GB="${DISK_GB:-6}"
CORES="${CORES:-2}"
MEMORY_MB="${MEMORY_MB:-1024}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"
GW="${GW:-}"
VLAN="${VLAN:-}"
PORT="${PORT:-8080}"

pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID existiert bereits. Wähle eine andere ID mit CTID=…"

# Speicher für die Container-Festplatte automatisch wählen
if [[ -z "${STORAGE:-}" ]]; then
  for s in local-lvm local-zfs; do
    if pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active"{print $1}' | grep -qx "$s"; then STORAGE="$s"; break; fi
  done
  [[ -n "${STORAGE:-}" ]] || STORAGE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active"{print $1; exit}')"
  [[ -n "${STORAGE:-}" ]] || die "Kein Speicher für Container gefunden. Bitte STORAGE=… angeben."
fi

# ---------------------------------------------------------------------------
# NAS-Ordner gleich mit einbinden?
# ---------------------------------------------------------------------------
declare -a MOUNTS=()
if [[ -n "${SHARES:-}" ]]; then
  IFS=',' read -r -a MOUNTS <<<"$SHARES"
elif [[ -n "$TTY" ]]; then
  mapfile -t CANDIDATES < <(
    { pvesm status 2>/dev/null | awk 'NR>1 && ($2=="cifs" || $2=="nfs") && $3=="active"{print "/mnt/pve/"$1}'
      awk '$3 ~ /^(nfs|nfs4|cifs|smb3|fuse\.sshfs)$/ && $2 !~ /^\/mnt\/pve\// {print $2}' /proc/mounts; } | sort -u)
  if ((${#CANDIDATES[@]})); then
    echo "  Diese NAS-Freigaben sind auf dem Server eingebunden:"
    for i in "${!CANDIDATES[@]}"; do echo "    ${C_INFO}$((i + 1))${C_OFF}) ${CANDIDATES[$i]}"; done
    sel="$(ask "  Welche sollen im FileHelper erscheinen? (Nummern mit Komma, leer = später über die Proxmox Zentrale)" "")"
    for n in ${sel//,/ }; do
      [[ "$n" =~ ^[0-9]+$ ]] && ((n >= 1 && n <= ${#CANDIDATES[@]})) && MOUNTS+=("${CANDIDATES[$((n - 1))]}")
    done
    echo
  fi
fi

# ---------------------------------------------------------------------------
# Vorlage
# ---------------------------------------------------------------------------
step "Suche die Debian-${DEBIAN}-Vorlage …"
pveam update >/dev/null 2>&1 || warn "Vorlagen-Liste konnte nicht aktualisiert werden – nutze die vorhandene."
TEMPLATE="$(pveam available --section system 2>/dev/null | awk -v d="debian-${DEBIAN}-standard" '$2 ~ d {print $2}' | sort -V | tail -n 1)"
if [[ -z "$TEMPLATE" ]]; then
  TEMPLATE="$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk -v d="debian-${DEBIAN}-standard" '$1 ~ d {sub(/.*\//, "", $1); print $1}' | sort -V | tail -n 1)"
fi
[[ -n "$TEMPLATE" ]] || die "Keine Debian-${DEBIAN}-Vorlage gefunden."
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  step "Lade $TEMPLATE …"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null || die "Download der Vorlage fehlgeschlagen."
fi
ok "Vorlage $TEMPLATE"

# ---------------------------------------------------------------------------
# Container anlegen
# ---------------------------------------------------------------------------
NET="name=eth0,bridge=${BRIDGE},ip=${IP}"
[[ -n "$GW" ]] && NET="${NET},gw=${GW}"
[[ -n "$VLAN" ]] && NET="${NET},tag=${VLAN}"

step "Lege Container ${CTID} (${CT_HOSTNAME}) auf ${STORAGE} an …"
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "$CT_HOSTNAME" --cores "$CORES" --memory "$MEMORY_MB" --swap 512 \
  --rootfs "${STORAGE}:${DISK_GB}" --net0 "$NET" \
  --unprivileged 1 --features nesting=1 --onboot 1 --tags filehelper \
  --description "FileHelper – Dateien im Browser
https://github.com/${REPO}

Port: ${PORT}
Ordner, die hier unter /mnt eingebunden sind, erscheinen im FileHelper.
Am einfachsten: Proxmox Zentrale → Speicher & NAS → „Im FileHelper anzeigen“." >/dev/null
ok "Container ${CTID} angelegt"

n=0
for m in "${MOUNTS[@]}"; do
  m="${m%/}"
  [[ -d "$m" ]] || { warn "Ordner $m gibt es nicht – übersprungen."; continue; }
  if [[ "$m" =~ [[:space:],=] ]]; then warn "Ordner \"$m\" enthält Leerzeichen/Komma – übersprungen."; continue; fi
  name="$(basename "$m")"; name="${name#nas-}"
  pct set "$CTID" "-mp${n}" "${m},mp=/mnt/${name}" >/dev/null && ok "NAS-Ordner $m → im FileHelper als „${name}“"
  n=$((n + 1))
done

step "Starte Container …"
pct start "$CTID"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- bash -c 'getent hosts github.com >/dev/null 2>&1' && break
  sleep 2
done
pct exec "$CTID" -- bash -c 'getent hosts github.com >/dev/null 2>&1' || die "Der Container hat kein Internet (DNS/Netzwerk prüfen: pct enter ${CTID})."
ok "Container läuft und ist online"

# ---------------------------------------------------------------------------
# FileHelper im Container installieren
# ---------------------------------------------------------------------------
step "Installiere FileHelper im Container (dauert 1–3 Minuten) …"
ADMIN_PW="$(tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 12 || true)"
pct exec "$CTID" -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates >/dev/null"
SCRIPT="$(curl -fsSL "${RAW}/install.sh")" || die "install.sh konnte nicht geladen werden (${RAW}/install.sh)."
pct exec "$CTID" -- env FH_REPO="$REPO" FH_BRANCH="$BRANCH" FH_PORT="$PORT" FH_ADMIN_PASSWORD="$ADMIN_PW" bash -c "$SCRIPT"

CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "  ${C_OK}FileHelper ist bereit!${C_OFF}"
echo
echo "    Adresse:   ${C_INFO}http://${CT_IP:-<IP-des-Containers>}:${PORT}${C_OFF}"
echo "    Benutzer:  ${C_INFO}admin${C_OFF}"
echo "    Passwort:  ${C_INFO}${ADMIN_PW}${C_OFF}   ${C_DIM}(bitte notieren und nach der Anmeldung ändern)${C_OFF}"
echo
echo "  ${C_DIM}Weitere NAS-Ordner anzeigen: Proxmox Zentrale → Speicher & NAS → „Im FileHelper anzeigen“"
echo "  oder von Hand:  pct set ${CTID} -mp<N> /mnt/pve/<freigabe>,mp=/mnt/<name>  und  pct reboot ${CTID}"
echo "  Von unterwegs/mit Domain: im Nginx Proxy Manager einen Proxy-Host auf ${CT_IP:-<IP>}:${PORT} anlegen."
echo "  Update später: dieses Skript erneut ausführen oder im Container „filehelper update“.${C_OFF}"
echo
