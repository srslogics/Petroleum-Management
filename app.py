"""Petroleum Management WSGI application."""
import argparse
import hashlib
import gzip
from collections import defaultdict
from html import escape
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
from urllib.parse import parse_qs, urlsplit
from wsgiref.simple_server import WSGIServer, make_server
from zoneinfo import ZoneInfo

from automation import AUTOMATION_SCHEMA, Automation, accept_feed
from security import Throttle, client_address
from mfa import MFA, MFA_SCHEMA, mfa_cipher
from manager_drafts import DRAFT_SCHEMA, draft_route, draft_query, unpack_draft
from outgoings import OUTGOING_SCHEMA, outgoing_route
from database import TursoDatabase, execute_many, open_db, read_snapshot, transaction

ROOT = Path(__file__).resolve().parent
TZ = ZoneInfo("Asia/Kolkata")
FUELS = ("Petrol", "Diesel")
METHODS = ("cash", "upi", "card", "credit")
MIN_PASSWORD_LENGTH = 15
MAX_SESSIONS_PER_USER = 10
JSON_BODY_LIMIT = 64 * 1024
# 300 detailed entries can contain 135,000 characters, including escaped Unicode.
SHIFT_BODY_LIMIT = 2 * 1024 * 1024
DEMO_USERS = (
    ("manager", "manager@demo.local", "Asha Patil", "ManagerDemo123!"),
    ("owner", "owner@demo.local", "Rohan Deshmukh", "OwnerDemo123!"),
)
ACCOUNT_AUDIT_TABLE = """
CREATE TABLE IF NOT EXISTS account_audit (
    id INTEGER PRIMARY KEY,
    station_id INTEGER NOT NULL REFERENCES stations(id),
    actor_id INTEGER NOT NULL REFERENCES users(id),
    target_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
)
"""

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS stations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS opening_stock_confirmations (
    station_id INTEGER PRIMARY KEY REFERENCES stations(id)
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
CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expiry);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id, expiry);
{ACCOUNT_AUDIT_TABLE};
CREATE INDEX IF NOT EXISTS account_audit_by_station ON account_audit(station_id, id);
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
CREATE TABLE IF NOT EXISTS shift_owner_credits (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id),
    shift_id INTEGER NOT NULL REFERENCES shifts(id), party TEXT NOT NULL, amount INTEGER NOT NULL,
    reference TEXT NOT NULL COLLATE NOCASE, note TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id), voided_at TEXT,
    UNIQUE(shift_id, reference)
);
CREATE TABLE IF NOT EXISTS manager_controls (
    user_id INTEGER PRIMARY KEY REFERENCES users(id), disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tanks (
    station_id INTEGER NOT NULL REFERENCES stations(id), fuel TEXT NOT NULL,
    capacity INTEGER NOT NULL, low_level INTEGER NOT NULL, PRIMARY KEY(station_id, fuel)
);
CREATE TABLE IF NOT EXISTS customers (
    station_id INTEGER NOT NULL REFERENCES stations(id), customer_key TEXT NOT NULL,
    name TEXT NOT NULL, due_date TEXT NOT NULL DEFAULT '', PRIMARY KEY(station_id, customer_key)
);
CREATE TABLE IF NOT EXISTS credit_allocations (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id), shift_id INTEGER NOT NULL REFERENCES shifts(id),
    name TEXT NOT NULL, amount INTEGER NOT NULL, reference TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    UNIQUE(station_id, reference)
);
CREATE TABLE IF NOT EXISTS repayments (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id), customer_key TEXT NOT NULL,
    amount INTEGER NOT NULL, method TEXT NOT NULL, paid_on TEXT NOT NULL, reference TEXT NOT NULL,
    note TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    UNIQUE(station_id, reference)
);
CREATE TABLE IF NOT EXISTS record_voids (
    station_id INTEGER NOT NULL REFERENCES stations(id), record_type TEXT NOT NULL, record_id INTEGER NOT NULL,
    reason TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    PRIMARY KEY(station_id, record_type, record_id)
);
CREATE TABLE IF NOT EXISTS bank_records (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id), source TEXT NOT NULL,
    method TEXT NOT NULL, amount INTEGER NOT NULL, fees INTEGER NOT NULL, bank_date TEXT NOT NULL,
    reference TEXT NOT NULL, note TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    UNIQUE(station_id, reference)
);
CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id), shift_id INTEGER NOT NULL REFERENCES shifts(id),
    requested_by INTEGER NOT NULL REFERENCES users(id), requested_at TEXT NOT NULL, reason TEXT NOT NULL,
    response TEXT NOT NULL DEFAULT '', responded_by INTEGER REFERENCES users(id), responded_at TEXT,
    resolved_at TEXT, resolved_by INTEGER REFERENCES users(id), resolution TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS shift_revisions (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id), shift_id INTEGER NOT NULL REFERENCES shifts(id),
    user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, reason TEXT NOT NULL,
    original_json TEXT NOT NULL, replacement_json TEXT NOT NULL, original_review TEXT NOT NULL DEFAULT 'null'
);
CREATE TABLE IF NOT EXISTS exception_acknowledgements (
    station_id INTEGER NOT NULL REFERENCES stations(id), exception_key TEXT NOT NULL, signature TEXT NOT NULL,
    note TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    PRIMARY KEY(station_id, exception_key)
);
CREATE INDEX IF NOT EXISTS repayments_by_station ON repayments(station_id, customer_key);
CREATE INDEX IF NOT EXISTS bank_records_by_source ON bank_records(station_id, source, method);
CREATE INDEX IF NOT EXISTS corrections_by_station ON corrections(station_id, shift_id);
CREATE INDEX IF NOT EXISTS revisions_by_station ON shift_revisions(station_id, shift_id);
CREATE TABLE IF NOT EXISTS reviews (
    shift_id INTEGER PRIMARY KEY REFERENCES shifts(id), user_id INTEGER NOT NULL REFERENCES users(id),
    reviewed_at TEXT NOT NULL, note TEXT NOT NULL
);
"""

SCHEMA += OUTGOING_SCHEMA + DRAFT_SCHEMA + AUTOMATION_SCHEMA + MFA_SCHEMA

STATIC_FILES = {
    "/app.js": "text/javascript", "/styles.css": "text/css", "/workspace.css": "text/css", "/daily-report.js": "text/javascript",
    "/typography.css": "text/css", "/money.css": "text/css", "/money.js": "text/javascript", "/outgoings.js": "text/javascript", "/outgoings.css": "text/css",
    "/manager-workflow.js": "text/javascript", "/manager-workflow.css": "text/css",
    "/mfa.js": "text/javascript", "/auth.css": "text/css",
    "/automation.js": "text/javascript", "/automation.css": "text/css",
    "/fonts/inter-latin.woff2": "font/woff2", "/fonts/inter-latin-ext.woff2": "font/woff2",
    "/tuljai-logo.jpg": "image/jpeg",
    "/manager-entries.js": "text/javascript",
    "/owner-business.js": "text/javascript",
    "/pwa.js": "text/javascript", "/sw.js": "text/javascript", "/offline.html": "text/html",
    "/offline.css": "text/css", "/owner.webmanifest": "application/manifest+json",
    "/manager.webmanifest": "application/manifest+json",
    "/icons/icon-192.png": "image/png", "/icons/icon-512.png": "image/png",
    "/icons/apple-touch-icon.png": "image/png",
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


def valid_unicode(value):
    try:
        value.encode("utf-8")
        return True
    except UnicodeError:
        return False


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result or not valid_unicode(key):
            raise ValueError("Invalid JSON object key.")
        result[key] = value
    return result


def reject_json_constant(value):
    raise ValueError("JSON numbers must be finite.")


def audit_account(db, sid, actor, target, action):
    db.execute("INSERT INTO account_audit(station_id,actor_id,target_id,action,created_at) VALUES (?,?,?,?,?)",
               (sid, actor, target, action, now()))


def valid_new_password(password):
    return (isinstance(password, str) and MIN_PASSWORD_LENGTH <= len(password) <= 200
            and valid_unicode(password)
            and bool(password.strip())
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
        raise RuntimeError("Use a password of 15–200 characters.")
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
        db.execute(ACCOUNT_AUDIT_TABLE)
        audit_account(db, 1, owner_id, owner_id, "owner_reset")


def number(value, places, label, optional=False):
    if optional and (value is None or value == ""):
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        fail(f"Enter a valid {label}.")
    try:
        parsed = Decimal(str(value).strip())
        if not parsed.is_finite() or not 0 <= parsed <= 1_000_000_000:
            raise InvalidOperation
        if parsed != parsed.quantize(Decimal(1).scaleb(-places)):
            raise InvalidOperation
        return int(parsed.scaleb(places))
    except (InvalidOperation, ValueError):
        fail(f"Enter {label} from 0 to 1,000,000,000 with up to {places} decimal places.")


def mapping(value, label, allowed=None):
    if not isinstance(value, dict):
        fail(f"Enter valid {label}.")
    if allowed is not None and value.keys() - set(allowed):
        fail(f"Unrecognised field in {label}. Check the entries and try again.")
    return value


def note(value, label, limit=250):
    if not isinstance(value, str) or not valid_unicode(value) or len(value.strip()) > limit:
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
    queries = [(OPEN_SHIFT_QUERY, (sid,)), *config_queries(sid), (LATEST_SHIFT_QUERY, (sid,)), draft_query(sid)]
    if in_write:
        active = get_open(db, sid)
        if active:
            return {"active": open_shift_public(active)}
        fuels, nozzles, latest = [list(rows) for rows in execute_many(db, queries[1:4])]
    else:
        active, fuels, nozzles, latest, draft = read_snapshot(db, queries)
        if active:
            return {"active": open_shift_public(active[0]) | {"draft": unpack_draft(draft[0] if draft else None)}}
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
            "submitted_at": row["submitted_at"], "submitter": row["submitter"], "review": review,
            "version": hashlib.sha256(row["report_json"].encode()).hexdigest(),
            "corrections": correction_list(db, sid, shift_id),
            "revisions": [dict(item) for item in db.execute(
                "SELECT r.*, u.name AS actor FROM shift_revisions r JOIN users u ON u.id = r.user_id WHERE r.station_id = ? AND r.shift_id = ? ORDER BY r.id", (sid, shift_id))]}


def shift_entries(body, payment_limit=100):
    entries = {}
    for category in ("payments", "deliveries", "expenses"):
        rows = body.get("entries", {}).get(category, [])
        limit = payment_limit if category == "payments" else 100
        if not isinstance(rows, list) or len(rows) > limit:
            fail(f"Enter up to {limit} {category} entries.")
        entries[category] = []
        for row in rows:
            row = mapping(row, "entry")
            fields = ("party", "reference", "note")
            parsed = {field: note(row.get(field, ""), field, 150) for field in fields}
            if category == "deliveries":
                if row.get("fuel") not in FUELS:
                    fail("Choose Petrol or Diesel for the delivery.")
                parsed["fuel"] = row["fuel"]
                parsed["quantity"] = number(row.get("quantity"), 3, "delivery litres")
                if parsed["quantity"] == 0:
                    fail("Delivery litres must be greater than zero.")
            else:
                parsed["amount"] = number(row.get("amount"), 2, "entry amount")
                if parsed["amount"] == 0:
                    fail("Entry amount must be greater than zero.")
                if category == "payments":
                    if row.get("method") not in METHODS:
                        fail("Choose a valid payment method.")
                    parsed["method"] = row["method"]
                    if parsed["method"] == "credit" and not parsed["party"]:
                        fail("Enter a customer name for credit sales.")
                elif not parsed["note"]:
                    fail("Describe the till expense.")
            entries[category].append(parsed)
    return entries


def pending_credit_query(sid, shift_id=None):
    sql = """SELECT c.id, c.party, c.amount, c.reference, c.note FROM shift_owner_credits c
             JOIN shifts s ON s.id = c.shift_id WHERE c.station_id = ? AND s.station_id = ?
             AND s.submitted_at IS NULL AND c.voided_at IS NULL"""
    if shift_id is not None:
        return sql + " AND c.shift_id = ? ORDER BY c.id", (sid, sid, shift_id)
    return sql + " ORDER BY c.id", (sid, sid)


def save_shift_credit(db, user, body, credit_id=None):
    sid = user["station_id"]
    shift_id = body.get("shift_id")
    action = body.get("action")
    if type(shift_id) is not int:
        fail("Reopen Money to select the current shift.")
    if action not in (("record",) if credit_id is None else ("edit", "void")):
        fail("Choose a valid credit action.")
    with transaction(db, immediate=True):
        active = get_open(db, sid)
        if not active or active["id"] != shift_id:
            fail("The shift has closed or changed. Refresh Money before recording credit.", 409)
        existing = list(db.execute(*pending_credit_query(sid, shift_id)))
        if credit_id is not None and not any(row["id"] == credit_id for row in existing):
            fail("This credit entry is no longer pending. Refresh Money.", 409)
        if action == "void":
            db.execute("UPDATE shift_owner_credits SET voided_at = ? WHERE id = ?", (now(), credit_id))
            return {"ok": True}
        party = required_note(body.get("party"), "a customer name", 150)
        amount = number(body.get("amount"), 2, "credit amount")
        if amount <= 0:
            fail("Credit amount must be greater than zero.")
        reference = required_note(body.get("reference"), "a sale reference", 150)
        message = note(body.get("note", ""), "a note", 150)
        try:
            if action == "record":
                if len(existing) >= 100:
                    fail("The shift already has 100 credit entries.", 409)
                db.execute("""INSERT INTO shift_owner_credits(station_id, shift_id, party, amount, reference, note, user_id)
                              VALUES (?, ?, ?, ?, ?, ?, ?)""",
                           (sid, shift_id, party, amount, reference, message, user["id"]))
            else:
                db.execute("UPDATE shift_owner_credits SET party = ?, amount = ?, reference = ?, note = ? WHERE id = ?",
                           (party, amount, reference, message, credit_id))
        except sqlite3.IntegrityError:
            fail("This sale reference has already been used for this shift.", 409)
    return {"ok": True}


def submit_shift(db, user, shift_id, body, *, revision=False):
    sid = user["station_id"]
    with transaction(db, immediate=True):
        row = db.execute("SELECT * FROM shifts WHERE id = ? AND station_id = ?", (shift_id, sid)).fetchone()
        if not row:
            fail("Shift not found.", 404)
        if row["submitted_at"] and not revision:
            fail("This shift has already been submitted.", 409)
        payment_limit = 100
        if revision:
            if not row["submitted_at"]:
                fail("Only a submitted shift can be corrected.", 409)
            if db.execute("SELECT 1 FROM shifts WHERE station_id = ? AND id > ? LIMIT 1", (sid, shift_id)).fetchone():
                fail("A later shift already uses these readings. Resolve through a documented clarification; historical figures cannot be rewritten.", 409)
            if db.execute("SELECT 1 FROM bank_records WHERE station_id = ? AND source = ?", (sid, f"shift:{shift_id}")).fetchone():
                fail("This shift has bank reconciliation records. Its figures cannot be rewritten.", 409)
            if db.execute("SELECT 1 FROM credit_allocations WHERE station_id = ? AND shift_id = ?", (sid, shift_id)).fetchone():
                fail("This shift's credit has been allocated to customers. Its figures cannot be rewritten.", 409)
            if db.execute("SELECT 1 FROM repayments WHERE station_id = ? LIMIT 1", (sid,)).fetchone():
                fail("Customer repayments already exist. Resolve with a documented clarification to preserve customer balances.", 409)
            reason = required_note(body.get("correction_reason"), "a correction reason", 500)
            version = required_note(body.get("expected_version"), "the report version; reopen the report to correct it", 64)
            if version != hashlib.sha256(row["report_json"].encode()).hexdigest():
                fail("This report changed while you were editing. Reopen it before correcting the figures.", 409)
            payment_limit = max(payment_limit, len(json.loads(row["report_json"]).get("entries", {}).get("payments", [])))
        mapping(body.get("entries", {}), "shift entries", ("payments", "deliveries", "expenses"))
        entries = shift_entries(body, payment_limit)
        if user["role"] == "manager":
            if any(entry["method"] == "credit" or entry["party"] for entry in entries["payments"]):
                fail("Managers record cash, UPI and card without customer details. Credit is recorded by the owner.")
            credit = body.get("collections", {}).get("credit") if isinstance(body.get("collections"), dict) else None
            if credit not in (None, "") and number(credit, 2, "credit") != 0:
                fail("Credit is recorded by the owner, not the manager.")
            saved = db.execute("SELECT version FROM manager_shift_drafts WHERE shift_id = ? AND station_id = ?", (shift_id, sid)).fetchone()
            if saved or "draft_version" in body:
                if type(body.get("draft_version")) is not int or body.get("draft_version") != (saved["version"] if saved else 0):
                    fail("This draft changed elsewhere. Reload the saved entries before submitting.", 409)
        draft = json.loads(row["opening_json"])
        closings = mapping(body.get("closings"), "closing readings", (str(n["id"]) for n in draft["nozzles"]))
        collections_input = mapping(body.get("collections"), "collections", METHODS)
        owner_credit = 0
        if not revision:
            pending = list(db.execute(*pending_credit_query(sid, shift_id)))
            if pending and (any(entry["method"] == "credit" for entry in entries["payments"])
                            or number(collections_input.get("credit"), 2, "credit", optional=True)):
                fail("Credit is already pending in Money for this shift. Review it there before submitting.", 409)
            for item in pending:
                entries["payments"].append({key: item[key] for key in ("party", "amount", "reference", "note")} | {"method": "credit"})
                owner_credit += item["amount"]
        deliveries_input = mapping(body.get("deliveries", {}), "deliveries", FUELS)
        physical_input = mapping(body.get("physical", {}), "physical stock readings", FUELS)
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
            delivered = [entry["quantity"] for entry in entries["deliveries"] if entry["fuel"] == fuel]
            fuels[fuel] = {
                "litres": litres[fuel], "rate": rate, "sales": sales,
                "delivery": sum(delivered) if delivered else (
                    number(deliveries_input.get(fuel), 3, f"{fuel} delivery", optional=True) or 0),
                "physical": number(physical_input.get(fuel), 3, f"{fuel} physical stock", optional=True),
            }
        collections = {}
        for method in METHODS:
            amounts = [entry["amount"] for entry in entries["payments"] if entry["method"] == method]
            collections[method] = sum(amounts) if amounts else (
                number(collections_input.get(method), 2, f"{method} collection", optional=True) or 0)
        expenses = (sum(entry["amount"] for entry in entries["expenses"]) if entries["expenses"] else
                    number(body.get("expenses"), 2, "till expenses", optional=True) or 0)
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
            "shift_note": note(body.get("shift_note", ""), "shift notes", 1000), "entries": entries,
        }
        if revision:
            prior_review = db.execute("SELECT * FROM reviews WHERE shift_id = ?", (shift_id,)).fetchone()
            db.execute("""INSERT INTO shift_revisions(station_id, shift_id, user_id, created_at, reason, original_json, replacement_json, original_review)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                       (sid, shift_id, user["id"], now(), reason, row["report_json"], json.dumps(payload),
                        json.dumps(dict(prior_review) if prior_review else None)))
            db.execute("UPDATE shifts SET report_json = ? WHERE id = ?", (json.dumps(payload), shift_id))
            db.execute("DELETE FROM reviews WHERE shift_id = ?", (shift_id,))
        else:
            db.execute("""UPDATE shifts SET submitted_at = ?, submitted_by = ?, report_json = ? WHERE id = ?""",
                       (now(), user["id"], json.dumps(payload), shift_id))
        if not revision:
            db.execute("DELETE FROM manager_shift_drafts WHERE shift_id = ? AND station_id = ?", (shift_id, sid))
        result = report(db, sid, shift_id)
        if user["role"] == "manager" and owner_credit:
            result["entries"]["payments"] = [item for item in result["entries"]["payments"] if item["method"] != "credit"]
            result["collections"]["credit"] = 0
            result["collection_total"] -= owner_credit
            result["collection_difference"] -= owner_credit
        return result


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
    queries = [
        *config_queries(sid), *(stock_query(sid, fuel) for fuel in FUELS),
        ("SELECT 1 FROM opening_stock_confirmations WHERE station_id = ?", (sid,)),
        ("""SELECT s.id, s.submitted_at, s.report_json, u.name AS submitter, r.reviewed_at
            FROM shifts s JOIN users u ON u.id = s.submitted_by LEFT JOIN reviews r ON r.shift_id = s.id
            WHERE s.station_id = ? AND s.business_date = ? AND s.submitted_at IS NOT NULL ORDER BY s.id DESC""",
         (sid, selected)),
    ]
    fuels, nozzles, petrol, diesel, stock_confirmation, rows, *business_rows = read_snapshot(db, [*queries, *business_queries(sid)])
    business = business_state(db, sid, results=business_rows)
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
            "can_edit_opening_stock": not petrol[0]["submitted"],
            "opening_stock_confirmed": bool(stock_confirmation or any(row["opening_stock"] for row in fuels)),
            "business": {"active": business["active"], "tanks": business["tanks"],
                         "exceptions_count": sum(not issue["acknowledgement"] for issue in business["exceptions"]),
                         "customer_balance": business["unallocated_credit"] + sum(c["balance"] for c in business["customers"])}}


