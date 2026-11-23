"""Authenticator codes, encrypted enrollment, and single-use recovery codes."""
import base64
import binascii
import hashlib
import hmac
import re
import secrets
from time import time

from cryptography.fernet import Fernet, InvalidToken

from database import execute_many, transaction

MFA_SCHEMA = """
CREATE TABLE IF NOT EXISTS account_mfa (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_seed TEXT NOT NULL,
    last_step INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mfa_enrollments (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    session_hash TEXT NOT NULL,
    encrypted_seed TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
    user_id INTEGER NOT NULL REFERENCES account_mfa(user_id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    PRIMARY KEY(user_id, code_hash)
);
"""


def mfa_cipher(value):
    if not value:
        return None
    try:
        raw = base64.b64decode(value, altchars=b"-_", validate=True)
        if len(raw) != 32:
            raise ValueError()
        return Fernet(base64.urlsafe_b64encode(raw))
    except (ValueError, binascii.Error):
        raise RuntimeError("MFA_ENCRYPTION_KEY must encode 32 random bytes.") from None


def totp(seed, step):
    key = base64.b32decode(seed)
    digest = hmac.digest(key, step.to_bytes(8, "big"), "sha1")
    offset = digest[-1] & 15
    value = int.from_bytes(digest[offset:offset + 4], "big") & 0x7fff_ffff
    return f"{value % 1_000_000:06d}"


def matching_step(seed, code, last_step):
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        return None
    current = int(time()) // 30
    for step in (current, current - 1, current + 1):
        if step > last_step and hmac.compare_digest(totp(seed, step), code):
            return step
    return None


def recovery_hash(user_id, code):
    return hashlib.sha256(f"{user_id}:{code}".encode()).hexdigest()


class MFA:
    def __init__(self, cipher, fail):
        self.cipher = cipher
        self.fail = fail

    def factor(self, db, user_id):
        return db.execute("SELECT encrypted_seed, last_step FROM account_mfa WHERE user_id = ?", (user_id,)).fetchone()

    def require_cipher(self):
        if self.cipher is None:
            self.fail("Authenticator service is unavailable. Contact your administrator.", 503)

    def encrypt(self, user_id, seed):
        self.require_cipher()
        return self.cipher.encrypt(f"{user_id}:{seed}".encode()).decode()

    def decrypt(self, user_id, token):
        self.require_cipher()
        try:
            account, seed = self.cipher.decrypt(token.encode()).decode().split(":", 1)
            if account == str(user_id) and re.fullmatch(r"[A-Z2-7]{32}", seed):
                return seed
        except (InvalidToken, ValueError):
            pass
        self.fail("Authenticator service is unavailable. Contact your administrator.", 503)

    def consume(self, db, user_id, factor, code):
        """Called within the same write transaction as the protected action."""
        self.require_cipher()
        if not isinstance(code, str) or len(code) > 40:
            self.fail("Enter an authenticator or recovery code.", 400)
        code = code.strip()
        recovery = code.replace("-", "").upper()
        if re.fullmatch(r"[A-F0-9]{20}", recovery):
            # Verify the configured encryption key before allowing recovery sign-in.
            self.decrypt(user_id, factor["encrypted_seed"])
            used = db.execute("""DELETE FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ?
                                 RETURNING user_id""", (user_id, recovery_hash(user_id, recovery))).fetchone()
            if used:
                return True
        else:
            seed = self.decrypt(user_id, factor["encrypted_seed"])
            step = matching_step(seed, code, factor["last_step"])
            if step is not None:
                db.execute("UPDATE account_mfa SET last_step = ? WHERE user_id = ?", (step, user_id))
                return False
        self.fail("The code is invalid or already used. Enter a new code.", 422)

    def manage(self, db, user, route, method, data, session_hash, verify_password, audit):
        user_id = user["id"]
        if route == "/mfa" and method == "GET":
            return {"configured": self.cipher is not None, "enabled": bool(self.factor(db, user_id))}
        if method != "POST" or route not in ("/mfa/setup", "/mfa/enable", "/mfa/disable"):
            self.fail("Page not found.", 404)
        self.require_cipher()
        if route != "/mfa/enable":
            password_account = verify_password(data.get("password"))

        with transaction(db, immediate=True):
            current = db.execute("""SELECT u.salt FROM sessions s JOIN users u ON u.id = s.user_id
                                   WHERE s.token_hash = ? AND s.user_id = ? AND s.expiry > ?""",
                                 (session_hash, user_id, int(time()))).fetchone()
            if not current or (route != "/mfa/enable" and current["salt"] != password_account):
                self.fail("Sign in again to manage verification.", 401)
            factor = self.factor(db, user_id)
            if route == "/mfa/disable":
                if not factor:
                    self.fail("Authenticator verification is already off.", 409)
                self.consume(db, user_id, factor, data.get("code"))
                db.execute("DELETE FROM mfa_recovery_codes WHERE user_id = ?", (user_id,))
                db.execute("DELETE FROM account_mfa WHERE user_id = ?", (user_id,))
                result = {"enabled": False}
                action = "mfa_disabled"
            elif factor:
                self.fail("Authenticator verification is already on.", 409)
            elif route == "/mfa/setup":
                seed = base64.b32encode(secrets.token_bytes(20)).decode()
                db.execute("""INSERT INTO mfa_enrollments VALUES (?, ?, ?, ?)
                            ON CONFLICT(user_id) DO UPDATE SET session_hash=excluded.session_hash,
                            encrypted_seed=excluded.encrypted_seed, expires_at=excluded.expires_at""",
                           (user_id, session_hash, self.encrypt(user_id, seed), int(time()) + 600))
                return {"setup_key": seed}
            else:
                pending = db.execute("""SELECT encrypted_seed FROM mfa_enrollments WHERE user_id = ?
                                       AND session_hash = ? AND expires_at > ?""",
                                     (user_id, session_hash, int(time()))).fetchone()
                if not pending:
                    self.fail("Setup expired. Start setup again.", 409)
                seed = self.decrypt(user_id, pending["encrypted_seed"])
                step = matching_step(seed, data.get("code"), -1)
                if step is None:
                    self.fail("Enter a current six-digit code from your authenticator.", 422)
                codes = [secrets.token_hex(10).upper() for _ in range(8)]
                db.execute("INSERT INTO account_mfa VALUES (?, ?, ?)", (user_id, pending["encrypted_seed"], step))
                execute_many(db, [
                    ("INSERT INTO mfa_recovery_codes VALUES (?, ?)", (user_id, recovery_hash(user_id, code)))
                    for code in codes
                ])
                result = {"enabled": True, "recovery_codes": ["-".join(code[i:i + 5] for i in range(0, 20, 5)) for code in codes]}
                action = "mfa_enabled"
            db.execute("DELETE FROM mfa_enrollments WHERE user_id = ?", (user_id,))
            db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            audit(action)
            return result
