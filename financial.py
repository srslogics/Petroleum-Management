"""Double-entry postings from station source records and owner journal entries."""

from collections import defaultdict
from calendar import monthrange
import json
import sqlite3

from database import execute_many, transaction


FINANCIAL_SCHEMA = """
CREATE TABLE IF NOT EXISTS financial_journals (
    id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id),
    posting_date TEXT NOT NULL, reference TEXT NOT NULL, reference_key TEXT,
    description TEXT NOT NULL, lines_json TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    reversal_of INTEGER REFERENCES financial_journals(id),
    UNIQUE(station_id, reference_key), UNIQUE(station_id, reversal_of)
);
CREATE INDEX IF NOT EXISTS financial_journals_by_date ON financial_journals(station_id, posting_date, id);
"""

# Signed amounts are paise, with positive values for debits and negative for credits.
ACCOUNTS = {
    "1000": ("Cash on hand", "Asset"),
    "1010": ("Bank", "Asset"),
    "1020": ("UPI clearing", "Asset"),
    "1030": ("Card clearing", "Asset"),
    "1100": ("Fuel credit receivable", "Asset"),
    "1110": ("Other receivables", "Asset"),
    "1120": ("Unassigned fuel credit", "Asset"),
    "1130": ("Staff advances", "Asset"),
    "1140": ("Loans and advances issued", "Asset"),
    "1200": ("Fuel inventory", "Asset"),
    "1210": ("Other inventory", "Asset"),
    "1300": ("Fixed assets", "Asset"),
    "1310": ("Accumulated depreciation", "Asset"),
    "2000": ("Supplier and other payables", "Liability"),
    "2010": ("Salaries payable", "Liability"),
    "2020": ("Customer advances", "Liability"),
    "2100": ("Taxes payable", "Liability"),
    "2200": ("Borrowings", "Liability"),
    "3000": ("Opening balance equity", "Equity"),
    "3100": ("Owner capital", "Equity"),
    "3110": ("Owner drawings", "Equity"),
    "3200": ("Retained earnings", "Equity"),
    "4000": ("Fuel sales", "Income"),
    "4100": ("Other income", "Income"),
    "5000": ("Fuel cost of sales", "Expense"),
    "5100": ("Till expenses", "Expense"),
    "5200": ("Salaries and wages", "Expense"),
    "5300": ("Bank and payment fees", "Expense"),
    "5400": ("Other operating expenses", "Expense"),
    "5500": ("Depreciation expense", "Expense"),
    "5600": ("Supplier credits and returns", "Expense"),
    "5610": ("Expense reimbursements", "Expense"),
    "9000": ("Collection differences", "Clearing"),
    "9010": ("Till cash differences", "Clearing"),
    "9020": ("Bills to classify", "Clearing"),
    "9030": ("Receivables to classify", "Clearing"),
}
PARTY_ACCOUNTS = {"1100": 1, "1110": 1, "2000": -1}
AUTO_CONTROLS = {*PARTY_ACCOUNTS, "1120", "1130", "2010"}
PAYMENT_ACCOUNTS = {"cash": "1000", "bank": "1010", "upi": "1020", "card": "1030"}
RECEIVABLE_OFFSETS = {"invoice": "4100", "supplier": "5600", "loan": "1140", "reimbursement": "5610",
                      "opening": "3000", "other": "9030"}


def journal_line(code, amount, *, party="", key=""):
    line = {"account": code, "amount": amount}
    if party:
        line.update(party=party, party_key=key or party.strip().casefold())
    return line


def posting(date, stamp, source, source_id, reference, description, lines, **details):
    lines = [line for line in lines if line["amount"]]
    if not lines:
        return None
    if len(lines) < 2 or sum(line["amount"] for line in lines):
        raise ValueError("Unbalanced financial posting.")
    return dict(date=date, recorded_at=stamp, source=source, source_id=source_id, reference=reference,
                description=description, lines=lines, **details)


def reversal(entry, stamp, reason):
    return posting(max(entry["date"], stamp[:10]), stamp, entry["source"], entry["source_id"],
                   entry["reference"], "Reversal · " + entry["description"],
                   [{**line, "amount": -line["amount"]} for line in entry["lines"]],
                   reversal=True, reason=reason, staff_id=entry.get("staff_id"))