def daily_owner_report(db, sid, selected, *, in_write=False):
    reader = (lambda connection, queries: [list(result) for result in execute_many(connection, queries)]) if in_write else read_snapshot
    opening_rows, prior_rows, rows = reader(db, [
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
    opening = dict.fromkeys(FUELS, 0) | {row["fuel"]: row["opening_stock"] for row in opening_rows}
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
            key: payload[key] for key in ("expenses", "expected", "counted", "cash_difference", "sales", "collection_difference", "expense_note")
        } | {"payments": {method: payload["collections"].get(method, 0) for method in METHODS},
             "entries": payload.get("entries", {}), "shift_note": payload.get("shift_note", "")})
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
            db.execute("INSERT INTO opening_stock_confirmations VALUES (?) ON CONFLICT DO NOTHING", (sid,))
        return config(db, sid)


def list_managers(db, station_id):
    return [dict(row) for row in db.execute(
        """SELECT u.id, u.name, u.login_id, COALESCE(mc.disabled, 0) AS disabled FROM users u
        LEFT JOIN manager_controls mc ON mc.user_id = u.id
        WHERE u.station_id = ? AND u.role = 'manager' ORDER BY u.id""",
        (station_id,),
    )]


def create_manager(db, user, data):
    station_id = user["station_id"]
    name = note(data.get("name", ""), "the manager's name", 80)
    if not name:
        fail("Enter the manager's name.")
    phone = indian_mobile(data.get("phone"))
    if not phone:
        fail("Enter a valid Indian mobile number.")
    password = data.get("password")
    if not valid_new_password(password):
        fail("Use a password of 15–200 characters.")
    salt = secrets.token_hex(16)
    digest = password_hash(password, salt)
    with transaction(db, immediate=True):
        if db.execute("SELECT 1 FROM users WHERE login_id = ?", (phone,)).fetchone():
            fail("That mobile number is already registered.", 409)
        insert_user(db, station_id, "manager", phone, name, salt, digest)
        target = db.execute("SELECT id FROM users WHERE login_id = ?", (phone,)).fetchone()
        audit_account(db, station_id, user["id"], target["id"], "create")
    return {"name": name, "login_id": phone}


