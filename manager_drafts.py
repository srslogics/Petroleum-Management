"""Incomplete manager entries, saved independently of locked shift reports."""
import json
import re
from database import transaction

DRAFT_SCHEMA = """
CREATE TABLE IF NOT EXISTS manager_shift_drafts (
 shift_id INTEGER PRIMARY KEY REFERENCES shifts(id), station_id INTEGER NOT NULL REFERENCES stations(id),
 version INTEGER NOT NULL, data_json TEXT NOT NULL, saved_by INTEGER NOT NULL REFERENCES users(id), saved_at TEXT NOT NULL
);
"""


def draft_route(db, user, method, route, body, *, fail, note, now):
    match = re.fullmatch(r'/shifts/([0-9]{1,18})/draft', route)
    if not match:
        return None
    shift_id, sid = int(match[1]), user['station_id']
    with transaction(db, immediate=method == 'POST'):
        shift = db.execute('SELECT * FROM shifts WHERE id = ? AND station_id = ?', (shift_id, sid)).fetchone()
        if not shift:
            fail('Shift not found.', 404)
        if shift['submitted_at']:
            fail('This shift is already submitted. Its draft cannot be changed.', 409)
        saved = db.execute('SELECT d.*, u.name AS actor FROM manager_shift_drafts d JOIN users u ON u.id = d.saved_by WHERE d.shift_id = ? AND d.station_id = ?', (shift_id, sid)).fetchone()
        if method == 'GET':
            return dict(version=saved['version'], data=json.loads(saved['data_json']), saved_at=saved['saved_at'], actor=saved['actor']) if saved else dict(version=0, data=None, saved_at=None, actor=None)
        if method != 'POST':
            fail('Page not found.', 404)
        version = body.get('version')
        if type(version) is not int or version < 0:
            fail('Reload the saved draft before saving.')
        if version != (saved['version'] if saved else 0):
            fail('Another manager or tab updated this draft. Load the saved draft before editing again.', 409)
        data = body.get('data')
        if not isinstance(data, dict) or set(data) != {'values', 'entries'}:
            fail('Enter valid draft entries.')
        values, entries = data['values'], data['entries']
        names = {'cash', 'upi', 'card', 'expenses', 'counted', 'expense_note', 'shift_note', 'delivery_Petrol', 'delivery_Diesel', 'physical_Petrol', 'physical_Diesel'}
        names.update('cash_count_' + str(value) for value in (500,200,100,50,20,10,5,2,1,'other'))
        names.update('closing_' + str(n['id']) for n in json.loads(shift['opening_json'])['nozzles'])
        if not isinstance(values, dict) or set(values) - names:
            fail('Unrecognised draft field.')
        clean_values = {key: note(value, key, 1000 if key == 'shift_note' else 250 if key == 'expense_note' else 40) for key, value in values.items()}
        if not isinstance(entries, dict) or set(entries) - {'payments','deliveries','expenses'}:
            fail('Enter valid draft entries.')
        clean_entries = {}
        for category in ('payments','deliveries','expenses'):
            rows = entries.get(category, [])
            if not isinstance(rows, list) or len(rows) > 100:
                fail('Enter up to 100 entries in each section.')
            allowed = {'method','amount','reference','note'} if category == 'payments' else {'fuel','quantity','party','reference','note'} if category == 'deliveries' else {'amount','party','reference','note'}
            clean_entries[category] = []
            for row in rows:
                if not isinstance(row, dict) or set(row) - allowed:
                    fail('Unrecognised draft entry field.')
                cleaned = {key: note(value, key, 150) for key, value in row.items()}
                if category == 'payments' and cleaned.get('method') not in ('cash','upi','card'):
                    fail('Managers record cash, UPI and card only. Credit is recorded by the owner.')
                if category == 'deliveries' and cleaned.get('fuel') not in ('Petrol','Diesel'):
                    fail('Choose Petrol or Diesel.')
                clean_entries[category].append(cleaned)
        saved_at = now()
        db.execute('''INSERT INTO manager_shift_drafts VALUES (?, ?, ?, ?, ?, ?)
                      ON CONFLICT(shift_id) DO UPDATE SET version=excluded.version, data_json=excluded.data_json,
                      saved_by=excluded.saved_by, saved_at=excluded.saved_at''',
                   (shift_id, sid, version+1, json.dumps(dict(values=clean_values,entries=clean_entries)), user['id'], saved_at))
        return dict(version=version+1, saved_at=saved_at, actor=user['name'])