def record_postings(row, source, day, title, lines, *, void=None, reference=None):
    entry = posting(day, row["created_at"], source, row["id"], reference or row["reference"], title, lines,
                    note=row["note"] if "note" in row.keys() else "",
                    actor=row["actor"] if "actor" in row.keys() else "",
                    staff_id=row["staff_id"] if "staff_id" in row.keys() else None)
    if entry:
        yield entry
        if void:
            yield reversal(entry, void["created_at"], void["reason"]) | {"actor": void.get("actor", "")}


def shift_lines(payload, part):
    collections = payload["collections"]
    if part == "sales":
        lines = [journal_line(PAYMENT_ACCOUNTS[method], collections.get(method, 0)) for method in ("cash", "upi", "card")]
        credit = [line for line in payload.get("entries", {}).get("payments", []) if line["method"] == "credit"]
        lines.extend(journal_line("1100", row["amount"], party=row["party"]) for row in credit)
        lines.append(journal_line("1120", collections.get("credit", 0) - sum(row["amount"] for row in credit)))
        lines.append(journal_line("4000", -payload["sales"]))
        lines.append(journal_line("9000", -sum(line["amount"] for line in lines)))
        return lines
    if part == "expenses":
        amount = payload["expenses"]
        return [journal_line("5100", amount), journal_line("1000", -amount)]
    difference = payload["cash_difference"]
    return [journal_line("1000", difference), journal_line("9010", -difference)]


def shift_postings(shifts, revisions, *, sales_only=False):
    by_shift = defaultdict(list)
    for revision in revisions:
        by_shift[revision["shift_id"]].append(revision)
    parts = (("sales", "Fuel sales"),) if sales_only else (
        ("sales", "Fuel sales"), ("expenses", "Till expenses"), ("cash", "Till cash difference"))
    for shift in shifts:
        versions = by_shift[shift["id"]]
        original = json.loads(versions[0]["original_json"] if versions else shift["report_json"])
        for part, title in parts:
            entry = posting(shift["business_date"], shift["submitted_at"], "shift", shift["id"],
                            f"Shift #{shift['id']}", title, shift_lines(original, part))
            if entry:
                yield entry
            for change in versions:
                replaced = posting(max(shift["business_date"], change["created_at"][:10]), change["created_at"], "shift",
                                   shift["id"], f"Shift #{shift['id']}", title + " · corrected",
                                   shift_lines(json.loads(change["replacement_json"]), part), reason=change["reason"])
                if entry and replaced and entry["lines"] == replaced["lines"]:
                    continue
                if entry:
                    yield reversal(entry, change["created_at"], change["reason"])
                if replaced:
                    yield replaced
                entry = replaced


def fuel_postings(shifts, revisions, allocations, repayments, names, *, sales_only=False):
    yield from shift_postings(shifts, revisions, sales_only=sales_only)
    shift_dates = {row["id"]: row["business_date"] for row in shifts}
    for row in allocations:
        yield from record_postings(row, "credit-allocation", max(shift_dates[row["shift_id"]], row["created_at"][:10]),
                                   "Assign fuel credit", [journal_line("1100", row["amount"], party=row["name"]),
                                                          journal_line("1120", -row["amount"])])
    for row in repayments:
        key = row["customer_key"]
        yield from record_postings(row, "repayment", row["paid_on"], "Fuel credit payment",
                                   [journal_line(PAYMENT_ACCOUNTS[row["method"]], row["amount"]),
                                    journal_line("1100", -row["amount"], party=names.get(key, key), key=key)],
                                   void=row.get("void"))


def dated_reduction_fits(entries, code, date, amount, *, party_key=None, staff_id=None):
    """A backdated payment cannot consume balances already used by later payments."""
    changes = defaultdict(int)
    for entry in entries:
        if staff_id is not None and entry.get("staff_id") != staff_id:
            continue
        changes[entry["date"]] += sum(line["amount"] for line in entry["lines"] if line["account"] == code
                                      and (party_key is None or line.get("party_key") == party_key))
    changes[date] -= amount
    balance = 0
    for day in sorted(changes):
        balance += changes[day]
        if day >= date and balance < 0:
            return False
    return True


def financial_queries(sid):
    return [
        ("SELECT * FROM shifts WHERE station_id=? AND submitted_at IS NOT NULL ORDER BY id", (sid,)),
        ("SELECT * FROM shift_revisions WHERE station_id=? ORDER BY id", (sid,)),
        ("SELECT * FROM credit_allocations WHERE station_id=? ORDER BY id", (sid,)),
        ("""SELECT j.*, u.name AS actor FROM financial_journals j JOIN users u ON u.id=j.user_id
            WHERE j.station_id=? ORDER BY j.id""", (sid,)),
    ]


