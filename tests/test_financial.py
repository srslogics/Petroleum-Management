"""Financial postings and historical balances through the Owner API."""

from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from app import create_app
from database import open_db
from test_workflow import Browser


class FinancialLedgerTest(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "ledger.sqlite3"
        self.browser = Browser(create_app(self.path, env={}))
        clock = patch("app.now", return_value="2026-11-20T10:00:00+05:30")
        self.clock = clock.start()
        self.addCleanup(clock.stop)
        self.login()
        self.call("/login", {"email": "manager@demo.local", "password": "ManagerDemo123!"}, role="manager")

    def login(self):
        self.call("/login", {"email": "owner@demo.local", "password": "OwnerDemo123!"})

    def day(self, value):
        self.clock.return_value = value + "T10:00:00+05:30"

    def call(self, route, payload=None, status=200, role="owner"):
        actual, response = self.browser.request(f"/api/{role}" + route, payload)
        self.assertEqual(actual, status, response)
        return response

    def trial(self, day=None):
        report = self.call("/business/ledger" + ("?as_of=" + day if day else ""))["financial"]
        self.assertEqual(report["total_debit"], report["total_credit"])
        for entry in report["entries"]:
            self.assertEqual(sum(line["amount"] for line in entry["lines"]), 0, entry)
        return report, {row["code"]: row["debit"] - row["credit"] for row in report["trial"]}

    def shift(self, readings, collections, counted, *, entries=None, expenses=0):
        openings = {"1": 100, "2": 200} if readings == (110, 210) else {}
        active = self.call("/shift", {"openings": openings}, role="manager")
        payload = {"closings": dict(zip(("1", "2"), readings)), "collections": collections,
                   "counted": counted, "expenses": expenses, "entries": entries or {}}
        return active["id"], payload, self.call(f"/shifts/{active['id']}/submit", payload)

    def bill(self, kind="supplier", reference="BILL", amount=150):
        self.call("/payables/bills", {"kind": kind, "payee": "Fleet A", "reference": reference, "amount": amount,
                                     "bill_date": "2026-11-20", "due_date": "2026-11-30", "note": "Invoice"})
        return self.call("/payables")["bills"][0]["id"]

    def payment(self, kind, ident, amount, reference, day, method="bank"):
        self.call("/outgoings/payments", {"kind": kind, "source_id": ident, "amount": amount,
                                         "reference": reference, "paid_on": day, "method": method})

    def test_shifts_cash_deposits_fees_receivables_payables_and_payroll_reconcile(self):
        self.shift((110, 210), {"cash": 600, "upi": 500, "card": 400}, 580, expenses=30,
                   entries={"payments": [{"method": "credit", "amount": 468, "party": "Fleet A"}]})
        self.day("2026-11-21")
        deposit = {"source": "shift:1", "method": "cash", "amount": 200, "bank_date": "2026-11-21", "reference": "CASH"}
        self.call("/bank-records", deposit | {"bank_date": "2026-11-19"}, status=400)
        self.call("/bank-records", deposit)
        self.call("/bank-records", deposit | {"method": "upi", "amount": 490, "fees": 10, "reference": "UPI"})
        self.call("/repayments", {"customer_key": "fleet a", "method": "bank", "paid_on": "2026-11-21",
                                  "amount": 68, "reference": "CUSTOMER"})
        self.call("/receivables", {"kind": "invoice", "party": "Fleet A", "recorded_on": "2026-11-20",
                                   "amount": 80, "reference": "SERVICE"})
        self.call("/receivables/payments", {"receivable_id": 1, "method": "cash", "paid_on": "2026-11-21",
                                            "amount": 20, "reference": "RECEIPT"})
        self.call("/bank-records", deposit | {"source": "market-receipt:1", "amount": 20, "reference": "RC-DEPOSIT",
                                             "bank_date": "2026-11-20"}, status=400)
        self.call("/bank-records", deposit | {"source": "market-receipt:1", "amount": 20, "reference": "RC-DEPOSIT"})

        bill = self.bill()
        self.payment("bill", bill, 50, "SUPPLIER", "2026-11-21")
        self.bill("opening", "OPEN-PAYABLE", 25)
        self.call("/payroll/staff", {"name": "Station staff", "code": "S1", "monthly_salary": 500})
        self.payment("advance", 1, 100, "ADV", "2026-11-20", "cash")
        self.call("/payroll/salaries", {"staff_id": 1, "period": "2026-11", "amount": 500,
                                        "advance_applied": 70, "due_date": "2026-11-30"})
        self.payment("salary", 1, 200, "SAL", "2026-11-21")
        self.call("/outgoings/payments", {"kind": "advance_return", "source_id": 1, "amount": 15,
                                         "reference": "RETURN-EARLY", "paid_on": "2026-11-19", "method": "cash"}, status=409)
        self.payment("advance_return", 1, 15, "RETURN", "2026-11-21", "cash")

        _, balance = self.trial()
        expected_rupees = {
            "1000": 295, "1010": 528, "1020": 0, "1030": 400, "1100": 400, "1110": 60, "1130": 15,
            "2000": -125, "2010": -230, "3000": 25, "4000": -1968, "4100": -80,
            "5100": 30, "5200": 500, "5300": 10, "9000": 0, "9010": -10, "9020": 150,
        }
        self.assertEqual({code: balance[code] for code in expected_rupees},
                         {code: rupees * 100 for code, rupees in expected_rupees.items()})

    def test_backdated_receipt_respects_future_payments_and_reversals_have_own_date(self):
        self.shift((110, 210), {"credit": 100}, 0,
                   entries={"payments": [{"method": "credit", "amount": 100, "party": "Fleet A"}]})
        self.day("2026-11-21")
        receipt = {"customer_key": "fleet a", "paid_on": "2026-11-21", "method": "bank",
                   "reference": "RECEIPT", "amount": 100}
        self.call("/repayments", receipt | {"paid_on": "2026-11-19"}, status=409)
        self.call("/repayments", receipt)
        self.day("2026-11-22")
        self.shift((120, 220), {"credit": 150}, 0,
                   entries={"payments": [{"method": "credit", "amount": 150, "party": "Fleet A"}]})
        self.call("/repayments", receipt | {"paid_on": "2026-11-20", "reference": "OVER-TIME", "amount": 25}, status=409)
        self.day("2026-11-23")
        self.call("/money-records/repayment/1/void", {"reason": "Duplicate receipt"})
        old, old_balances = self.trial("2026-11-21")
        today, today_balances = self.trial()
        self.assertEqual((old_balances["1100"], old_balances["1010"]), (0, 10000))
        self.assertEqual((today_balances["1100"], today_balances["1010"]), (25000, 0))
        rows = [entry for entry in today["entries"] if entry["reference"] == "RECEIPT"]
        self.assertEqual([row["date"] for row in rows], ["2026-11-21", "2026-11-23"])
        self.assertEqual(rows[1]["reason"], "Duplicate receipt")
        self.assertFalse(any(entry.get("reversal") for entry in old["entries"]))

    def test_unassigned_credit_and_shift_revisions_do_not_restate_past_days(self):
        shift, body, report = self.shift((110, 210), {"credit": 100}, 0)
        self.day("2026-11-21")
        self.call(f"/shifts/{shift}/revise", body | {"collections": {"credit": 200}, "correction_reason": "Collection checked",
                                                    "expected_version": report["version"]})
        self.day("2026-11-22")
        self.call("/credit-allocations", {"shift_id": shift, "amount": 125, "name": "Fleet A", "reference": "ALLOC"})
        self.call("/repayments", {"customer_key": "fleet a", "amount": 25, "method": "cash",
                                  "paid_on": "2026-11-21", "reference": "EARLY"}, status=409)
        original, before = self.trial("2026-11-20")
        corrected, middle = self.trial("2026-11-21")
        after, balances = self.trial()
        self.assertEqual([original["unassigned"], corrected["unassigned"], after["unassigned"]], [10000, 20000, 7500])
        self.assertEqual([before["1100"], middle["1100"], balances["1100"]], [0, 0, 12500])
        self.assertTrue(any(entry.get("reversal") and entry["source"] == "shift" for entry in corrected["entries"]))

    def test_manual_journal_validation_reversal_persistence_and_station_scope(self):
        self.call("/business/ledger?as_of=2026-11-21", status=400)
        self.call("/business/ledger?as_of=invalid", status=400)
        self.call("/business/ledger", status=404, role="manager")
        journal = {"date": "2026-11-20", "reference": "OPEN", "description": "Opening bank and stock",
                   "lines": [{"account": "1010", "debit": "123.45"}, {"account": "1200", "debit": 10},
                             {"account": "3000", "credit": "133.45"}]}
        self.call("/ledger/journals", journal | {"lines": journal["lines"][:-1]}, status=400)
        self.call("/ledger/journals", journal | {"lines": journal["lines"][:-1] + [{"account": "2000", "credit": "133.45"}]}, status=400)
        self.call("/ledger/journals", journal, status=404, role="manager")
        self.call("/ledger/journals", journal)
        self.call("/ledger/journals", journal | {"reference": "open"}, status=409)
        first, balances = self.trial()
        self.assertEqual((balances["1010"], balances["1200"], balances["3000"]), (12345, 1000, -13345))
        self.browser = Browser(create_app(self.path, env={}))
        self.login()
        self.day("2026-11-21")
        self.call("/ledger/journals/reverse", {"id": first["entries"][0]["source_id"], "reason": "Incorrect count"})
        self.call("/ledger/journals/reverse", {"id": 1, "reason": "Twice"}, status=409)
        self.assertEqual(self.trial("2026-11-20")[0]["total_debit"], 13345)
        self.assertEqual(self.trial()[0]["total_debit"], 0)
        with closing(open_db(self.path)) as db, db:
            db.execute("INSERT INTO stations VALUES (2,'Other station','OTHER')")
            db.execute("UPDATE users SET station_id=2 WHERE role='owner'")
        self.assertEqual(self.trial()[0]["entries"], [])
        self.call("/ledger/journals/reverse", {"id": 1, "reason": "Foreign record"}, status=404)
