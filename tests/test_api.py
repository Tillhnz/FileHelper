"""Tests gegen einen echten FileHelper-Server mit Testdaten (wie im Container, nur in einem Temp-Ordner)."""
from __future__ import annotations

import http.cookiejar
import io
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parent.parent


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def server(tmp_path_factory):
    base = tmp_path_factory.mktemp("fh")
    root, state = base / "mnt", base / "state"
    (root / "Fotos" / "Urlaub").mkdir(parents=True)
    (root / "Dokumente").mkdir()
    (root / "Dokumente" / "Notiz.txt").write_text("Hallo\n")
    (root / "Dokumente" / "evil.html").write_text("<script>alert(1)</script>")
    (root / "Dokumente" / ".versteckt").write_text("x")
    (root / "Dokumente" / "groß.bin").write_bytes(bytes(range(256)) * 40)
    os.symlink("/etc", root / "Dokumente" / "ausbruch")
    from PIL import Image
    Image.new("RGB", (800, 600), (40, 120, 220)).save(root / "Fotos" / "Urlaub" / "bild.jpg")
    env = {**os.environ, "FH_ROOT": str(root), "FH_STATE_DIR": str(state), "FH_UPDATE_WATCH": "0"}
    subprocess.run([sys.executable, "-c", "from backend import store; store.set_user('till', password='geheim123', admin=True); "
                    "store.set_user('gast', password='geheim123', readonly=True)"], cwd=ROOT_DIR, env=env, check=True)
    port = _free_port()
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", str(port)],
                            cwd=ROOT_DIR, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            urllib.request.urlopen(url + "/api/health", timeout=1)
            break
        except OSError:
            time.sleep(0.2)
    else:
        proc.kill()
        raise RuntimeError(proc.stdout.read().decode())
    yield {"url": url, "root": root}
    proc.terminate()
    proc.wait(10)


class Client:
    def __init__(self, base: str):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def req(self, method: str, path: str, body=None, raw: bytes | None = None, headers=None, csrf=True):
        h = dict(headers or {})
        data = None
        if csrf:
            h["X-FileHelper"] = "1"
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        elif raw is not None:
            data = raw
            h["Content-Type"] = "application/octet-stream"
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            resp = self.opener.open(r, timeout=20)
            return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def json(self, method: str, path: str, body=None, **kw):
        st, _h, data = self.req(method, path, body, **kw)
        return st, (json.loads(data) if data else {})

    def login(self, user="till", pw="geheim123"):
        st, data = self.json("POST", "/api/login", {"username": user, "password": pw})
        assert st == 200, data
        return self


def wait_job(c: Client, job: dict) -> dict:
    for _ in range(100):
        st, data = c.json("GET", f"/api/jobs/{job['id']}")
        if data["job"]["state"] != "running":
            return data["job"]
        time.sleep(0.05)
    raise AssertionError("Aufgabe hängt")


def test_health_and_login(server):
    c = Client(server["url"])
    assert c.json("GET", "/api/health")[0] == 200
    assert c.json("GET", "/api/shares")[0] == 401
    assert c.json("POST", "/api/login", {"username": "till", "password": "x"}, csrf=False)[0] == 403  # CSRF-Schutz
    assert c.json("POST", "/api/login", {"username": "till", "password": "falsch"})[0] == 401
    c.login()
    st, data = c.json("GET", "/api/shares")
    assert st == 200 and [s["name"] for s in data["shares"]] == ["Dokumente", "Fotos"]


def test_list_and_path_safety(server):
    c = Client(server["url"]).login()
    st, data = c.json("GET", "/api/list?share=Dokumente&path=")
    names = {i["name"]: i for i in data["items"]}
    assert "Notiz.txt" in names and names[".versteckt"]["hidden"] and "ausbruch" not in names
    assert c.json("GET", "/api/list?share=Dokumente&path=../Fotos")[0] == 400
    assert c.json("GET", "/api/list?share=Dokumente&path=ausbruch")[0] == 403
    assert c.json("GET", "/api/file?share=..&path=etc/passwd")[0] == 404


def test_download_range_and_unsafe_types(server):
    c = Client(server["url"]).login()
    st, h, body = c.req("GET", "/api/file?share=Dokumente&path=evil.html")
    assert st == 200 and h["Content-Type"].startswith("text/plain")
    st, h, body = c.req("GET", "/api/file?share=Dokumente&path=gro%C3%9F.bin", headers={"Range": "bytes=10-19"})
    assert st == 206 and body == bytes(range(10, 20)) and h["Content-Range"] == "bytes 10-19/10240"
    st, h, body = c.req("GET", "/api/zip?share=Dokumente&path=")
    names = zipfile.ZipFile(io.BytesIO(body)).namelist()
    assert "Dokumente/Notiz.txt" in names and not any("versteckt" in n for n in names)


