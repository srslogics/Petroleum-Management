"""Owner money, operations and access controls through the public WSGI API."""
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from app import create_app
from database import open_db
from test_workflow import Browser


class OwnerControlsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "owner.sqlite3"
        self.app = create_app(self.database, env={})
        self.browser = Browser(self.app)
        clock = patch("app.now", return_value="2026-11-22T10:00:00+05:30")
        self.now = clock.start()
        self.addCleanup(clock.stop)
        self.call('/api/owner/login', {'email':'owner@demo.local', 'password':'OwnerDemo123!'})
        self.call('/api/manager/login', {'email':'manager@demo.local', 'password':'ManagerDemo123!'})

    def call(self, route, data=None, status=200):
        actual, body = self.browser.request(route, data)
        self.assertEqual(actual, status, body)
        return body

    def state(self):
        return self.call('/api/owner/business')

    def submit(self, detailed=True):
        active = self.call('/api/manager/shift', {'openings':{'1':100, '2':200}})
        body = {'closings':{'1':110, '2':210}, 'collections':{'cash':'100','upi':'200','card':'300','credit':'400'},
                'counted':'90', 'expenses':'10', 'physical':{'Petrol':'7989'}, 'shift_note':'Check pump'}
        if detailed:
            body['entries'] = {'payments':[{'method':'credit','amount':'400','party':'Fleet A','reference':'INV-1'}]}
        result = self.call(f"/api/owner/shifts/{active['id']}/submit", body)
        body["expected_version"] = result["version"]
        return result, body

    def test_owner_credit_posts_on_close_without_exposing_customer_details(self):
        active = self.call('/api/manager/shift', {'openings': {'1': 100, '2': 200}})
        money_path = '/api/owner/business/money'
        entry = {'shift_id': active['id'], 'action': 'record', 'party': 'Fleet QA',
                 'amount': '400', 'reference': 'SALE-1'}
        self.call('/api/manager/shift-credit', entry, status=404)
        self.call('/api/owner/shift-credit', entry)
        self.call('/api/owner/shift-credit', entry | {'reference': 'sale-1'}, status=409)
        self.call('/api/owner/shift-credit', entry | {'reference': 'SALE-2', 'amount': 0}, status=400)
        pending, = self.call(money_path)['pending_credits']
        self.assertEqual(self.call(money_path)['customers'], [])
        self.assertNotIn('Fleet QA', str(self.call('/api/manager/shift')))
        change = f"/api/owner/shift-credit/{pending['id']}"
        self.call(change, entry | {'action': 'edit', 'amount': '468'})
        self.call('/api/owner/shift-credit', entry | {'reference': 'SALE-2'})
        extra = next(row for row in self.call(money_path)['pending_credits'] if row['reference'] == 'SALE-2')
        self.call(f"/api/owner/shift-credit/{extra['id']}", {'shift_id': active['id'], 'action': 'void'})

        body = {'closings': {'1': 110, '2': 210}, 'collections': {'cash': 1000, 'upi': 500}, 'counted': 1000}
        self.call('/api/owner/shifts/1/submit', body | {'collections': {'cash': 1000, 'credit': 468}}, status=409)
        receipt = self.call('/api/manager/shifts/1/submit', body)
        self.assertNotIn('Fleet QA', str(receipt))
        self.assertEqual(receipt['collections']['credit'], 0)
        self.call('/api/manager/shifts/1/submit', body, status=409)
        self.call(change, entry | {'action': 'edit'}, status=409)
        self.assertEqual(self.call(money_path)['pending_credits'], [])
        customer, = self.call(money_path)['customers']
        self.assertEqual(customer['balance'], 46800)
        self.assertEqual(len(customer['transactions']), 1)
        report = self.call('/api/owner/daily-report')
        self.assertEqual((report['sales'], report['receipts'], report['payments']['credit']), (196800, 150000, 46800))
        self.assertEqual(report['sales_difference'], 0)
        self.assertEqual(report['till']['cash_difference'], 0)
        active = self.call('/api/manager/shift', {'openings': {}})
        self.call('/api/owner/shift-credit', entry | {'reference': 'STALE'}, status=409)
        self.call('/api/owner/shift-credit', entry | {'reference': 'CURRENT', 'shift_id': active['id']})
        self.assertEqual(len(self.call(money_path)['pending_credits']), 1)

    def test_credit_repayments_allocation_and_restart(self):
        shift, body = self.submit()
        self.call('/api/owner/customers', {'name':'Fleet A','due_date':'2026-11-21'})
        self.assertTrue(self.state()['customers'][0]['overdue'])
        payment = {'customer_key':'fleet a','amount':'100','method':'cash','paid_on':'2026-11-22','reference':'RCPT-1'}
        self.call('/api/owner/repayments', payment)
        self.call('/api/owner/repayments', payment, status=409)
        self.call('/api/owner/repayments', payment | {'reference':'OVER','amount':'301'}, status=409)
        self.call('/api/owner/repayments', payment | {'reference':'FUTURE','paid_on':'2026-11-23'}, status=400)
        self.assertEqual(self.state()['customers'][0]['balance'], 30000)
        self.assertTrue(any(item['source'].startswith('repayment:') for item in self.state()['settlements']))
        before = self.call('/api/owner/daily-report')['sales']
        self.call('/api/owner/repayments', payment | {'reference':'RCPT-2','amount':'300','method':'bank'})
        self.assertEqual(self.state()['customers'][0]['balance'], 0)
        self.assertEqual(self.call('/api/owner/daily-report')['sales'], before)
        self.call('/api/owner/repayments', payment | {'reference':'RCPT-3','amount':'1'}, status=409)
        self.browser = Browser(create_app(self.database, env={}))
        self.call('/api/owner/login', {'email':'owner@demo.local','password':'OwnerDemo123!'})
        self.assertEqual(self.state()['customers'][0]['repaid'], 40000)
        self.call('/api/manager/login', {'email':'manager@demo.local','password':'ManagerDemo123!'})
        second, _ = self.submit(detailed=False)
        self.assertEqual(self.state()['unallocated_credit'], 40000)
        allocation = {'shift_id':second['id'],'name':'Fleet B','amount':'250','reference':'ALLOC-1'}
        self.call('/api/owner/credit-allocations', allocation)
        self.call('/api/owner/credit-allocations', allocation | {'amount':'1000'}, status=409)
        self.assertEqual(self.state()['unallocated_credit'], 15000)
        self.assertEqual(next(row for row in self.state()['customers'] if row['name'] == 'Fleet B')['balance'], 25000)

    def test_partial_settlements_fees_deposits_and_duplicates(self):
        shift, _ = self.submit()
        receipt = {'source':f"shift:{shift['id']}",'method':'card','amount':'195','fees':'5',
                   'bank_date':'2026-11-22','reference':'BANK-1'}
        self.call('/api/owner/bank-records', receipt)
        self.call('/api/owner/bank-records', receipt, status=409)
        state = self.state()
        card = next(row for row in state['settlements'] if row['method'] == 'card')
        self.assertEqual((card['expected'],card['banked'],card['fees'],card['remaining']), (30000,19500,500,10000))
        self.call('/api/owner/bank-records', receipt | {'reference':'OVER','amount':'100','fees':'1'}, status=409)
        self.call('/api/owner/bank-records', receipt | {'reference':'BANK-2','amount':'100','fees':'0'})
        self.call('/api/owner/bank-records', receipt | {'reference':'CASH','method':'cash','amount':'90','fees':'1'}, status=400)
        self.call('/api/owner/bank-records', receipt | {'reference':'CASH','method':'cash','amount':'90','fees':'0'})
        self.assertEqual(next(row for row in self.state()['settlements'] if row['method'] == 'cash')['remaining'], 0)
        self.assertEqual(self.call('/api/owner/daily-report')['payments']['card'], 30000)

    def test_money_voids_keep_history_and_restore_balances(self):
        self.submit()
        self.call('/api/owner/repayments', {'customer_key':'fleet a','amount':'100','method':'cash','paid_on':'2026-11-22','reference':'REPAY'})
        repayment = self.state()['repayments'][0]
        self.call('/api/owner/bank-records', {'source':f"repayment:{repayment['id']}",'method':'cash','amount':'100','bank_date':'2026-11-22','reference':'DEPOSIT'})
        self.call(f"/api/owner/money-records/repayment/{repayment['id']}/void", {'reason':'Mistaken receipt'}, status=409)
        bank = self.state()['bank_records'][0]
        self.call(f"/api/owner/money-records/bank/{bank['id']}/void", {'reason':'Deposit was allocated incorrectly'})
        self.assertTrue(self.state()['bank_records'][0]['void'])
        self.call(f"/api/owner/money-records/repayment/{repayment['id']}/void", {'reason':'Mistaken receipt'})
        self.call(f"/api/owner/money-records/repayment/{repayment['id']}/void", {'reason':'Again'}, status=409)
        self.assertEqual(self.state()['customers'][0]['balance'],40000)
        self.assertTrue(self.state()['repayments'][0]['void'])
        self.assertFalse(any(row['source'].startswith('repayment:') for row in self.state()['settlements']))

    def test_receivables_payments_deposits_and_voids(self):
        self.submit()
        report = self.call('/api/owner/daily-report')
        route = '/api/owner/receivables'
        due = {'kind': 'supplier', 'party': 'Fuel Supply', 'reference': 'REFUND-1',
               'amount': '5000', 'recorded_on': '2026-11-19', 'due_date': '2026-11-21'}
        self.call(route, due)
        self.call(route, due | {'party': 'fuel supply', 'reference': 'refund-1'}, status=409)
        self.call(route, due | {'reference': 'REFUND-2', 'due_date': '2026-11-18'}, status=400)
        item, = self.state()['market_receivables']
        self.assertTrue(item['overdue'])
        self.assertTrue(any(row['kind'] == 'Overdue receivable' for row in self.state()['exceptions']))
        self.assertEqual(self.call('/api/owner/dashboard')['business']['market_balance'], 500000)

        payment = {'receivable_id': item['id'], 'amount': '2000', 'method': 'cash',
                   'reference': 'CASH-REFUND', 'paid_on': '2026-11-22'}
        self.call(route + '/payments', payment)
        self.call(route + '/payments', payment, status=409)
        self.call(route + '/payments', payment | {'reference': 'TOO-MUCH', 'amount': '3000.01'}, status=409)
        self.call(route + '/payments', payment | {'reference': 'TOO-EARLY', 'paid_on': '2026-11-18'}, status=400)
        self.call('/api/owner/repayments', {'customer_key': 'fleet a', 'amount': '1', 'method': 'bank',
                  'reference': 'cash-refund', 'paid_on': payment['paid_on']}, status=409)
        self.assertEqual(self.state()['market_receivables'][0]['balance'], 300000)

        receipt, = self.state()['market_receipts']
        source = f"market-receipt:{receipt['id']}"
        banking = self.call('/api/owner/business/banking')
        cash = next(row for row in banking['settlements'] if row['source'] == source)
        self.assertEqual(cash['remaining'], 200000)
        self.call('/api/owner/bank-records', {'source': source, 'method': 'cash', 'amount': '2000',
                  'bank_date': '2026-11-22', 'reference': 'BANK-DEPOSIT-1'})
        self.call(route + '/payments', payment | {'reference': 'BANK-REFUND', 'method': 'bank', 'amount': '3000'})
        self.assertEqual(self.state()['market_receivables'][0]['balance'], 0)
        self.assertFalse(any(row['kind'] == 'Overdue receivable' for row in self.state()['exceptions']))

        bank, = self.state()['bank_records']
        reason = {'reason': 'Recorded in the wrong account'}
        void = '/api/owner/money-records/'
        self.call(f"{void}market-due/{item['id']}/void", reason, status=409)
        self.call(f"{void}market-receipt/{receipt['id']}/void", reason, status=409)
        self.call(f"{void}bank/{bank['id']}/void", reason)
        for entry in self.state()['market_receipts']:
            self.call(f"{void}market-receipt/{entry['id']}/void", reason)
        self.assertEqual(self.state()['market_receivables'][0]['balance'], 500000)
        self.call(f"{void}market-due/{item['id']}/void", reason)
        self.call(route, due | {'amount': '4500'})
        self.assertEqual([row['balance'] for row in self.state()['market_receivables']], [450000, 0])
        self.assertEqual(self.state()['market_receivables'][1]['void']['reason'], reason['reason'])
        self.assertEqual(self.call('/api/owner/daily-report'), report)

    def test_concurrent_receivable_payments_cannot_overpay(self):
        route = '/api/owner/receivables'
        self.call(route, {'kind': 'invoice', 'party': 'Tenant', 'reference': 'NOV-RENT',
                  'amount': '1000', 'recorded_on': '2026-11-22'})
        item, = self.state()['market_receivables']
        payment = {'receivable_id': item['id'], 'amount': '750', 'method': 'bank', 'paid_on': '2026-11-22'}

        def pay(reference):
            browser = Browser(self.app)
            browser.cookies = self.browser.cookies.copy()
            return browser.request(route + '/payments', payment | {'reference': reference})[0]

        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(pay, ['RENT-1', 'RENT-2'])), [200, 409])
        self.assertEqual(self.state()['market_receivables'][0]['balance'], 25000)

    def test_owner_contacts_persist_and_can_update_numbers(self):
        route = '/api/owner/contacts'
        contact = {'name': 'Fleet Supplies', 'phone': '90000 00001'}
        self.call(route, contact)
        self.call(route, {'name': ' fleet supplies ', 'phone': ''}, status=409)
        self.call(route, {'name': 'Invalid number', 'phone': '+91 invalid'}, status=400)
        item, = self.call(route)['contacts']
        self.assertEqual(item['phone'], '+919000000001')
        self.call(route, {'id': item['id'], 'phone': '+44 20 7946 0012'})
        self.browser = Browser(create_app(self.database, env={}))
        self.call('/api/owner/login', {'email': 'owner@demo.local', 'password': 'OwnerDemo123!'})
        saved, = self.call(route)['contacts']
        self.assertEqual(saved, item | {'phone': '+442079460012'})
        self.call(route, {'id': item['id'], 'phone': ''})
        self.assertEqual(self.call(route)['contacts'][0]['phone'], '')

    def test_upgrade_adds_control_tables_without_changing_existing_shifts(self):
        shift, _ = self.submit()
        tables = ['station_contacts','market_receipts','market_receivables','manager_controls','tanks','customers','credit_allocations','repayments','record_voids','bank_records',
                  'corrections','shift_revisions','exception_acknowledgements']
        with closing(open_db(self.database)) as db, db:
            for table in tables:
                db.execute(f'DROP TABLE {table}')
        self.browser = Browser(create_app(self.database, env={}))
        self.call('/api/owner/login', {'email':'owner@demo.local','password':'OwnerDemo123!'})
        self.assertEqual(self.call('/api/owner/shifts/1')['sales'],shift['sales'])
        self.assertEqual(self.state()['customers'][0]['balance'],40000)
        self.assertEqual(self.state()['tanks'],{})
        self.assertEqual(self.state()['market_receivables'], [])

    def test_concurrent_repayments_cannot_overpay(self):
        self.submit()
        payload = {'customer_key':'fleet a','amount':'300','method':'bank','paid_on':'2026-11-22'}
        def pay(reference):
            browser = Browser(self.app)
            browser.cookies = self.browser.cookies.copy()
            return browser.request('/api/owner/repayments', payload | {'reference':reference})[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(pay, ['ONE','TWO'])), [200,409])
        self.assertEqual(self.state()['customers'][0]['balance'], 10000)

    def test_open_shift_tanks_and_exception_acknowledgement(self):
        self.assertEqual(self.state()['tanks'], {})
        active = self.call('/api/manager/shift', {'openings':{'1':100,'2':200}})
        self.now.return_value = '2026-11-22T23:00:00+05:30'
        state = self.state()
        self.assertEqual(state['active']['opener'], 'Asha Patil')
        self.assertEqual(state['active']['hours'], 13)
        self.assertTrue(state['active']['overdue'])
        key = next(row['key'] for row in state['exceptions'] if row['kind'] == 'Overdue shift')
        self.call('/api/owner/exceptions/acknowledge', {'key':key,'note':'Called manager'})
        self.assertTrue(next(row for row in self.state()['exceptions'] if row['key'] == key)['acknowledgement'])
        self.call('/api/owner/tanks', {'fuel':'Petrol','capacity':'10000','low_level':'10000'}, status=400)
        self.call('/api/owner/tanks', {'fuel':'Petrol','capacity':'10000','low_level':'8000'})
        self.assertEqual(self.state()['tanks']['Petrol']['capacity'], 10000000)
        self.assertTrue(any(row['kind'] == 'Low stock' for row in self.state()['exceptions']))
        self.call('/api/owner/exceptions/acknowledge', {'key':'unknown','note':'No'}, status=409)

    def test_correction_requests_revision_audit_and_dependency_protection(self):
        shift, body = self.submit()
        route = f"/api/owner/shifts/{shift['id']}"
        self.call(route + '/review', {'note':'Initially checked'})
        self.call(route + '/corrections', {'reason':'Check the counted cash'})
        self.call(route + '/corrections', {'reason':'Duplicate'}, status=409)
        request = self.call('/api/manager/corrections')[0]
        self.call(f"/api/manager/corrections/{request['id']}/respond", {'response':'Counted cash should be 100'})
        self.call(f"/api/manager/corrections/{request['id']}/respond", {'response':'Duplicate'}, status=409)
        self.call(route + '/revise', body, status=400)
        updated = self.call(route + '/revise', body | {'counted':'100','correction_reason':'Manager confirmed recount'})
        self.assertEqual(updated['counted'],10000)
        self.assertIsNone(updated['review'])
        self.assertEqual(len(updated['revisions']),1)
        self.assertIn('Initially checked', updated['revisions'][0]['original_review'])
        self.assertIn('9000', updated['revisions'][0]['original_json'])
        self.assertEqual(updated['submitter'],shift['submitter'])
        self.call(route + '/revise', body | {'counted':'110','correction_reason':'Stale copy'}, status=409)
        self.call(f"/api/owner/corrections/{request['id']}/resolve", {'resolution':'Corrected cash after recount'})
        self.assertTrue(self.call('/api/manager/corrections')[0]['resolved_at'])
        self.assertFalse(any(row['kind']=='Correction request' for row in self.state()['exceptions']))
        self.call('/api/manager/shift', {'openings':{}})
        self.call(route + '/revise', body | {'correction_reason':'Too late'}, status=409)

    def test_manager_disable_reset_edit_and_session_revocation(self):
        manager = self.call('/api/owner/managers')[0]
        route = '/api/owner/managers/' + str(manager['id'])
        self.call(route, {'action':'disable'})
        self.call('/api/manager/shift', status=401)
        self.call('/api/manager/login', {'email':'manager@demo.local','password':'ManagerDemo123!'}, status=401)
        self.call(route, {'action':'enable'})
        self.call('/api/manager/login', {'email':'manager@demo.local','password':'ManagerDemo123!'})
        self.call(route, {'action':'reset_password','password':'ManagerFixture-Reset!'})
        self.call('/api/manager/shift', status=401)
        self.call('/api/manager/login', {'email':'manager@demo.local','password':'ManagerDemo123!'}, status=401)
        self.call('/api/manager/login', {'email':'manager@demo.local','password':'ManagerFixture-Reset!'})
        self.call(route, {'action':'edit','name':'Updated Manager','phone':'9000000002'})
        self.call('/api/manager/login', {'identifier':'9000000002','password':'ManagerFixture-Reset!'})
        self.call(route, {'action':'revoke_sessions'})
        self.call('/api/manager/shift', status=401)
        self.assertEqual(self.call('/api/owner/managers')[0]['name'],'Updated Manager')
        self.call('/api/owner/managers/2', {'action':'disable'}, status=404)  # owner cannot be disabled here

    def test_owner_routes_enforce_role_and_station_isolation(self):
        shift, body = self.submit()
        self.call('/api/manager/business', status=404)
        self.call('/api/manager/repayments', {}, status=404)
        self.call('/api/manager/receivables', {}, status=404)
        self.call('/api/manager/contacts', status=404)
        self.call('/api/owner/contacts', {'name': 'Station One Contact', 'phone': '9000000001'})
        contact, = self.call('/api/owner/contacts')['contacts']
        self.call('/api/manager/business/banking', status=404)
        self.call('/api/owner/receivables', {'kind': 'other', 'party': 'Station One Account',
                  'amount': '100', 'reference': 'ST-1', 'recorded_on': '2026-11-22'})
        receivable, = self.state()['market_receivables']
        self.call('/api/manager/shifts/1/revise', body, status=404)
        manager_id = self.call('/api/owner/managers')[0]['id']
        with closing(open_db(self.database)) as db, db:
            db.execute("INSERT INTO stations VALUES (2, 'Other', 'OTHER')")
            db.execute("UPDATE users SET station_id = 2 WHERE role = 'owner'")
        self.assertEqual(self.state()['customers'], [])
        self.assertEqual(self.state()['market_receivables'], [])
        self.assertEqual(self.call('/api/owner/contacts')['contacts'], [])
        self.call('/api/owner/contacts', {'id': contact['id'], 'phone': ''}, status=404)
        self.call('/api/owner/receivables/payments', {'receivable_id': receivable['id'], 'amount': '1',
                  'method': 'bank', 'reference': 'ST-2', 'paid_on': '2026-11-22'}, status=404)
        self.call(f"/api/owner/money-records/market-due/{receivable['id']}/void", {'reason': 'Other station'}, status=404)
        self.call('/api/owner/managers/' + str(manager_id), {'action':'disable'}, status=404)
        self.call('/api/owner/bank-records', {'source':'shift:1','method':'cash','amount':'1','bank_date':'2026-11-22','reference':'OTHER'}, status=404)
        self.call('/api/owner/shifts/1/corrections', {'reason':'Other station'}, status=404)
        self.call('/api/owner/shifts/1/revise', body | {'correction_reason':'Other station'}, status=404)


if __name__ == '__main__':
    unittest.main()
