"""Login for two roles:
  * admin  - Medge Controls: tag / communication configuration page only.
  * client - Ankur Scientific (one shared login): view-only dashboard only.
PBKDF2 password hashes in settings.json, in-memory session tokens (a server restart signs everyone out)."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time

DEFAULT_ADMIN = ("admin", "admin123")
DEFAULT_CLIENT = ("ankur", "ankur123")
SESSION_TTL = 8 * 3600
ITERATIONS = 200_000
ROLES = ("admin", "client")


def hash_password(password: str, salt: str | None = None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), ITERATIONS).hex()
    return h, salt


class Auth:
    def __init__(self, store):
        self.store = store
        self._sessions: dict[str, tuple[str, float]] = {}   # token -> (role, expiry)
        self._lock = threading.Lock()
        self._fails: dict[str, list[float]] = {}
        s = store.settings
        changes = {}
        if not s["admin"].get("password_hash"):
            h, salt = hash_password(DEFAULT_ADMIN[1])
            changes["admin"] = {"username": DEFAULT_ADMIN[0], "password_hash": h, "salt": salt, "must_change": True}
        elif not s["admin"].get("username"):
            changes["admin"] = {"username": DEFAULT_ADMIN[0]}
        if not (s.get("client") or {}).get("password_hash"):
            h, salt = hash_password(DEFAULT_CLIENT[1])
            changes["client"] = {"username": DEFAULT_CLIENT[0], "password_hash": h, "salt": salt, "must_change": True}
        if changes:
            store.save_settings(changes)

    # -- helpers ---------------------------------------------------------------
    def _account(self, role):
        return self.store.settings["admin" if role == "admin" else "client"]

    def _throttled(self, ip):
        now = time.time()
        fails = [t for t in self._fails.get(ip, []) if now - t < 300]
        self._fails[ip] = fails
        return len(fails) >= 8

    def _check_pw(self, role, password):
        acc = self._account(role)
        h, _ = hash_password(password or "", acc["salt"])
        return hmac.compare_digest(h, acc["password_hash"])

    # -- sessions ----------------------------------------------------------------
    def login(self, username: str, password: str, ip: str):
        """Return (token, role, error)."""
        if self._throttled(ip):
            return None, None, "Too many failed attempts. Wait 5 minutes."
        username = (username or "").strip().lower()
        role = next((r for r in ROLES if self._account(r).get("username", "").lower() == username), None)
        if not role or not self._check_pw(role, password):
            self._fails.setdefault(ip, []).append(time.time())
            return None, None, "Wrong username or password"
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._sessions[token] = (role, time.time() + SESSION_TTL)
        return token, role, None

    def role(self, token: str | None):
        """Role of a valid session (sliding expiry), else None."""
        if not token:
            return None
        with self._lock:
            s = self._sessions.get(token)
            if not s or s[1] < time.time():
                self._sessions.pop(token, None)
                return None
            self._sessions[token] = (s[0], time.time() + SESSION_TTL)
            return s[0]

    def check(self, token):                      # admin check (kept for older callers)
        return self.role(token) == "admin"

    def logout(self, token):
        with self._lock:
            self._sessions.pop(token, None)

    def must_change(self, role):
        return bool(self._account(role).get("must_change"))

    # -- passwords -------------------------------------------------------------------
    def change_password(self, old, new, role="admin"):
        if not self._check_pw(role, old):
            return "Current password is wrong"
        if not new or len(new) < 8:
            return "New password must be at least 8 characters"
        self._set(role, new)
        self._drop_role(role)
        return None

    def set_client_login(self, username, new_password):
        """Admin sets the client's username and/or password (no old password needed)."""
        username = (username or "").strip().lower()
        changes = {}
        if username:
            if not username.isascii() or not username.replace("_", "").replace(".", "").isalnum() or len(username) > 32:
                return "Client username: letters, digits, '.', '_' only (max 32)"
            if username == self.store.settings["admin"].get("username", "").lower():
                return "Client username must differ from the admin username"
            changes["username"] = username
        if new_password:
            if len(new_password) < 8:
                return "Client password must be at least 8 characters"
            h, s = hash_password(new_password)
            changes.update({"password_hash": h, "salt": s, "must_change": False})
        if not changes:
            return "Nothing to change"
        self.store.save_settings({"client": changes})
        self._drop_role("client")
        return None

    def _set(self, role, new):
        h, s = hash_password(new)
        self.store.save_settings({("admin" if role == "admin" else "client"): {"password_hash": h, "salt": s, "must_change": False}})

    def _drop_role(self, role):
        with self._lock:
            for t in [t for t, (r, _) in self._sessions.items() if r == role]:
                del self._sessions[t]
