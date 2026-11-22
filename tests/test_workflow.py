"""Exercise the WSGI application and SQLite without binding a TCP port."""
import io
import json
import re
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit
from wsgiref.util import setup_testing_defaults
from wsgiref.validate import validator

from app import create_app, reset_owner, setup_owner
from database import TursoDatabase, encode_arg, open_db


class Browser:
    def __init__(self, application, host="local.test", origin="http://local.test"):
        self.application = validator(application)
        self.host = host
        self.origin = origin
        self.cookies = {}
        self.set_cookies = {}
        self.response_headers = {}

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
        self.response_headers[path] = headers
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

    def test_only_versioned_public_assets_are_cached(self):
        html = self.expect(200, "/owner").decode()
        self.assertEqual(self.browser.response_headers["/owner"]["Cache-Control"], "no-store")
        for asset in ("/styles.css", "/app.js", "/daily-report.js", "/tuljai-logo.jpg"):
            versioned = re.search(re.escape(asset) + r"\?v=[a-f0-9]{16}", html)[0]
            self.assertEqual(self.expect(200, versioned), self.expect(200, asset))
            self.assertIn("immutable", self.browser.response_headers[versioned]["Cache-Control"])
            self.assertEqual(self.browser.response_headers[asset]["Cache-Control"], "no-store")
        self.expect(401, "/api/owner/dashboard")
        self.assertEqual(self.browser.response_headers["/api/owner/dashboard"]["Cache-Control"], "no-store")

    def test_pwa_role_manifests_and_offline_assets(self):
        for role in ("owner", "manager"):
            manifest = self.expect(200, f"/{role}.webmanifest")
            # Browser fixture returns non-application/json bodies as bytes.
            manifest = json.loads(manifest)
            self.assertEqual((manifest["id"], manifest["start_url"], manifest["display"]),
                             ("/" + role, "/" + role, "standalone"))
            page = self.expect(200, "/" + role).decode()
            self.assertIn(f'/{role}.webmanifest?v=', page)
            self.assertIn('rel="apple-touch-icon"', page)
            for icon in manifest["icons"]:
                self.assertTrue(self.expect(200, icon["src"]).startswith(b"\x89PNG"))
        self.expect(200, "/offline.html")
        self.expect(200, "/offline.css")
        self.expect(200, "/pwa.js")
        self.expect(200, "/sw.js")
        self.assertEqual(self.browser.response_headers["/sw.js"]["Cache-Control"], "no-store")

    def test_social_previews_are_present_before_sign_in(self):
        from html.parser import HTMLParser

        class Metadata(HTMLParser):
            def __init__(self):
                super().__init__()
                self.tags = {}
            def handle_starttag(self, tag, attributes):
                attrs = dict(attributes)
                if tag == "meta":
                    self.tags[attrs.get("property", attrs.get("name"))] = attrs.get("content")

        for path in ("/", "/owner", "/manager"):
            page = self.expect(200, path).decode()
            parser = Metadata()
            parser.feed(page)
            self.assertEqual(parser.tags["og:url"], "https://petroleum-management.onrender.com" + path)
            self.assertTrue(parser.tags["og:title"].startswith("Tuljai"))
            self.assertEqual(parser.tags["twitter:card"], "summary_large_image")
            image = parser.tags["og:image"]
            self.assertEqual(image, parser.tags["twitter:image"])
            self.assertTrue(self.expect(200, image).startswith(b"\xff\xd8"))
            self.assertNotIn("__PAGE_", page)
            self.assertNotIn("password_hash", page)

    def test_manager_entries_are_saved_and_visible_to_owner(self):
        self.login()
        active = self.expect(200, "/api/manager/shift", {"openings": {"1": 100, "2": 200}})
        entries = {
            "payments": [
                {"method": "upi", "amount": "100", "reference": "UTR-TEST", "party": "Customer"},
                {"method": "upi", "amount": "50"},
                {"method": "credit", "amount": "25", "party": "Fleet account"},
            ],
            "deliveries": [{"fuel": "Petrol", "quantity": "200", "party": "Demo supplier", "reference": "CH-01"}],
            "expenses": [{"amount": "10", "party": "Cleaner", "note": "Cleaning"}],
        }
        closing = {"closings": {"1": 110, "2": 210}, "collections": {"cash": "1000", "upi": "999"},
                   "expenses": "999", "counted": "990", "entries": entries, "shift_note": "Check nozzle hose"}
        invalid = dict(closing, entries={**entries, "payments": [{"method": "credit", "amount": "25"}]})
        self.expect(400, f"/api/manager/shifts/{active['id']}/submit", invalid)
        self.expect(200, f"/api/manager/shifts/{active['id']}/submit", closing)
        report = self.expect(200, f"/api/owner/shifts/{active['id']}")
        self.assertEqual(report["collections"]["upi"], 15000)
        self.assertEqual(report["collections"]["credit"], 2500)
        self.assertEqual(report["expenses"], 1000)
        self.assertEqual(report["expected"], 99000)
        self.assertEqual(report["fuels"]["Petrol"]["delivery"], 200000)
        self.assertEqual(report["entries"]["payments"][0]["reference"], "UTR-TEST")
        daily = self.expect(200, "/api/owner/daily-report?date=2026-11-22")
        self.assertEqual(daily["shifts"][0]["shift_note"], "Check nozzle hose")
        self.assertEqual(daily["shifts"][0]["entries"], report["entries"])
        self.expect(409, f"/api/manager/shifts/{active['id']}/submit", closing)

    def test_two_consecutive_shifts(self):
        self.assertIn(b"Tuljai Petroleum", self.expect(200, "/manager"))
        self.assertIn(b"Tuljai Petroleum", self.expect(200, "/owner"))
        self.expect(200, "/app.js")
        self.expect(200, "/styles.css")
        self.expect(200, "/daily-report.js")
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

    def test_daily_report_payment_reconciliation_and_stock_carry_forward(self):
        self.login()
        first = self.expect(200, "/api/manager/shift", {"openings": {"1": "100", "2": "200"}})
        self.expect(200, f"/api/manager/shifts/{first['id']}/submit", {
            "closings": {"1": "110", "2": "210"}, "deliveries": {"Petrol": "100", "Diesel": "50"},
            "collections": {"cash": "1000", "upi": "400", "card": "300", "credit": "268"},
            "expenses": "50", "counted": "940", "physical": {"Petrol": "8088"}, "expense_note": "Cleaning",
        })
        self.expect(200, f"/api/owner/shifts/{first['id']}/review", {"note": "Cash checked"})
        second = self.expect(200, "/api/manager/shift", {})
        self.expect(200, f"/api/manager/shifts/{second['id']}/submit", {
            "closings": {"1": "120", "2": "220"}, "collections": {"cash": "500", "upi": "1000", "card": "400"},
            "counted": "510",
        })
        self.now.return_value = "2026-11-23T09:00:00+05:30"
        outside = self.expect(200, "/api/manager/shift", {})
        self.expect(200, f"/api/manager/shifts/{outside['id']}/submit", {
            "closings": {"1": "125", "2": "220"}, "collections": {"cash": "522.50"}, "counted": "522.50",
        })
        response = self.expect(200, "/api/owner/daily-report?date=2026-11-22")
        self.assertEqual(response["payments"], {"cash": 150000, "upi": 140000, "card": 70000, "credit": 26800})
        self.assertEqual((response["sales"], response["receipts"], response["accounted"], response["sales_difference"]),
                         (393600, 360000, 386800, -6800))
        self.assertEqual(response["till"], {"expenses": 5000, "expected": 145000, "counted": 145000,
                                           "cash_difference": 0, "shortage": 1000, "overage": 1000})
        self.assertEqual(response["nozzles"][0], {
            "code": "P-01", "fuel": "Petrol", "opening": 100000, "closing": 120000, "litres": 20000,
        })
        petrol = response["fuels"]["Petrol"]
        self.assertEqual((petrol["opening_stock"], petrol["delivery"], petrol["closing_stock"]),
                         (8000000, 100000, 8080000))
        self.assertEqual(petrol["physical"], {
            "litres": 8088000, "shift_id": first["id"], "submitted_at": "2026-11-22T10:00:00+05:30",
            "book_at_reading": 8090000, "difference": -2000,
        })
        self.assertEqual([shift["id"] for shift in response["shifts"]], [first["id"], second["id"]])
        self.assertEqual(response["shifts"][0]["review_note"], "Cash checked")
        self.assertEqual(response["shifts"][0]["expense_note"], "Cleaning")
        next_day = self.expect(200, "/api/owner/daily-report")
        self.assertEqual(next_day["fuels"]["Petrol"]["opening_stock"], 8080000)
        self.assertEqual(next_day["fuels"]["Petrol"]["closing_stock"], 8075000)
        self.assertIsNone(next_day["fuels"]["Petrol"]["physical"])
        self.assertEqual([shift["id"] for shift in next_day["shifts"]], [outside["id"]])
        empty = self.expect(200, "/api/owner/daily-report?date=2026-11-24")
        self.assertEqual(empty["shifts"], [])
        self.assertEqual(empty["fuels"]["Petrol"]["opening_stock"], 8075000)
        self.expect(400, "/api/owner/daily-report?date=2026-11-31")
        self.expect(404, "/api/manager/daily-report")

    def test_original_email_accounts_survive_schema_update(self):
        with closing(open_db(self.database)) as db:
            db.execute("ALTER TABLE users RENAME COLUMN login_id TO email")
        self.browser = Browser(create_app(self.database, env={}))
        self.login()

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
        self.assertEqual(self.expect(200, "/api/owner/daily-report")["shifts"], [])
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

        self.pipeline_count = 0
        database_path = self.database
        test = self

        class PipelineServer:
            def __init__(self, host, timeout):
                test.assertEqual(host, "pump-example.turso.io")
                self.sock = None
                self.timeout = timeout
                self.db = sqlite3.connect(database_path, isolation_level=None)
                self.baton = None
                test.addCleanup(self.db.close)

            def request(self, method, path, body, headers):
                test.pipeline_count += 1
                test.assertEqual((method, path), ("POST", "/v2/pipeline"))
                test.assertEqual(headers["Authorization"], "Bearer test-only-token")
                request = json.loads(body)
                test.assertEqual(request["baton"], self.baton)
                results = []
                for operation in request["requests"]:
                    if operation["type"] == "close":
                        self.db.close()
                        self.baton = None
                        results.append({"type": "ok", "response": {"type": "close"}})
                        break
                    statement = operation["stmt"]
                    params = [
                        int(arg["value"]) if arg["type"] == "integer" else arg.get("value")
                        for arg in statement["args"]
                    ]
                    try:
                        cursor = self.db.execute(statement["sql"], params)
                        rows = cursor.fetchall()
                    except sqlite3.Error as error:
                        results.append({"type": "error", "error": {"code": error.sqlite_errorname}})
                        continue
                    results.append({"type": "ok", "response": {"type": "execute", "result": {
                        "cols": [{"name": column[0]} for column in cursor.description or ()],
                        "rows": [[encode_arg(value) for value in row] for row in rows],
                    }}})
                else:
                    self.baton = "next:" + (self.baton or "")
                self.payload = {"baton": self.baton, "base_url": None, "results": results}

            def getresponse(self):
                response = io.BytesIO(json.dumps(self.payload).encode())
                response.status = 200
                return response

            def close(self):
                self.db.close()

        transport = patch("database.HTTPSConnection", PipelineServer)
        self.addCleanup(transport.stop)
        transport.start()

    def test_authenticated_screen_reads_use_two_database_requests(self):
        env = self.env
        database = TursoDatabase.from_env(env, required=True)
        setup_owner(database, env, "9000000001", "TestOw7")
        browser = Browser(create_app(env=env), "pump.onrender.com", "https://pump.onrender.com")
        self.assertEqual(browser.request("/api/owner/login", {"identifier": "9000000001", "password": "TestOw7"})[0], 200)
        for path in ("/api/owner/dashboard", "/api/owner/daily-report", "/api/owner/settings"):
            before = self.pipeline_count
            status, data = browser.request(path)
            self.assertEqual((status, self.pipeline_count - before), (200, 2), path)
            if path != "/api/owner/settings":
                self.assertEqual(data["session"]["role"], "owner")
                self.assertNotIn("password_hash", data["session"])
        self.assertEqual(browser.request("/api/owner/managers", {
            "name": "Test Manager", "phone": "9000000002", "password": "TestMg7",
        })[0], 200)
        self.assertEqual(browser.request("/api/manager/login", {"identifier": "9000000002", "password": "TestMg7"})[0], 200)
        before = self.pipeline_count
        status, data = browser.request("/api/manager/shift")
        self.assertEqual((status, self.pipeline_count - before), (200, 2))
        self.assertEqual(data["session"]["role"], "manager")

    def test_database_timeout_returns_json_and_keeps_health_responding(self):
        browser = Browser(create_app(env=self.env), "pump.onrender.com", "https://pump.onrender.com")
        with patch("database.HTTPSConnection.request", side_effect=TimeoutError), self.assertLogs(level="WARNING"):
            self.assertEqual(browser.request("/api/owner/session")[0], 401)
            self.assertEqual(browser.request("/api/owner/login", {"identifier": "probe", "password": "probe"}),
                             (503, {"error": "Database temporarily unavailable. Please try again."}))
            self.assertEqual(browser.request("/healthz"), (200, {"ok": True}))

    def test_configure_hosted_station_and_reopen_database(self):
        env = self.env
        owner = {"identifier": "9000000001", "password": "TestOw7"}
        manager = {"identifier": "9000000002", "password": "TestMg7"}
        browser = Browser(create_app(env=env), "pump.onrender.com", "https://pump.onrender.com")
        self.assertEqual(browser.request("/healthz"), (200, {"ok": True}))
        self.assertEqual(browser.request("/api/owner/login", owner)[0], 401)
        database = TursoDatabase.from_env(env, required=True)
        with self.assertRaisesRegex(RuntimeError, "7–200 characters"):
            setup_owner(database, env, owner["identifier"], "TestOw")
        setup_owner(database, env, "+91 90000 00001", owner["password"])
        with self.assertRaisesRegex(RuntimeError, "An owner already exists"):
            setup_owner(database, env, "9000000003", "Different-test-password")
        self.assertNotIn(b'demo-mode', browser.request("/manager")[1])
        self.assertEqual(browser.request("/api/owner/login", owner, origin="https://unrelated.test")[0], 403)
        self.assertEqual(browser.request("/api/owner/login", owner, origin="http://pump.onrender.com")[0], 403)
        self.assertEqual(browser.request("/api/owner/login", owner)[0], 200)
        self.assertIn("; Secure", browser.set_cookies["owner"])
        self.assertEqual(browser.request("/api/owner/managers"), (200, []))
        self.assertEqual(browser.request("/api/manager/login", manager)[0], 401)
        new_manager = {"name": "Test Manager", "phone": "+91-90000-00002", "password": manager["password"]}
        self.assertEqual(browser.request("/api/owner/managers", new_manager | {"password": "TestMg"})[0], 400)
        status, created = browser.request("/api/owner/managers", new_manager)
        self.assertEqual((status, created), (200, {"name": "Test Manager", "login_id": "+919000000002"}))
        self.assertEqual(browser.request("/api/owner/managers", new_manager | {"phone": manager["identifier"]})[0], 409)
        self.assertEqual(browser.request("/api/owner/managers", new_manager | {"phone": owner["identifier"]})[0], 409)
        self.assertEqual(browser.request("/api/manager/login", manager)[0], 200)
        self.assertEqual(browser.request("/api/manager/managers", new_manager)[0], 404)
        self.assertEqual(browser.request("/api/owner/managers", new_manager,
                                         cookie=browser.cookies["manager"].replace("pm_manager", "pm_owner"))[0], 403)
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
        status, daily = restarted.request("/api/owner/daily-report")
        self.assertEqual((status, daily["receipts"]), (200, 300000))
        self.assertEqual(restarted.request("/api/owner/logout", {})[0], 200)
        self.assertIn("; Secure", restarted.set_cookies["owner"])
        self.assertEqual(restarted.request("/api/owner/dashboard")[0], 401)

    def test_reset_owner_preserves_account_and_revokes_sessions(self):
        env = self.env
        database = TursoDatabase.from_env(env, required=True)
        setup_owner(database, env, "9000000001", "TestOw7")
        browser = Browser(create_app(env=env), "pump.onrender.com", "https://pump.onrender.com")
        old = {"identifier": "9000000001", "password": "TestOw7"}
        self.assertEqual(browser.request("/api/owner/login", old)[0], 200)
        original_id = browser.request("/api/owner/session")[1]["id"]
        self.assertEqual(browser.request("/api/owner/managers", {
            "name": "Test Manager", "phone": "9000000002", "password": "TestMg7",
        })[0], 200)
        with self.assertRaisesRegex(RuntimeError, "different account"):
            reset_owner(database, "9000000002", "TestOw8")
        self.assertEqual(browser.request("/api/owner/session")[0], 200)
        reset_owner(database, "+91 90000 00003", "TestOw8")
        self.assertEqual(browser.request("/api/owner/session")[0], 401)
        self.assertEqual(browser.request("/api/owner/login", old)[0], 401)
        self.assertEqual(browser.request("/api/owner/login", {"identifier": "9000000003", "password": "TestOw8"})[0], 200)
        self.assertEqual(browser.request("/api/owner/session")[1]["id"], original_id)
        self.assertEqual(len(browser.request("/api/owner/managers")[1]), 1)

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
