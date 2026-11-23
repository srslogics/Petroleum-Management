"""Owner outgoing ledgers. Amounts are integer paise; corrections retain history."""
import re
from contextlib import nullcontext
import sqlite3
from datetime import date
from database import read_snapshot, transaction

OUTGOING_SCHEMA = """
CREATE TABLE IF NOT EXISTS payroll_staff (
 id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id), code TEXT NOT NULL,
 name TEXT NOT NULL, job_title TEXT NOT NULL, phone TEXT NOT NULL, monthly_salary INTEGER NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(station_id, code)
);
CREATE TABLE IF NOT EXISTS payroll_salaries (
 id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id), staff_id INTEGER NOT NULL REFERENCES payroll_staff(id),
 period TEXT NOT NULL, amount INTEGER NOT NULL, advance_applied INTEGER NOT NULL, due_date TEXT NOT NULL,
 note TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 voided_at TEXT, void_reason TEXT NOT NULL DEFAULT '', voided_by INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS salary_per_month ON payroll_salaries(station_id, staff_id, period) WHERE voided_at IS NULL;
CREATE TABLE IF NOT EXISTS payable_bills (
 id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id), kind TEXT NOT NULL,
 payee TEXT NOT NULL, payee_key TEXT NOT NULL, reference TEXT NOT NULL, reference_key TEXT NOT NULL,
 amount INTEGER NOT NULL, bill_date TEXT NOT NULL, due_date TEXT NOT NULL, note TEXT NOT NULL,
 user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 voided_at TEXT, void_reason TEXT NOT NULL DEFAULT '', voided_by INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_payable_bill ON payable_bills(station_id, payee_key, reference_key) WHERE voided_at IS NULL;
CREATE TABLE IF NOT EXISTS outgoing_entries (
 id INTEGER PRIMARY KEY, station_id INTEGER NOT NULL REFERENCES stations(id), kind TEXT NOT NULL,
 staff_id INTEGER REFERENCES payroll_staff(id), salary_id INTEGER REFERENCES payroll_salaries(id), bill_id INTEGER REFERENCES payable_bills(id),
 amount INTEGER NOT NULL, method TEXT NOT NULL, paid_on TEXT NOT NULL, reference TEXT NOT NULL, reference_key TEXT NOT NULL,
 note TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 voided_at TEXT, void_reason TEXT NOT NULL DEFAULT '', voided_by INTEGER REFERENCES users(id), UNIQUE(station_id, reference_key)
);
CREATE INDEX IF NOT EXISTS outgoing_station ON outgoing_entries(station_id, staff_id);
CREATE INDEX IF NOT EXISTS salary_station ON payroll_salaries(station_id, staff_id);
CREATE INDEX IF NOT EXISTS bill_station ON payable_bills(station_id, due_date);
"""


