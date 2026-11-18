"""Vorschaubilder für Fotos (auch HEIC und Kamera-RAW wie Fujifilm .RAF) und Videos."""
from __future__ import annotations

import hashlib
import io
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

from . import store
from .fsops import ext_of, kind_of

CACHE = store.STATE_DIR / "thumbs"
CACHE_LIMIT = int(os.environ.get("FH_THUMB_CACHE_MB", "2048")) * 1024 * 1024
FFMPEG = shutil.which("ffmpeg")
_sem = threading.BoundedSemaphore(int(os.environ.get("FH_THUMB_WORKERS", "3")))

try:
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 300_000_000
    HAVE_PIL = True
except ImportError:  # pragma: no cover
    HAVE_PIL = False

HAVE_HEIF = False
if HAVE_PIL:
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
        HAVE_HEIF = True
    except Exception:  # noqa: BLE001 – optional
        pass

RAW = {"raf", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2"}
SIZES = (256, 512, 1024, 2048)


def supported(name: str) -> bool:
    e = ext_of(name)
    k = kind_of(name)
    if k == "video":
        return bool(FFMPEG)
    if k != "image" or not HAVE_PIL or e in ("svg", "ico"):
        return False
    if e in ("heic", "heif"):
        return HAVE_HEIF
    return True


def _embedded_jpeg(path: str) -> bytes | None:
    """Kamera-RAW-Dateien enthalten ein fertiges JPEG. Das ist viel schneller als echtes Entwickeln."""
    with open(path, "rb") as fh:
        head = fh.read(100)
        if head.startswith(b"FUJIFILMCCD-RAW"):
            off = int.from_bytes(head[84:88], "big")
            ln = int.from_bytes(head[88:92], "big")
            if 0 < ln < 50 * 1024 * 1024:
                fh.seek(off)
                data = fh.read(ln)
                if data[:2] == b"\xff\xd8":
                    return data
        # Andere Hersteller: das größte eingebettete JPEG in den ersten 32 MB suchen
        fh.seek(0)
        blob = fh.read(32 * 1024 * 1024)
    best, best_px, pos, tries = None, 0, 0, 0
    while tries < 40:
        start = blob.find(b"\xff\xd8\xff", pos)
        if start < 0:
            break
        tries += 1
        pos = start + 3
        try:
            w, hgt = Image.open(io.BytesIO(blob[start:start + 262144])).size  # nur der Kopf
        except Exception:  # noqa: BLE001
            continue
        if w * hgt > best_px:
            best, best_px = start, w * hgt
    return blob[best:] if best is not None and best_px >= 320 * 240 else None  # Rest hinter dem JPEG stört Pillow nicht


def _render_image(path: str, size: int) -> bytes:
    e = ext_of(path)
    if e in RAW:
        data = _embedded_jpeg(path)
        if not data:
            raise ValueError("Kein Vorschaubild in der RAW-Datei")
        img = Image.open(io.BytesIO(data))
    else:
        img = Image.open(path)
    try:
        img.draft("RGB", (size, size))  # JPEG direkt verkleinert laden → viel schneller
    except Exception:  # noqa: BLE001
        pass
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() or img.mode == "P" else "RGB")
    img.thumbnail((size, size), Image.LANCZOS if size <= 512 else Image.BICUBIC)
    out = io.BytesIO()
    img.save(out, "WEBP", quality=80 if size <= 512 else 85, method=4)
    return out.getvalue()


def _render_video(path: str, size: int) -> bytes:
    for ss in ("3", "0"):
        try:
            r = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", ss, "-i", path, "-frames:v", "1",
                                "-vf", f"scale='min({size},iw)':-2", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "-"],
                               capture_output=True, timeout=40, check=False)
        except subprocess.TimeoutExpired:
            raise ValueError("Video braucht zu lange")
        if r.returncode == 0 and r.stdout:
            img = Image.open(io.BytesIO(r.stdout))
            out = io.BytesIO()
            img.convert("RGB").save(out, "WEBP", quality=80)
            return out.getvalue()
    raise ValueError("Kein Bild aus dem Video")


def get(path: str, size: int) -> tuple[Path, bool]:
    """Gibt den Pfad im Zwischenspeicher zurück (erzeugt das Bild bei Bedarf)."""
    size = min(SIZES, key=lambda s: abs(s - size))
    st = os.stat(path)
    key = hashlib.sha1(f"{path}\0{st.st_mtime_ns}\0{st.st_size}\0{size}".encode()).hexdigest()
    target = CACHE / key[:2] / f"{key}.webp"
    if target.exists():
        return target, True
    with _sem:
        if target.exists():
            return target, True
        data = _render_video(path, size) if kind_of(path) == "video" else _render_image(path, size)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, target)
    return target, False


def prune() -> None:
    """Hält den Zwischenspeicher unter FH_THUMB_CACHE_MB (älteste zuerst weg)."""
    if not CACHE.exists():
        return
    files = []
    total = 0
    for p in CACHE.rglob("*.webp"):
        try:
            st = p.stat()
        except OSError:
            continue
        files.append((st.st_atime, st.st_size, p))
        total += st.st_size
    if total <= CACHE_LIMIT:
        return
    for _at, sz, p in sorted(files):
        try:
            p.unlink()
        except OSError:
            continue
        total -= sz
        if total <= CACHE_LIMIT * 0.8:
            break


def clear() -> None:
    shutil.rmtree(CACHE, ignore_errors=True)


def cache_size() -> int:
    if not CACHE.exists():
        return 0
    return sum(p.stat().st_size for p in CACHE.rglob("*.webp") if p.is_file())


def status() -> dict:
    return {"pillow": HAVE_PIL, "heif": HAVE_HEIF, "ffmpeg": bool(FFMPEG)}


_last_prune = 0.0


def maybe_prune() -> None:
    global _last_prune
    if time.time() - _last_prune > 3600:
        _last_prune = time.time()
        threading.Thread(target=prune, daemon=True).start()
