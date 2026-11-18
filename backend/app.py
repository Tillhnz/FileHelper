"""FileHelper – deine Dateien im Browser. Starlette-App (API + Oberfläche)."""
from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import subprocess
import time
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import fsops, store, thumbs
from .fsops import FsError

BASE = Path(__file__).resolve().parent.parent
FRONTEND = BASE / "frontend"
VERSION = (BASE / "VERSION").read_text().strip() if (BASE / "VERSION").exists() else "dev"
REPO = os.environ.get("FH_REPO", "Tillhnz/FileHelper")
BRANCH = os.environ.get("FH_BRANCH", "main")
COOKIE = "fh_session"
FS_TIMEOUT = float(os.environ.get("FH_FS_TIMEOUT", "20"))
CHUNK = 1024 * 1024

# ---------------------------------------------------------------------------
# Hilfen
# ---------------------------------------------------------------------------


def err(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


async def fs(fn, *args, timeout: float | None = FS_TIMEOUT, **kw):
    """Dateisystem-Zugriffe in einem Thread – mit Zeitlimit, falls eine NAS hängt."""
    try:
        return await asyncio.wait_for(asyncio.to_thread(fn, *args, **kw), timeout)
    except asyncio.TimeoutError:
        raise FsError(504, "Die NAS antwortet gerade nicht. Ist sie eingeschaltet und im Netz?")
    except PermissionError:
        raise FsError(403, "Keine Berechtigung. Die Freigabe ist für FileHelper vermutlich nur lesbar.")
    except FileNotFoundError:
        raise FsError(404, "Datei oder Ordner nicht gefunden.")
    except FileExistsError:
        raise FsError(409, "Es gibt schon eine Datei oder einen Ordner mit diesem Namen.")
    except IsADirectoryError:
        raise FsError(400, "Das ist ein Ordner.")
    except NotADirectoryError:
        raise FsError(400, "Das ist kein Ordner.")
    except OSError as e:
        if e.errno == 28:
            raise FsError(507, "Kein Speicherplatz mehr frei.")
        if e.errno == 30:
            raise FsError(403, "Die Freigabe ist schreibgeschützt.")
        raise FsError(500, e.strerror or str(e))


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def disposition(name: str, inline: bool) -> str:
    ascii_name = re.sub(r'[^A-Za-z0-9._ ()\-]', "_", name) or "download"
    return f'{"inline" if inline else "attachment"}; filename="{ascii_name}"; filename*=UTF-8\'\'{urllib.parse.quote(name)}'


async def body_json(request: Request) -> dict:
    try:
        data = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise FsError(400, "Ungültige Anfrage")
    if not isinstance(data, dict):
        raise FsError(400, "Ungültige Anfrage")
    return data


class User:
    def __init__(self, name: str, data: dict):
        self.name = name
        self.admin = bool(data.get("admin"))
        self.readonly = bool(data.get("readonly")) and not self.admin
        self.data = data


def current_user(request: Request) -> User | None:
    s = store.session_user(request.cookies.get(COOKIE))
    return User(*s) if s else None


def need_user(request: Request) -> User:
    u = current_user(request)
    if not u:
        raise FsError(401, "Bitte anmelden.")
    return u


def need_writer(request: Request) -> User:
    u = need_user(request)
    if u.readonly:
        raise FsError(403, "Dein Konto darf nur ansehen und herunterladen.")
    return u


def need_admin(request: Request) -> User:
    u = need_user(request)
    if not u.admin:
        raise FsError(403, "Nur für Administratoren.")
    return u


def q(request: Request, key: str, default: str = "") -> str:
    return request.query_params.get(key, default)


# ---------------------------------------------------------------------------
# Anmeldung
# ---------------------------------------------------------------------------
_fails: dict[str, list[float]] = {}


def _too_many(key: str) -> bool:
    now = time.time()
    arr = [t for t in _fails.get(key, []) if now - t < 900]
    _fails[key] = arr
    return len(arr) >= 10


def _fail(key: str) -> None:
    _fails.setdefault(key, []).append(time.time())


def _set_session(resp: Response, request: Request, name: str, remember: bool) -> None:
    days = 30 if remember else 1
    resp.set_cookie(COOKIE, store.session_token(name, days), max_age=days * 86400 if remember else None, httponly=True,
                    samesite="strict", secure=request.url.scheme == "https", path="/")


async def login(request: Request):
    data = await body_json(request)
    name, pw = str(data.get("username", "")).strip(), str(data.get("password", ""))
    key = f"{client_ip(request)}|{name.lower()}"
    if _too_many(key):
        return err(429, "Zu viele Fehlversuche. Bitte in 15 Minuten noch einmal probieren.")
    u = store.get_user(name)
    ok = await asyncio.to_thread(store.check_password, pw, u["hash"]) if u and u.get("hash") else False
    if not ok:
        _fail(key)
        await asyncio.sleep(0.6)
        return err(401, "Benutzername oder Passwort stimmt nicht.")
    _fails.pop(key, None)
    store.touch_login(name)
    resp = JSONResponse({"user": store.public_user(name, u)})
    _set_session(resp, request, name, bool(data.get("remember", True)))
    return resp


async def logout(request: Request):
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


async def me(request: Request):
    u = need_user(request)
    return JSONResponse({"user": store.public_user(u.name, u.data), "favorites": u.data.get("favorites", []), "version": VERSION})


async def change_password(request: Request):
    u = need_user(request)
    data = await body_json(request)
    if not await asyncio.to_thread(store.check_password, str(data.get("old", "")), u.data.get("hash", "")):
        return err(400, "Das bisherige Passwort stimmt nicht.")
    prob = store.password_problem(data.get("new"))
    if prob:
        return err(400, prob)
    await asyncio.to_thread(store.set_user, u.name, password=data["new"])
    resp = JSONResponse({"ok": True})
    _set_session(resp, request, u.name, True)
    return resp


async def favorites(request: Request):
    u = need_user(request)
    data = await body_json(request)
    favs = data.get("favorites")
    if not isinstance(favs, list):
        return err(400, "Ungültige Favoriten")
    return JSONResponse({"favorites": store.set_favorites(u.name, favs)})


# ---------------------------------------------------------------------------
# Benutzerverwaltung
# ---------------------------------------------------------------------------
async def users_list(request: Request):
    need_admin(request)
    return JSONResponse({"users": [store.public_user(n, u) for n, u in sorted(store.users().items())]})


async def users_save(request: Request):
    admin = need_admin(request)
    data = await body_json(request)
    name = str(data.get("name", "")).strip()
    create = request.method == "POST"
    if create:
        if not store.USERNAME_RE.match(name):
            return err(400, "Benutzername: 2–32 Zeichen, nur Buchstaben, Zahlen, Punkt, - und _.")
        if store.get_user(name):
            return err(409, "Diesen Benutzer gibt es schon.")
    else:
        name = request.path_params["name"]
        if not store.get_user(name):
            return err(404, "Benutzer nicht gefunden.")
    pw = data.get("password") or None
    if create or pw:
        prob = store.password_problem(pw)
        if prob:
            return err(400, prob)
    is_admin = data.get("admin")
    if name == admin.name and is_admin is False:
        return err(400, "Du kannst dir die Administrator-Rechte nicht selbst nehmen.")
    await asyncio.to_thread(store.set_user, name, password=pw, admin=is_admin if is_admin is not None else (False if create else None),
                            readonly=data.get("readonly") if data.get("readonly") is not None else (False if create else None))
    return JSONResponse({"user": store.public_user(name, store.get_user(name))})


async def users_delete(request: Request):
    admin = need_admin(request)
    name = request.path_params["name"]
    if name == admin.name:
        return err(400, "Du kannst dich nicht selbst löschen.")
    store.delete_user(name)
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------------------
# Freigaben & Ordner
# ---------------------------------------------------------------------------
async def shares(request: Request):
    u = need_user(request)
    show_hidden = u.admin and q(request, "all") == "1"
    items = await fs(fsops.list_shares, show_hidden, timeout=10)

    async def info(s):
        try:
            i = await asyncio.wait_for(asyncio.to_thread(fsops._fs_info, os.path.join(fsops.ROOT, s["name"])), 3)
            s.update(i)
        except asyncio.TimeoutError:
            s["stale"] = True
        if u.readonly:
            s["writable"] = False
        return s
    items = await asyncio.gather(*(info(s) for s in items))
    return JSONResponse({"shares": items, "root": fsops.ROOT})


async def share_settings(request: Request):
    need_admin(request)
    data = await body_json(request)
    name = request.path_params["name"]
    fsops.share_root(name)
    store.set_share_settings(name, label=data.get("label"), hidden=data.get("hidden"))
    return JSONResponse({"ok": True})


async def list_dir(request: Request):
    u = need_user(request)
    data = await fs(fsops.list_dir, q(request, "share"), q(request, "path"))
    if u.readonly:
        data["writable"] = False
    return JSONResponse(data)


async def search(request: Request):
    need_user(request)
    data = await fs(fsops.search, q(request, "share"), q(request, "path"), q(request, "q"), timeout=15)
    return JSONResponse(data)


async def stat_entry(request: Request):
    need_user(request)
    _root, path, parts = fsops.resolve(q(request, "share"), q(request, "path"))
    st = await fs(os.stat, path)
    info = fsops.entry_info(parts[-1] if parts else q(request, "share"), st)
    if info["dir"] and q(request, "size") == "1":
        info.update(await fs(fsops.dir_size, path, timeout=20))
    return JSONResponse(info)


# ---------------------------------------------------------------------------
# Herunterladen (mit Range für Videos) & Vorschau
# ---------------------------------------------------------------------------
def _parse_range(header: str, size: int) -> tuple[int, int] | None:
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not m or (not m.group(1) and not m.group(2)):
        return None
    if m.group(1):
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
    else:
        start = max(0, size - int(m.group(2)))
        end = size - 1
    if start >= size or start > end:
        return None
    return start, min(end, size - 1)


def _file_iter(path: str, start: int, length: int):
    with open(path, "rb") as fh:
        fh.seek(start)
        remaining = length
        while remaining > 0:
            chunk = fh.read(min(CHUNK, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


async def send_file(request: Request, path: str, name: str, *, download: bool) -> Response:
    st = await fs(os.stat, path)
    if os.path.isdir(path):
        raise FsError(400, "Ordner bitte als ZIP herunterladen.")
    size = st.st_size
    etag = f'"{int(st.st_mtime_ns):x}-{size:x}"'
    ext = fsops.ext_of(name)
    mime = fsops.guess_mime(name)
    inline = not download
    if inline and ext in fsops.UNSAFE_INLINE:
        mime = "text/plain; charset=utf-8"  # nie als Webseite ausführen
    elif inline and fsops.kind_of(name) == "text":
        mime = "text/plain; charset=utf-8" if not mime.startswith("text/") or "charset" not in mime else mime
        if mime.startswith("text/") and "charset" not in mime:
            mime += "; charset=utf-8"
    elif inline and mime == "application/octet-stream":
        inline = False
    headers = {"Accept-Ranges": "bytes", "ETag": etag, "Last-Modified": time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(st.st_mtime)),
               "Content-Disposition": disposition(name, inline), "Cache-Control": "private, max-age=0, must-revalidate",
               "X-Content-Type-Options": "nosniff"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    rng = request.headers.get("range")
    if rng and (not request.headers.get("if-range") or request.headers.get("if-range") == etag):
        r = _parse_range(rng, size)
        if r is None:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        start, end = r
        length = end - start + 1
        headers.update({"Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(length)})
        return StreamingResponse(_file_iter(path, start, length), status_code=206, media_type=mime, headers=headers)
    headers["Content-Length"] = str(size)
    if request.method == "HEAD":
        return Response(status_code=200, media_type=mime, headers=headers)
    return StreamingResponse(_file_iter(path, 0, size), media_type=mime, headers=headers)


async def download(request: Request):
    need_user(request)
    _root, path, parts = fsops.resolve(q(request, "share"), q(request, "path"))
    if not parts:
        raise FsError(400, "Bitte eine Datei wählen.")
    return await send_file(request, path, parts[-1], download=q(request, "dl") == "1")


async def send_thumb(request: Request, path: str, name: str) -> Response:
    if not thumbs.supported(name):
        raise FsError(415, "Für diese Datei gibt es keine Vorschau.")
    try:
        size = int(q(request, "s", "256"))
    except ValueError:
        size = 256
    try:
        target, _cached = await asyncio.wait_for(asyncio.to_thread(thumbs.get, path, size), 60)
    except asyncio.TimeoutError:
        raise FsError(504, "Die Vorschau braucht zu lange.")
    except FileNotFoundError:
        raise FsError(404, "Datei nicht gefunden.")
    except Exception as e:  # noqa: BLE001 – kaputte Bilder sollen die App nicht stören
        raise FsError(415, f"Keine Vorschau möglich ({type(e).__name__}).")
    thumbs.maybe_prune()
    return FileResponse(target, media_type="image/webp", headers={"Cache-Control": "private, max-age=604800"})


async def thumb(request: Request):
    need_user(request)
    _root, path, parts = fsops.resolve(q(request, "share"), q(request, "path"))
    return await send_thumb(request, path, parts[-1] if parts else "")


def _zip_name(names: list[str], fallback: str) -> str:
    base = names[0] if len(names) == 1 else fallback
    return (base or "Dateien") + ".zip"


_zip_tickets: dict[str, dict] = {}


async def zip_ticket(request: Request):
    """Für viele ausgewählte Dateien: Auswahl vorab schicken (URL wäre sonst zu lang)."""
    u = need_user(request)
    data = await body_json(request)
    items = data.get("items")
    if not isinstance(items, list) or not items or len(items) > 5000:
        return err(400, "Ungültige Auswahl")
    now = time.time()
    for k in [k for k, t in _zip_tickets.items() if t["exp"] < now]:
        _zip_tickets.pop(k, None)
    tid = secrets.token_urlsafe(16)
    _zip_tickets[tid] = {"user": u.name, "share": str(data.get("share", "")), "path": str(data.get("path", "")),
                         "items": [str(i) for i in items], "exp": now + 300}
    return JSONResponse({"ticket": tid})


async def zip_download(request: Request):
    u = need_user(request)
    share, base = q(request, "share"), q(request, "path")
    names = request.query_params.getlist("item")
    ticket = _zip_tickets.pop(q(request, "ticket"), None) if q(request, "ticket") else None
    if ticket:
        if ticket["user"] != u.name or ticket["exp"] < time.time():
            raise FsError(403, "Download-Link abgelaufen.")
        share, base, names = ticket["share"], ticket["path"], ticket["items"]
    _root, base_path, base_parts = fsops.resolve(share, base)
    if not names:  # ganzen Ordner
        items = [(base_path, base_parts[-1] if base_parts else share)]
        zname = _zip_name([], base_parts[-1] if base_parts else share)
    else:
        items = []
        for n in names[:5000]:
            if not fsops.valid_name(n):
                raise FsError(400, "Ungültiger Name")
            _r, p, _ = fsops.resolve(share, f"{base}/{n}")
            items.append((p, n))
        zname = _zip_name(names, base_parts[-1] if base_parts else share)
    return StreamingResponse(fsops.zip_stream(items), media_type="application/zip",
                             headers={"Content-Disposition": disposition(zname, False), "Cache-Control": "no-store"})


# ---------------------------------------------------------------------------
# Hochladen (in Stücken, damit auch große Dateien durch Proxys passen)
# ---------------------------------------------------------------------------
UPLOAD_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _part_path(directory: str, upload_id: str) -> str:
    return os.path.join(directory, f".fh-{upload_id}.part")


async def upload(request: Request):
    need_writer(request)
    share, base = q(request, "share"), q(request, "path")
    relname = q(request, "name")
    upload_id = q(request, "id")
    if not UPLOAD_ID.match(upload_id):
        return err(400, "Ungültige Upload-Kennung")
    parts = fsops.clean_rel(relname)
    if not parts or not all(fsops.valid_name(p) for p in parts):
        return err(400, f"Ungültiger Dateiname: {relname}")
    try:
        offset = int(q(request, "offset", "0"))
    except ValueError:
        return err(400, "Ungültiger Versatz")
    final = q(request, "final") == "1"
    _root, base_path, _ = fsops.resolve(share, base)
    # Unterordner (beim Hochladen ganzer Ordner) anlegen
    target_dir = base_path
    if len(parts) > 1:
        _r, target_dir, _ = fsops.resolve(share, "/".join([base, *parts[:-1]]), must_exist=False)
        await fs(os.makedirs, target_dir, exist_ok=True)
    if not os.path.isdir(target_dir):
        return err(400, "Zielordner gibt es nicht.")
    part = _part_path(target_dir, upload_id)

    def prepare():
        if offset == 0:
            return open(part, "wb")
        cur = os.path.getsize(part) if os.path.exists(part) else -1
        if cur != offset:
            return cur
        return open(part, "ab")
    fh = await fs(prepare)
    if isinstance(fh, int):
        return JSONResponse({"error": "Upload-Stand passt nicht", "have": max(fh, 0)}, status_code=409)
    written = 0
    try:
        buf = bytearray()
        async for chunk in request.stream():
            buf += chunk
            if len(buf) >= 4 * CHUNK:
                data = bytes(buf)
                buf.clear()
                await fs(fh.write, data, timeout=120)
                written += len(data)
        if buf:
            await fs(fh.write, bytes(buf), timeout=120)
            written += len(buf)
    finally:
        await fs(fh.close, timeout=120)
    if not final:
        return JSONResponse({"ok": True, "have": offset + written})

    conflict = q(request, "conflict", "rename")
    name = parts[-1]

    def finish():
        final_name = name
        if os.path.lexists(os.path.join(target_dir, name)):
            if conflict == "skip":
                os.unlink(part)
                return None
            if conflict != "overwrite":
                final_name = fsops.unique_name(target_dir, name)
            elif os.path.isdir(os.path.join(target_dir, name)):
                raise FsError(409, "Es gibt schon einen Ordner mit diesem Namen.")
        dest = os.path.join(target_dir, final_name)
        os.replace(part, dest)
        try:
            mtime = float(q(request, "mtime", "0")) / 1000
            if 315532800 < mtime < time.time() + 86400:
                os.utime(dest, (time.time(), mtime))
        except (ValueError, OSError):
            pass
        return final_name
    saved = await fs(finish, timeout=60)
    return JSONResponse({"ok": True, "name": saved, "skipped": saved is None})


async def upload_cancel(request: Request):
    need_writer(request)
    upload_id = q(request, "id")
    if not UPLOAD_ID.match(upload_id):
        return err(400, "Ungültige Upload-Kennung")
    parts = fsops.clean_rel(q(request, "name"))
    sub = "/".join([q(request, "path"), *parts[:-1]])
    try:
        _r, d, _ = fsops.resolve(q(request, "share"), sub)
        await fs(os.unlink, _part_path(d, upload_id))
    except FsError:
        pass
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------------------
# Ändern: Ordner anlegen, umbenennen, verschieben, kopieren, löschen, Textdatei speichern
# ---------------------------------------------------------------------------
async def mkdir(request: Request):
    need_writer(request)
    data = await body_json(request)
    name = str(data.get("name", "")).strip()
    if not fsops.valid_name(name):
        return err(400, "Ungültiger Ordnername.")
    _r, path, _ = fsops.resolve(data.get("share"), f"{data.get('path', '')}/{name}", must_exist=False)
    await fs(os.mkdir, path)
    return JSONResponse({"ok": True, "name": name})


async def rename(request: Request):
    need_writer(request)
    data = await body_json(request)
    new = str(data.get("new", "")).strip()
    if not fsops.valid_name(new):
        return err(400, "Ungültiger Name. Nicht erlaubt: / und Namen, die mit .fh- beginnen.")
    _r, path, parts = fsops.resolve(data.get("share"), data.get("path"))
    if not parts:
        return err(400, "Die Freigabe selbst kann hier nicht umbenannt werden.")
    dest = os.path.join(os.path.dirname(path), new)
    if os.path.lexists(dest) and os.path.normcase(dest) != os.path.normcase(path):
        return err(409, "Es gibt schon etwas mit diesem Namen.")
    await fs(os.rename, path, dest)
    return JSONResponse({"ok": True, "name": new})


async def transfer(request: Request):
    u = need_writer(request)
    data = await body_json(request)
    move = data.get("mode") == "move"
    share, base = data.get("share"), data.get("path", "")
    names = data.get("items") or []
    if not isinstance(names, list) or not names:
        return err(400, "Nichts ausgewählt.")
    _r, dest, _ = fsops.resolve(data.get("dest_share"), data.get("dest_path", ""))
    if not os.path.isdir(dest):
        return err(400, "Ziel ist kein Ordner.")
    pairs = []
    real_dest = os.path.realpath(dest)
    for n in names[:5000]:
        if not isinstance(n, str) or not fsops.valid_name(n):
            return err(400, "Ungültiger Name")
        _r, src, _ = fsops.resolve(share, f"{base}/{n}")
        real_src = os.path.realpath(src)
        if real_dest == real_src or real_dest.startswith(real_src + os.sep):
            return err(400, f"„{n}“ kann nicht in sich selbst {'verschoben' if move else 'kopiert'} werden.")
        if move and os.path.dirname(real_src) == real_dest:
            return err(400, "Das liegt schon in diesem Ordner.")
        pairs.append((src, dest))
    title = f"{len(pairs)} {'Element' if len(pairs) == 1 else 'Elemente'} {'verschieben' if move else 'kopieren'}"
    job = fsops.transfer(u.name, pairs, move, title)
    return JSONResponse({"job": job.public()})


async def delete(request: Request):
    u = need_writer(request)
    data = await body_json(request)
    share, base = data.get("share"), data.get("path", "")
    names = data.get("items") or []
    if not isinstance(names, list) or not names:
        return err(400, "Nichts ausgewählt.")
    paths = []
    for n in names[:5000]:
        if not isinstance(n, str) or not fsops.valid_name(n):
            return err(400, "Ungültiger Name")
        _r, p, parts = fsops.resolve(share, f"{base}/{n}")
        if not parts:
            return err(400, "Die Freigabe selbst kann nicht gelöscht werden.")
        paths.append(p)
    job = fsops.delete(u.name, paths, f"{len(paths)} {'Element' if len(paths) == 1 else 'Elemente'} löschen")
    return JSONResponse({"job": job.public()})


async def job_status(request: Request):
    u = need_user(request)
    job = fsops.JOBS.get(request.path_params["job_id"])
    if not job or (job.user != u.name and not u.admin):
        return err(404, "Aufgabe nicht gefunden.")
    return JSONResponse({"job": job.public()})


async def save_text(request: Request):
    need_writer(request)
    data = await body_json(request)
    text = data.get("text")
    if not isinstance(text, str) or len(text.encode()) > fsops.MAX_TEXT_PREVIEW * 4:
        return err(400, "Text zu groß.")
    _r, path, parts = fsops.resolve(data.get("share"), data.get("path"), must_exist=False)
    if not parts or not fsops.valid_name(parts[-1]):
        return err(400, "Ungültiger Dateiname.")
    if data.get("create") and os.path.lexists(path):
        return err(409, "Es gibt schon eine Datei mit diesem Namen.")

    def write():
        tmp = os.path.join(os.path.dirname(path), f".fh-{secrets.token_hex(6)}.part")
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        os.replace(tmp, path)
    await fs(write)
    return JSONResponse({"ok": True})


# ---------------------------------------------------------------------------
# Geteilte Links
# ---------------------------------------------------------------------------
async def links_list(request: Request):
    u = need_user(request)
    items = [store.public_link(l) for l in store.links().values() if u.admin or l["user"] == u.name]
    items.sort(key=lambda l: -l["created"])
    return JSONResponse({"links": items})


async def links_create(request: Request):
    u = need_writer(request)
    data = await body_json(request)
    share, path = data.get("share"), data.get("path", "")
    _r, abs_path, parts = fsops.resolve(share, path)
    days = data.get("days")
    expires = int(time.time() + float(days) * 86400) if days else None
    pw = data.get("password") or None
    if pw and len(pw) < 4:
        return err(400, "Das Link-Passwort muss mindestens 4 Zeichen haben.")
    link = await asyncio.to_thread(store.add_link, share=share, path="/".join(parts), is_dir=os.path.isdir(abs_path),
                                   name=parts[-1] if parts else share, user=u.name, expires=expires, password=pw)
    return JSONResponse({"link": store.public_link(link)})


async def links_delete(request: Request):
    u = need_user(request)
    l = store.links().get(request.path_params["lid"])
    if not l or (l["user"] != u.name and not u.admin):
        return err(404, "Link nicht gefunden.")
    store.delete_link(l["id"])
    return JSONResponse({"ok": True})


# Öffentliche Seite eines Links -------------------------------------------------
_link_fails: dict[str, list[float]] = {}


def _link(request: Request, *, need_auth: bool = True) -> dict:
    l = store.link_by_token(request.path_params["token"])
    if not l:
        raise FsError(404, "Dieser Link ist abgelaufen oder wurde gelöscht.")
    if need_auth and l.get("pw"):
        tok = store.read_token(request.cookies.get(f"fh_l_{l['id']}"))
        if not tok or tok.get("l") != l["id"]:
            raise FsError(401, "Passwort erforderlich.")
    return l


def _link_path(l: dict, sub: str) -> tuple[str, list[str]]:
    sub_parts = fsops.clean_rel(sub)
    if sub_parts and not l["dir"]:
        raise FsError(404, "Nicht gefunden.")
    _r, p, parts = fsops.resolve(l["share"], "/".join([l["path"], *sub_parts]))
    return p, parts


async def public_info(request: Request):
    l = _link(request, need_auth=False)
    locked = False
    if l.get("pw"):
        tok = store.read_token(request.cookies.get(f"fh_l_{l['id']}"))
        locked = not tok or tok.get("l") != l["id"]
    info = {"name": l["name"], "dir": l["dir"], "expires": l.get("expires"), "locked": locked}
    if not locked and not l["dir"]:
        try:
            p, _ = _link_path(l, "")
            st = await fs(os.stat, p, timeout=5)
            info.update({"size": st.st_size, "mtime": int(st.st_mtime), "kind": fsops.kind_of(l["name"]),
                         "thumb": thumbs.supported(l["name"]), "convert": fsops.ext_of(l["name"]) in fsops.CONVERT_IMAGES})
        except FsError as e:
            info["error"] = e.message
    return JSONResponse(info)


async def public_auth(request: Request):
    l = _link(request, need_auth=False)
    key = f"{client_ip(request)}|{l['id']}"
    now = time.time()
    arr = [t for t in _link_fails.get(key, []) if now - t < 900]
    _link_fails[key] = arr
    if len(arr) >= 10:
        return err(429, "Zu viele Versuche. Bitte später noch einmal.")
    data = await body_json(request)
    if not l.get("pw") or not await asyncio.to_thread(store.check_password, str(data.get("password", "")), l["pw"]):
        arr.append(now)
        await asyncio.sleep(0.6)
        return err(401, "Falsches Passwort.")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(f"fh_l_{l['id']}", store.make_token({"l": l["id"], "exp": int(now) + 86400}), max_age=86400, httponly=True,
                    samesite="lax", secure=request.url.scheme == "https", path=f"/s/{l['token']}")
    return resp


async def public_list(request: Request):
    l = _link(request)
    if not l["dir"]:
        raise FsError(400, "Das ist eine einzelne Datei.")
    p, parts = _link_path(l, q(request, "path"))
    data = await fs(fsops.list_dir, l["share"], "/".join(parts))
    data["items"] = [i for i in data["items"] if not i["hidden"]]
    for i in data["items"]:
        i["thumb"] = not i["dir"] and thumbs.supported(i["name"])
    return JSONResponse({"items": data["items"], "path": q(request, "path").strip("/")})


async def public_file(request: Request):
    l = _link(request)
    p, parts = _link_path(l, q(request, "path"))
    dl = q(request, "dl") == "1"
    if dl:
        store.count_download(l["id"])
    return await send_file(request, p, parts[-1] if parts else l["name"], download=dl)


async def public_thumb(request: Request):
    l = _link(request)
    p, parts = _link_path(l, q(request, "path"))
    return await send_thumb(request, p, parts[-1] if parts else l["name"])


async def public_zip(request: Request):
    l = _link(request)
    if not l["dir"]:
        raise FsError(400, "Das ist eine einzelne Datei.")
    p, parts = _link_path(l, q(request, "path"))
    store.count_download(l["id"])
    name = parts[-1] if parts else l["name"]
    return StreamingResponse(fsops.zip_stream([(p, name)]), media_type="application/zip",
                             headers={"Content-Disposition": disposition(name + ".zip", False), "Cache-Control": "no-store"})


async def public_page(request: Request):
    return _html("share.html")


# ---------------------------------------------------------------------------
# System: Version, Update, Zwischenspeicher
# ---------------------------------------------------------------------------
_latest = {"at": 0.0, "version": None}


def _fetch_latest() -> str | None:
    try:
        url = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/VERSION"
        with urllib.request.urlopen(url, timeout=6) as r:
            return r.read().decode().strip()[:20]
    except Exception:  # noqa: BLE001
        return None


def _vkey(v: str) -> tuple:
    return tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[.-]", v or "0"))


async def system(request: Request):
    u = need_user(request)
    info = {"version": VERSION, "root": fsops.ROOT, "thumbs": {**thumbs.status(), "step": (FRONTEND / "vendor/occt/occt-import-js.wasm").exists()},
            "admin": u.admin}
    if u.admin:
        if time.time() - _latest["at"] > 6 * 3600 or q(request, "check") == "1":
            _latest.update(at=time.time(), version=await asyncio.to_thread(_fetch_latest))
        info["latest"] = _latest["version"]
        info["update"] = bool(_latest["version"] and _vkey(_latest["version"]) > _vkey(VERSION))
        info["cache"] = await asyncio.to_thread(thumbs.cache_size)
        info["repo"] = REPO
    return JSONResponse(info)


async def system_update(request: Request):
    need_admin(request)
    script = BASE / "install.sh"
    if not script.exists():
        return err(500, "install.sh nicht gefunden.")
    try:
        subprocess.Popen(["systemd-run", "--unit", f"filehelper-update-{int(time.time())}", "--collect",
                          "/usr/bin/env", "bash", str(script), "--update"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        return err(500, "systemd-run fehlt – bitte im Container „filehelper update“ ausführen.")
    return JSONResponse({"ok": True})


async def cache_clear(request: Request):
    need_admin(request)
    await asyncio.to_thread(thumbs.clear)
    return JSONResponse({"ok": True})


async def health(request: Request):
    return JSONResponse({"ok": True, "version": VERSION})


# ---------------------------------------------------------------------------
# Oberfläche
# ---------------------------------------------------------------------------
_html_cache: dict[str, str] = {}


def _html(name: str) -> Response:
    if name not in _html_cache or VERSION == "dev":
        _html_cache[name] = (FRONTEND / name).read_text().replace("{{VERSION}}", VERSION)
    return Response(_html_cache[name], media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-cache"})


async def index(request: Request):
    return _html("index.html")


CSP = ("default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self'; worker-src 'self'; object-src 'none'; frame-src 'self'; frame-ancestors 'self'; "
       "base-uri 'none'; form-action 'self'")
# Nur der Hintergrund-Leser für 3D-Modelle darf WebAssembly ausführen: Der STEP-Leser (OpenCascade,
# mit Emscripten gebaut) braucht dafür eval. Ein Worker hat seine eigene CSP – die Seite selbst bleibt streng.
WORKER_CSP = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'"


async def model_worker(request: Request):
    return FileResponse(FRONTEND / "js" / "model-worker.js", media_type="text/javascript",
                        headers={"Content-Security-Policy": WORKER_CSP, "Cache-Control": "no-cache"})


class Guard:
    """Sicherheits-Header und CSRF-Schutz: Änderungen nur mit eigenem Header (den fremde Seiten nicht setzen können)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        method = scope["method"]
        path = scope["path"]
        if method not in ("GET", "HEAD", "OPTIONS") and (path.startswith("/api/") or path.startswith("/s/")):
            hdrs = dict(scope["headers"])
            if hdrs.get(b"x-filehelper") != b"1":
                resp = err(403, "Anfrage abgelehnt (CSRF-Schutz).")
                return await resp(scope, receive, send)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = message.setdefault("headers", [])
                names = {k.lower() for k, _ in headers}
                extra = [(b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"same-origin"),
                         (b"x-frame-options", b"SAMEORIGIN")]
                if b"content-security-policy" not in names:
                    extra.append((b"content-security-policy", CSP.encode()))
                headers.extend(e for e in extra if e[0] not in names)
            await send(message)
        try:
            await self.app(scope, receive, send_wrapper)
        except FsError as e:  # Fehler, die außerhalb eines Endpunkts entstehen
            await err(e.status, e.message)(scope, receive, send)


async def fs_error(request: Request, exc: FsError):
    return err(exc.status, exc.message)


@asynccontextmanager
async def lifespan(app):
    store.load()
    store.purge_expired_links()
    if not store.users():
        print("FileHelper: Noch kein Benutzer angelegt. Im Container ausführen: filehelper passwd admin", flush=True)
    thumbs.maybe_prune()
    yield


routes = [
    Route("/api/health", health),
    Route("/api/login", login, methods=["POST"]),
    Route("/api/logout", logout, methods=["POST"]),
    Route("/api/me", me),
    Route("/api/me/password", change_password, methods=["POST"]),
    Route("/api/me/favorites", favorites, methods=["PUT"]),
    Route("/api/users", users_list),
    Route("/api/users", users_save, methods=["POST"]),
    Route("/api/users/{name}", users_save, methods=["PUT"]),
    Route("/api/users/{name}", users_delete, methods=["DELETE"]),
    Route("/api/shares", shares),
    Route("/api/shares/{name}", share_settings, methods=["PUT"]),
    Route("/api/list", list_dir),
    Route("/api/search", search),
    Route("/api/stat", stat_entry),
    Route("/api/file", download, methods=["GET", "HEAD"]),
    Route("/api/thumb", thumb),
    Route("/api/zip", zip_download),
    Route("/api/zip", zip_ticket, methods=["POST"]),
    Route("/api/upload", upload, methods=["POST"]),
    Route("/api/upload", upload_cancel, methods=["DELETE"]),
    Route("/api/mkdir", mkdir, methods=["POST"]),
    Route("/api/rename", rename, methods=["POST"]),
    Route("/api/transfer", transfer, methods=["POST"]),
    Route("/api/delete", delete, methods=["POST"]),
    Route("/api/text", save_text, methods=["POST"]),
    Route("/api/jobs/{job_id}", job_status),
    Route("/api/links", links_list),
    Route("/api/links", links_create, methods=["POST"]),
    Route("/api/links/{lid}", links_delete, methods=["DELETE"]),
    Route("/api/system", system),
    Route("/api/system/update", system_update, methods=["POST"]),
    Route("/api/system/cache", cache_clear, methods=["DELETE"]),
    Route("/s/{token}", public_page),
    Route("/s/{token}/info", public_info),
    Route("/s/{token}/auth", public_auth, methods=["POST"]),
    Route("/s/{token}/list", public_list),
    Route("/s/{token}/file", public_file, methods=["GET", "HEAD"]),
    Route("/s/{token}/thumb", public_thumb),
    Route("/s/{token}/zip", public_zip),
    Route("/", index),
    Route("/static/js/model-worker.js", model_worker),
    Mount("/static", StaticFiles(directory=FRONTEND), name="static"),
]

app = Starlette(routes=routes, lifespan=lifespan, exception_handlers={FsError: fs_error}, middleware=[Middleware(Guard)])
