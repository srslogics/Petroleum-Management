"""Station contacts for owner ledgers and WhatsApp."""

import re

from database import transaction


CONTACTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS station_contacts (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id),
    name TEXT NOT NULL, name_key TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
    UNIQUE(station_id, name_key)
);
"""


def contact_phone(value, fail):
    if not isinstance(value, str) or len(value) > 30:
        fail("Enter a valid WhatsApp number.")
    value = re.sub(r"[\s().-]", "", value.strip())
    if not value:
        return ""
    if re.fullmatch(r"[6-9][0-9]{9}", value):
        value = "+91" + value
    if not re.fullmatch(r"\+[1-9][0-9]{7,14}", value):
        fail("Enter an Indian mobile number or include the country code, such as +91.")
    return value


def contacts_route(db, sid, method, route, body, *, fail, required_note):
    if route != "/contacts":
        return None
    if method == "GET":
        rows = db.execute("SELECT id, name, phone FROM station_contacts WHERE station_id = ? ORDER BY name_key", (sid,))
        return {"contacts": list(map(dict, rows))}
    if method == "POST":
        phone = contact_phone(body.get("phone", ""), fail)
        ident = body.get("id")
        with transaction(db, immediate=True):
            if ident is None:
                name = required_note(body.get("name"), "the contact name", 150)
                match = db.execute("SELECT id FROM station_contacts WHERE station_id = ? AND name_key = ?",
                                   (sid, name.casefold())).fetchone()
                if match:
                    fail("This contact name is already saved. Open the contact to update its number.", 409)
                db.execute("INSERT INTO station_contacts (station_id, name, name_key, phone) VALUES (?, ?, ?, ?)",
                           (sid, name, name.casefold(), phone))
            else:
                if type(ident) is not int or not 0 < ident < 10**18:
                    fail("Choose a valid contact.")
                match = db.execute("SELECT id FROM station_contacts WHERE station_id = ? AND id = ?", (sid, ident)).fetchone()
                if not match:
                    fail("Contact not found.", 404)
                db.execute("UPDATE station_contacts SET phone = ? WHERE station_id = ? AND id = ?", (phone, sid, ident))
        return {"ok": True}
    return None
