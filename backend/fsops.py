"""Dateisystem: Freigaben finden, Pfade sicher auflösen, auflisten, suchen, ZIP, Kopieren/Verschieben."""
from __future__ import annotations

import mimetypes
import os
import shutil
import stat
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass, field

from . import store

ROOT = os.path.realpath(os.environ.get("FH_ROOT", "/mnt"))

HIDDEN_NAMES = {"@eadir", "#recycle", "#snapshot", "$recycle.bin", "system volume information", "thumbs.db",
                ".ds_store", "lost+found", "desktop.ini"}

EXT_KIND = {}
for kind, exts in {
    "image": "jpg jpeg png gif webp bmp avif svg ico heic heif tif tiff raf cr2 cr3 nef arw dng orf rw2",
    "video": "mp4 m4v mov webm mkv avi wmv mts m2ts 3gp mpg mpeg",
    "audio": "mp3 m4a aac flac wav ogg oga opus wma aiff",
    "pdf": "pdf",
    "text": "txt md markdown log csv tsv json yaml yml toml ini conf cfg env xml html htm css js mjs ts py sh bash zsh "
            "sql srt vtt gpx kml nfo properties gitignore dockerfile",
    "archive": "zip rar 7z tar gz tgz bz2 xz zst iso dmg",
    "doc": "doc docx odt rtf pages",
    "sheet": "xls xlsx ods numbers",
    "slides": "ppt pptx odp key",
    "design": "psd ai xcf drp drt fcpxml prproj aep",
}.items():
    for e in exts.split():
        EXT_KIND[e] = kind

# Diese Bildformate kann der Browser nicht selbst anzeigen → Vorschau wird umgewandelt
CONVERT_IMAGES = {"heic", "heif", "tif", "tiff", "raf", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2"}
# Werden nie „inline“ ausgeliefert (könnten im Browser Skripte ausführen)
UNSAFE_INLINE = {"html", "htm", "xhtml", "svg", "xml", "js", "mjs"}
MAX_TEXT_PREVIEW = 1024 * 1024


class FsError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def ext_of(name: str) -> str:
    base = name.lower()
    if base in ("dockerfile", ".gitignore"):
        return base.lstrip(".")
    return base.rsplit(".", 1)[-1] if "." in base else ""


def kind_of(name: str, is_dir: bool = False) -> str:
    return "folder" if is_dir else EXT_KIND.get(ext_of(name), "file")


def is_hidden(name: str) -> bool:
    return name.startswith(".") or name.lower() in HIDDEN_NAMES


def valid_name(name: str) -> bool:
    return (isinstance(name, str) and 0 < len(name) <= 255 and name not in (".", "..") and "/" not in name
            and "\0" not in name and not name.startswith(".fh-") and name.strip() == name.strip(" ") and name.strip() != "")


# ---------------------------------------------------------------------------
# Freigaben = Unterordner von FH_ROOT (normalerweise eingebundene NAS-Ordner)
# ---------------------------------------------------------------------------
def _fs_info(path: str) -> dict:
    info = {"writable": os.access(path, os.W_OK), "readonly_mount": False, "total": None, "free": None}
    try:
        st = os.statvfs(path)
        info["readonly_mount"] = bool(st.f_flag & os.ST_RDONLY)
        if info["readonly_mount"]:
            info["writable"] = False
        info["total"] = st.f_blocks * st.f_frsize
        info["free"] = st.f_bavail * st.f_frsize
    except OSError:
        pass
    return info


def _mount_points() -> dict:
    mounts = {}
    try:
        with open("/proc/self/mountinfo") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) > 9:
                    target = parts[4].replace("\\040", " ")
                    sep = parts.index("-")
                    mounts[target] = {"fstype": parts[sep + 1], "source": parts[sep + 2]}
    except OSError:
        pass
    return mounts


def list_shares(include_hidden: bool = False) -> list[dict]:
    settings = store.settings()
    hidden_set = set(settings.get("hidden", []))
    labels = settings.get("labels", {})
    mounts = _mount_points()
    out = []
    try:
        entries = sorted(os.scandir(ROOT), key=lambda e: e.name.lower())
    except FileNotFoundError:
        return []
    for e in entries:
        if is_hidden(e.name):
            continue
        try:
            if not e.is_dir(follow_symlinks=True):
                continue
        except OSError:
            continue
        if e.name in hidden_set and not include_hidden:
            continue
        real = os.path.realpath(e.path)
        m = mounts.get(real) or mounts.get(e.path)
        out.append({"name": e.name, "label": labels.get(e.name) or e.name, "hidden": e.name in hidden_set,
                    "mounted": m is not None, "fstype": (m or {}).get("fstype")})
    return out


