"""Exercise the WSGI application and SQLite without binding a TCP port."""
import io
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit
from wsgiref.util import setup_testing_defaults
from wsgiref.validate import validator

from app import create_app
from database import open_db


class Browser:
    def __init__(self, application, host="local.test", origin="http://local.test"):
        self.application = validator(application)
        self.host = host
        self.origin = origin
        self.cookies = {}
        self.set_cookies = {}

    def request(self, path, data=None, cookie=None, origin=None):
        method = "GET" if data is None else "POST"
        payload = b"" if data is None else json.dumps(data).encode()
        role = path.split("/")[2] if path.startswith("/api/") else ""
        cookie = self.cookies.get(role, "") if cookie is None else cookie
        url = urlsplit(path)
        environ = {}
        setup_testing_defaults(environ)
        environ.update({
            "REQUEST_METHOD": method, "PATH_INFO": url.path, "QUERY_STRING": url.query,
            "HTTP_HOST": self.host, "HTTP_ORIGIN": self.origin if origin is None else origin,
            "HTTP_COOKIE": cookie, "CONTENT_TYPE": "application/json",
            "CONTENT_LENGTH": str(len(payload)), "wsgi.input": io.BytesIO(payload),
        })
        response = {}

        def start_response(status, headers):
            response.update(status=int(status.split()[0]), headers=dict(headers))

        chunks = self.application(environ, start_response)
        try:
            body = b"".join(chunks)
        finally:
            chunks.close()
        headers = response["headers"]
        if "Set-Cookie" in headers:
            self.set_cookies[role] = headers["Set-Cookie"]
            self.cookies[role] = headers["Set-Cookie"].split(";", 1)[0]
        if headers["Content-Type"].startswith("application/json"):
            body = json.loads(body)
        return response["status"], body


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.database = Path(temp.name) / "test.sqlite3"
        self.browser = Browser(create_app(self.database, env={}))
        time = patch("app.now", return_value="2026-11-22T10:00:00+05:30")
        self.addCleanup(time.stop)
        self.now = time.start()

    def expect(self, status, path, data=None, **kwargs):
        actual, body = self.browser.request(path, data, **kwargs)
        self.assertEqual(actual, status, body)
        return body

    def login(self):
        manager = {"email": "manager@demo.local", "password": "ManagerDemo123!"}
        owner = {"email": "owner@demo.local", "password": "OwnerDemo123!"}
        self.expect(403, "/api/owner/login", manager)
        self.expect(200, "/api/manager/login", manager)
        self.expect(200, "/api/owner/login", owner)

    def test_two_consecutive_shifts(self):
        self.assertIn(b"Pump Ledger", self.expect(200, "/manager"))
        self.assertIn(b"Pump Ledger", self.expect(200, "/owner"))
        self.expect(200, "/app.js")
        self.expect(200, "/styles.css")
        self.expect(401, "/api/manager/shift")
        self.login()
        initial = self.expect(200, "/api/manager/shift")
        self.assertEqual([n["opening"] for n in initial["setup"]["nozzles"]], [None, None])
        self.expect(400, "/api/manager/shift", {"openings": {}})
        first = self.expect(200, "/api/manager/shift", {"openings": {"1": "1000", "2": "2000"}})
        self.expect(409, "/api/manager/shift", {"openings": {"1": "1000", "2": "2000"}})
        self.expect(404, "/api/owner/shifts/1")
        self.expect(200, "/api/owner/settings", {"rates": {"Petrol": "105", "Diesel": "93"}})
        closing = {
            "closings": {"1": "1100.125", "2": "2050"},
            "deliveries": {"Petrol": "500", "Diesel": "250"},
            "physical": {"Petrol": "8399"},
            "collections": {"cash": "9000", "upi": "5000", "card": "1000", "credit": "78.06"},
            "expenses": "250", "counted": "8740",
            "expense_note": "Station cleaning",
        }
        self.expect(400, f"/api/manager/shifts/{first['id']}/submit",
                    closing | {"closings": {"1": "999", "2": "2050"}})
        # Two concurrent attempts against one open shift must create one report.
        with ThreadPoolExecutor(max_workers=2) as pool:
            attempts = list(pool.map(
                lambda _: self.browser.request(f"/api/manager/shifts/{first['id']}/submit", closing),
                range(2),
            ))
        self.assertEqual(sorted(status for status, _ in attempts), [200, 409])
        submitted = self.expect(200, f"/api/owner/shifts/{first['id']}")
        self.assertEqual(submitted["fuels"]["Petrol"]["rate"], 10450)
        self.assertEqual(submitted["fuels"]["Petrol"]["sales"], 1046306)
        self.assertEqual(submitted["fuels"]["Diesel"]["sales"], 461500)
        self.assertEqual(submitted["submitter"], "Asha Patil")
        self.assertEqual(submitted["expected"], 875000)
        self.assertEqual(submitted["cash_difference"], -1000)
        self.assertEqual(submitted["collection_difference"], 0)
        self.assertEqual(submitted["expense_note"], "Station cleaning")
        self.expect(409, "/api/owner/settings", {"opening_stock": {"Petrol": 0, "Diesel": 0}})
        self.expect(404, f"/api/manager/shifts/{first['id']}/review", {"note": "Invalid role"})
        reviewed = self.expect(200, f"/api/owner/shifts/{first['id']}/review", {"note": "Cash short by ₹10"})
        self.assertEqual(reviewed["review"]["reviewer"], "Rohan Deshmukh")
        self.assertEqual(reviewed["review"]["review_note"], "Cash short by ₹10")
        self.expect(409, f"/api/owner/shifts/{first['id']}/review", {"note": "Duplicate review"})
        self.expect(200, "/api/owner/settings", {"nozzle": {"code": "P-02", "fuel": "Petrol"}})
        self.expect(400, "/api/owner/settings", {"nozzle": {"code": "K-01", "fuel": "Kerosene"}})
        self.now.return_value = "2026-11-22T18:00:00+05:30"
        second = self.expect(200, "/api/manager/shift", {"openings": {"1": "10", "3": "30"}})
        self.assertEqual([n["opening"] for n in second["nozzles"]], [1100125, 2050000, 30000])
        self.assertEqual([n["carried"] for n in second["nozzles"]], [True, True, False])
        self.expect(200, f"/api/manager/shifts/{second['id']}/submit", {
            "closings": {"1": "1120.125", "2": "2075", "3": "35"},
            "collections": {"cash": "1000", "upi": "3950"},
            "counted": "1000", "physical": {"Diesel": "10170"},
        })
        dashboard = self.expect(200, "/api/owner/dashboard?date=2026-11-22")
        self.assertEqual(dashboard["daily"], {
            "Petrol": {"litres": 125125, "sales": 1308806},
            "Diesel": {"litres": 75000, "sales": 694000},
        })
        petrol, diesel = (dashboard["stock"][fuel] for fuel in ("Petrol", "Diesel"))
        self.assertEqual((petrol["calculated"], diesel["calculated"]), (8374875, 10175000))
        self.assertEqual((petrol["physical"]["litres"], diesel["physical"]["litres"]), (8399000, 10170000))
        self.assertEqual([shift["id"] for shift in dashboard["shifts"]], [second["id"], first["id"]])
        self.assertIsNotNone(dashboard["shifts"][1]["reviewed_at"])
        self.assertEqual(self.expect(200, "/api/owner/dashboard?date=2026-11-21")["shifts"], [])

    def test_station_and_role_access(self):
        self.login()
        self.expect(403, "/api/owner/dashboard",
                    cookie=self.browser.cookies["manager"].replace("pm_manager=", "pm_owner="))
        shift = self.expect(200, "/api/manager/shift", {"openings": {"1": 0, "2": 0}})
        self.expect(200, f"/api/manager/shifts/{shift['id']}/submit",
                    {"closings": {"1": 0, "2": 0}, "collections": {}, "counted": 0})
        with closing(open_db(self.database)) as db, db:
            db.execute("INSERT INTO stations VALUES (2, 'Other Fictional Station', 'OTHER')")
            db.execute("INSERT INTO fuels SELECT 2, fuel, rate, opening_stock FROM fuels WHERE station_id = 1")
            db.execute("UPDATE users SET station_id = 2 WHERE role = 'owner'")
        self.expect(404, f"/api/owner/shifts/{shift['id']}")
        self.expect(404, f"/api/owner/shifts/{shift['id']}/review", {"note": "Invalid station"})
        self.assertEqual(self.expect(200, "/api/owner/dashboard")["shifts"], [])
        self.expect(200, "/api/owner/logout", {})
        self.expect(401, "/api/owner/dashboard")


class HostedTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "petroleum.sqlite3"
        self.env = {
            "RENDER": "true",
            "TURSO_DATABASE_URL": "libsql://pump-example.turso.io",
            "TURSO_AUTH_TOKEN": "test-only-token",
        }

        try:
            import libsql
        except ModuleNotFoundError:
            libsql = SimpleNamespace(connect=sqlite3.connect, Error=ValueError)
        driver_connect = libsql.connect

        def connect(*, database, auth_token, isolation_level):
            self.assertEqual(database, self.env["TURSO_DATABASE_URL"])
            self.assertEqual(auth_token, self.env["TURSO_AUTH_TOKEN"])
            return driver_connect(str(self.database), isolation_level=isolation_level)

        # Render's build exercises the native driver against a local test
        # file. Local tests can run with SQLite when libsql is unavailable.
        driver = SimpleNamespace(connect=connect, Error=libsql.Error)
        modules = patch.dict("sys.modules", {"libsql": driver})
        self.addCleanup(modules.stop)
        modules.start()

    def test_configure_hosted_station_and_reopen_database(self):
        env = self.env.copy()
        with self.assertRaisesRegex(RuntimeError, "PETROLEUM_MANAGER_EMAIL"):
            create_app(env=env)
        owner = {"email": "owner@example.test", "password": "Hosted-owner-test-password"}
        manager = {"email": "manager@example.test", "password": "Hosted-manager-test-password"}
        env.update({
            "PETROLEUM_OWNER_EMAIL": owner["email"], "PETROLEUM_OWNER_PASSWORD": owner["password"],
            "PETROLEUM_MANAGER_EMAIL": manager["email"], "PETROLEUM_MANAGER_PASSWORD": manager["password"],
        })
        browser = Browser(create_app(env=env), "pump.onrender.com", "https://pump.onrender.com")
        self.assertEqual(browser.request("/healthz"), (200, {"ok": True}))
        self.assertNotIn(b'demo-mode', browser.request("/manager")[1])
        self.assertEqual(browser.request("/api/owner/login", owner, origin="https://unrelated.test")[0], 403)
        self.assertEqual(browser.request("/api/owner/login", owner, origin="http://pump.onrender.com")[0], 403)
        self.assertEqual(browser.request("/api/owner/login", owner)[0], 200)
        self.assertIn("; Secure", browser.set_cookies["owner"])
        self.assertEqual(browser.request("/api/manager/login", manager)[0], 200)
        openings = {"openings": {"1": "100", "2": "200"}}
        self.assertEqual(browser.request("/api/manager/shift", openings)[0], 409)
        self.assertEqual(browser.request("/api/owner/settings", {"rates": {"Petrol": "105", "Diesel": "90"}})[0], 200)
        self.assertEqual(browser.request("/api/owner/settings", {"nozzle": {"code": "P-01", "fuel": "Petrol"}})[0], 409)
        self.assertEqual(browser.request("/api/owner/settings", {"opening_stock": {"Petrol": "1000", "Diesel": "2000"}})[0], 200)
        status, shift = browser.request("/api/manager/shift", openings)
        self.assertEqual(status, 200)
        self.assertEqual(browser.request(f"/api/manager/shifts/{shift['id']}/submit", {
            "closings": {"1": "120", "2": "210"}, "collections": {"cash": "3000"}, "counted": "3000",
        })[0], 200)
        restarted = Browser(create_app(env=self.env),
                            "pump.onrender.com", "https://pump.onrender.com")
        restarted.cookies = browser.cookies.copy()
        self.assertEqual(restarted.request(f"/api/owner/shifts/{shift['id']}")[1]["sales"], 300000)
        self.assertEqual(restarted.request("/api/owner/logout", {})[0], 200)
        self.assertIn("; Secure", restarted.set_cookies["owner"])
        self.assertEqual(restarted.request("/api/owner/dashboard")[0], 401)

    def test_reject_missing_turso_config_and_demo_database(self):
        with self.assertRaisesRegex(RuntimeError, "Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN"):
            create_app(env={"RENDER": "true", "PETROLEUM_DB": str(self.database)})
        with self.assertRaisesRegex(RuntimeError, "database URL from Turso"):
            create_app(env=self.env | {"TURSO_DATABASE_URL": "http://pump-example.turso.io"})
        create_app(self.database, env={})
        with self.assertRaisesRegex(RuntimeError, "contains demo accounts"):
            create_app(env=self.env)


if __name__ == "__main__":
    unittest.main()