def required_note(value, label, limit=150):
    value = note(value, label, limit)
    if not value:
        fail(f"Enter {label}.")
    return value


def business_date(value, label="a date"):
    try:
        return date.fromisoformat(value).isoformat()
    except (ValueError, TypeError):
        fail(f"Enter {label} as YYYY-MM-DD.")


def correction_list(db, sid, shift_id=None):
    return [dict(row) for row in db.execute("""SELECT c.*, u.name AS requester, m.name AS responder
        FROM corrections c JOIN users u ON u.id = c.requested_by LEFT JOIN users m ON m.id = c.responded_by
        WHERE c.station_id = ? AND (? IS NULL OR c.shift_id = ?) ORDER BY c.id DESC""", (sid, shift_id, shift_id))]


def respond_correction(db, user, correction_id, body):
    response = required_note(body.get("response"), "a clarification or proposed correction", 1000)
    with transaction(db, immediate=True):
        row = db.execute("SELECT * FROM corrections WHERE id = ? AND station_id = ?", (correction_id, user["station_id"])).fetchone()
        if not row:
            fail("Correction request not found.", 404)
        if row["resolved_at"] or row["responded_at"]:
            fail("This request has already been answered or closed.", 409)
        db.execute("UPDATE corrections SET response = ?, responded_by = ?, responded_at = ? WHERE id = ?",
                   (response, user["id"], now(), correction_id))
    return {"ok": True}


