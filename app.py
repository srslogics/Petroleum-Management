"""Local Phase 1 HTTP server and SQLite persistence."""
import argparse
import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing, contextmanager
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
TZ = ZoneInfo("Asia/Kolkata")
FUELS = ("Petrol", "Diesel")
METHODS = ("cash", "upi", "card", "credit")
DEMO_USERS = (
    ("manager", "manager@demo.local", "Asha Patil", "ManagerDemo123!"),
    ("owner", "owner@demo.local", "Rohan Deshmukh", "OwnerDemo123!"),
)
SCHEMA = """
CREATE TABLE IF NOT EXISTS stations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id),
    role TEXT NOT NULL CHECK(role IN ('manager','owner')), email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    expiry INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fuels (
    station_id INTEGER NOT NULL REFERENCES stations(id),
    fuel TEXT NOT NULL CHECK(fuel IN ('Petrol','Diesel')),
    rate INTEGER NOT NULL, opening_stock INTEGER NOT NULL, PRIMARY KEY(station_id, fuel)
);
CREATE TABLE IF NOT EXISTS nozzles (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id),
    code TEXT NOT NULL COLLATE NOCASE, fuel TEXT NOT NULL, UNIQUE(station_id, code),
    FOREIGN KEY(station_id, fuel) REFERENCES fuels(station_id, fuel)
);
CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id),
    business_date TEXT NOT NULL, opened_at TEXT NOT NULL, opened_by INTEGER NOT NULL REFERENCES users(id),
    opening_json TEXT NOT NULL, submitted_at TEXT, submitted_by INTEGER REFERENCES users(id),
    report_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts(station_id) WHERE submitted_at IS NULL;
CREATE TABLE IF NOT EXISTS reviews (
    shift_id INTEGER PRIMARY KEY REFERENCES shifts(id), user_id INTEGER NOT NULL REFERENCES users(id),
    reviewed_at TEXT NOT NULL, note TEXT NOT NULL
);
"""


class RequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def fail(message, status=400):
    raise RequestError(status, message)


def now():
    return datetime.now(TZ).isoformat(timespec="seconds")


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600_000).hex()


