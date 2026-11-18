#!/usr/bin/env bash
# ===========================================================================
#  FileHelper – Installation IM Container (Debian/Ubuntu)
#
#  Normalerweise nicht direkt aufrufen, sondern auf dem Proxmox-Host:
#    bash -c "$(curl -fsSL https://raw.githubusercontent.com/Tillhnz/FileHelper/main/proxmox/create-lxc.sh)"
#
#  Im Container:
#    bash install.sh              installieren
#    filehelper update            aktualisieren   (= bash /opt/filehelper/install.sh --update)
#    filehelper uninstall         entfernen       (Dateien auf der NAS bleiben unberührt)
# ===========================================================================
set -euo pipefail

REPO="${FH_REPO:-Tillhnz/FileHelper}"
BRANCH="${FH_BRANCH:-main}"
INSTALL_DIR="/opt/filehelper"
STATE_DIR="/var/lib/filehelper"
ENV_FILE="/etc/filehelper.env"
SERVICE="filehelper"

C_OK=$'\e[1;32m'; C_ERR=$'\e[1;31m'; C_INFO=$'\e[1;36m'; C_DIM=$'\e[2m'; C_OFF=$'\e[0m'
step() { echo "${C_INFO}›${C_OFF} $*"; }
ok()   { echo "${C_OK}✔${C_OFF} $*"; }
die()  { echo "${C_ERR}✘ $*${C_OFF}" >&2; exit 1; }

MODE="install"
case "${1:-}" in
  --update)    MODE="update" ;;
  --uninstall) MODE="uninstall" ;;
  ""|--install) ;;
  *) die "Unbekannte Option: $1 (erlaubt: --update, --uninstall)" ;;
esac
[[ $EUID -eq 0 ]] || die "Bitte als root ausführen."

# Läuft das Skript aus dem Installationsordner, wird es gleich überschrieben → Kopie ausführen
if [[ "${BASH_SOURCE[0]:-}" == "$INSTALL_DIR/install.sh" && -z "${FH_REEXEC:-}" ]]; then
  TMP="$(mktemp /tmp/fh-install.XXXXXX.sh)"
  cp "$INSTALL_DIR/install.sh" "$TMP"
  FH_REEXEC=1 exec bash "$TMP" "$@"
fi

# Repository aus der bestehenden Konfiguration übernehmen
if [[ -f "$ENV_FILE" ]]; then
  _r="$(grep -E '^FH_REPO=' "$ENV_FILE" | cut -d= -f2- || true)"; [[ -n "$_r" && -z "${FH_REPO:-}" ]] && REPO="$_r"
  _b="$(grep -E '^FH_BRANCH=' "$ENV_FILE" | cut -d= -f2- || true)"; [[ -n "$_b" && -z "${FH_BRANCH:-}" ]] && BRANCH="$_b"
fi

# ---------------------------------------------------------------------------
if [[ $MODE == "uninstall" ]]; then
  step "Entferne FileHelper …"
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE}.service" /usr/local/bin/filehelper
  systemctl daemon-reload
  rm -rf "$INSTALL_DIR" "$STATE_DIR" "$ENV_FILE"
  ok "Entfernt. Deine Dateien unter /mnt wurden nicht angefasst."
  exit 0
fi

echo
echo "  ${C_INFO}FileHelper${C_OFF} ${C_DIM}– deine Dateien im Browser${C_OFF}"
echo