def active_shift_summary(row):
    hours = max(0, (datetime.fromisoformat(now()) - datetime.fromisoformat(row["opened_at"])).total_seconds() / 3600)
    return {**open_shift_public(row), "opener": row["opener"], "hours": round(hours, 1), "overdue": hours >= 12}


def business_queries(sid):
    return [
        ("SELECT s.*, u.name AS opener FROM shifts s JOIN users u ON u.id = s.opened_by WHERE s.station_id = ? ORDER BY s.id", (sid,)),
        ("SELECT * FROM customers WHERE station_id = ?", (sid,)),
        ("SELECT r.*, u.name AS actor FROM repayments r JOIN users u ON u.id = r.user_id WHERE r.station_id = ? ORDER BY r.id", (sid,)),
        ("SELECT b.*, u.name AS actor FROM bank_records b JOIN users u ON u.id = b.user_id WHERE b.station_id = ? ORDER BY b.id", (sid,)),
        ("SELECT * FROM tanks WHERE station_id = ?", (sid,)),
        ("SELECT r.shift_id FROM reviews r JOIN shifts s ON s.id = r.shift_id WHERE s.station_id = ?", (sid,)),
        ("SELECT * FROM exception_acknowledgements WHERE station_id = ?", (sid,)),
        ("SELECT fuel, opening_stock FROM fuels WHERE station_id = ?", (sid,)),
        ("SELECT * FROM corrections WHERE station_id = ? ORDER BY id DESC", (sid,)),
        ("SELECT * FROM credit_allocations WHERE station_id = ? ORDER BY id", (sid,)),
        ("SELECT v.*, u.name AS actor FROM record_voids v JOIN users u ON u.id = v.user_id WHERE v.station_id = ?", (sid,)),
    ]


def business_state(db, sid, *, in_write=False, results=None):
    if results is None:
        queries = business_queries(sid)
        results = ([list(rows) for rows in execute_many(db, queries)] if in_write else read_snapshot(db, queries))
    shifts, configs, repayments, bank, tanks, reviews, acks, fuels, corrections, allocations, voids = results
    void_lookup = {(row["record_type"], row["record_id"]): dict(row) for row in voids}
    repayment_history = [dict(row) | {"void": void_lookup.get(("repayment", row["id"]))} for row in repayments]
    bank_history = [dict(row) | {"void": void_lookup.get(("bank", row["id"]))} for row in bank]
    repayments = [row for row in repayment_history if not row["void"]]
    bank = [row for row in bank_history if not row["void"]]
    bank_by_source = defaultdict(list)
    allocations_by_shift = defaultdict(list)
    for row in bank:
        bank_by_source[row["source"], row["method"]].append(row)
    for row in allocations:
        allocations_by_shift[row["shift_id"]].append(row)
    customers = {row["customer_key"]: dict(row) | {"sales": 0, "repaid": 0, "transactions": []} for row in configs}
    settlements = []
    exceptions = []
    stock = {row["fuel"]: row["opening_stock"] for row in fuels}
    reviewed = {row["shift_id"] for row in reviews}
    active = None
    unallocated = 0
    unallocated_shifts = []

    def customer(name):
        key = name.strip().casefold()
        return customers.setdefault(key, {"customer_key": key, "name": name.strip(), "due_date": "", "sales": 0, "repaid": 0, "transactions": []})

    def issue(key, kind, message, signature, shift_id=None):
        exceptions.append({"key": key, "kind": kind, "message": message, "signature": str(signature), "shift_id": shift_id})

    def receivable(source, method, expected, label):
        records = bank_by_source.get((source, method), [])
        gross = sum(item["amount"] + item["fees"] for item in records)
        settlements.append({"source": source, "method": method, "label": label, "expected": expected,
                            "banked": sum(item["amount"] for item in records), "fees": sum(item["fees"] for item in records),
                            "remaining": expected - gross, "records": records})

    for row in shifts:
        if not row["submitted_at"]:
            active = active_shift_summary(row)
            if active["overdue"]:
                issue(f"overdue:{row['id']}", "Overdue shift", f"Shift #{row['id']} has been open for {active['hours']:.1f} hours.", row["opened_at"], row["id"])
            continue
        payload = json.loads(row["report_json"])
        shift_id = row["id"]
        for kind, field in (("Cash difference", "cash_difference"), ("Collection difference", "collection_difference")):
            if payload[field]:
                issue(f"{field}:{shift_id}", kind, f"Shift #{shift_id}: ₹{payload[field] / 100:,.2f}.", payload[field], shift_id)
        if shift_id not in reviewed:
            issue(f"review:{shift_id}", "Pending review", f"Shift #{shift_id} is awaiting owner review.", hashlib.sha256(row["report_json"].encode()).hexdigest(), shift_id)
        for fuel in FUELS:
            item = payload["fuels"][fuel]
            stock[fuel] += item["delivery"] - item["litres"]
            if item["physical"] is not None and item["physical"] != stock[fuel]:
                diff = item["physical"] - stock[fuel]
                issue(f"stock:{shift_id}:{fuel}", "Stock difference", f"Shift #{shift_id}, {fuel}: physical minus book stock {diff / 1000:,.3f} L.", diff, shift_id)
        credit_entries = [item for item in payload.get("entries", {}).get("payments", []) if item["method"] == "credit"]
        if not credit_entries:
            assigned = allocations_by_shift.get(shift_id, [])
            remaining = payload["collections"].get("credit", 0) - sum(item["amount"] for item in assigned)
            unallocated += remaining
            if remaining:
                unallocated_shifts.append({"shift_id": shift_id, "remaining": remaining})
            for allocation in assigned:
                item = customer(allocation["name"])
                item["sales"] += allocation["amount"]
                item["transactions"].append({"date": row["business_date"], "type": "Allocated credit sale", "amount": allocation["amount"],
                                             "reference": allocation["reference"], "note": "Allocated by owner", "shift_id": shift_id})
        for entry in credit_entries:
            item = customer(entry["party"])
            item["sales"] += entry["amount"]
            item["transactions"].append({"date": row["business_date"], "type": "Credit sale", "amount": entry["amount"],
                                         "reference": entry["reference"], "note": entry["note"], "shift_id": shift_id})
        for method in ("upi", "card", "cash"):
            expected = max(0, payload["counted"]) if method == "cash" else payload["collections"][method]
            if expected:
                receivable(f"shift:{shift_id}", method, expected, f"Shift #{shift_id} · {row['business_date']}")
    for row in repayments:
        item = customers.get(row["customer_key"])
        if item is None:
            continue
        item["repaid"] += row["amount"]
        item["transactions"].append({"date": row["paid_on"], "type": "Repayment", "amount": -row["amount"],
                                     "reference": row["reference"], "note": row["note"], "actor": row["actor"]})
        if row["method"] == "cash":
            receivable(f"repayment:{row['id']}", "cash", row["amount"], f"Cash repayment · {item['name']} · {row['paid_on']}")
    for item in customers.values():
        item["balance"] = item["sales"] - item["repaid"]
        item["transactions"].sort(key=lambda entry: entry["date"])
        item["overdue"] = bool(item["balance"] > 0 and item["due_date"] and item["due_date"] < now()[:10])
        if item["overdue"]:
            issue("credit:" + item["customer_key"], "Overdue customer", f"{item['name']}: ₹{item['balance'] / 100:,.2f} due since {item['due_date']}.", f"{item['balance']}:{item['due_date']}")
    for row in tanks:
        if stock[row["fuel"]] > row["capacity"]:
            issue("capacity:" + row["fuel"], "Above tank capacity", f"{row['fuel']}: calculated stock exceeds configured capacity.", stock[row["fuel"]])
        if stock[row["fuel"]] <= row["low_level"]:
            issue("low:" + row["fuel"], "Low stock", f"{row['fuel']}: {stock[row['fuel']] / 1000:,.3f} L remaining.", stock[row["fuel"]])
    for item in settlements:
        if item["remaining"] > 0:
            issue(f"bank:{item['source']}:{item['method']}", "Cash awaiting deposit" if item["method"] == "cash" else "Pending bank settlement",
                  f"{item['label']}, {item['method']}: ₹{item['remaining'] / 100:,.2f} outstanding.", item["remaining"])
    if unallocated:
        issue("unallocated-credit", "Unallocated customer credit", f"₹{unallocated / 100:,.2f} credit needs customer allocation.", unallocated)
    for row in corrections:
        if not row["resolved_at"]:
            issue(f"correction:{row['id']}", "Correction request", f"Shift #{row['shift_id']}: {row['reason']}" + (" · Manager responded" if row["responded_at"] else " · Awaiting manager"), row["responded_at"] or row["requested_at"], row["shift_id"])
    acknowledged = {row["exception_key"]: dict(row) for row in acks}
    for item in exceptions:
        ack = acknowledged.get(item["key"])
        item["acknowledgement"] = ack if ack and ack["signature"] == item["signature"] else None
    return {"active": active, "customers": sorted(customers.values(), key=lambda item: item["name"].casefold()),
            "unallocated_credit": unallocated, "unallocated_shifts": unallocated_shifts, "settlements": settlements, "bank_records": bank_history,
            "repayments": repayment_history, "tanks": {row["fuel"]: dict(row) for row in tanks},
            "stock": stock, "exceptions": exceptions, "corrections": [dict(row) for row in corrections],
            "today": now()[:10]}