def test_thumbnail(server):
    c = Client(server["url"]).login()
    st, h, body = c.req("GET", "/api/thumb?share=Fotos&path=Urlaub/bild.jpg&s=256")
    assert st == 200 and h["Content-Type"] == "image/webp" and body[:4] == b"RIFF"


def test_upload_in_chunks(server):
    c = Client(server["url"]).login()
    data = os.urandom(300_000)
    q = "/api/upload?share=Dokumente&path=&name=Neu/sub/datei.bin&id=abcdefgh01"
    assert c.json("POST", q + "&offset=0&final=0", raw=data[:100_000])[0] == 200
    st, resp = c.json("POST", q + "&offset=5&final=0", raw=b"x")
    assert st == 409 and resp["have"] == 100_000
    st, resp = c.json("POST", q + "&offset=100000&final=1", raw=data[100_000:])
    assert st == 200 and resp["name"] == "datei.bin"
    assert (server["root"] / "Dokumente/Neu/sub/datei.bin").read_bytes() == data
    st, resp = c.json("POST", "/api/upload?share=Dokumente&path=Neu/sub&name=datei.bin&id=abcdefgh02&offset=0&final=1", raw=b"1")
    assert resp["name"] == "datei (1).bin"


def test_change_files(server):
    c = Client(server["url"]).login()
    assert c.json("POST", "/api/mkdir", {"share": "Dokumente", "path": "", "name": "Projekt"})[0] == 200
    assert c.json("POST", "/api/rename", {"share": "Dokumente", "path": "Projekt", "new": "Projekt 2"})[0] == 200
    st, data = c.json("POST", "/api/transfer", {"mode": "move", "share": "Dokumente", "path": "", "items": ["Projekt 2"],
                                               "dest_share": "Dokumente", "dest_path": "Projekt 2"})
    assert st == 400  # nicht in sich selbst
    st, data = c.json("POST", "/api/transfer", {"mode": "copy", "share": "Dokumente", "path": "", "items": ["Notiz.txt"],
                                               "dest_share": "Fotos", "dest_path": ""})
    assert wait_job(c, data["job"])["state"] == "done"
    assert (server["root"] / "Fotos/Notiz.txt").read_text() == "Hallo\n"
    st, data = c.json("POST", "/api/delete", {"share": "Fotos", "path": "", "items": ["Notiz.txt"]})
    assert wait_job(c, data["job"])["state"] == "done" and not (server["root"] / "Fotos/Notiz.txt").exists()


def test_readonly_user(server):
    c = Client(server["url"]).login("gast")
    assert c.json("POST", "/api/mkdir", {"share": "Dokumente", "path": "", "name": "x"})[0] == 403
    assert c.json("GET", "/api/list?share=Dokumente&path=")[0] == 200


def test_shared_link_with_password(server):
    c = Client(server["url"]).login()
    st, data = c.json("POST", "/api/links", {"share": "Fotos", "path": "Urlaub", "days": 1, "password": "abcd"})
    token = data["link"]["token"]
    anon = Client(server["url"])
    assert anon.json("GET", f"/s/{token}/info")[1]["locked"] is True
    assert anon.json("GET", f"/s/{token}/list")[0] == 401
    assert anon.json("POST", f"/s/{token}/auth", {"password": "falsch"})[0] == 401
    assert anon.json("POST", f"/s/{token}/auth", {"password": "abcd"})[0] == 200
    st, data = anon.json("GET", f"/s/{token}/list")
    assert [i["name"] for i in data["items"]] == ["bild.jpg"]
    assert anon.json("GET", f"/s/{token}/list?path=../../Dokumente")[0] == 400
    assert anon.json("GET", "/s/gibtesnicht/info")[0] == 404


def test_security_headers(server):
    c = Client(server["url"])
    st, h, _ = c.req("GET", "/")
    assert "'unsafe-eval'" not in h["Content-Security-Policy"]
    st, h, _ = c.req("GET", "/static/js/model-worker.js")
    assert st == 200 and "'wasm-unsafe-eval'" in h["Content-Security-Policy"]


def test_update_check_counts_commits(monkeypatch):
    sys.path.insert(0, str(ROOT_DIR))
    from backend import updatewatch
    commits = [{"sha": "c" * 40, "commit": {"message": "Bump pillow from 12.3.0 to 12.3.1\n\nDetails", "committer": {"date": "x"}}},
               {"sha": "b" * 40, "commit": {"message": "Neue Funktion", "committer": {"date": "x"}}},
               {"sha": "a" * 40, "commit": {"message": "Installiert", "committer": {"date": "x"}}}]
    monkeypatch.setattr(updatewatch, "installed_commit", lambda: "a" * 40)
    monkeypatch.setattr(updatewatch, "_get_json", lambda url: commits)
    st = updatewatch.check(force=True)
    assert st["behind"] == 2
    sec, lines = updatewatch.describe(st["changes"])
    assert sec and "Neue Funktion" in lines