# ---------------------------------------------------------------------------
step "Benötigte Pakete installieren …"
export DEBIAN_FRONTEND=noninteractive
NEED=()
PKGS=(git python3 python3-venv curl ca-certificates)
[[ "${FH_NO_FFMPEG:-0}" == "1" ]] || PKGS+=(ffmpeg)
for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || NEED+=("$p"); done
if ((${#NEED[@]})); then
  apt-get update -qq || true
  if ! apt-get install -y -qq --no-install-recommends "${NEED[@]}" >/dev/null; then
    # ffmpeg ist nur für Video-Vorschaubilder – ohne geht es auch
    NEED=("${NEED[@]/ffmpeg/}")
    apt-get install -y -qq --no-install-recommends ${NEED[@]} >/dev/null || die "Pakete konnten nicht installiert werden."
    echo "  ${C_DIM}Hinweis: ffmpeg fehlt – Videos bekommen keine Vorschaubilder.${C_OFF}"
  fi
fi
ok "Pakete vorhanden"

# ---------------------------------------------------------------------------
step "Programm von GitHub laden (${REPO}, Zweig ${BRANCH}) …"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" remote set-url origin "https://github.com/${REPO}.git"
  git -C "$INSTALL_DIR" fetch -q --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" reset -q --hard FETCH_HEAD
else
  rm -rf "$INSTALL_DIR"
  git clone -q --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$INSTALL_DIR" \
    || die "Konnte https://github.com/${REPO} nicht laden. Ist das Repository öffentlich und hat der Container Internet?"
fi
ok "Version $(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo '?')"

# ---------------------------------------------------------------------------
step "Python-Umgebung einrichten …"
SYS_PY="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
VENV_PY="$("$INSTALL_DIR/.venv/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
if [[ "$VENV_PY" != "$SYS_PY" ]]; then
  rm -rf "$INSTALL_DIR/.venv"
  python3 -m venv "$INSTALL_DIR/.venv"
fi
"$INSTALL_DIR/.venv/bin/pip" install -q --upgrade pip >/dev/null
if ! "$INSTALL_DIR/.venv/bin/pip" install -q -r "$INSTALL_DIR/backend/requirements.txt"; then
  # pillow-heif gibt es nicht für jede Plattform – ohne geht es auch (nur keine HEIC-Vorschau)
  grep -v pillow-heif "$INSTALL_DIR/backend/requirements.txt" > /tmp/fh-req.txt
  "$INSTALL_DIR/.venv/bin/pip" install -q -r /tmp/fh-req.txt || die "Python-Pakete konnten nicht installiert werden."
fi
ok "Python-Umgebung bereit"

# ---------------------------------------------------------------------------
# CAD-Leser für STEP/IGES (OpenCascade als WebAssembly, LGPL-2.1) – ca. 8 MB
OCCT_VERSION="0.0.24"
OCCT_DIR="$INSTALL_DIR/frontend/vendor/occt"
if [[ "$(cat "$OCCT_DIR/VERSION" 2>/dev/null)" != "$OCCT_VERSION" ]]; then
  step "CAD-Leser für STEP-Dateien laden …"
  mkdir -p "$OCCT_DIR"
  CDN="https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist"
  if curl -fsSL "$CDN/occt-import-js.js" -o "$OCCT_DIR/occt-import-js.js.tmp" \
    && curl -fsSL "$CDN/occt-import-js.wasm" -o "$OCCT_DIR/occt-import-js.wasm.tmp"; then
    curl -fsSL "$CDN/license.occt-import-js.txt" -o "$OCCT_DIR/LICENSE.txt" 2>/dev/null || true
    mv "$OCCT_DIR/occt-import-js.js.tmp" "$OCCT_DIR/occt-import-js.js"
    mv "$OCCT_DIR/occt-import-js.wasm.tmp" "$OCCT_DIR/occt-import-js.wasm"
    echo "$OCCT_VERSION" > "$OCCT_DIR/VERSION"
    ok "STEP-Vorschau bereit"
  else
    rm -f "$OCCT_DIR"/*.tmp
    echo "  ${C_DIM}Hinweis: Download fehlgeschlagen – STL geht, STEP-Dateien erst nach „filehelper update“.${C_OFF}"
  fi
fi

# ---------------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  step "Konfiguration anlegen …"
  cat > "$ENV_FILE" <<EOF
# FileHelper – Einstellungen. Nach Änderungen: systemctl restart ${SERVICE}

# Adresse und Port der Oberfläche
FH_BIND=0.0.0.0
FH_PORT=${FH_PORT:-8080}

# Jeder Unterordner hiervon erscheint als Freigabe (z. B. von der Proxmox Zentrale eingebundene NAS-Ordner)
FH_ROOT=/mnt

# IP-Adressen eines Reverse-Proxys (z. B. Nginx Proxy Manager), dem FileHelper die echte
# Besucher-IP glauben darf. Kommagetrennt, z. B. 192.168.1.10
FH_TRUSTED_PROXIES=127.0.0.1

# Größe des Zwischenspeichers für Vorschaubilder (MB)
FH_THUMB_CACHE_MB=2048

# Repository für Updates
FH_REPO=${REPO}
FH_BRANCH=${BRANCH}
EOF
  chmod 600 "$ENV_FILE"
  ok "Konfiguration: $ENV_FILE"
else
  grep -q '^FH_REPO=' "$ENV_FILE" && sed -i "s#^FH_REPO=.*#FH_REPO=${REPO}#" "$ENV_FILE" || echo "FH_REPO=${REPO}" >> "$ENV_FILE"
fi
mkdir -p "$STATE_DIR" /mnt
chmod 700 "$STATE_DIR"

# ---------------------------------------------------------------------------
step "Dienst einrichten …"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=FileHelper – Dateien im Browser
After=network-online.target remote-fs.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
Environment=FH_STATE_DIR=${STATE_DIR}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/env bash -c 'exec ${INSTALL_DIR}/.venv/bin/uvicorn backend.app:app --host "\${FH_BIND:-0.0.0.0}" --port "\${FH_PORT:-8080}" --proxy-headers --forwarded-allow-ips "\${FH_TRUSTED_PROXIES:-127.0.0.1}" --no-server-header --log-level warning --timeout-keep-alive 30'
Restart=on-failure
RestartSec=3
Nice=5

[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/bin/filehelper <<EOF
#!/usr/bin/env bash
# FileHelper – Hilfsbefehle im Container
set -e
cd ${INSTALL_DIR}
export FH_STATE_DIR=${STATE_DIR}
case "\${1:-}" in
  passwd)    shift; ${INSTALL_DIR}/.venv/bin/python -m backend.cli passwd "\$@"; systemctl restart ${SERVICE} ;;
  users)     ${INSTALL_DIR}/.venv/bin/python -m backend.cli users ;;
  update)    bash ${INSTALL_DIR}/install.sh --update ;;
  uninstall) bash ${INSTALL_DIR}/install.sh --uninstall ;;
  logs)      journalctl -u ${SERVICE} -n 100 -f ;;
  restart)   systemctl restart ${SERVICE} ;;
  status)    systemctl status ${SERVICE} --no-pager ;;
  *) echo "FileHelper \$(cat ${INSTALL_DIR}/VERSION)"
     echo "  filehelper passwd <name>   Passwort setzen (legt den Benutzer an, falls neu)"
     echo "  filehelper users           Benutzer anzeigen"
     echo "  filehelper update          Neueste Version installieren"
     echo "  filehelper logs            Protokoll ansehen"
     echo "  filehelper restart         Neu starten"
     echo "  filehelper uninstall       Entfernen (Dateien bleiben)";;
esac
EOF
chmod +x /usr/local/bin/filehelper "$INSTALL_DIR/install.sh"

# Erster Start: Administrator anlegen
INITIAL_PW=""
if ! (cd "$INSTALL_DIR" && FH_STATE_DIR="$STATE_DIR" "$INSTALL_DIR/.venv/bin/python" -m backend.cli has-users); then
  if [[ -n "${FH_ADMIN_PASSWORD:-}" ]]; then
    (cd "$INSTALL_DIR" && FH_STATE_DIR="$STATE_DIR" FH_ADMIN_USER="${FH_ADMIN_USER:-admin}" "$INSTALL_DIR/.venv/bin/python" -c \
      "import os; from backend import store; store.set_user(os.environ['FH_ADMIN_USER'], password=os.environ['FH_ADMIN_PASSWORD'], admin=True)")
    INITIAL_PW="$FH_ADMIN_PASSWORD"
  else
    INITIAL_PW="$(cd "$INSTALL_DIR" && FH_STATE_DIR="$STATE_DIR" "$INSTALL_DIR/.venv/bin/python" -m backend.cli passwd "${FH_ADMIN_USER:-admin}" --random --admin)"
  fi
fi

systemctl daemon-reload
systemctl enable -q "$SERVICE"
systemctl restart "$SERVICE"

# shellcheck disable=SC1090
source "$ENV_FILE"
for _ in $(seq 1 20); do
  curl -fs "http://127.0.0.1:${FH_PORT:-8080}/api/health" >/dev/null 2>&1 && break
  sleep 1
done
if ! systemctl is-active -q "$SERVICE"; then
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  die "Der Dienst ist nicht gestartet (siehe Meldungen oben)."
fi
ok "Dienst läuft"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
ok "Fertig! Öffne im Browser:  ${C_INFO}http://${IP:-<IP-des-Containers>}:${FH_PORT:-8080}${C_OFF}"
if [[ -n "$INITIAL_PW" ]]; then
  echo
  echo "  Anmeldung:  Benutzer ${C_INFO}${FH_ADMIN_USER:-admin}${C_OFF}   Passwort ${C_INFO}${INITIAL_PW}${C_OFF}"
  echo "  ${C_DIM}Bitte notieren und danach unter Einstellungen → Passwort ändern.${C_OFF}"
fi
echo