def share_root(share: str) -> str:
    if not isinstance(share, str) or not valid_name(share) or is_hidden(share):
        raise FsError(404, "Diese Freigabe gibt es nicht.")
    p = os.path.join(ROOT, share)
    if not os.path.isdir(p):
        raise FsError(404, "Diese Freigabe gibt es nicht (mehr).")
    return os.path.realpath(p)


def clean_rel(rel: str | None) -> list[str]:
    if rel is None:
        return []
    if not isinstance(rel, str) or "\0" in rel or len(rel) > 4096:
        raise FsError(400, "Ungültiger Pfad")
    parts = [p for p in rel.replace("\\", "/").split("/") if p]
    if any(p in (".", "..") for p in parts):
        raise FsError(400, "Ungültiger Pfad")
    return parts


def resolve(share: str, rel: str | None, *, must_exist: bool = True) -> tuple[str, str, list[str]]:
    """Gibt (Wurzel, absoluter Pfad, Teile) zurück und stellt sicher, dass nichts aus der Freigabe herausführt."""
    root = share_root(share)
    parts = clean_rel(rel)
    path = os.path.join(root, *parts)
    # Der Elternordner muss (nach Auflösen von Verknüpfungen) in der Freigabe liegen …
    parent_real = os.path.realpath(os.path.dirname(path)) if parts else root
    if not (parent_real == root or parent_real.startswith(root + os.sep)):
        raise FsError(403, "Zugriff außerhalb der Freigabe ist nicht erlaubt.")
    # … und das Ziel selbst auch, falls es eine Verknüpfung ist
    if parts and os.path.islink(path):
        real = os.path.realpath(path)
        if not (real == root or real.startswith(root + os.sep)):
            raise FsError(403, "Diese Verknüpfung zeigt aus der Freigabe heraus.")
    if must_exist and not os.path.lexists(path):
        raise FsError(404, "Datei oder Ordner nicht gefunden.")
    return root, path, parts


def entry_info(name: str, st: os.stat_result, rel_dir: str = "") -> dict:
    is_dir = stat.S_ISDIR(st.st_mode)
    e = ext_of(name)
    d = {"name": name, "dir": is_dir, "size": None if is_dir else st.st_size, "mtime": int(st.st_mtime),
         "kind": kind_of(name, is_dir), "hidden": is_hidden(name)}
    if rel_dir is not None and rel_dir != "":
        d["parent"] = rel_dir
    if not is_dir and e in CONVERT_IMAGES:
        d["convert"] = True
    return d


def list_dir(share: str, rel: str) -> dict:
    root, path, parts = resolve(share, rel)
    if not os.path.isdir(path):
        raise FsError(400, "Das ist kein Ordner.")
    items = []
    truncated = False
    with os.scandir(path) as it:
        for e in it:
            if e.name.startswith(".fh-"):
                continue
            try:
                st = e.stat(follow_symlinks=True)
            except OSError:
                continue
            if e.is_symlink():
                real = os.path.realpath(e.path)
                if not (real == root or real.startswith(root + os.sep)):
                    continue
            items.append(entry_info(e.name, st, ""))
            if len(items) >= 20000:
                truncated = True
                break
    return {"share": share, "path": "/".join(parts), "items": items, "truncated": truncated, **_fs_info(path)}


def search(share: str, rel: str, query: str, limit: int = 300, seconds: float = 8.0) -> dict:
    root, path, parts = resolve(share, rel)
    q = query.lower().strip()
    if len(q) < 2:
        raise FsError(400, "Bitte mindestens 2 Zeichen eingeben.")
    words = q.split()
    deadline = time.monotonic() + seconds
    results, stack, done = [], [(path, "/".join(parts))], True
    while stack:
        if time.monotonic() > deadline or len(results) >= limit:
            done = False
            break
        cur, cur_rel = stack.pop()
        try:
            with os.scandir(cur) as it:
                for e in it:
                    if is_hidden(e.name) or e.name.startswith(".fh-"):
                        continue
                    try:
                        is_dir = e.is_dir(follow_symlinks=False)
                    except OSError:
                        continue
                    sub_rel = f"{cur_rel}/{e.name}" if cur_rel else e.name
                    low = e.name.lower()
                    if all(w in low for w in words):
                        try:
                            results.append(entry_info(e.name, e.stat(follow_symlinks=False), cur_rel or "/"))
                        except OSError:
                            pass
                    if is_dir:
                        stack.append((e.path, sub_rel))
        except OSError:
            continue
    return {"items": results[:limit], "complete": done}


