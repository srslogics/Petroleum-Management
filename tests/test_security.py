"""Regression checks for authentication, account auditing and browser policy."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from app import create_app
from security import client_address
from test_workflow import Browser


class SecurityTest(TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.database = Path(folder.name) / "security.sqlite3"
        self.browser = Browser(create_app(self.database, env={}))
        self.owner = {"email": "owner@demo.local", "password": "OwnerDemo123!"}

    def test_login_throttle_applies_across_sources_and_expires(self):
        with patch("security.monotonic", return_value=1000) as clock:
            for index in range(10):
                bad_login = self.owner | {"email": "OWNER@demo.local", "password": "incorrect"}
                status, _ = self.browser.request("/api/owner/login", bad_login,
                                                 headers={"REMOTE_ADDR": f"192.0.2.{index}"})
                self.assertEqual(status, 401)
            route = "/api/owner/login"
            self.assertEqual(self.browser.request(route, self.owner, headers={"REMOTE_ADDR": "192.0.2.20"})[0], 429)
            self.assertEqual(self.browser.response_headers[route]["Retry-After"], "300")
            clock.return_value += 301
            self.assertEqual(self.browser.request(route, self.owner)[0], 200)

    def test_client_address_does_not_trust_unconfigured_forwarding(self):
        environ = {"REMOTE_ADDR": "192.0.2.20", "HTTP_X_FORWARDED_FOR": "192.0.2.11, 198.51.100.1"}
        self.assertEqual(client_address(environ), "192.0.2.20")
        self.assertEqual(client_address(environ, render_proxy=True), "198.51.100.1")
        self.assertEqual(client_address({"REMOTE_ADDR": "2001:db8::1234"}), "2001:db8::")

    def test_cross_origin_browser_calls_are_rejected_and_response_is_private(self):
        self.assertEqual(self.browser.request("/api/owner/login", self.owner)[0], 200)
        for site in ("same-site", "cross-site"):
            headers = {"HTTP_SEC_FETCH_SITE": site}
            self.assertEqual(self.browser.request("/api/owner/session", origin="", headers=headers)[0], 403)
            self.assertEqual(self.browser.request("/api/owner/logout", {}, origin="", headers=headers)[0], 403)
        self.assertEqual(self.browser.request("/api/owner/session")[0], 200)
        headers = self.browser.response_headers["/api/owner/session"]
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertIn("form-action 'self'", headers["Content-Security-Policy"])
        self.assertNotIn("Strict-Transport-Security", headers)

    def test_relogin_rotates_cookie_and_caps_active_sessions(self):
        session_cookies = []
        for _ in range(11):
            self.assertEqual(self.browser.request("/api/owner/login", self.owner, cookie="")[0], 200)
            session_cookies.append(self.browser.cookies["owner"])
        statuses = [self.browser.request("/api/owner/session", cookie=cookie)[0] for cookie in session_cookies]
        self.assertEqual(statuses.count(200), 10)
        self.assertEqual(statuses[-1], 200)
        self.assertEqual(self.browser.request("/api/owner/login", self.owner)[0], 200)
        self.assertEqual(self.browser.request("/api/owner/session", cookie=session_cookies[-1])[0], 401)

    def test_account_events_exclude_secrets_and_require_owner(self):
        self.assertEqual(self.browser.request("/api/owner/login", self.owner)[0], 200)
        manager = {"name": "Test manager", "phone": "9000000111", "password": "Test manager phrase"}
        self.assertEqual(self.browser.request("/api/owner/managers", manager | {"password": "12345678901234"})[0], 400)
        self.assertEqual(self.browser.request("/api/owner/managers", manager)[0], 200)
        self.assertEqual(self.browser.request("/api/manager/login", {"identifier": manager["phone"], "password": manager["password"]})[0], 200)
        self.assertEqual(self.browser.request("/api/manager/account-audit")[0], 404)
        status, records = self.browser.request("/api/owner/account-audit")
        self.assertEqual(status, 200)
        self.assertEqual(records[0]["action"], "create")
        self.assertEqual(records[0]["target"], manager["name"])
        self.assertNotIn(manager["password"], json.dumps(records))
        self.assertNotIn(manager["phone"], json.dumps(records))