def operations_state(db, sid):
    shifts, tanks, corrections, fuels, petrol, diesel = read_snapshot(db, [
        ("""SELECT s.*, u.name AS opener FROM shifts s JOIN users u ON u.id = s.opened_by
            WHERE s.station_id = ? AND s.submitted_at IS NULL""", (sid,)),
        ("SELECT * FROM tanks WHERE station_id = ?", (sid,)),
        ("SELECT * FROM corrections WHERE station_id = ? ORDER BY id DESC", (sid,)),
        ("SELECT fuel, opening_stock FROM fuels WHERE station_id = ?", (sid,)),
        *(stock_query(sid, fuel) for fuel in FUELS),
    ])
    opening = {row["fuel"]: row["opening_stock"] for row in fuels}
    stock = {fuel: opening.get(fuel, 0) + rows[0]["delivery"] - rows[0]["sold"]
             for fuel, rows in zip(FUELS, (petrol, diesel))}
    return {"active": active_shift_summary(shifts[0]) if shifts else None,
            "tanks": {row["fuel"]: dict(row) for row in tanks}, "stock": stock,
            "corrections": list(map(dict, corrections))}


def owner_control_route(db, user, method, route, body):
    outgoing = outgoing_route(db, user, method, route, body, now=now, fail=fail, number=number, note=note)
    if outgoing is not None:
        return outgoing
    sid = user["station_id"]
    if method == "GET" and route == "/business":
        return business_state(db, sid)
    credit_match = re.fullmatch(r"/shift-credit(?:/([0-9]{1,18}))?", route)
    if method == "POST" and credit_match:
        return save_shift_credit(db, user, body, int(credit_match[1]) if credit_match[1] else None)
    void_match = re.fullmatch(r"/money-records/(repayment|bank)/([0-9]{1,18})/void", route)
    if method == "POST" and void_match:
        kind, record_id = void_match[1], int(void_match[2])
        reason = required_note(body.get("reason"), "the reason for voiding this record", 500)
        with transaction(db, immediate=True):
            state = business_state(db, sid, in_write=True)
            target = next((row for row in state["repayments" if kind == "repayment" else "bank_records"] if row["id"] == record_id), None)
            if not target:
                fail("Money record not found.", 404)
            if target["void"]:
                fail("This record is already void.", 409)
            if kind == "repayment" and any(row["source"] == f"repayment:{record_id}" and not row["void"] for row in state["bank_records"]):
                fail("Void the linked cash deposit before voiding this repayment.", 409)
            db.execute("INSERT INTO record_voids VALUES (?, ?, ?, ?, ?, ?)", (sid, kind, record_id, reason, user["id"], now()))
        return {"ok": True}
    match = re.fullmatch(r"/managers/([0-9]{1,18})", route)
    if method == "POST" and match:
        manager_id = int(match[1])
        with transaction(db, immediate=True):
            target = db.execute("SELECT * FROM users WHERE id = ? AND station_id = ? AND role = 'manager'", (manager_id, sid)).fetchone()
            if not target:
                fail("Manager not found.", 404)
            action = body.get("action")
            if action in ("disable", "enable"):
                db.execute("INSERT INTO manager_controls(user_id, disabled) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET disabled = excluded.disabled", (manager_id, int(action == "disable")))
            elif action == "reset_password":
                password = body.get("password")
                if not valid_new_password(password):
                    fail("Use a password of 15–200 characters.")
                salt = secrets.token_hex(16)
                db.execute("UPDATE users SET salt = ?, password_hash = ? WHERE id = ?", (salt, password_hash(password, salt), manager_id))
            elif action == "edit":
                name = required_note(body.get("name"), "the manager's name", 80)
                phone = indian_mobile(body.get("phone"))
                if not phone:
                    fail("Enter a valid Indian mobile number.")
                if db.execute("SELECT 1 FROM users WHERE login_id = ? AND id <> ?", (phone, manager_id)).fetchone():
                    fail("That mobile number is already registered.", 409)
                db.execute("UPDATE users SET name = ?, login_id = ? WHERE id = ?", (name, phone, manager_id))
            elif action != "revoke_sessions":
                fail("Choose a valid manager action.")
            db.execute("DELETE FROM sessions WHERE user_id = ?", (manager_id,))
            audit_account(db, sid, user["id"], manager_id, action)
        return {"ok": True}
    if method == "POST" and route == "/tanks":
        fuel = body.get("fuel")
        if fuel not in FUELS:
            fail("Choose Petrol or Diesel.")
        capacity = number(body.get("capacity"), 3, "tank capacity")
        threshold = number(body.get("low_level"), 3, "low stock threshold")
        if not 0 < capacity or threshold >= capacity:
            fail("Capacity must be positive and the low stock threshold must be below capacity.")
        with transaction(db, immediate=True):
            db.execute("INSERT INTO tanks VALUES (?, ?, ?, ?) ON CONFLICT(station_id, fuel) DO UPDATE SET capacity = excluded.capacity, low_level = excluded.low_level", (sid, fuel, capacity, threshold))
        return {"ok": True}
    if method == "POST" and route in ("/customers", "/repayments", "/bank-records", "/exceptions/acknowledge", "/credit-allocations"):
        with transaction(db, immediate=True):
            state = business_state(db, sid, in_write=True)
            if route == "/credit-allocations":
                target = next((item for item in state["unallocated_shifts"] if item["shift_id"] == body.get("shift_id")), None)
                if not target:
                    fail("No unallocated credit found for this shift.", 404)
                amount = number(body.get("amount"), 2, "credit allocation")
                if not 0 < amount <= target["remaining"]:
                    fail("Allocate a positive amount within the unallocated balance.", 409)
                name = required_note(body.get("name"), "a customer name", 150)
                reference = required_note(body.get("reference"), "a unique allocation reference", 150)
                try:
                    db.execute("INSERT INTO credit_allocations(station_id, shift_id, name, amount, reference, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", (sid, target["shift_id"], name, amount, reference, user["id"], now()))
                except sqlite3.IntegrityError:
                    fail("This allocation reference has already been recorded.", 409)
            elif route == "/customers":
                name = required_note(body.get("name"), "a customer name", 150)
                due = business_date(body["due_date"]) if body.get("due_date") else ""
                db.execute("INSERT INTO customers VALUES (?, ?, ?, ?) ON CONFLICT(station_id, customer_key) DO UPDATE SET name = excluded.name, due_date = excluded.due_date", (sid, name.casefold(), name, due))
            elif route == "/exceptions/acknowledge":
                key = note(body.get("key"), "an exception", 250)
                issue = next((item for item in state["exceptions"] if item["key"] == key), None)
                if not issue:
                    fail("This exception is no longer active. Refresh the inbox.", 409)
                message = required_note(body.get("note"), "a follow-up note", 500)
                db.execute("INSERT INTO exception_acknowledgements VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(station_id, exception_key) DO UPDATE SET signature = excluded.signature, note = excluded.note, user_id = excluded.user_id, created_at = excluded.created_at", (sid, key, issue["signature"], message, user["id"], now()))
            else:
                amount = number(body.get("amount"), 2, "amount")
                if amount <= 0:
                    fail("Amount must be greater than zero.")
                reference = required_note(body.get("reference"), "a unique bank or receipt reference", 150)
                message = note(body.get("note", ""), "a note", 500)
                if route == "/repayments":
                    key = note(body.get("customer_key"), "a customer", 150)
                    customer = next((item for item in state["customers"] if item["customer_key"] == key), None)
                    if customer is None:
                        fail("Customer not found.", 404)
                    if amount > customer["balance"]:
                        fail("Repayment exceeds the customer's outstanding balance.", 409)
                    if body.get("method") not in ("cash", "bank"):
                        fail("Choose cash received or confirmed bank receipt.")
                    paid_on = business_date(body.get("paid_on"))
                    if paid_on > now()[:10]:
                        fail("A repayment cannot be recorded in the future.")
                    sql = "INSERT INTO repayments(station_id, customer_key, amount, method, paid_on, reference, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    params = (sid, key, amount, body["method"], paid_on, reference, message, user["id"], now())
                else:
                    source = note(body.get("source"), "a payment source", 80)
                    method_name = body.get("method")
                    target = next((item for item in state["settlements"] if item["source"] == source and item["method"] == method_name), None)
                    if target is None:
                        fail("Payment source not found.", 404)
                    fees = number(body.get("fees", "0"), 2, "settlement fees")
                    if method_name == "cash" and fees:
                        fail("Cash deposits cannot include settlement fees.")
                    if amount + fees > target["remaining"]:
                        fail("Amount plus fees exceeds the unreconciled balance.", 409)
                    bank_date = business_date(body.get("bank_date"))
                    if bank_date > now()[:10]:
                        fail("A bank receipt cannot be recorded in the future.")
                    sql = "INSERT INTO bank_records(station_id, source, method, amount, fees, bank_date, reference, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    params = (sid, source, method_name, amount, fees, bank_date, reference, message, user["id"], now())
                try:
                    db.execute(sql, params)
                except sqlite3.IntegrityError:
                    fail("This reference has already been recorded. Refresh before trying again.", 409)
        return {"ok": True}
    match = re.fullmatch(r"/shifts/([0-9]{1,18})/(corrections|revise)", route)
    if method == "POST" and match:
        shift_id = int(match[1])
        if match[2] == "revise":
            return submit_shift(db, user, shift_id, body, revision=True)
        reason = required_note(body.get("reason"), "the correction or clarification needed", 500)
        with transaction(db, immediate=True):
            report(db, sid, shift_id)
            if db.execute("SELECT 1 FROM corrections WHERE station_id = ? AND shift_id = ? AND resolved_at IS NULL", (sid, shift_id)).fetchone():
                fail("An open correction request already exists for this shift.", 409)
            db.execute("INSERT INTO corrections(station_id, shift_id, requested_by, requested_at, reason) VALUES (?, ?, ?, ?, ?)", (sid, shift_id, user["id"], now(), reason))
        return {"ok": True}
    match = re.fullmatch(r"/corrections/([0-9]{1,18})/resolve", route)
    if method == "POST" and match:
        resolution = required_note(body.get("resolution"), "the resolution and any adjustment made", 1000)
        with transaction(db, immediate=True):
            row = db.execute("SELECT * FROM corrections WHERE id = ? AND station_id = ?", (int(match[1]), sid)).fetchone()
            if not row:
                fail("Correction request not found.", 404)
            if row["resolved_at"]:
                fail("This correction request is already closed.", 409)
            db.execute("UPDATE corrections SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?", (now(), user["id"], resolution, row["id"]))
        return {"ok": True}
    return None


