# FileHelper

Deine Dateien von der NAS – mit einer schicken Oberfläche im Browser und auf dem Handy. Läuft als kleiner LXC-Container auf deinem Proxmox-Server, Design wie die [Proxmox Zentrale (BetterProxmoxUI)](https://github.com/Tillhnz/BetterProxmoxUI).

## Was FileHelper kann

- **Alle Freigaben auf einen Blick** – jeder Ordner, der im Container unter `/mnt` eingebunden ist (z. B. NAS-Freigaben per NFS oder SMB), erscheint als eigene Freigabe mit freiem Speicherplatz
- **Ansehen ohne Herunterladen** – Fotos (auch iPhone-HEIC und Kamera-RAW wie Fujifilm `.RAF`), Videos mit Vorspulen, Musik, PDFs und Textdateien; durchblättern mit Pfeiltasten oder Wischen
- **Vorschaubilder** für Fotos und Videos, Kachel- und Foto-Ansicht (Ordner voller Bilder öffnen automatisch als Kacheln)
- **Herunterladen** – einzelne Dateien direkt, mehrere Dateien oder ganze Ordner als ZIP (wird beim Herunterladen erzeugt, ohne Zwischendatei)
- **Hochladen** – Dateien und ganze Ordner, per Knopf oder einfach ins Fenster ziehen; große Dateien werden in Stücken übertragen (läuft auch hinter Proxys wie dem Nginx Proxy Manager) und nach Verbindungsabbrüchen fortgesetzt; Bildschirmfotos per Strg+V einfügen
- **Ordnen** – neuer Ordner, neue Textdatei, umbenennen, verschieben und kopieren (auch zwischen Freigaben, per Ziehen auf einen Ordner), löschen; Textdateien direkt bearbeiten
- **Suchen** – sofort im aktuellen Ordner, mit Enter auch in allen Unterordnern
- **Links teilen** – für Dateien und Ordner, ohne Konto nutzbar, wahlweise mit Ablaufdatum und Passwort; Übersicht mit Download-Zähler
- **Favoriten** für Ordner und Dateien, die du oft brauchst
- **Benutzer** mit Rollen: Administrator, Benutzer, Nur ansehen
- **Fürs Handy gemacht** – untere Navigationsleiste, große Tippflächen, langes Drücken zum Auswählen, Menüs von unten, Zurück-Taste schließt die Vorschau; als App auf den Home-Bildschirm legen
- Hell und dunkel, alles auf Deutsch

## Installation (eine Zeile)

Auf dem **Proxmox-Server** als `root` (z. B. *Rechenzentrum → Knoten → Shell*):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/Tillhnz/FileHelper/main/proxmox/create-lxc.sh)"
```

Das Skript

1. legt einen kleinen, **unprivilegierten** Debian-Container an (2 Kerne, 1 GB RAM, 6 GB Festplatte, Netzwerk per DHCP),
2. fragt, welche schon eingebundenen NAS-Freigaben gleich angezeigt werden sollen (optional),
3. installiert FileHelper darin und zeigt am Ende **Adresse, Benutzer und Passwort** an.

Danach im Browser öffnen: `http://<IP-des-Containers>:8080`

Anpassen per Umgebungsvariablen, z. B. feste IP und eigene ID:

```bash
CTID=150 IP=192.168.1.50/24 GW=192.168.1.1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/Tillhnz/FileHelper/main/proxmox/create-lxc.sh)"
```

| Variable | Standard | Bedeutung |
|---|---|---|
| `CTID` | nächste freie | Container-ID |
| `CT_HOSTNAME` | `filehelper` | Name des Containers |
| `STORAGE` | `local-lvm`/`local-zfs` | Speicher für die Container-Festplatte |
| `DISK_GB` / `CORES` / `MEMORY_MB` | `6` / `2` / `1024` | Größe |
| `IP` / `GW` / `VLAN` / `BRIDGE` | `dhcp` / – / – / `vmbr0` | Netzwerk |
| `PORT` | `8080` | Port der Oberfläche |
| `SHARES` | – | Ordner des Hosts, die gleich eingebunden werden, z. B. `/mnt/pve/nas-fotos,/mnt/pve/nas-dokumente` |
| `DEBIAN` | `12` | Debian-Version der Vorlage |

## NAS-Ordner anzeigen