def validate_fuel_payment(db, sid, state, customer_key, paid_on, amount):
    shifts, revisions, allocations = execute_many(db, financial_queries(sid)[:3])
    names = {row["customer_key"]: row["name"] for row in state["customers"]}
    return dated_reduction_fits(fuel_postings(list(shifts), list(revisions), list(allocations),
                                             state["repayments"], names, sales_only=True),
                                "1100", paid_on, amount, party_key=customer_key)


def outgoing_postings(state):
    staff = {row["id"]: row["name"] for row in state["staff"]}
    bills = {row["id"]: row for row in state["bills"]}
    for row in bills.values():
        debit = "3000" if row["kind"] == "opening" else "9020"
        yield from record_postings(row, "bill", row["bill_date"], "Opening payable" if row["kind"] == "opening" else "Bill",
                                   [journal_line(debit, row["amount"]), journal_line("2000", -row["amount"], party=row["payee"], key=row["payee_key"])],
                                   void=outgoing_void(row))
    for row in state["salaries"]:
        label = f"Salary #{row['id']} · {row['period']}"
        yield from record_postings(row, "salary", salary_date(row), "Salary accrued · " + staff[row["staff_id"]],
                                   [journal_line("5200", row["amount"]), journal_line("2010", -row["amount"])],
                                   void=outgoing_void(row), reference=label)
        # Recovery was elected when payroll was prepared, even for a past salary month.
        applied = row["advance_applied"]
        yield from record_postings(row, "salary-recovery", row["created_at"][:10], "Advance applied · " + staff[row["staff_id"]],
                                   [journal_line("2010", applied), journal_line("1130", -applied)],
                                   void=outgoing_void(row), reference=label)
    for row in state["entries"]:
        amount = row["amount"]
        paid_from = PAYMENT_ACCOUNTS[row["method"]]
        kind = row["kind"]
        if kind == "bill":
            bill = bills[row["bill_id"]]
            title = "Bill payment"
            lines = [journal_line("2000", amount, party=bill["payee"], key=bill["payee_key"]), journal_line(paid_from, -amount)]
        elif kind == "salary":
            title = "Salary payment · " + staff[row["staff_id"]]
            lines = [journal_line("2010", amount), journal_line(paid_from, -amount)]
        else:
            is_advance = kind == "advance"
            title = ("Staff advance · " if is_advance else "Staff advance returned · ") + staff[row["staff_id"]]
            amount = amount if is_advance else -amount
            lines = [journal_line("1130", amount), journal_line(paid_from, -amount)]
        yield from record_postings(row, "outgoing-payment", row["paid_on"], title, lines, void=outgoing_void(row))


def salary_date(row):
    year, month = map(int, row["period"].split("-"))
    return min(row["created_at"][:10], f"{row['period']}-{monthrange(year, month)[1]:02d}")


def outgoing_void(row):
    return {"created_at": row["voided_at"], "reason": row["void_reason"],
            "actor": row["void_actor"]} if row["voided_at"] else None


def postings(incoming, outgoing, sources):
    shifts, revisions, allocations, journals = sources
    names = {row["customer_key"]: row["name"] for row in incoming["customers"]}
    yield from fuel_postings(shifts, revisions, allocations, incoming["repayments"], names)
    due = {row["id"]: row for row in incoming["market_receivables"]}
    for row in due.values():
        yield from record_postings(row, "receivable", row["recorded_on"], "Opening receivable" if row["kind"] == "opening" else "Receivable",
                                   [journal_line("1110", row["amount"], party=row["party"], key=row["party_key"]),
                                    journal_line(RECEIVABLE_OFFSETS[row["kind"]], -row["amount"])], void=row["void"])
    for row in incoming["market_receipts"]:
        item = due[row["receivable_id"]]
        yield from record_postings(row, "receivable-payment", row["paid_on"], "Receivable payment",
                                   [journal_line(PAYMENT_ACCOUNTS[row["method"]], row["amount"]),
                                    journal_line("1110", -row["amount"], party=item["party"], key=item["party_key"])], void=row["void"])
    for row in incoming["bank_records"]:
        yield from record_postings(row, "bank", row["bank_date"], "Cash deposit" if row["method"] == "cash" else "Bank settlement",
                                   [journal_line("1010", row["amount"]), journal_line("5300", row["fees"]),
                                    journal_line(PAYMENT_ACCOUNTS[row["method"]], -row["amount"] - row["fees"])], void=row["void"])
    yield from outgoing_postings(outgoing)
    for row in journals:
        yield posting(row["posting_date"], row["created_at"], "journal", row["id"], row["reference"],
                      row["description"], json.loads(row["lines_json"]), actor=row["actor"],
                      reversal=bool(row["reversal_of"]), reversal_of=row["reversal_of"])