class Request:
    def __init__(self, environ, database, hosted, demo, public_url="https://petroleum-management.onrender.com", automation_env=None, assets=None, throttle=None, allowed_hosts=(), render_proxy=False, mfa=None):
        self.environ = environ
        self.database = database
        self.hosted = hosted
        self.demo = demo
        self.public_url = public_url
        self.automation_env = automation_env or {}
        self.assets = assets
        self.throttle = throttle
        self.allowed_hosts = allowed_hosts
        self.render_proxy = render_proxy
        self.mfa = mfa

    def payload(self, limit=JSON_BODY_LIMIT):
        if self.environ.get("CONTENT_TYPE", "").partition(";")[0].strip().lower() != "application/json":
            fail("Send a JSON request.", 415)
        try:
            size = int(self.environ.get("CONTENT_LENGTH") or "0")
            if not 0 < size <= limit:
                fail("Invalid request size.", 413)
            raw = self.environ["wsgi.input"].read(size)
            if len(raw) != size:
                fail("Incomplete request body.")
            return mapping(json.loads(raw, parse_float=Decimal, parse_constant=reject_json_constant,
                                      object_pairs_hook=reject_duplicate_keys), "request data")
        except (ValueError, UnicodeError, InvalidOperation, RecursionError):
            fail("Invalid JSON request.")

    def check_browser_origin(self):
        if self.environ.get("HTTP_SEC_FETCH_SITE") in ("cross-site", "same-site"):
            fail("Invalid request origin.", 403)
        origin = self.environ.get("HTTP_ORIGIN")
        scheme = "https" if self.hosted else self.environ["wsgi.url_scheme"]
        if origin and origin != f'{scheme}://{self.environ.get("HTTP_HOST")}':
            fail("Invalid request origin.", 403)
    def limit(self, group, key, maximum, seconds):
        if not self.throttle.take((group, key), maximum, seconds):
            fail("Too many requests. Try again later.", 429)

    def address(self):
        return client_address(self.environ, render_proxy=self.render_proxy)

    def token(self, role):
        jar = SimpleCookie()
        try:
            jar.load(self.environ.get("HTTP_COOKIE", ""))
        except CookieError:
            return ""
        cookie = jar.get(f"pm_{role}")
        return hashlib.sha256(cookie.value.encode()).hexdigest() if cookie and re.fullmatch(r"[A-Za-z0-9_-]{43}", cookie.value) else ""

    def session_cookie(self, role, token, age):
        secure = "; Secure" if self.hosted else ""
        return f"pm_{role}={token}; Path=/api/{role}; HttpOnly; SameSite=Strict; Max-Age={age}{secure}"

    def authenticated(self, db, role):
        user = db.execute("""SELECT u.id, u.role, u.name, u.station_id, s.name AS station, s.code AS station_code
                             FROM sessions t JOIN users u ON u.id = t.user_id
                             JOIN stations s ON s.id = u.station_id
                             WHERE t.token_hash = ? AND t.expiry > ?
                             AND NOT EXISTS (SELECT 1 FROM manager_controls mc WHERE mc.user_id = u.id AND mc.disabled = 1)""", (self.token(role), int(time.time()))).fetchone()
        if not user:
            fail("Sign in to continue.", 401)
        if user["role"] != role:
            fail("This account cannot access this app.", 403)
        return dict(user)

    def mfa_password(self, db, user, password):
        self.limit("mfa-password", user["id"], 10, 300)
        if not isinstance(password, str) or len(password) > 200 or not valid_unicode(password):
            fail("Enter your current password.")
        account = db.execute("SELECT salt, password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
        if not account or not secrets.compare_digest(password_hash(password, account["salt"]), account["password_hash"]):
            fail("The current password is incorrect.", 422)
        self.throttle.clear(("mfa-password", user["id"]))
        return account["salt"]

    def api(self, method, path):
        match = re.fullmatch(r"/api/(manager|owner)(/.*)", path)
        if not match:
            fail("Page not found.", 404)
        role, route = match.groups()
        self.check_browser_origin()
        login = method == "POST" and route == "/login"
        if not login and not self.token(role):
            fail("Sign in to continue.", 401)
        data = None
        if method == "POST":
            closing_shift = ((role == "manager" and re.fullmatch(r"/shifts/[0-9]{1,18}/(submit|draft)", route))
                             or (role == "owner" and re.fullmatch(r"/shifts/[0-9]{1,18}/(revise|submit)", route)))
            limit = 6 * 1024 * 1024 if route == "/automation/documents" else SHIFT_BODY_LIMIT if closing_shift or route.startswith("/automation/imports") else JSON_BODY_LIMIT
            data = self.payload(limit)
        with closing(open_db(self.database)) as db:
            if login:
                identifier = note(data.get("identifier", data.get("email", "")), "a mobile number or email", 254).lower()
                login_id = indian_mobile(identifier) or identifier
                password = data.get("password", "")
                if not isinstance(password, str) or len(password) > 200 or not valid_unicode(password):
                    fail("Enter a password of up to 200 characters.")
                self.limit("login-source", self.address(), 30, 60)
                account_key = hashlib.sha256(login_id.encode()).hexdigest()
                self.limit("login-account", account_key, 10, 300)
                user = db.execute("""SELECT u.*, COALESCE(mc.disabled, 0) AS disabled
                                     FROM users u LEFT JOIN manager_controls mc ON mc.user_id = u.id
                                     WHERE login_id = ?""", (login_id,)).fetchone()
                digest = password_hash(password, user["salt"] if user else "0" * 32)
                matches = secrets.compare_digest(digest, user["password_hash"] if user else "0" * 64)
                if not user or user["disabled"] or not matches:
                    fail("Sign-in details are incorrect.", 401)
                if user["role"] != role:
                    fail("This account cannot sign in to this app.", 403)
                token = secrets.token_urlsafe(32)
                expiry = 12 * 60 * 60
                with transaction(db, immediate=True):
                    factor = self.mfa.factor(db, user["id"])
                    if factor:
                        self.mfa.require_cipher()
                        if not data.get("code"):
                            return {"mfa_required": True}, None
                        self.limit("mfa-code", user["id"], 10, 300)
                        recovered = self.mfa.consume(db, user["id"], factor, data["code"])
                        if recovered:
                            db.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
                            audit_account(db, user["station_id"], user["id"], user["id"], "mfa_recovery")
                    db.execute("DELETE FROM sessions WHERE expiry <= ?", (int(time.time()),))
                    issued = db.execute("""INSERT INTO sessions(token_hash, user_id, expiry)
                        SELECT ?, id, ? FROM users WHERE id = ? AND salt = ? AND login_id = ?
                        AND NOT EXISTS (SELECT 1 FROM manager_controls WHERE user_id = users.id AND disabled = 1)
                        RETURNING token_hash""",
                        (hashlib.sha256(token.encode()).hexdigest(), int(time.time()) + expiry,
                         user["id"], user["salt"], login_id)).fetchone()
                    if not issued:
                        fail("Sign-in details changed. Please sign in again.", 401)
                    previous = self.token(role)
                    if previous:
                        db.execute("DELETE FROM sessions WHERE token_hash = ? AND user_id = ?", (previous, user["id"]))
                    db.execute("""DELETE FROM sessions WHERE user_id = ? AND token_hash IN
                                  (SELECT token_hash FROM sessions WHERE user_id = ?
                                   ORDER BY expiry DESC, CASE WHEN token_hash = ? THEN 0 ELSE 1 END, token_hash
                                   LIMIT -1 OFFSET ?)""",
                               (user["id"], user["id"], issued["token_hash"], MAX_SESSIONS_PER_USER))
                self.throttle.clear(("login-account", account_key))
                return {"ok": True}, self.session_cookie(role, token, expiry)
            user = self.authenticated(db, role)
            sid = user["station_id"]
            if method == "POST" and route == "/logout":
                with transaction(db, immediate=True):
                    db.execute("DELETE FROM sessions WHERE token_hash = ?", (self.token(role),))
                return {"ok": True}, self.session_cookie(role, "", 0)
            if route == "/mfa" or route.startswith("/mfa/"):
                if method == "POST" and route != "/mfa/setup":
                    self.limit("mfa-code", user["id"], 10, 300)
                result = self.mfa.manage(db, user, route, method, data, self.token(role),
                                         lambda password: self.mfa_password(db, user, password),
                                         lambda action: audit_account(db, sid, user["id"], user["id"], action))
                if method == "POST" and route in ("/mfa/enable", "/mfa/disable"):
                    return result, self.session_cookie(role, "", 0)
                return result, None
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
                result = list_managers(db, sid) if method == "GET" else create_manager(db, user, data)
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

    def automation_helpers(self):
        return dict(now=now, fail=fail, number=number, note=note, business_state=business_state, daily_report=daily_owner_report, business_queries=business_queries, env=self.automation_env, database=self.database)

    def shift_route(self, db, user, role, method, route, data):
        if route == "/automation" or route.startswith("/automation/"):
            try:
                return Automation(db, user, **self.automation_helpers()).route(method, route, data, parse_qs(self.environ.get("QUERY_STRING", "")))
            except sqlite3.IntegrityError:
                fail("This salary, bill or bank reference already exists. Review the original record.", 409)
        if role == "manager":
            draft = draft_route(db, user, method, route, data, fail=fail, note=note, now=now)
            if draft is not None:
                return draft
        if role == "owner":
            if method == "GET" and route == "/account-audit":
                rows, = read_snapshot(db, [("""
                    SELECT a.action, a.created_at, actor.name AS actor, target.name AS target
                    FROM account_audit a JOIN users actor ON actor.id = a.actor_id
                    JOIN users target ON target.id = a.target_id
                    WHERE a.station_id = ? ORDER BY a.id DESC LIMIT 100
                """, (user["station_id"],))])
                return list(map(dict, rows))
            if method == "GET" and route == "/business/operations":
                return operations_state(db, user["station_id"])
            if method == "GET" and route == "/business/exceptions":
                state = business_state(db, user["station_id"])
                return {key: state[key] for key in ("active", "exceptions")}
            if method == "GET" and route == "/business/money":
                sid = user["station_id"]
                *rows, pending = read_snapshot(db, [*business_queries(sid), pending_credit_query(sid)])
                state = business_state(db, sid, results=rows)
                keys = ("active", "customers", "unallocated_credit", "unallocated_shifts", "settlements", "bank_records", "repayments", "today")
                return {key: state[key] for key in keys} | {"pending_credits": list(map(dict, pending))}
            control = owner_control_route(db, user, method, route, data)
            if control is not None:
                return control
        if role == "manager" and route == "/corrections" and method == "GET":
            return correction_list(db, user["station_id"])
        response = re.fullmatch(r"/corrections/([0-9]{1,18})/respond", route)
        if role == "manager" and method == "POST" and response:
            return respond_correction(db, user, int(response[1]), data)

        match = re.fullmatch(r"/shifts/([0-9]{1,18})(/submit|/review)?", route)
        if match:
            shift_id, action = int(match[1]), match[2]
            if role in ("manager", "owner") and method == "POST" and action == "/submit":
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
            if path != "/healthz" and self.allowed_hosts and self.environ.get("HTTP_HOST", "").lower() not in self.allowed_hosts:
                fail("Invalid request host.", 400)
            feed = re.fullmatch(r"/api/feeds/([a-f0-9]{32})", path)
            if feed and method == "POST":
                self.check_browser_origin()
                authorization = self.environ.get("HTTP_AUTHORIZATION", "")
                if not re.fullmatch(r"Bearer [A-Za-z0-9_-]{43}", authorization):
                    fail("Invalid connection credentials.", 401)
                self.limit("feed-source", self.address(), 120, 60)
                with closing(open_db(self.database)) as db:
                    result = accept_feed(db, feed[1], authorization, lambda: self.payload(SHIFT_BODY_LIMIT),
                                         lambda: self.limit("feed", feed[1], 60, 60), **self.automation_helpers())
                return 200, json.dumps(result).encode(), json_type, None
            if path.startswith("/api/") and method in ("GET", "POST"):
                result, cookie = self.api(method, path)
                return 200, json.dumps(result).encode(), json_type, cookie
            if method not in ("GET", "HEAD") or (method == "HEAD" and path.startswith("/api/")):
                fail("Page not found.", 404)
            if path == "/healthz":
                return 200, b'{"ok":true}', json_type, None
            if path in STATIC_FILES:
                body = self.assets[path][0]
                content_type = STATIC_FILES[path]
                if content_type.startswith("text/"):
                    content_type += "; charset=utf-8"
                return 200, body, content_type, None
            if path in ("/", "/manager", "/owner"):
                body = self.assets["index"][0]
                titles = {
                    "/": ("Tuljai Realtors & Petroleum", "Petrol and Diesel station management for Tuljai Realtors & Petroleum."),
                    "/owner": ("Tuljai Petroleum | Owner App", "View daily fuel sales, payments, stock and shift reports."),
                    "/manager": ("Tuljai Petroleum | Station Manager App", "Manage shift readings, fuel deliveries, collections and cash reconciliation."),
                }
                title, description = titles[path]
                preview = self.public_url + "/tuljai-logo.jpg?v=" + self.assets["/tuljai-logo.jpg"][1]
                metadata = {
                    "__PAGE_TITLE__": title, "__PAGE_DESCRIPTION__": description,
                    "__PAGE_URL__": self.public_url + path, "__PREVIEW_IMAGE__": preview,
                }
                for placeholder, value in metadata.items():
                    body = body.replace(placeholder.encode(), escape(value, quote=True).encode())
                if path == "/manager":
                    body = body.replace(b'"/owner.webmanifest"', b'"/manager.webmanifest"')
                if not self.demo:
                    body = body.replace(b'<meta name="demo-mode" content="true">', b'')
                for asset in STATIC_FILES:
                    version = self.assets[asset][1]
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
    public_url = env.get("PUBLIC_APP_URL") or env.get("RENDER_EXTERNAL_URL") or "https://petroleum-management.onrender.com"
    public_url = public_url.rstrip("/")
    parsed = urlsplit(public_url)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path):
        raise RuntimeError("PUBLIC_APP_URL must be the public app origin, such as https://your-app.onrender.com.")

    configured_origins = (env.get("PUBLIC_APP_URL"), env.get("RENDER_EXTERNAL_URL"))
    allowed_hosts = {urlsplit(origin).netloc.lower() for origin in configured_origins if origin} if hosted else set()
    if hosted and parsed.scheme != "https":
        raise RuntimeError("Hosted deployments require an HTTPS public app URL.")
    throttle = Throttle()
    mfa = MFA(mfa_cipher(env.get("MFA_ENCRYPTION_KEY")), fail)
    automation_env = {key: env[key] for key in ("OPENAI_API_KEY", "AUTOMATION_OCR_MODEL") if env.get(key)}
    assets = {}
    for key, filename in [(key, key.lstrip("/")) for key in STATIC_FILES] + [("index", "index.html")]:
        data = (ROOT / "static" / filename).read_bytes()
        compressed = gzip.compress(data, compresslevel=5, mtime=0) if len(data) >= 1024 and (key == "index" or STATIC_FILES[key].startswith("text/")) else None
        assets[key] = (data, asset_version(data), compressed)

    def application(environ, start_response):
        request = Request(environ, database, hosted, demo, public_url, automation_env, assets,
                          throttle=throttle, allowed_hosts=allowed_hosts, render_proxy=env.get("RENDER") == "true", mfa=mfa)
        status, body, content_type, cookie = request.dispatch()
        path = environ["PATH_INFO"]
        cache_control = "no-store"
        if (status == 200 and path in STATIC_FILES and path != "/sw.js"
                and environ.get("QUERY_STRING", "") == "v=" + assets[path][1]):
            cache_control = "public, max-age=31536000, immutable"
        encoding = None
        compressible = status == 200 and environ["REQUEST_METHOD"] in ("GET", "HEAD") and (content_type.startswith("text/") or content_type.startswith("application/json"))
        if compressible and len(body) >= 1024:
            requested = {}
            for entry in environ.get("HTTP_ACCEPT_ENCODING", "").lower().split(","):
                name, _, params = entry.strip().partition(";")
                try:
                    requested[name] = float(params.strip().removeprefix("q=")) if params else 1
                except ValueError:
                    requested[name] = 0
            if requested.get("gzip", requested.get("*", 0)) > 0:
                compressed = assets.get(path, (None, None, None))[2] or gzip.compress(body, compresslevel=3, mtime=0)
                if len(compressed) < len(body):
                    body, encoding = compressed, "gzip"
        headers = [
            ("Content-Type", content_type),
            ("Content-Length", str(len(body))),
            ("Cache-Control", cache_control),
            ("X-Content-Type-Options", "nosniff"),
            ("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"),
            ("Referrer-Policy", "same-origin"),
            ("X-Frame-Options", "DENY"),
            ("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()"),
            ("Cross-Origin-Resource-Policy", "same-origin"),
        ]
        if hosted:
            headers.append(("Strict-Transport-Security", "max-age=31536000"))
        if status == 429:
            headers.append(("Retry-After", "300" if path.endswith("/login") else "60"))
        if compressible:
            headers.append(("Vary", "Accept-Encoding"))
        if encoding:
            headers.append(("Content-Encoding", encoding))
        if cookie:
            headers.append(("Set-Cookie", cookie))
        start_response(f"{status} {HTTPStatus(status).phrase}", headers)
        return [b"" if environ["REQUEST_METHOD"] == "HEAD" else body]

    return application


class LocalServer(ThreadingMixIn, WSGIServer):
    # Browsers open a burst of connections for scripts, styles and font subsets.
    request_queue_size = 128
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
