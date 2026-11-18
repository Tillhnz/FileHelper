"""Kommandozeile im Container:  filehelper passwd <name> | users | info"""
from __future__ import annotations

import getpass
import secrets
import sys

from . import store


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else "help"
    if cmd == "passwd":
        name = argv[1] if len(argv) > 1 else "admin"
        if not store.USERNAME_RE.match(name):
            print("Ungültiger Benutzername.")
            return 1
        if "--random" in argv:
            pw = secrets.token_urlsafe(9)
        else:
            pw = getpass.getpass(f"Neues Passwort für {name}: ")
            if pw != getpass.getpass("Noch einmal: "):
                print("Die Passwörter stimmen nicht überein.")
                return 1
        prob = store.password_problem(pw)
        if prob:
            print(prob)
            return 1
        new = store.get_user(name) is None
        store.set_user(name, password=pw, admin=True if new or "--admin" in argv else None)
        if "--random" in argv:
            print(pw)
        else:
            print(f"Passwort für {name} gesetzt.")
        return 0
    if cmd == "users":
        for n, u in sorted(store.users().items()):
            print(f"{n:20} {'Administrator' if u.get('admin') else 'Nur lesen' if u.get('readonly') else 'Benutzer'}")
        return 0
    if cmd == "has-users":
        return 0 if store.users() else 1
    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
