"""Gespeicherte Einstellungen: Benutzer, Favoriten, geteilte Links.

Alles liegt in einer JSON-Datei unter FH_STATE_DIR (Standard /var/lib/filehelper).
Schreiben passiert atomar (temporäre Datei + rename), damit nichts kaputtgeht,
wenn der Container mitten im Speichern ausgeschaltet wird.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

STATE_DIR = Path(os.environ.get("FH_STATE_DIR", "/var/lib/filehelper"))
CONFIG_FILE = STATE_DIR / "config.json"
USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{2,32}$")

_lock = threading.RLock()
_data: dict | None = None


def _default() -> dict:
    return {"secret": secrets.token_hex(32), "users": {}, "links": {}, "settings": {"labels": {}, "hidden": []}}


def load() -> dict:
    global _data
    with _lock:
        if _data is None:
            try:
                _data = json.loads(CONFIG_FILE.read_text())
            except FileNotFoundError:
                _data = _default()
                save()
            except (OSError, ValueError) as e:  # kaputte Datei nicht überschreiben
                raise SystemExit(f"Konfiguration {CONFIG_FILE} ist nicht lesbar: {e}")
            for k, v in _default().items():
                _data.setdefault(k, v)
        return _data


def save() -> None:
    with _lock:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_FILE.with_suffix(".tmp")
        with open(tmp, "w") as fh:
            json.dump(_data, fh, indent=1, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, CONFIG_FILE)


def secret() -> bytes:
    return load()["secret"].encode()


# ---------------------------------------------------------------------------
# Passwörter
# ---------------------------------------------------------------------------
def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def check_password(pw: str, stored: str) -> bool:
    try:
        algo, salt_b64, dk_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(pw.encode(), salt=base64.b64decode(salt_b64), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(dk, base64.b64decode(dk_b64))
    except (ValueError, TypeError):
        return False


def password_problem(pw: str) -> str | None:
    if not isinstance(pw, str) or len(pw) < 8:
        return "Das Passwort muss mindestens 8 Zeichen lang sein."
    if len(pw) > 200:
        return "Das Passwort ist zu lang."
    return None


# ---------------------------------------------------------------------------
# Benutzer
# ---------------------------------------------------------------------------
def users() -> dict:
    return load()["users"]


def get_user(name: str) -> dict | None:
    return users().get(name)


def public_user(name: str, u: dict) -> dict:
    return {"name": name, "admin": bool(u.get("admin")), "readonly": bool(u.get("readonly")),
            "created": u.get("created"), "last_login": u.get("last_login")}


def set_user(name: str, *, password: str | None = None, admin: bool | None = None, readonly: bool | None = None) -> dict:
    with _lock:
        u = users().setdefault(name, {"created": int(time.time()), "favorites": [], "ver": 1})
        if password is not None:
            u["hash"] = hash_password(password)
            u["ver"] = int(u.get("ver", 1)) + 1  # alte Anmeldungen werden ungültig
        if admin is not None:
            u["admin"] = bool(admin)
        if readonly is not None:
            u["readonly"] = bool(readonly)
        save()
        return u


def delete_user(name: str) -> None:
    with _lock:
        users().pop(name, None)
        save()


def touch_login(name: str) -> None:
    with _lock:
        u = get_user(name)
        if u:
            u["last_login"] = int(time.time())
            save()


# ---------------------------------------------------------------------------
# Sitzungen (signiertes Cookie, kein Server-Speicher nötig)
# ---------------------------------------------------------------------------
def _sign(payload: bytes) -> str:
    return base64.urlsafe_b64encode(hmac.new(secret(), payload, hashlib.sha256).digest()).decode().rstrip("=")


def make_token(data: dict) -> str:
    raw = base64.urlsafe_b64encode(json.dumps(data, separators=(",", ":")).encode()).decode().rstrip("=")
    return raw + "." + _sign(raw.encode())


def read_token(token: str | None) -> dict | None:
    if not token or "." not in token:
        return None
    raw, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(raw.encode())):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("exp", 0) < time.time():
        return None
    return data


def session_token(name: str, days: int) -> str:
    u = get_user(name) or {}
    return make_token({"u": name, "v": u.get("ver", 1), "exp": int(time.time()) + days * 86400})


def session_user(token: str | None) -> tuple[str, dict] | None:
    data = read_token(token)
    if not data or "u" not in data:
        return None
    u = get_user(data["u"])
    if not u or u.get("ver", 1) != data.get("v"):
        return None
    return data["u"], u


# ---------------------------------------------------------------------------
# Favoriten
# ---------------------------------------------------------------------------
def set_favorites(name: str, favs: list) -> list:
    clean = []
    for f in favs[:100]:
        if isinstance(f, dict) and isinstance(f.get("share"), str) and isinstance(f.get("path", ""), str):
            clean.append({"share": f["share"][:200], "path": f.get("path", "")[:2000], "name": str(f.get("name", ""))[:200],
                          "dir": bool(f.get("dir", True))})
    with _lock:
        u = get_user(name)
        if u is not None:
            u["favorites"] = clean
            save()
    return clean


# ---------------------------------------------------------------------------
# Geteilte Links
# ---------------------------------------------------------------------------
def links() -> dict:
    return load()["links"]


def add_link(*, share: str, path: str, is_dir: bool, name: str, user: str, expires: int | None, password: str | None) -> dict:
    with _lock:
        lid = secrets.token_hex(6)
        link = {"id": lid, "token": secrets.token_urlsafe(18), "share": share, "path": path, "dir": is_dir, "name": name,
                "user": user, "created": int(time.time()), "expires": expires, "downloads": 0,
                "pw": hash_password(password) if password else None}
        links()[lid] = link
        save()
        return link


def link_by_token(token: str) -> dict | None:
    for l in links().values():
        if hmac.compare_digest(l["token"], token):
            if l.get("expires") and l["expires"] < time.time():
                return None
            return l
    return None


def delete_link(lid: str) -> None:
    with _lock:
        links().pop(lid, None)
        save()


def count_download(lid: str) -> None:
    with _lock:
        l = links().get(lid)
        if l:
            l["downloads"] = int(l.get("downloads", 0)) + 1
            save()


def purge_expired_links() -> None:
    now = time.time()
    with _lock:
        old = [k for k, l in links().items() if l.get("expires") and l["expires"] < now - 30 * 86400]
        for k in old:
            links().pop(k, None)
        if old:
            save()


def public_link(l: dict) -> dict:
    return {k: l.get(k) for k in ("id", "token", "share", "path", "dir", "name", "user", "created", "expires", "downloads")} | {"protected": bool(l.get("pw"))}


# ---------------------------------------------------------------------------
# Anzeige-Einstellungen für Freigaben
# ---------------------------------------------------------------------------
def settings() -> dict:
    return load()["settings"]


def set_setting(key: str, value) -> None:
    with _lock:
        settings()[key] = value
        save()


def set_share_settings(name: str, *, label: str | None, hidden: bool | None) -> None:
    with _lock:
        s = settings()
        if label is not None:
            if label.strip():
                s["labels"][name] = label.strip()[:60]
            else:
                s["labels"].pop(name, None)
        if hidden is not None:
            hs = set(s.get("hidden", []))
            hs.add(name) if hidden else hs.discard(name)
            s["hidden"] = sorted(hs)
        save()
