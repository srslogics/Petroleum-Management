"""Authenticator enrollment, replay protection and account recovery."""
import base64
import json
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from cryptography.fernet import Fernet
from app import create_app
from database import open_db
from mfa import totp
from test_workflow import Browser


class MFAWorkflowTest(TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.database = Path(temp.name) / "mfa.sqlite3"
        self.key = Fernet.generate_key().decode()
        self.app = create_app(self.database, env={"MFA_ENCRYPTION_KEY": self.key})
        self.clock = self.enterContext(patch("mfa.time.time", return_value=1_800_000_000))

    def credentials(self, role):
        return {"email": role + "@demo.local", "password": {"owner": "OwnerDemo123!", "manager": "ManagerDemo123!"}[role]}

    def enroll(self, browser, role):
        credentials = self.credentials(role)
        path = f"/api/{role}"
        self.assertEqual(browser.request(path + "/login", credentials)[0], 200)
        status, setup = browser.request(path + "/mfa/setup", {"password": credentials["password"]})
        self.assertEqual(status, 200, setup)
        seed = setup["setup_key"]
        status, result = browser.request(path + "/mfa/enable", {"code": totp(seed, int(self.clock.return_value) // 30)})
        self.assertEqual(status, 200, result)
        return seed, result["recovery_codes"]

    def test_rfc_totp_vector(self):
        seed = base64.b32encode(b"12345678901234567890").decode()
        self.assertEqual(totp(seed, 59 // 30), "287082")

    def test_both_roles_require_second_factor_reject_replay_and_use_recovery_once(self):
        for role in ("owner", "manager"):
            browser = Browser(self.app)
            credentials = self.credentials(role)
            prefix = f"/api/{role}"
            seed, codes = self.enroll(browser, role)
            self.assertEqual(len(codes), 8)
            with closing(open_db(self.database)) as db:
                self.assertNotIn(seed, json.dumps([dict(row) for row in db.execute("SELECT * FROM account_mfa")]))
                self.assertNotIn(codes[0].replace("-", ""), json.dumps([dict(row) for row in db.execute("SELECT * FROM mfa_recovery_codes")]))
            self.assertEqual(browser.request(prefix + "/session")[0], 401)
            self.assertEqual(browser.request(prefix + "/login", credentials), (200, {"mfa_required": True}))
            self.assertEqual(browser.request(prefix + "/session")[0], 401)
            self.clock.return_value += 30
            code = totp(seed, int(self.clock.return_value) // 30)
            self.assertEqual(browser.request(prefix + "/login", credentials | {"code": code})[0], 200)
            original = browser.cookies[role]
            second = Browser(self.app)
            self.assertEqual(second.request(prefix + "/login", credentials | {"code": code})[0], 422)
            self.assertEqual(second.request(prefix + "/login", credentials | {"code": codes[0]})[0], 200)
            self.assertEqual(browser.request(prefix + "/session", cookie=original)[0], 401)
            self.assertEqual(browser.request(prefix + "/login", credentials | {"code": codes[0]})[0], 422)
            self.assertEqual(second.request(prefix + "/mfa/disable", {"password": "wrong", "code": codes[1]})[0], 422)
            self.assertEqual(second.request(prefix + "/mfa/disable", {"password": credentials["password"], "code": codes[1]})[0], 200)
            self.assertEqual(second.request(prefix + "/session")[0], 401)
            self.assertEqual(second.request(prefix + "/login", credentials), (200, {"ok": True}))

    def test_pending_is_bound_to_session_expires_and_enable_revokes_other_sessions(self):
        credentials = self.credentials("manager")
        browser, other = Browser(self.app), Browser(self.app)
        prefix = "/api/manager"
        for client in (browser, other):
            self.assertEqual(client.request(prefix + "/login", credentials)[0], 200)
        seed = browser.request(prefix + "/mfa/setup", {"password": credentials["password"]})[1]["setup_key"]
        code = totp(seed, int(self.clock.return_value) // 30)
        self.assertEqual(other.request(prefix + "/mfa/enable", {"code": code})[0], 409)
        self.clock.return_value += 601
        self.assertEqual(browser.request(prefix + "/mfa/enable", {"code": code})[0], 409)
        self.enroll(browser, "manager")
        self.assertEqual(other.request(prefix + "/session")[0], 401)

    def test_missing_key_fails_closed_for_enrolled_account(self):
        self.enroll(Browser(self.app), "owner")
        self.clock.return_value += 30
        for env in ({}, {"MFA_ENCRYPTION_KEY": Fernet.generate_key().decode()}):
            browser = Browser(create_app(self.database, env=env))
            result = browser.request("/api/owner/login", self.credentials("owner") | {"code": "123456"})
            self.assertEqual(result[0], 503)
            self.assertEqual(browser.request("/api/owner/session")[0], 401)