def dir_size(path: str, seconds: float = 10.0) -> dict:
    total, files, dirs, deadline, done = 0, 0, 0, time.monotonic() + seconds, True
    for cur, dnames, fnames in os.walk(path):
        dirs += len(dnames)
        for f in fnames:
            try:
                total += os.lstat(os.path.join(cur, f)).st_size
                files += 1
            except OSError:
                pass
        if time.monotonic() > deadline:
            done = False
            break
    return {"size": total, "files": files, "dirs": dirs, "complete": done}


def unique_name(directory: str, name: str) -> str:
    if not os.path.lexists(os.path.join(directory, name)):
        return name
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, ext = name, ""
    for i in range(1, 10000):
        cand = f"{stem} ({i}).{ext}" if ext else f"{stem} ({i})"
        if not os.path.lexists(os.path.join(directory, cand)):
            return cand
    raise FsError(409, "Zu viele gleichnamige Dateien.")


def guess_mime(name: str) -> str:
    e = ext_of(name)
    special = {"mkv": "video/x-matroska", "m4a": "audio/mp4", "flac": "audio/flac", "opus": "audio/ogg", "md": "text/markdown",
               "mts": "video/mp2t", "heic": "image/heic", "webp": "image/webp", "avif": "image/avif", "log": "text/plain"}
    if e in special:
        return special[e]
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


# ---------------------------------------------------------------------------
# ZIP-Download (wird beim Herunterladen erzeugt, ohne Zwischendatei)
# ---------------------------------------------------------------------------
class _Sink:
    def __init__(self):
        self.buf = bytearray()

    def write(self, b):
        self.buf += b
        return len(b)

    def flush(self):
        pass

    def take(self) -> bytes:
        out = bytes(self.buf)
        self.buf.clear()
        return out


STORE_KINDS = {"image", "video", "audio", "archive", "pdf"}


def zip_stream(items: list[tuple[str, str]]):
    """items: Liste von (absoluter Pfad, Name im ZIP). Ordner werden vollständig aufgenommen."""
    sink = _Sink()
    with zipfile.ZipFile(sink, "w", allowZip64=True) as z:
        def add_file(src: str, arc: str):
            try:
                st = os.stat(src)
            except OSError:
                return
            t = time.localtime(max(st.st_mtime, 315532800))[:6]
            zi = zipfile.ZipInfo(arc, date_time=t)
            zi.external_attr = 0o644 << 16
            if kind_of(arc) in STORE_KINDS:
                zi.compress_type = zipfile.ZIP_STORED
            else:
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi._compresslevel = 1  # schnell statt klein
            try:
                with open(src, "rb") as fh, z.open(zi, "w", force_zip64=st.st_size > 2 ** 31) as dst:
                    while True:
                        chunk = fh.read(1024 * 1024)
                        if not chunk:
                            break
                        dst.write(chunk)
                        if len(sink.buf) >= 1024 * 1024:
                            yield sink.take()
            except OSError:
                return
            yield sink.take()

        for src, arc in items:
            if os.path.isdir(src):
                empty = True
                for cur, dnames, fnames in os.walk(src):
                    dnames[:] = sorted(d for d in dnames if not is_hidden(d))
                    rel = os.path.relpath(cur, src)
                    base = arc if rel == "." else f"{arc}/{rel}"
                    for f in sorted(fnames):
                        if is_hidden(f) or f.startswith(".fh-"):
                            continue
                        empty = False
                        yield from add_file(os.path.join(cur, f), f"{base}/{f}")
                    if not fnames and not dnames and rel != ".":
                        z.writestr(zipfile.ZipInfo(base + "/"), b"")
                if empty:
                    z.writestr(zipfile.ZipInfo(arc + "/"), b"")
            else:
                yield from add_file(src, arc)
    yield sink.take()