def open_db(path):
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def initialize(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(open_db(path)) as db, db:
        db.executescript(SCHEMA)
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM stations LIMIT 1").fetchone():
            return
        db.execute("INSERT INTO stations VALUES (1, 'Horizon Fuel Station', 'HZN-01')")
        db.executemany("INSERT INTO fuels VALUES (1, ?, ?, ?)", [
            ("Petrol", 10450, 8000000), ("Diesel", 9230, 10000000),
        ])
        db.executemany("INSERT INTO nozzles(station_id, code, fuel) VALUES (1, ?, ?)", [
            ("P-01", "Petrol"), ("D-01", "Diesel"),
        ])
        for role, email, name, password in DEMO_USERS:
            salt = secrets.token_hex(16)
            db.execute("""INSERT INTO users(station_id, role, email, name, salt, password_hash)
                          VALUES (1, ?, ?, ?, ?, ?)""",
                       (role, email, name, salt, password_hash(password, salt)))


@contextmanager
def write(db):
    with db:
        db.execute("BEGIN IMMEDIATE")
        yield


def number(value, places, label, optional=False):
    if optional and (value is None or value == ""):
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        fail(f"Enter a valid {label}.")
    try:
        parsed = Decimal(str(value).strip())
        if not parsed.is_finite() or not 0 <= parsed <= 1_000_000_000:
            raise InvalidOperation
        scaled = parsed * (10 ** places)
        if scaled != scaled.to_integral_value():
            raise InvalidOperation
        return int(scaled)
    except (InvalidOperation, ValueError):
        fail(f"Enter {label} from 0 to 1,000,000,000 with up to {places} decimal places.")


def mapping(value, label):
    if not isinstance(value, dict):
        fail(f"Enter valid {label}.")
    return value


def note(value, label, limit=250):
    if not isinstance(value, str) or len(value.strip()) > limit:
        fail(f"Enter {label} of up to {limit} characters.")
    return value.strip()


def config(db, sid):
    return {
        "fuels": {row["fuel"]: dict(row) for row in db.execute(
            "SELECT fuel, rate, opening_stock FROM fuels WHERE station_id = ?", (sid,))},
        "nozzles": [dict(row) for row in db.execute(
            "SELECT id, code, fuel FROM nozzles WHERE station_id = ? ORDER BY id", (sid,))],
    }


def get_open(db, sid):
    return db.execute("SELECT * FROM shifts WHERE station_id = ? AND submitted_at IS NULL", (sid,)).fetchone()


def shift_identity(row):
    return {key: row[key] for key in ("id", "business_date", "opened_at")}


def open_shift_public(row):
    return {**shift_identity(row), **json.loads(row["opening_json"])}


def manager_state(db, sid):
    active = get_open(db, sid)
    if active:
        return {"active": open_shift_public(active)}
    current = config(db, sid)
    readings = {}
    last = None
    for row in db.execute("""SELECT id, business_date, submitted_at, report_json FROM shifts
                             WHERE station_id = ? AND submitted_at IS NOT NULL ORDER BY id DESC""", (sid,)):
        if last is None:
            last = {key: row[key] for key in ("id", "business_date", "submitted_at")}
        for nozzle in json.loads(row["report_json"])["nozzles"]:
            readings.setdefault(nozzle["id"], nozzle["closing"])
        if len(readings) == len(current["nozzles"]):
            break
    for nozzle in current["nozzles"]:
        nozzle["opening"] = readings.get(nozzle["id"])
    return {"active": None, "setup": current, "last": last}


def start_shift(db, user, body):
    sid = user["station_id"]
    manual = mapping(body.get("openings", {}), "opening readings")
    with write(db):
        state = manager_state(db, sid)
        if state["active"]:
            fail("A shift is already open. Reload to resume it.", 409)
        setup = state["setup"]
        if not setup["nozzles"]:
            fail("Configure at least one nozzle before opening a shift.", 409)
        for nozzle in setup["nozzles"]:
            nozzle["carried"] = nozzle["opening"] is not None
            if not nozzle["carried"]:
                nozzle["opening"] = number(manual.get(str(nozzle["id"])), 3, f'{nozzle["code"]} opening reading')
        opened = now()
        db.execute("""INSERT INTO shifts(station_id, business_date, opened_at, opened_by, opening_json)
                      VALUES (?, ?, ?, ?, ?)""",
                   (sid, opened[:10], opened, user["id"], json.dumps({
                       "nozzles": setup["nozzles"],
                       "rates": {fuel: setup["fuels"][fuel]["rate"] for fuel in FUELS},
                   })))
        return open_shift_public(get_open(db, sid))


def report(db, sid, shift_id):
    row = db.execute("""SELECT s.*, u.name AS submitter, r.reviewed_at, r.note AS review_note,
                               reviewer.name AS reviewer
                        FROM shifts s JOIN users u ON u.id = s.submitted_by
                        LEFT JOIN reviews r ON r.shift_id = s.id
                        LEFT JOIN users reviewer ON reviewer.id = r.user_id
                        WHERE s.station_id = ? AND s.id = ?""", (sid, shift_id)).fetchone()
    if not row:
        fail("Submitted shift not found.", 404)
    review = None
    if row["reviewed_at"]:
        review = {key: row[key] for key in ("reviewed_at", "review_note", "reviewer")}
    return {**shift_identity(row), **json.loads(row["report_json"]),
            "submitted_at": row["submitted_at"], "submitter": row["submitter"], "review": review}


def submit_shift(db, user, shift_id, body):
    sid = user["station_id"]
    with write(db):
        row = db.execute("SELECT * FROM shifts WHERE id = ? AND station_id = ?", (shift_id, sid)).fetchone()
        if not row:
            fail("Shift not found.", 404)
        if row["submitted_at"]:
            fail("This shift has already been submitted.", 409)
        draft = json.loads(row["opening_json"])
        closings = mapping(body.get("closings"), "closing readings")
        collections_input = mapping(body.get("collections"), "collections")
        deliveries_input = mapping(body.get("deliveries", {}), "deliveries")
        physical_input = mapping(body.get("physical", {}), "physical stock readings")
        litres = dict.fromkeys(FUELS, 0)
        for nozzle in draft["nozzles"]:
            closing_reading = number(closings.get(str(nozzle["id"])), 3, f'{nozzle["code"]} closing reading')
            if closing_reading < nozzle["opening"]:
                fail(f'{nozzle["code"]} closing reading must be at least its opening reading.')
            nozzle["closing"] = closing_reading
            nozzle["litres"] = closing_reading - nozzle["opening"]
            litres[nozzle["fuel"]] += nozzle["litres"]
        fuels = {}
        for fuel in FUELS:
            rate = draft["rates"][fuel]
            sales = int((Decimal(litres[fuel]) * rate / 1000).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            fuels[fuel] = {
                "litres": litres[fuel], "rate": rate, "sales": sales,
                "delivery": number(deliveries_input.get(fuel), 3, f"{fuel} delivery", optional=True) or 0,
                "physical": number(physical_input.get(fuel), 3, f"{fuel} physical stock", optional=True),
            }
        collections = {method: number(collections_input.get(method), 2, f"{method} collection", optional=True) or 0
                       for method in METHODS}
        expenses = number(body.get("expenses"), 2, "till expenses", optional=True) or 0
        counted = number(body.get("counted"), 2, "actual cash counted")
        expected = collections["cash"] - expenses
        sales = sum(item["sales"] for item in fuels.values())
        collection_total = sum(collections.values())
        payload = {
            "nozzles": draft["nozzles"], "fuels": fuels, "collections": collections,
            "expenses": expenses, "counted": counted, "expected": expected,
            "cash_difference": counted - expected, "sales": sales,
            "collection_total": collection_total, "collection_difference": collection_total - sales,
            "expense_note": note(body.get("expense_note", ""), "an expense note"),
        }
        db.execute("""UPDATE shifts SET submitted_at = ?, submitted_by = ?, report_json = ? WHERE id = ?""",
                   (now(), user["id"], json.dumps(payload), shift_id))
        return report(db, sid, shift_id)


def owner_state(db, sid, selected):
    setup = config(db, sid)
    daily = {fuel: {"litres": 0, "sales": 0} for fuel in FUELS}
    stock = {fuel: {"opening": setup["fuels"][fuel]["opening_stock"], "delivery": 0, "sold": 0, "physical": None}
             for fuel in FUELS}
    shifts = []
    has_submitted = False
    for row in db.execute("""SELECT s.id, s.business_date, s.submitted_at, s.report_json,
                                    u.name AS submitter, r.reviewed_at
                             FROM shifts s JOIN users u ON u.id = s.submitted_by
                             LEFT JOIN reviews r ON r.shift_id = s.id
                             WHERE s.station_id = ? ORDER BY s.id DESC""", (sid,)):
        has_submitted = True
        payload = json.loads(row["report_json"])
        for fuel in FUELS:
            values = payload["fuels"][fuel]
            inventory = stock[fuel]
            inventory["delivery"] += values["delivery"]
            inventory["sold"] += values["litres"]
            if inventory["physical"] is None and values["physical"] is not None:
                inventory["physical"] = {"litres": values["physical"], "shift_id": row["id"], "at": row["submitted_at"]}
            if row["business_date"] == selected:
                daily[fuel]["litres"] += values["litres"]
                daily[fuel]["sales"] += values["sales"]
        if row["business_date"] == selected:
            shifts.append({key: row[key] for key in ("id", "submitted_at", "submitter", "reviewed_at")} | {
                "sales": payload["sales"], "cash_difference": payload["cash_difference"]})
    for item in stock.values():
        item["calculated"] = item["opening"] + item["delivery"] - item["sold"]
    return {"date": selected, "daily": daily, "stock": stock, "shifts": shifts, "setup": setup,
            "can_edit_opening_stock": not has_submitted}


def review_shift(db, user, shift_id, body):
    sid = user["station_id"]
    review_note = note(body.get("note", ""), "a review note", 500)
    with write(db):
        existing = report(db, sid, shift_id)
        if existing["review"]:
            fail("This shift has already been reviewed.", 409)
        db.execute("INSERT INTO reviews VALUES (?, ?, ?, ?)", (shift_id, user["id"], now(), review_note))
        return report(db, sid, shift_id)


def save_config(db, sid, body):
    with write(db):
        if "rates" in body:
            rates = mapping(body["rates"], "fuel rates")
            for fuel in FUELS:
                rate = number(rates.get(fuel), 2, f"{fuel} rate")
                if not 0 < rate <= 100_000:
                    fail(f"{fuel} rate must be between ₹0.01 and ₹1,000 per litre.")
                db.execute("UPDATE fuels SET rate = ? WHERE station_id = ? AND fuel = ?", (rate, sid, fuel))
        if "nozzle" in body:
            nozzle = mapping(body["nozzle"], "nozzle details")
            code = note(nozzle.get("code", ""), "a nozzle code", 20)
            fuel = nozzle.get("fuel")
            if not code or fuel not in FUELS:
                fail("Enter a nozzle code and pick Petrol or Diesel.")
            count = db.execute("SELECT COUNT(*) FROM nozzles WHERE station_id = ?", (sid,)).fetchone()[0]
            if count >= 50:
                fail("This station has reached the limit of 50 nozzles.", 409)
            try:
                db.execute("INSERT INTO nozzles(station_id, code, fuel) VALUES (?, ?, ?)", (sid, code, fuel))
            except sqlite3.IntegrityError:
                fail("A nozzle with that code already exists.", 409)
        if "opening_stock" in body:
            stock = mapping(body["opening_stock"], "opening stock")
            if db.execute("SELECT 1 FROM shifts WHERE station_id = ? AND submitted_at IS NOT NULL", (sid,)).fetchone():
                fail("Opening stock is locked once the first shift is submitted.", 409)
            for fuel in FUELS:
                quantity = number(stock.get(fuel), 3, f"{fuel} opening stock")
                db.execute("UPDATE fuels SET opening_stock = ? WHERE station_id = ? AND fuel = ?",
                           (quantity, sid, fuel))
        return config(db, sid)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body, content_type="application/json; charset=utf-8", cookie=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def payload(self):
        if self.headers.get_content_type() != "application/json":
            fail("Send a JSON request.", 415)
        origin = self.headers.get("Origin")
        if origin and origin != f'http://{self.headers.get("Host")}':
            fail("Invalid request origin.", 403)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 65536:
                fail("Invalid request size.", 413)
            return mapping(json.loads(self.rfile.read(size)), "request data")
        except (ValueError, UnicodeError, RecursionError):
            fail("Invalid JSON request.")

    def token(self, role):
        jar = SimpleCookie()
        jar.load(self.headers.get("Cookie", ""))
        cookie = jar.get(f"pm_{role}")
        return hashlib.sha256(cookie.value.encode()).hexdigest() if cookie else ""

    def authenticated(self, db, role):
        user = db.execute("""SELECT u.id, u.role, u.name, u.station_id, s.name AS station, s.code AS station_code
                             FROM sessions t JOIN users u ON u.id = t.user_id
                             JOIN stations s ON s.id = u.station_id
                             WHERE t.token_hash = ? AND t.expiry > ?""", (self.token(role), int(time.time()))).fetchone()
        if not user:
            fail("Sign in to continue.", 401)
        if user["role"] != role:
            fail("This account cannot access this app.", 403)
        return dict(user)

    def api(self, method, url):
        match = re.fullmatch(r"/api/(manager|owner)(/.*)", url.path)
        if not match:
            fail("Page not found.", 404)
        role, route = match.groups()
        data = self.payload() if method == "POST" else None
        with closing(open_db(self.server.db_path)) as db:
            if method == "POST" and route == "/login":
                email = note(data.get("email", ""), "an email", 254).lower()
                password = data.get("password", "")
                if not isinstance(password, str) or len(password) > 200:
                    fail("Enter a password of up to 200 characters.")
                user = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
                if not user or not secrets.compare_digest(password_hash(password, user["salt"]), user["password_hash"]):
                    fail("Email or password is incorrect.", 401)
                if user["role"] != role:
                    fail("This account cannot sign in to this app.", 403)
                token = secrets.token_urlsafe(32)
                expiry = 12 * 60 * 60
                with write(db):
                    db.execute("DELETE FROM sessions WHERE expiry <= ?", (int(time.time()),))
                    db.execute("INSERT INTO sessions VALUES (?, ?, ?)",
                               (hashlib.sha256(token.encode()).hexdigest(), user["id"], int(time.time()) + expiry))
                return {"ok": True}, f"pm_{role}={token}; Path=/api/{role}; HttpOnly; SameSite=Strict; Max-Age={expiry}"
            user = self.authenticated(db, role)
            sid = user["station_id"]
            if method == "POST" and route == "/logout":
                with write(db):
                    db.execute("DELETE FROM sessions WHERE token_hash = ?", (self.token(role),))
                return {"ok": True}, f"pm_{role}=; Path=/api/{role}; HttpOnly; SameSite=Strict; Max-Age=0"
            if method == "GET" and route == "/session":
                result = user
            elif role == "manager" and route == "/shift":
                if method == "GET":
                    with read_snapshot(db):
                        result = manager_state(db, sid)
                else:
                    result = start_shift(db, user, data)
            elif role == "owner" and method == "GET" and route == "/dashboard":
                day = parse_qs(url.query).get("date", [now()[:10]])[0]
                try:
                    selected = date.fromisoformat(day).isoformat()
                except ValueError:
                    fail("Choose a valid business date.")
                with read_snapshot(db):
                    result = owner_state(db, sid, selected)
            elif role == "owner" and method == "POST" and route == "/settings":
                result = save_config(db, sid, data)
            else:
                result = self.shift_route(db, user, role, method, route, data)
            return result, None

    def shift_route(self, db, user, role, method, route, data):
        match = re.fullmatch(r"/shifts/([0-9]{1,18})(/submit|/review)?", route)
        if match:
            shift_id, action = int(match[1]), match[2]
            if role == "manager" and method == "POST" and action == "/submit":
                return submit_shift(db, user, shift_id, data)
            if role == "owner" and method == "GET" and action is None:
                return report(db, user["station_id"], shift_id)
            if role == "owner" and method == "POST" and action == "/review":
                return review_shift(db, user, shift_id, data)
        fail("Page not found.", 404)

    def dispatch(self, method):
        url = urlsplit(self.path)
        try:
            if url.path.startswith("/api/"):
                result, cookie = self.api(method, url)
                self.reply(200, json.dumps(result).encode(), cookie=cookie)
                return
            if method != "GET":
                fail("Page not found.", 404)
            assets = {
                "/": ("index.html", "text/html"), "/manager": ("index.html", "text/html"),
                "/owner": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
                "/styles.css": ("styles.css", "text/css"),
            }
            if url.path not in assets:
                fail("Page not found.", 404)
            name, content_type = assets[url.path]
            self.reply(200, (ROOT / "static" / name).read_bytes(), f"{content_type}; charset=utf-8")
        except RequestError as error:
            self.reply(error.status, json.dumps({"error": str(error)}).encode())
        except sqlite3.OperationalError:
            self.log_error("Database request failed")
            self.reply(HTTPStatus.SERVICE_UNAVAILABLE, b'{"error":"Database unavailable. Try again."}')

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")


@contextmanager
def read_snapshot(db):
    """Read a consistent snapshot across multiple dashboard queries."""
    with db:
        db.execute("BEGIN")
        yield


def make_server(host, port, database):
    initialize(database)
    server = ThreadingHTTPServer((host, port), Handler)
    server.db_path = database
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", type=Path, default=Path(os.environ.get("PETROLEUM_DB", ROOT / "data" / "petroleum.sqlite3")))
    args = parser.parse_args()
    with make_server("127.0.0.1", args.port, args.db) as server:
        print(f"Petroleum Management listening at http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
