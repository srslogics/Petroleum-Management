"""Payroll and supplier balances through the authenticated API."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from app import create_app
from database import open_db
from test_workflow import Browser


class OutgoingsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'db.sqlite3'
        self.app = create_app(self.path, env={})
        self.browser = Browser(self.app)
        clock = patch('app.now', return_value='2026-11-23T12:00:00+05:30')
        clock.start()
        self.addCleanup(clock.stop)
        self.call('/login', dict(email='owner@demo.local', password='OwnerDemo123!'))

    def call(self, route, body=None, status=200):
        actual, data = self.browser.request('/api/owner'+route, body)
        self.assertEqual(actual, status, data)
        return data

    def staff(self, **values):
        self.call('/payroll/staff', dict(code='S1', name='Staff One', job_title='Attendant', phone='', monthly_salary='15000') | values)
        return self.call('/payroll')['staff'][0]

    def salary(self, **values):
        self.call('/payroll/salaries', dict(staff_id=1, period='2026-11', amount='15000', advance_applied='0', due_date='2026-11-30') | values)
        return self.call('/payroll')['salaries'][0]

    def bill(self, **values):
        self.call('/payables/bills', dict(kind='supplier',payee='Fuel Co',reference='INV-1',amount='1000',bill_date='2026-11-01',due_date='2026-11-20',note='Fuel invoice') | values)
        return self.call('/payables')['bills'][0]

    def pay(self, kind, source, amount, ref, status=200):
        return self.call('/outgoings/payments',dict(kind=kind,source_id=source,amount=amount,reference=ref,paid_on='2026-11-23',method='bank'),status)

    def void(self, kind, ident, status=200):
        self.call(f'/outgoings/{kind}/{ident}/void',{'reason':'Correction'},status)

    def test_salary_advances_partial_payment_and_reversal(self):
        before=self.call('/daily-report')
        self.staff()
        self.pay('advance',1,'5000','ADV-1')
        self.pay('advance_return',1,'1000','RETURN-1')
        self.salary(advance_applied='3000')
        state=self.call('/payroll')
        self.assertEqual(state['staff'][0]['advance_balance'],100000)
        self.assertEqual(state['salaries'][0]['balance'],1200000)
        self.pay('salary',1,'7000','SAL-1')
        self.pay('salary',1,'5001','OVER',409)
        self.pay('salary',1,'5000','SAL-2')
        self.assertEqual(self.call('/payroll')['salaries'][0]['balance'],0)
        self.void('salary',1,409)
        self.void('entry',1,409)  # advance already used
        self.void('entry',4)
        self.void('entry',3)
        self.void('salary',1)
        self.assertEqual(self.call('/payroll')['staff'][0]['advance_balance'],400000)
        self.void('entry',1,409)  # return still depends on the advance
        self.void('entry',2)
        self.void('entry',1)
        self.assertEqual(self.call('/payroll')['staff'][0]['advance_balance'],0)
        self.salary(amount='9000',advance_applied='0')  # voided month may be replaced
        self.assertEqual(self.call('/daily-report'),before)
        restarted=Browser(create_app(self.path,env={}))
        restarted.cookies=self.browser.cookies.copy()
        self.assertEqual(restarted.request('/api/owner/payroll')[1]['salaries'][0]['balance'],900000)

    def test_bill_partial_payments_duplicates_and_voids(self):
        self.bill()
        self.assertTrue(self.call('/payables')['bills'][0]['overdue'])
        self.call('/payables/bills',dict(kind='supplier',payee='FUEL CO',reference='inv-1',amount='1',bill_date='2026-11-01',due_date='2026-11-20',note='Duplicate'),409)
        self.bill(payee='Electricity',kind='other')
        self.pay('bill',1,'300','PAY-1')
        self.pay('bill',1,'701','OVER',409)
        self.pay('bill',1,'700','PAY-2')
        self.assertEqual(next(b for b in self.call('/payables')['bills'] if b['id']==1)['balance'],0)
        self.void('bill',1,409)
        self.void('entry',1)
        self.void('entry',2)
        self.void('bill',1)
        self.bill()
        self.assertEqual(len(self.call('/payables')['bills']),3)
        self.pay('bill',3,'1','pay-1',409)  # references remain reserved after voiding

    def test_staff_defaults_inactive_and_validation(self):
        staff=self.staff()
        self.salary()
        self.call('/payroll/staff',dict(id=1,code='S1',name='New Name',monthly_salary='20000',active=False))
        self.assertEqual(self.call('/payroll')['salaries'][0]['amount'],1500000)
        self.pay('advance',1,'1','NO',409)
        self.call('/payroll/salaries',dict(staff_id=1,period='2026-10',amount='100',advance_applied=0,due_date='2026-11-23'),409)
        self.pay('salary',1,'100','OLD-DUE') # inactive staff can still be paid
        for amount in ['-1','NaN','1.001',True]:
            self.call('/outgoings/payments',dict(kind='salary',source_id=1,amount=amount,reference='BAD',paid_on='2026-11-23',method='bank'),400)
        self.call('/outgoings/payments',dict(kind='salary',source_id=1,amount=1,reference='FUTURE',paid_on='2026-11-24',method='bank'),400)
        self.call('/outgoings/payments',dict(kind='salary',source_id=True,amount=1,reference='BOOL',paid_on='2026-11-23',method='bank'),400)
        self.call('/payroll/staff',dict(code='s1',name='Duplicate',monthly_salary=0),409)
        self.assertEqual(staff['monthly_salary'],1500000)

    def test_recovery_limit_month_duplicates_and_cross_ledger_references(self):
        self.staff()
        self.pay('advance',1,'100','COMMON')
        self.pay('advance_return',1,'101','OVER',409)
        self.call('/payroll/salaries',dict(staff_id=1,period='2026-11',amount=100,advance_applied=101,due_date='2026-11-23'),409)
        self.salary(amount=100,advance_applied=100)
        self.assertEqual(self.call('/payroll')['salaries'][0]['balance'],0)
        self.call('/payroll/salaries',dict(staff_id=1,period='2026-11',amount=100,advance_applied=0,due_date='2026-11-23'),409)
        self.bill()
        self.pay('bill',1,'100','common',409)
        for period in ['2026-13','2026-1','2026-12','not-a-month']:
            self.call('/payroll/salaries',dict(staff_id=1,period=period,amount=100,advance_applied=0,due_date='2026-11-23'),400)

    def test_concurrent_payments_cannot_overpay(self):
        self.bill()
        def payment(ref):
            browser=Browser(self.app);browser.cookies=self.browser.cookies.copy()
            return browser.request('/api/owner/outgoings/payments',dict(kind='bill',source_id=1,amount=700,reference=ref,paid_on='2026-11-23',method='cash'))[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(payment,['RACE-1','RACE-2'])),[200,409])
        self.assertEqual(self.call('/payables')['bills'][0]['balance'],30000)

    def test_existing_database_upgrade_and_invalid_bills(self):
        before=self.call('/settings')
        db=open_db(self.path)
        for table in ('outgoing_entries','payable_bills','payroll_salaries','payroll_staff'):
            db.execute('DROP TABLE '+table)
        db.commit()
        db.close()
        restarted=Browser(create_app(self.path,env={}))
        restarted.cookies=self.browser.cookies.copy()
        self.browser=restarted
        self.assertEqual(self.call('/settings'),before)
        self.assertEqual(self.call('/payroll')['staff'],[])
        valid=dict(kind='other',payee='Rent',reference='R1',amount=500,bill_date='2026-11-01',due_date='2026-11-30',note='November rent')
        for change in [dict(kind='staff'),dict(amount=0),dict(bill_date='2026-11-24'),dict(due_date='2026-10-31'),dict(due_date='2026-02-30'),dict(payee=''),dict(reference=''),dict(note='')]:
            self.call('/payables/bills',valid|change,400)
        self.call('/payables/bills',valid)
        self.call('/outgoings/payments',dict(kind='bill',source_id=1,amount=100,method='cash',paid_on='2026-10-31',reference='EARLY'),400)
        self.call('/outgoings/bill/1/void',dict(reason=''),400)
        self.void('bill',1)
        self.pay('bill',1,100,'VOID-BILL',409)
        self.void('bill',1,409)

    def test_station_scope_and_role_permissions(self):
        self.staff();self.salary();self.bill();self.pay('advance',1,'100','ADV')
        db=open_db(self.path)
        db.execute("INSERT INTO stations VALUES (2,'Other','OTHER')")
        db.execute('UPDATE users SET station_id=2 WHERE role=\'owner\'')
        db.commit()
        db.close()
        self.assertEqual(self.call('/payroll')['staff'],[])
        self.assertEqual(self.call('/payables')['bills'],[])
        self.pay('salary',1,1,'CROSS',404)
        self.pay('bill',1,1,'CROSS',404)
        self.pay('advance_return',1,1,'CROSS',404)
        for kind in ('salary','bill','entry'):
            self.void(kind,1,404)
        self.call('/payroll/staff',dict(id=1,code='S1',name='Cross',monthly_salary=0,active=True),404)
        self.browser.request('/api/manager/login',dict(email='manager@demo.local',password='ManagerDemo123!'))
        for route in ['/payroll','/payables']:
            self.assertEqual(self.browser.request('/api/manager'+route)[0],404)
            self.assertEqual(self.browser.request('/api/manager'+route+'/staff',{})[0],404)
            self.assertEqual(Browser(self.app).request('/api/owner'+route)[0],401)

if __name__=='__main__':
    unittest.main()