# ---------------------------------------------------------------------------
# Länger laufende Aufgaben: Kopieren, Verschieben, Löschen
# ---------------------------------------------------------------------------
@dataclass
class Job:
    id: str
    kind: str
    user: str
    title: str
    total: int = 0
    done: int = 0
    state: str = "running"  # running | done | error
    error: str | None = None
    current: str = ""
    started: float = field(default_factory=time.time)
    finished: float | None = None
    results: list = field(default_factory=list)

    def public(self) -> dict:
        return {k: getattr(self, k) for k in ("id", "kind", "title", "total", "done", "state", "error", "current", "started", "finished")}


JOBS: dict[str, Job] = {}
_jobs_lock = threading.Lock()


def _cleanup_jobs():
    now = time.time()
    with _jobs_lock:
        for k in [k for k, j in JOBS.items() if j.finished and now - j.finished > 3600]:
            JOBS.pop(k, None)


def _tree_bytes(path: str) -> int:
    if not os.path.isdir(path) or os.path.islink(path):
        try:
            return os.lstat(path).st_size
        except OSError:
            return 0
    total = 0
    for cur, _d, files in os.walk(path):
        for f in files:
            try:
                total += os.lstat(os.path.join(cur, f)).st_size
            except OSError:
                pass
    return total


def _copy_file(src: str, dst: str, job: Job):
    job.current = os.path.basename(src)
    with open(src, "rb") as fi, open(dst, "wb") as fo:
        while True:
            b = fi.read(4 * 1024 * 1024)
            if not b:
                break
            fo.write(b)
            job.done += len(b)
    try:
        shutil.copystat(src, dst)
    except OSError:
        pass


def _copy_tree(src: str, dst: str, job: Job):
    if os.path.islink(src):
        os.symlink(os.readlink(src), dst)
        return
    if os.path.isdir(src):
        os.makedirs(dst, exist_ok=False)
        for e in os.scandir(src):
            _copy_tree(e.path, os.path.join(dst, e.name), job)
        try:
            shutil.copystat(src, dst)
        except OSError:
            pass
    else:
        _copy_file(src, dst, job)


def _run_transfer(job: Job, pairs: list[tuple[str, str]], move: bool):
    try:
        job.total = sum(_tree_bytes(s) for s, _ in pairs)
        for src, dst_dir in pairs:
            name = unique_name(dst_dir, os.path.basename(src))
            dst = os.path.join(dst_dir, name)
            if move:
                try:
                    os.rename(src, dst)  # gleiches Laufwerk: sofort fertig
                    job.done += _tree_bytes(dst) if job.total else 0
                    job.results.append(name)
                    continue
                except OSError as e:
                    if e.errno != 18:  # EXDEV = anderes Laufwerk → kopieren + löschen
                        raise
            _copy_tree(src, dst, job)
            if move:
                if os.path.isdir(src) and not os.path.islink(src):
                    shutil.rmtree(src)
                else:
                    os.unlink(src)
            job.results.append(name)
        job.state = "done"
    except FsError as e:
        job.state, job.error = "error", e.message
    except OSError as e:
        job.state, job.error = "error", f"{e.strerror or e}{f': {os.path.basename(e.filename)}' if e.filename else ''}"
    finally:
        job.finished = time.time()
        job.current = ""


def _run_delete(job: Job, paths: list[str]):
    try:
        job.total = len(paths)
        for p in paths:
            job.current = os.path.basename(p)
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            else:
                os.unlink(p)
            job.done += 1
        job.state = "done"
    except OSError as e:
        job.state, job.error = "error", f"{e.strerror or e}{f': {os.path.basename(e.filename)}' if e.filename else ''}"
    finally:
        job.finished = time.time()
        job.current = ""


def start_job(kind: str, user: str, title: str, target, *args) -> Job:
    _cleanup_jobs()
    job = Job(id=uuid.uuid4().hex[:12], kind=kind, user=user, title=title)
    with _jobs_lock:
        JOBS[job.id] = job
    threading.Thread(target=target, args=(job, *args), daemon=True).start()
    return job


def transfer(user: str, pairs: list[tuple[str, str]], move: bool, title: str) -> Job:
    return start_job("move" if move else "copy", user, title, _run_transfer, pairs, move)


def delete(user: str, paths: list[str], title: str) -> Job:
    return start_job("delete", user, title, _run_delete, paths)