def posting_order(entry):
    if entry["source"] == "shift":
        return 0
    payment = entry["source"] in ("repayment", "receivable-payment", "outgoing-payment", "bank", "salary-recovery")
    if entry.get("reversal"):
        return 3 if payment else 4
    return 2 if payment else 1


def ledger_report(incoming, outgoing, sources, as_of):
    account_totals = defaultdict(int)
    entries = [entry for entry in postings(incoming, outgoing, sources) if entry["date"] <= as_of]
    entries.sort(key=lambda entry: (entry["date"], entry["recorded_at"], posting_order(entry)))
    for entry in entries:
        for line in entry["lines"]:
            account_totals[line["account"]] += line["amount"]
    trial = [dict(code=code, name=name, category=category, debit=max(0, account_totals[code]),
                  credit=max(0, -account_totals[code])) for code, (name, category) in ACCOUNTS.items()]
    debit, credit = (sum(row[side] for row in trial) for side in ("debit", "credit"))
    return {"as_of": as_of, "entries": entries, "trial": trial, "total_debit": debit, "total_credit": credit,
            "accounts": [dict(code=code, name=name, category=group, manual=code not in AUTO_CONTROLS)
                         for code, (name, group) in ACCOUNTS.items()],
            "unassigned": account_totals["1120"]}


def journal_route(db, user, route, body, *, now, fail, business_date, number, required_note):
    sid = user["station_id"]
    stamp = now()
    if route == "/ledger/journals":
        day = business_date(body.get("date"), "the posting date")
        if day > stamp[:10]:
            fail("A journal entry cannot be posted in the future.")
        reference = required_note(body.get("reference"), "a journal reference")
        description = required_note(body.get("description"), "a journal description", 500)
        items = body.get("lines")
        if not isinstance(items, list) or not 2 <= len(items) <= 20:
            fail("Enter between 2 and 20 journal lines.")
        lines = []
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("account"), str):
                fail("Choose an account for each line.")
            code = item["account"]
            if code not in ACCOUNTS or code in AUTO_CONTROLS:
                fail("Choose an account available for manual posting.")
            debit, credit = (number(item.get(side), 2, side, optional=True) or 0 for side in ("debit", "credit"))
            if bool(debit) == bool(credit):
                fail("Enter a debit or a credit on each line.")
            lines.append(journal_line(code, debit - credit))
        if sum(line["amount"] for line in lines):
            fail("Total debits must equal total credits.")
        if len({line["account"] for line in lines}) < 2:
            fail("Choose at least two different accounts.")
        try:
            with transaction(db, immediate=True):
                db.execute("""INSERT INTO financial_journals
                    (station_id, posting_date, reference, reference_key, description, lines_json, user_id, created_at)
                    VALUES (?,?,?,?,?,?,?,?)""",
                           (sid, day, reference, reference.casefold(), description, json.dumps(lines), user["id"], stamp))
        except sqlite3.IntegrityError:
            fail("This journal reference has already been posted.", 409)
    else:
        original_id = body.get("id")
        if type(original_id) is not int or not 0 < original_id < 10**18:
            fail("Choose a valid journal entry.")
        reason = required_note(body.get("reason"), "the reversal reason", 350)
        try:
            with transaction(db, immediate=True):
                row = db.execute("""SELECT * FROM financial_journals WHERE station_id=? AND id=?
                    AND reversal_of IS NULL""", (sid, original_id)).fetchone()
                if not row:
                    fail("Journal entry not found.", 404)
                lines = [{**line, "amount": -line["amount"]} for line in json.loads(row["lines_json"])]
                db.execute("""INSERT INTO financial_journals
                    (station_id, posting_date, reference, description, lines_json, user_id, created_at, reversal_of)
                    VALUES (?,?,?,?,?,?,?,?)""", (sid, max(row["posting_date"], stamp[:10]), row["reference"],
                                                  "Reversal · " + reason, json.dumps(lines), user["id"], stamp, original_id))
        except sqlite3.IntegrityError:
            fail("This journal entry has already been reversed.", 409)
    return {"ok": True}
