"""Logins and roles (permissions are enforced on the server, never only in the browser):
  * admin    - Medge Controls: Settings (tags, gateway, users) + the full dashboard.
  * operator - the plant dashboard + acknowledge alarms + write the HMI level set points.
               The original shared client login (settings["client"]) is an operator account.
  * viewer   - the plant dashboard, read-only.
Extra operator / viewer accounts live in settings["users"]. PBKDF2 password hashes, in-memory session tokens
(a server restart signs everyone out)."""
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
ROLES = ("admin", "operator", "viewer")
DASHBOARD_ROLES = ROLES                 # may open the plant dashboard
OPERATE_ROLES = ("admin", "operator")   # may acknowledge alarms / write set points


def hash_password(password: str, salt: str | None = None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), ITERATIONS).hex()
    return h, salt


def _valid_username(u):
    return bool(u) and u.isascii() and u.replace("_", "").replace(".", "").isalnum() and len(u) <= 32


class Auth:
    def __init__(self, store):
        self.store = store
        self._sessions: dict[str, tuple[str, str, float]] = {}   # token -> (role, username, expiry)
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

    # -- accounts ----------------------------------------------------------------
    def accounts(self):
        """[(role, account dict, key)] - key: 'admin', 'client' or ('users', index)."""
        s = self.store.settings
        out = [("admin", s["admin"], "admin"), ("operator", s.get("client") or {}, "client")]
        for i, u in enumerate(s.get("users") or []):
            if u.get("role") in ("operator", "viewer"):
                out.append((u["role"], u, ("users", i)))
        return out

    def users(self):
        """Account list for the Settings page (no hashes)."""
        return [{"username": a.get("username", ""), "role": r, "builtin": not isinstance(k, tuple), "must_change": bool(a.get("must_change"))}
                for r, a, k in self.accounts()]

    def _find(self, username):
        username = (username or "").strip().lower()
        return next(((r, a, k) for r, a, k in self.accounts() if a.get("username", "").lower() == username), None)

    def _throttled(self, ip):
        now = time.time()
        fails = [t for t in self._fails.get(ip, []) if now - t < 300]
        self._fails[ip] = fails
        return len(fails) >= 8

    @staticmethod
    def _check(acc, password):
        if not acc.get("password_hash") or not acc.get("salt"):
            return False
        h, _ = hash_password(password or "", acc["salt"])
        return hmac.compare_digest(h, acc["password_hash"])

    # -- sessions ----------------------------------------------------------------
    def login(self, username: str, password: str, ip: str):
        """Return (token, role, error)."""
        if self._throttled(ip):
            return None, None, "Too many failed attempts. Wait 5 minutes."
        found = self._find(username)
        if not found or not self._check(found[1], password):
            self._fails.setdefault(ip, []).append(time.time())
            return None, None, "Wrong username or password"
        role, acc, _ = found
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._sessions[token] = (role, acc.get("username", ""), time.time() + SESSION_TTL)
        return token, role, None

    def session(self, token: str | None):
        """(role, username) of a valid session (sliding expiry), else (None, None)."""
        if not token:
            return None, None
        with self._lock:
            s = self._sessions.get(token)
            if not s or s[2] < time.time():
                self._sessions.pop(token, None)
                return None, None
            self._sessions[token] = (s[0], s[1], time.time() + SESSION_TTL)
            return s[0], s[1]

    def role(self, token: str | None):
        return self.session(token)[0]

    def check(self, token):                      # admin check (kept for older callers)
        return self.role(token) == "admin"

    def logout(self, token):
        with self._lock:
            self._sessions.pop(token, None)

    def must_change(self, role):
        if role == "admin":
            return bool(self.store.settings["admin"].get("must_change"))
        return bool((self.store.settings.get("client") or {}).get("must_change"))

    # -- passwords / users ---------------------------------------------------------------
    def change_password(self, old, new, role="admin"):
        acc = self.store.settings["admin"] if role == "admin" else (self.store.settings.get("client") or {})
        if not self._check(acc, old):
            return "Current password is wrong"
        if not new or len(new) < 8:
            return "New password must be at least 8 characters"
        h, s = hash_password(new)
        self.store.save_settings({("admin" if role == "admin" else "client"): {"password_hash": h, "salt": s, "must_change": False}})
        self._drop_user(acc.get("username", ""))
        return None

    def set_client_login(self, username, new_password):
        """Admin sets the built-in operator (client) login: username and/or password."""
        username = (username or "").strip().lower()
        changes = {}
        if username:
            if not _valid_username(username):
                return "Username: letters, digits, '.', '_' only (max 32)"
            other = self._find(username)
            if other and other[2] != "client":
                return "That username is already used by another account"
            changes["username"] = username
        if new_password:
            if len(new_password) < 8:
                return "Password must be at least 8 characters"
            h, s = hash_password(new_password)
            changes.update({"password_hash": h, "salt": s, "must_change": False})
        if not changes:
            return "Nothing to change"
        old = (self.store.settings.get("client") or {}).get("username", "")
        self.store.save_settings({"client": changes})
        self._drop_user(old)
        return None

    def save_user(self, username, role, password=None):
        """Add or update an extra operator / viewer account (admin only)."""
        username = (username or "").strip().lower()
        if not _valid_username(username):
            return "Username: letters, digits, '.', '_' only (max 32)"
        if role not in ("operator", "viewer"):
            return "Role must be operator or viewer"
        users = [dict(u) for u in (self.store.settings.get("users") or [])]
        found = self._find(username)
        if found and not isinstance(found[2], tuple):
            return "That username belongs to a built-in account"
        idx = found[2][1] if found else None
        if idx is None:
            if not password or len(password) < 8:
                return "Password must be at least 8 characters"
            h, s = hash_password(password)
            users.append({"username": username, "role": role, "password_hash": h, "salt": s})
        else:
            users[idx]["role"] = role
            if password:
                if len(password) < 8:
                    return "Password must be at least 8 characters"
                users[idx]["password_hash"], users[idx]["salt"] = hash_password(password)
        self.store.save_settings({"users": users})
        self._drop_user(username)
        return None

    def delete_user(self, username):
        found = self._find(username)
        if not found or not isinstance(found[2], tuple):
            return "Only added operator / viewer accounts can be deleted"
        users = [dict(u) for i, u in enumerate(self.store.settings.get("users") or []) if i != found[2][1]]
        self.store.save_settings({"users": users})
        self._drop_user(username)
        return None

    def _drop_user(self, username):
        username = (username or "").lower()
        with self._lock:
            for t in [t for t, (_r, u, _e) in self._sessions.items() if u.lower() == username]:
                del self._sessions[t]