class Ledger:
    def __init__(self, db, user, now, fail, number, note):
        self.db, self.user, self.now, self.fail, self.number, self.note = db, user, now, fail, number, note
        self.sid = user['station_id']
        self.today = now()[:10]

    def text(self, body, key, required=True, limit=150):
        value = self.note(body.get(key, ''), key.replace('_', ' '), limit)
        if required and not value:
            self.fail('Enter ' + key.replace('_', ' ') + '.')
        return value

    def amount(self, body, key='amount', zero=False):
        value = self.number(body.get(key), 2, key.replace('_', ' '))
        if not zero and value <= 0:
            self.fail('Enter an amount greater than zero.')
        return value

    def day(self, body, key, past=False):
        value = body.get(key)
        try:
            parsed = date.fromisoformat(value)
            if parsed.isoformat() != value:
                raise ValueError()
        except (ValueError, TypeError):
            self.fail('Enter a valid ' + key.replace('_', ' ') + '.')
        if past and value > self.today:
            self.fail('Payment and bill dates cannot be in the future.')
        return value

    def state(self, writing=False):
        queries = [(f"SELECT {'id, name' if table == 'users' else '*'} FROM {table} WHERE station_id = ? ORDER BY id DESC", (self.sid,))
                   for table in ('payroll_staff', 'payroll_salaries', 'payable_bills', 'outgoing_entries', 'users')]
        rows = ([list(self.db.execute(sql, args)) for sql, args in queries] if writing
                else read_snapshot(self.db, queries))
        staff, salaries, bills, entries, users = [[dict(row) for row in group] for group in rows]
        names = {row['id']: row['name'] for row in users}
        for row in staff + salaries + bills + entries:
            row['actor'] = names.get(row['user_id'], 'Owner')
            row['void_actor'] = names.get(row.get('voided_by'), '')
        active = [row for row in entries if not row['voided_at']]
        for row in salaries + bills:
            key = 'salary_id' if 'staff_id' in row else 'bill_id'
            row['paid'] = sum(e['amount'] for e in active if e[key] == row['id'])
            row['net'] = row['amount'] - row.get('advance_applied', 0)
            row['balance'] = 0 if row['voided_at'] else row['net'] - row['paid']
            row['overdue'] = row['balance'] > 0 and row['due_date'] < self.today
        for row in staff:
            row['advance_balance'] = sum(e['amount'] * (1 if e['kind'] == 'advance' else -1)
                for e in active if e['staff_id'] == row['id'] and e['kind'] in ('advance', 'advance_return')) - sum(
                s['advance_applied'] for s in salaries if s['staff_id'] == row['id'] and not s['voided_at'])
        return dict(staff=staff, salaries=salaries, bills=bills, entries=entries, today=self.today)

    def find(self, state, group, value):
        if type(value) is not int or value <= 0:
            self.fail('Choose a valid record.')
        row = next((r for r in state[group] if r['id'] == value), None)
        if not row:
            self.fail('Record not found.', 404)
        return row

    def insert(self, table, values):
        values = dict(station_id=self.sid, **values, user_id=self.user['id'], created_at=self.now())
        self.db.execute(f"INSERT INTO {table} ({','.join(values)}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))

    def mutate(self, route, body, *, in_transaction=False):
        with nullcontext() if in_transaction else transaction(self.db, immediate=True):
            state = self.state(True)
            if route == '/payroll/staff':
                values = dict(code=self.text(body, 'code').upper(), name=self.text(body, 'name'),
                    job_title=self.text(body, 'job_title', False, 80), phone=self.text(body, 'phone', False, 24),
                    monthly_salary=self.amount(body, 'monthly_salary', True))
                if 'id' in body:
                    self.find(state, 'staff', body['id'])
                    if type(body.get('active')) is not bool:
                        self.fail('Choose an active staff status.')
                    values['active'] = int(body['active'])
                    self.db.execute(f"UPDATE payroll_staff SET {','.join(k+' = ?' for k in values)} WHERE id = ? AND station_id = ?",
                                    (*values.values(), body['id'], self.sid))
                else:
                    self.insert('payroll_staff', values)
            elif route == '/payroll/salaries':
                staff = self.find(state, 'staff', body.get('staff_id'))
                if not staff['active']:
                    self.fail('This staff member is inactive.', 409)
                period = self.text(body, 'period')
                if not re.fullmatch(r'20[0-9]{2}-(0[1-9]|1[0-2])', period) or period > self.today[:7]:
                    self.fail('Choose a valid salary month, up to the current month.')
                amount, applied = self.amount(body), self.amount(body, 'advance_applied', True)
                due = self.day(body, 'due_date')
                if due < period + '-01':
                    self.fail('The due date must be within or after the salary month.')
                if applied > min(amount, staff['advance_balance']):
                    self.fail('Advance recovery exceeds the salary or outstanding advances.', 409)
                self.insert('payroll_salaries', dict(staff_id=staff['id'], period=period, amount=amount,
                    advance_applied=applied, due_date=due, note=self.text(body, 'note', False, 500)))
            elif route == '/payables/bills':
                kind = body.get('kind')
                if kind not in ('supplier', 'other'):
                    self.fail('Choose supplier or other bill.')
                payee, reference = self.text(body, 'payee'), self.text(body, 'reference')
                bill_date, due = self.day(body, 'bill_date', True), self.day(body, 'due_date')
                if due < bill_date:
                    self.fail('The due date cannot be before the bill date.')
                self.insert('payable_bills', dict(kind=kind, payee=payee, payee_key=payee.casefold(),
                    reference=reference, reference_key=reference.casefold(), amount=self.amount(body),
                    bill_date=bill_date, due_date=due, note=self.text(body, 'note', True, 500)))
            elif route == '/outgoings/payments':
                kind = body.get('kind')
                if kind not in ('salary', 'bill', 'advance', 'advance_return'):
                    self.fail('Choose a valid payment type.')
                amount, paid_on = self.amount(body), self.day(body, 'paid_on', True)
                staff_id = salary_id = bill_id = None
                if kind in ('salary', 'bill'):
                    target = self.find(state, 'salaries' if kind == 'salary' else 'bills', body.get('source_id'))
                    if target['voided_at'] or amount > target['balance']:
                        self.fail('Payment exceeds the remaining balance.', 409)
                    if paid_on < (target['period'] + '-01' if kind == 'salary' else target['bill_date']):
                        self.fail('Payment date is before the salary month or bill date.')
                    if kind == 'salary':
                        salary_id, staff_id = target['id'], target['staff_id']
                    else:
                        bill_id = target['id']
                else:
                    target = self.find(state, 'staff', body.get('source_id'))
                    staff_id = target['id']
                    if kind == 'advance' and not target['active']:
                        self.fail('This staff member is inactive.', 409)
                    if kind == 'advance_return' and amount > target['advance_balance']:
                        self.fail('Return exceeds the outstanding advance.', 409)
                method = body.get('method')
                if method not in ('cash', 'bank'):
                    self.fail('Choose cash or bank.')
                reference = self.text(body, 'reference')
                self.insert('outgoing_entries', dict(kind=kind, staff_id=staff_id, salary_id=salary_id, bill_id=bill_id,
                    amount=amount, method=method, paid_on=paid_on, reference=reference,
                    reference_key=reference.casefold(), note=self.text(body, 'note', False, 500)))
            else:
                match = re.fullmatch(r'/outgoings/(salary|bill|entry)/([0-9]{1,18})/void', route)
                if not match:
                    self.fail('Not found.', 404)
                kind, ident = match[1], int(match[2])
                group, table = {'salary': ('salaries', 'payroll_salaries'), 'bill': ('bills', 'payable_bills'), 'entry': ('entries', 'outgoing_entries')}[kind]
                row = self.find(state, group, ident)
                if row['voided_at']:
                    self.fail('This record is already void.', 409)
                if kind != 'entry' and row['paid']:
                    self.fail('Void its payment entries first.', 409)
                if kind == 'entry':
                    staff = self.find(state, 'staff', row['staff_id']) if row['staff_id'] else None
                    if row['kind'] == 'advance' and staff['advance_balance'] < row['amount']:
                        self.fail('Reverse the advance returns or salary recovery first.', 409)
                reason = self.text(body, 'reason', True, 500)
                self.db.execute(f'UPDATE {table} SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ? AND station_id = ?',
                                (self.now(), reason, self.user['id'], ident, self.sid))
        return {'ok': True}


def outgoing_route(db, user, method, route, body, **helpers):
    if route not in ('/payroll', '/payables') and not route.startswith(('/payroll/', '/payables/', '/outgoings/')):
        return None
    ledger = Ledger(db, user, **helpers)
    if method == 'GET' and route in ('/payroll', '/payables'):
        return ledger.state()
    if method != 'POST':
        ledger.fail('Not found.', 404)
    try:
        return ledger.mutate(route, body)
    except sqlite3.IntegrityError:
        ledger.fail('This staff code, salary month, bill or payment reference already exists.', 409)
