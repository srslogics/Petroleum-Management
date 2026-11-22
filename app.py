"""Petroleum Management WSGI application."""
import argparse
import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from getpass import getpass
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs
from wsgiref.simple_server import WSGIServer, make_server
from zoneinfo import ZoneInfo

from database import TursoDatabase, execute_many, open_db, read_snapshot, transaction

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
    role TEXT NOT NULL CHECK(role IN ('manager','owner')), login_id TEXT NOT NULL UNIQUE,
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
CREATE INDEX IF NOT EXISTS submitted_shifts_by_date ON shifts(station_id, business_date, id)
    WHERE submitted_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS reviews (
    shift_id INTEGER PRIMARY KEY REFERENCES shifts(id), user_id INTEGER NOT NULL REFERENCES users(id),
    reviewed_at TEXT NOT NULL, note TEXT NOT NULL
);
"""


STATIC_FILES = {
    "/app.js": "text/javascript", "/styles.css": "text/css", "/daily-report.js": "text/javascript",
    "/tuljai-logo.jpg": "image/jpeg",
}


def asset_version(body):
    return hashlib.sha256(body).hexdigest()[:16]


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


def indian_mobile(value):
    if not isinstance(value, str):
        return None
    number = re.sub(r"[ -]", "", value.strip())
    match = re.fullmatch(r"(?:(?:\+?91))?([6-9][0-9]{9})", number)
    return "+91" + match[1] if match else None


def valid_new_password(password):
    return (isinstance(password, str) and 7 <= len(password) <= 200
            and password not in (account[3] for account in DEMO_USERS))


def insert_user(db, station_id, role, login_id, name, salt, digest):
    db.execute("""INSERT INTO users(station_id, role, login_id, name, salt, password_hash)
                  VALUES (?, ?, ?, ?, ?, ?)""", (station_id, role, login_id, name, salt, digest))


def initialize(database, demo, env):
    if isinstance(database, Path):
        database.parent.mkdir(parents=True, exist_ok=True)
    with closing(open_db(database)) as db, transaction(db, immediate=True):
        schema = [(statement.strip(), ()) for statement in SCHEMA.split(";") if statement.strip()]
        *_, info = execute_many(db, [*schema, ("PRAGMA table_info(users)", ())])
        columns = {row["name"] for row in info}
        if "email" in columns and "login_id" not in columns:
            db.execute("ALTER TABLE users RENAME COLUMN email TO login_id")
        if db.execute("SELECT 1 FROM stations LIMIT 1").fetchone():
            if not demo and db.execute("SELECT 1 FROM users WHERE login_id IN (?, ?)",
                                     tuple(user[1] for user in DEMO_USERS)).fetchone():
                raise RuntimeError("Use a fresh hosted database. The configured database contains demo accounts.")
            return
        if not demo:
            station = (env.get("PETROLEUM_STATION_NAME", "Fuel Station"),
                       env.get("PETROLEUM_STATION_CODE", "STATION-01"))
            fuels = [(fuel, 0, 0) for fuel in FUELS]
        else:
            station = ("Horizon Fuel Station", "HZN-01")
            fuels = [("Petrol", 10450, 8000000), ("Diesel", 9230, 10000000)]
        db.execute("INSERT INTO stations VALUES (1, ?, ?)", station)
        for fuel, rate, stock in fuels:
            db.execute("INSERT INTO fuels VALUES (1, ?, ?, ?)", (fuel, rate, stock))
        for code, fuel in (("P-01", "Petrol"), ("D-01", "Diesel")):
            db.execute("INSERT INTO nozzles(station_id, code, fuel) VALUES (1, ?, ?)", (code, fuel))
        for role, login_id, name, password in DEMO_USERS if demo else ():
            salt = secrets.token_hex(16)
            insert_user(db, 1, role, login_id, name, salt, password_hash(password, salt))


def owner_credentials(phone, password):
    phone = indian_mobile(phone)
    if not phone:
        raise RuntimeError("Enter the owner's Indian mobile number.")
    if not valid_new_password(password):
        raise RuntimeError("Use a password of 7–200 characters.")
    salt = secrets.token_hex(16)
    return phone, salt, password_hash(password, salt)


def setup_owner(database, env, phone, password):
    phone, salt, digest = owner_credentials(phone, password)
    initialize(database, demo=False, env=env)
    with closing(open_db(database)) as db, transaction(db, immediate=True):
        if db.execute("SELECT 1 FROM users WHERE role = 'owner' AND station_id = 1").fetchone():
            raise RuntimeError("An owner already exists for this station.")
        if db.execute("SELECT 1 FROM users WHERE login_id = ?", (phone,)).fetchone():
            raise RuntimeError("That mobile number is already registered.")
        insert_user(db, 1, "owner", phone, "Owner", salt, digest)


def reset_owner(database, phone, password):
    phone, salt, digest = owner_credentials(phone, password)
    with closing(open_db(database)) as db, transaction(db, immediate=True):
        owners = list(db.execute("SELECT id FROM users WHERE station_id = 1 AND role = 'owner' LIMIT 2"))
        if len(owners) != 1:
            raise RuntimeError("Owner reset requires exactly one existing owner for this station.")
        owner_id = owners[0]["id"]
        if db.execute("SELECT 1 FROM users WHERE login_id = ? AND id <> ?", (phone, owner_id)).fetchone():
            raise RuntimeError("That mobile number is already registered to a different account.")
        db.execute("UPDATE users SET login_id = ?, salt = ?, password_hash = ? WHERE id = ?",
                   (phone, salt, digest, owner_id))
        db.execute("DELETE FROM sessions WHERE user_id = ?", (owner_id,))


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


def config_queries(sid):
    return [
        ("SELECT fuel, rate, opening_stock FROM fuels WHERE station_id = ?", (sid,)),
        ("SELECT id, code, fuel FROM nozzles WHERE station_id = ? ORDER BY id", (sid,)),
    ]


def unpack_config(fuels, nozzles):
    return {"fuels": {row["fuel"]: dict(row) for row in fuels}, "nozzles": [dict(row) for row in nozzles]}


def config(db, sid):
    return unpack_config(*execute_many(db, config_queries(sid)))


OPEN_SHIFT_QUERY = "SELECT * FROM shifts WHERE station_id = ? AND submitted_at IS NULL"
LATEST_SHIFT_QUERY = """SELECT id, business_date, submitted_at, report_json FROM shifts
                        WHERE station_id = ? AND submitted_at IS NOT NULL ORDER BY id DESC LIMIT 1"""


def get_open(db, sid):
    return db.execute(OPEN_SHIFT_QUERY, (sid,)).fetchone()


def shift_identity(row):
    return {key: row[key] for key in ("id", "business_date", "opened_at")}


def open_shift_public(row):
    return {**shift_identity(row), **json.loads(row["opening_json"])}


def manager_state(db, sid, *, in_write=False):
    queries = [(OPEN_SHIFT_QUERY, (sid,)), *config_queries(sid), (LATEST_SHIFT_QUERY, (sid,))]
    if in_write:
        active = get_open(db, sid)
        if active:
            return {"active": open_shift_public(active)}
        fuels, nozzles, latest = [list(rows) for rows in execute_many(db, queries[1:])]
    else:
        active, fuels, nozzles, latest = read_snapshot(db, queries)
        if active:
            return {"active": open_shift_public(active[0])}
    current = unpack_config(fuels, nozzles)
    last = None
    readings = {}
    if latest:
        row = latest[0]
        last = {key: row[key] for key in ("id", "business_date", "submitted_at")}
        # New nozzles can only be added. Any nozzle absent from the most
        # recent submitted shift has no older opening to carry forward.
        readings = {nozzle["id"]: nozzle["closing"] for nozzle in json.loads(row["report_json"])["nozzles"]}
    for nozzle in current["nozzles"]:
        nozzle["opening"] = readings.get(nozzle["id"])
    return {"active": None, "setup": current, "last": last}


def start_shift(db, user, body):
    sid = user["station_id"]
    manual = mapping(body.get("openings", {}), "opening readings")
    with transaction(db, immediate=True):
        state = manager_state(db, sid, in_write=True)
        if state["active"]:
            fail("A shift is already open. Reload to resume it.", 409)
        setup = state["setup"]
        if not setup["nozzles"]:
            fail("Configure at least one nozzle before opening a shift.", 409)
        if any(setup["fuels"][fuel]["rate"] <= 0 for fuel in FUELS):
            fail("Ask the owner to set both fuel rates before opening a shift.", 409)
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
    with transaction(db, immediate=True):
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


def stock_query(sid, fuel):
    path = f"$.fuels.{fuel}"
    return ("""
        WITH totals AS (
          SELECT COUNT(*) AS submitted,
                 COALESCE(SUM(json_extract(report_json, ?)), 0) AS delivery,
                 COALESCE(SUM(json_extract(report_json, ?)), 0) AS sold,
                 MAX(CASE WHEN json_extract(report_json, ?) IS NOT NULL THEN id END) AS reading_id
          FROM shifts WHERE station_id = ? AND submitted_at IS NOT NULL
        )
        SELECT totals.*, s.submitted_at AS measured_at, json_extract(s.report_json, ?) AS measured
        FROM totals LEFT JOIN shifts s ON s.id = totals.reading_id
        """, (path + ".delivery", path + ".litres", path + ".physical", sid, path + ".physical"))


def owner_state(db, sid, selected):
    fuels, nozzles, petrol, diesel, rows = read_snapshot(db, [
        *config_queries(sid), *(stock_query(sid, fuel) for fuel in FUELS),
        ("""SELECT s.id, s.submitted_at, s.report_json, u.name AS submitter, r.reviewed_at
            FROM shifts s JOIN users u ON u.id = s.submitted_by LEFT JOIN reviews r ON r.shift_id = s.id
            WHERE s.station_id = ? AND s.business_date = ? AND s.submitted_at IS NOT NULL ORDER BY s.id DESC""",
         (sid, selected)),
    ])
    setup = unpack_config(fuels, nozzles)
    daily = {fuel: {"litres": 0, "sales": 0} for fuel in FUELS}
    stock = {}
    for fuel, totals in zip(FUELS, (petrol[0], diesel[0])):
        opening = setup["fuels"][fuel]["opening_stock"]
        physical = None if totals["measured"] is None else {
            "litres": totals["measured"], "shift_id": totals["reading_id"], "at": totals["measured_at"],
        }
        stock[fuel] = {
            "opening": opening, "delivery": totals["delivery"], "sold": totals["sold"],
            "calculated": opening + totals["delivery"] - totals["sold"], "physical": physical,
        }
    shifts = []
    for row in rows:
        payload = json.loads(row["report_json"])
        for fuel in FUELS:
            for field in ("litres", "sales"):
                daily[fuel][field] += payload["fuels"][fuel][field]
        shifts.append({key: row[key] for key in ("id", "submitted_at", "submitter", "reviewed_at")} | {
            "sales": payload["sales"], "cash_difference": payload["cash_difference"],
        })
    return {"date": selected, "daily": daily, "stock": stock, "shifts": shifts, "setup": setup,
            "can_edit_opening_stock": not petrol[0]["submitted"]}


def daily_owner_report(db, sid, selected):
    opening_rows, prior_rows, rows = read_snapshot(db, [
        ("SELECT fuel, opening_stock FROM fuels WHERE station_id = ?", (sid,)),
        ("""
        SELECT
          COALESCE(SUM(json_extract(report_json, '$.fuels.Petrol.delivery')
                       - json_extract(report_json, '$.fuels.Petrol.litres')), 0) AS Petrol,
          COALESCE(SUM(json_extract(report_json, '$.fuels.Diesel.delivery')
                       - json_extract(report_json, '$.fuels.Diesel.litres')), 0) AS Diesel
        FROM shifts WHERE station_id = ? AND business_date < ? AND submitted_at IS NOT NULL
        """, (sid, selected)),
        ("""
        SELECT s.id, s.opened_at, s.submitted_at, s.report_json, u.name AS submitter,
               r.reviewed_at, r.note AS review_note, reviewer.name AS reviewer
        FROM shifts s JOIN users u ON u.id = s.submitted_by
        LEFT JOIN reviews r ON r.shift_id = s.id
        LEFT JOIN users reviewer ON reviewer.id = r.user_id
        WHERE s.station_id = ? AND s.business_date = ? AND s.submitted_at IS NOT NULL ORDER BY s.id
        """, (sid, selected)),
    ])
    opening = {row["fuel"]: row["opening_stock"] for row in opening_rows}
    prior = prior_rows[0]
    fuels = {
        fuel: {"opening_stock": opening[fuel] + prior[fuel], "litres": 0, "sales": 0,
               "delivery": 0, "rates": [], "closing_stock": opening[fuel] + prior[fuel], "physical": None}
        for fuel in FUELS
    }
    payments = dict.fromkeys(METHODS, 0)
    till = dict.fromkeys(("expenses", "expected", "counted", "cash_difference", "shortage", "overage"), 0)
    shifts = []
    nozzles = {}
    for row in rows:
        payload = json.loads(row["report_json"])
        for method in METHODS:
            payments[method] += payload["collections"].get(method, 0)
        for field in ("expenses", "expected", "counted", "cash_difference"):
            till[field] += payload[field]
        variance = payload["cash_difference"]
        till["shortage"] += max(0, -variance)
        till["overage"] += max(0, variance)
        for fuel, summary in fuels.items():
            entry = payload["fuels"][fuel]
            for field in ("litres", "sales", "delivery"):
                summary[field] += entry[field]
            if entry["rate"] not in summary["rates"]:
                summary["rates"].append(entry["rate"])
            summary["closing_stock"] += entry["delivery"] - entry["litres"]
            if entry.get("physical") is not None:
                summary["physical"] = {
                    "litres": entry["physical"], "shift_id": row["id"],
                    "submitted_at": row["submitted_at"], "book_at_reading": summary["closing_stock"],
                    "difference": entry["physical"] - summary["closing_stock"],
                }
        for nozzle in payload["nozzles"]:
            meter = nozzles.setdefault(nozzle["id"], {
                "code": nozzle["code"], "fuel": nozzle["fuel"], "opening": nozzle["opening"], "litres": 0,
            })
            meter["closing"] = nozzle["closing"]
            meter["litres"] += nozzle["litres"]
        fields = ("id", "opened_at", "submitted_at", "submitter", "reviewed_at", "review_note", "reviewer")
        shifts.append({key: row[key] for key in fields} | {
            key: payload[key] for key in ("expenses", "cash_difference", "sales", "collection_difference", "expense_note")
        } | {"payments": {method: payload["collections"].get(method, 0) for method in METHODS}})
    sales = sum(fuel["sales"] for fuel in fuels.values())
    accounted = sum(payments.values())
    return {
        "date": selected, "payments": payments, "till": till, "fuels": fuels, "shifts": shifts,
        "nozzles": list(nozzles.values()), "sales": sales, "litres": sum(fuel["litres"] for fuel in fuels.values()),
        "receipts": accounted - payments["credit"], "accounted": accounted, "sales_difference": accounted - sales,
    }


def review_shift(db, user, shift_id, body):
    sid = user["station_id"]
    review_note = note(body.get("note", ""), "a review note", 500)
    with transaction(db, immediate=True):
        existing = report(db, sid, shift_id)
        if existing["review"]:
            fail("This shift has already been reviewed.", 409)
        db.execute("INSERT INTO reviews VALUES (?, ?, ?, ?)", (shift_id, user["id"], now(), review_note))
        return report(db, sid, shift_id)


def save_config(db, sid, body):
    with transaction(db, immediate=True):
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
            count = db.execute("SELECT COUNT(*) AS total FROM nozzles WHERE station_id = ?", (sid,)).fetchone()["total"]
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


def list_managers(db, station_id):
    return [dict(row) for row in db.execute(
        "SELECT name, login_id FROM users WHERE station_id = ? AND role = 'manager' ORDER BY id",
        (station_id,),
    )]


def create_manager(db, station_id, data):
    name = note(data.get("name", ""), "the manager's name", 80)
    if not name:
        fail("Enter the manager's name.")
    phone = indian_mobile(data.get("phone"))
    if not phone:
        fail("Enter a valid Indian mobile number.")
    password = data.get("password")
    if not valid_new_password(password):
        fail("Use a password of 7–200 characters.")
    salt = secrets.token_hex(16)
    digest = password_hash(password, salt)
    with transaction(db, immediate=True):
        if db.execute("SELECT 1 FROM users WHERE login_id = ?", (phone,)).fetchone():
            fail("That mobile number is already registered.", 409)
        insert_user(db, station_id, "manager", phone, name, salt, digest)
    return {"name": name, "login_id": phone}


class Request:
    def __init__(self, environ, database, hosted, demo):
        self.environ = environ
        self.database = database
        self.hosted = hosted
        self.demo = demo

    def payload(self):
        if self.environ.get("CONTENT_TYPE", "").partition(";")[0].strip().lower() != "application/json":
            fail("Send a JSON request.", 415)
        origin = self.environ.get("HTTP_ORIGIN")
        scheme = "https" if self.hosted else self.environ["wsgi.url_scheme"]
        if origin and origin != f'{scheme}://{self.environ.get("HTTP_HOST")}':
            fail("Invalid request origin.", 403)
        try:
            size = int(self.environ.get("CONTENT_LENGTH") or "0")
            if not 0 < size <= 65536:
                fail("Invalid request size.", 413)
            return mapping(json.loads(self.environ["wsgi.input"].read(size)), "request data")
        except (ValueError, UnicodeError, RecursionError):
            fail("Invalid JSON request.")

    def token(self, role):
        jar = SimpleCookie()
        try:
            jar.load(self.environ.get("HTTP_COOKIE", ""))
        except CookieError:
            return ""
        cookie = jar.get(f"pm_{role}")
        return hashlib.sha256(cookie.value.encode()).hexdigest() if cookie else ""

    def session_cookie(self, role, token, age):
        secure = "; Secure" if self.hosted else ""
        return f"pm_{role}={token}; Path=/api/{role}; HttpOnly; SameSite=Strict; Max-Age={age}{secure}"

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

    def api(self, method, path):
        match = re.fullmatch(r"/api/(manager|owner)(/.*)", path)
        if not match:
            fail("Page not found.", 404)
        role, route = match.groups()
        data = self.payload() if method == "POST" else None
        login = method == "POST" and route == "/login"
        if not login and not self.token(role):
            fail("Sign in to continue.", 401)
        with closing(open_db(self.database)) as db:
            if login:
                identifier = note(data.get("identifier", data.get("email", "")), "a mobile number or email", 254).lower()
                login_id = indian_mobile(identifier) or identifier
                password = data.get("password", "")
                if not isinstance(password, str) or len(password) > 200:
                    fail("Enter a password of up to 200 characters.")
                user = db.execute("SELECT * FROM users WHERE login_id = ?", (login_id,)).fetchone()
                digest = password_hash(password, user["salt"] if user else "0" * 32)
                if not user or not secrets.compare_digest(digest, user["password_hash"]):
                    fail("Sign-in details are incorrect.", 401)
                if user["role"] != role:
                    fail("This account cannot sign in to this app.", 403)
                token = secrets.token_urlsafe(32)
                expiry = 12 * 60 * 60
                with transaction(db, immediate=True):
                    db.execute("DELETE FROM sessions WHERE expiry <= ?", (int(time.time()),))
                    issued = db.execute("""INSERT INTO sessions(token_hash, user_id, expiry)
                        SELECT ?, id, ? FROM users WHERE id = ? AND salt = ?
                        RETURNING token_hash""",
                        (hashlib.sha256(token.encode()).hexdigest(), int(time.time()) + expiry,
                         user["id"], user["salt"])).fetchone()
                    if not issued:
                        fail("Sign-in details changed. Please sign in again.", 401)
                return {"ok": True}, self.session_cookie(role, token, expiry)
            user = self.authenticated(db, role)
            sid = user["station_id"]
            if method == "POST" and route == "/logout":
                with transaction(db, immediate=True):
                    db.execute("DELETE FROM sessions WHERE token_hash = ?", (self.token(role),))
                return {"ok": True}, self.session_cookie(role, "", 0)
            if method == "GET" and route == "/session":
                result = user
            elif role == "manager" and route == "/shift":
                if method == "GET":
                    result = manager_state(db, sid) | {"session": user}
                else:
                    result = start_shift(db, user, data)
            elif role == "owner" and method == "GET" and route in ("/dashboard", "/daily-report"):
                day = parse_qs(self.environ.get("QUERY_STRING", "")).get("date", [now()[:10]])[0]
                try:
                    selected = date.fromisoformat(day).isoformat()
                except ValueError:
                    fail("Choose a valid business date.")
                view = owner_state if route == "/dashboard" else daily_owner_report
                result = view(db, sid, selected) | {"session": user}
            elif role == "owner" and route == "/managers":
                result = list_managers(db, sid) if method == "GET" else create_manager(db, sid, data)
            elif role == "owner" and route == "/settings":
                if method == "GET":
                    fuels, nozzles, submitted = read_snapshot(db, [
                        *config_queries(sid),
                        ("SELECT 1 FROM shifts WHERE station_id = ? AND submitted_at IS NOT NULL LIMIT 1", (sid,)),
                    ])
                    result = {"setup": unpack_config(fuels, nozzles), "can_edit_opening_stock": not submitted}
                else:
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

    def dispatch(self):
        method = self.environ["REQUEST_METHOD"]
        path = self.environ["PATH_INFO"]
        json_type = "application/json; charset=utf-8"
        try:
            if path.startswith("/api/") and method in ("GET", "POST"):
                result, cookie = self.api(method, path)
                return 200, json.dumps(result).encode(), json_type, cookie
            if method not in ("GET", "HEAD") or (method == "HEAD" and path.startswith("/api/")):
                fail("Page not found.", 404)
            if path == "/healthz":
                return 200, b'{"ok":true}', json_type, None
            if path in STATIC_FILES:
                body = (ROOT / "static" / path.lstrip("/")).read_bytes()
                content_type = STATIC_FILES[path]
                if content_type.startswith("text/"):
                    content_type += "; charset=utf-8"
                return 200, body, content_type, None
            if path in ("/", "/manager", "/owner"):
                body = (ROOT / "static" / "index.html").read_bytes()
                if not self.demo:
                    body = body.replace(b'<meta name="demo-mode" content="true">', b'')
                for asset in STATIC_FILES:
                    version = asset_version((ROOT / "static" / asset.lstrip("/")).read_bytes())
                    body = body.replace(f'"{asset}"'.encode(), f'"{asset}?v={version}"'.encode())
                return 200, body, "text/html; charset=utf-8", None
            fail("Page not found.", 404)
        except RequestError as error:
            return error.status, json.dumps({"error": str(error)}).encode(), json_type, None
        except sqlite3.OperationalError as error:
            logging.warning("Database request failed for %s %s: %s", method, path, error)
            return 503, b'{"error":"Database temporarily unavailable. Please try again."}', json_type, None
        except Exception:
            logging.exception("Request failed for %s %s", method, path)
            return 500, b'{"error":"The service could not complete this request. Please try again."}', json_type, None


def create_app(database=None, env=None):
    env = os.environ if env is None else env
    hosted = env.get("PETROLEUM_HOSTED") == "1" or env.get("RENDER") == "true"
    turso = TursoDatabase.from_env(env, required=hosted)
    demo = turso is None
    database = turso or Path(database or env.get("PETROLEUM_DB") or ROOT / "data" / "petroleum.sqlite3")
    initialize(database, demo, env)

    def application(environ, start_response):
        status, body, content_type, cookie = Request(environ, database, hosted, demo).dispatch()
        path = environ["PATH_INFO"]
        cache_control = "no-store"
        if (status == 200 and path in STATIC_FILES
                and environ.get("QUERY_STRING", "") == "v=" + asset_version(body)):
            cache_control = "public, max-age=31536000, immutable"
        headers = [
            ("Content-Type", content_type),
            ("Content-Length", str(len(body))),
            ("Cache-Control", cache_control),
            ("X-Content-Type-Options", "nosniff"),
            ("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'"),
        ]
        if cookie:
            headers.append(("Set-Cookie", cookie))
        start_response(f"{status} {HTTPStatus(status).phrase}", headers)
        return [b"" if environ["REQUEST_METHOD"] == "HEAD" else body]

    return application


class LocalServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("setup-owner", "reset-owner"),
                        help="Create or reset the owner directly in Turso.")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", type=Path)
    args = parser.parse_args()
    if args.command:
        env = os.environ.copy()
        try:
            if not env.get("TURSO_DATABASE_URL"):
                env["TURSO_DATABASE_URL"] = input("Turso database URL: ")
            if not env.get("TURSO_AUTH_TOKEN"):
                env["TURSO_AUTH_TOKEN"] = getpass("Turso database token: ")
            database = TursoDatabase.from_env(env, required=True)
            phone = input("Owner mobile number: ")
            password = getpass("Owner password: ")
            if password != getpass("Confirm owner password: "):
                raise RuntimeError("The passwords do not match.")
            if args.command == "reset-owner":
                reset_owner(database, phone, password)
            else:
                setup_owner(database, env, phone, password)
        except (RuntimeError, sqlite3.Error) as error:
            parser.exit(1, f"{error}\n")
        except (EOFError, KeyboardInterrupt):
            parser.exit(1, "Owner setup cancelled.\n")
        message = "Owner sign-in reset" if args.command == "reset-owner" else "Owner account created"
        print(f"{message}. Sign in at /owner.")
        return
    with make_server("127.0.0.1", args.port, create_app(args.db), server_class=LocalServer) as server:
        print(f"Petroleum Management listening at http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