FileHelper zeigt jeden Unterordner von `/mnt` im Container als Freigabe. Am einfachsten geht das Freigeben mit der **Proxmox Zentrale**:

1. **Speicher & NAS → NAS-Freigabe verbinden** (NFS oder SMB) – Proxmox bindet die Freigabe unter `/mnt/pve/<name>` ein.
2. Bei der Freigabe auf **„Im FileHelper anzeigen“** tippen und den Ordner wählen (ganze Freigabe oder ein Unterordner).
3. Der Container startet kurz neu – fertig, der Ordner erscheint im FileHelper.

Von Hand auf dem Proxmox-Host:

```bash
pct set <CTID> -mp0 /mnt/pve/nas-fotos,mp=/mnt/fotos
pct reboot <CTID>
```

**Schreibrechte:** Der Container ist unprivilegiert (sicherer). Damit FileHelper auf die NAS schreiben darf (Hochladen, Löschen …):

- **NFS:** In der NFS-Freigabe der NAS „Alle Benutzer zu admin zuordnen“ (Squash / `all_squash`) einstellen.
- **SMB:** Die Freigabe in der Proxmox Zentrale mit „Für Container beschreibbar machen“ verbinden (setzt `uid=100000,gid=100000`).

Ist eine Freigabe nur lesbar, zeigt FileHelper „nur lesen“ an und sperrt Hochladen, Umbenennen und Löschen. Soll eine Freigabe bewusst nur lesbar sein, beim Teilen „Nur lesen“ wählen.

## Von unterwegs und mit eigener Domain

FileHelper selbst spricht nur HTTP im Heimnetz. Für eine Adresse wie `dateien.all-heinzen.de` im **Nginx Proxy Manager** einen Proxy-Host auf `http://<IP-des-Containers>:8080` anlegen (mit SSL, „Websockets“ nicht nötig). Danach in `/etc/filehelper.env` die IP des Proxy Managers bei `FH_TRUSTED_PROXIES` eintragen, damit die Sperre nach Fehlversuchen die echte Besucher-IP sieht. Geteilte Links funktionieren dann auch für andere.

## Aktualisieren & Befehle

- In der Oberfläche: **Einstellungen → System → Auf … aktualisieren**
- Auf dem Proxmox-Host: das Installations-Skript einfach noch einmal ausführen – es erkennt den vorhandenen Container und bietet das Update an
- Im Container (`pct enter <CTID>`):

| Befehl | Wirkung |
|---|---|
| `filehelper update` | neueste Version installieren |
| `filehelper passwd <name>` | Passwort setzen (legt den Benutzer an, falls neu) |
| `filehelper users` | Benutzer anzeigen |
| `filehelper logs` | Protokoll ansehen |
| `filehelper uninstall` | entfernen (Dateien bleiben unberührt) |

Einstellungen stehen in `/etc/filehelper.env` (danach `filehelper restart`).

## Sicherheit

- Anmeldung mit eigenem Konto (Passwörter mit scrypt gespeichert), Sperre nach 10 Fehlversuchen für 15 Minuten
- Sitzungs-Cookie `HttpOnly`/`SameSite=Strict`, Schutz gegen fremde Seiten (CSRF), strenge Content-Security-Policy
- Kein Zugriff außerhalb der Freigaben – auch nicht über Verknüpfungen (Symlinks)
- HTML-, SVG- und Skriptdateien werden nie als Webseite ausgeführt, sondern als Text angezeigt
- Geteilte Links sind nur für das Geteilte gültig, optional mit Passwort und Ablaufdatum
- Läuft in einem unprivilegierten Container – root im Container ist auf dem Host ein normaler Benutzer

## Technik

Python (Starlette/Uvicorn) und eine Oberfläche ohne Build-Schritt (Vanilla-JS, gleiche Bausteine wie die Proxmox Zentrale). Vorschaubilder mit Pillow (+ pillow-heif für HEIC) und ffmpeg für Videos; Zwischenspeicher unter `/var/lib/filehelper/thumbs` (Größe per `FH_THUMB_CACHE_MB`).

Lokal ausprobieren:

```bash
pip install -r backend/requirements.txt
FH_ROOT=./test-data FH_STATE_DIR=./data python -m backend.cli passwd admin
FH_ROOT=./test-data FH_STATE_DIR=./data uvicorn backend.app:app --port 8080
```
