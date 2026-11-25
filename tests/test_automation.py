"""Automation previews, approvals and imports never bypass ledger boundaries."""
import base64
import io
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from app import create_app, fail, number, note, business_state, daily_owner_report
from automation import Automation
from automation_runner import run_once
from database import open_db
from test_workflow import Browser


class AutomationTest(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        self.path=Path(folder.name)/'automation.sqlite3';self.app=create_app(self.path,env={});self.browser=Browser(self.app)
        self.clock=patch('app.now',return_value='2026-11-23T12:00:00+05:30');self.clock.start();self.addCleanup(self.clock.stop)
        self.call('/login',dict(email='owner@demo.local',password='OwnerDemo123!'))
        self.call('/login',dict(email='manager@demo.local',password='ManagerDemo123!'),role='manager')

    def call(self,path,data=None,status=200,role='owner',headers=None):
        code,body=self.browser.request('/api/'+role+path,data,headers=headers)
        self.assertEqual(code,status,body);return body

    def state(self):return self.call('/automation')
    def staff(self):self.call('/payroll/staff',dict(code='S1',name='Staff One',monthly_salary=15000))
    def rule(self,kind='salary',**extra):
        self.call('/automation/rules',dict(kind=kind,name='Monthly '+kind,start_month='2026-11',run_day=1,due_day=28,**extra))
    def shift(self):
        self.call('/shift',dict(openings={'1':100,'2':200}),role='manager')
    def submitted(self):
        self.shift();return self.call('/shifts/1/submit',dict(closings={'1':110,'2':210},collections={'upi':100,'card':200,'cash':50},counted=50),role='manager')

    def test_recurring_salary_is_reviewable_idempotent_and_atomic(self):
        self.staff();self.rule()
        before=self.call('/payroll');state=self.state()
        self.assertEqual(before['salaries'],[]);self.assertEqual(len(state['drafts']),1)
        draft=state['drafts'][0];self.assertEqual(draft['payload']['advance_applied'],'0')
        self.assertEqual(self.call('/automation/run',{})['created_drafts'],0)
        self.assertEqual(self.call('/payroll')['salaries'],[])
        self.call('/automation/drafts',dict(id=draft['id'],action='approve',values={'advance_applied':100}),409)
        self.assertEqual(self.state()['drafts'][0]['status'],'pending')
        self.call('/automation/drafts',dict(id=draft['id'],action='approve',values={'amount':'14000'}))
        self.call('/automation/drafts',dict(id=draft['id'],action='approve'),409)
        self.assertEqual(self.call('/payroll')['salaries'][0]['amount'],1400000)
        self.assertEqual(self.call('/payroll')['entries'],[])
        self.assertEqual(self.call('/automation/run',{})['created_drafts'],0)
        restarted=Browser(create_app(self.path,env={}));restarted.cookies=self.browser.cookies.copy()
        self.assertEqual(restarted.request('/api/owner/automation')[1]['drafts'][0]['status'],'applied')

    def test_bill_rules_pause_resume_and_dismissal(self):
        self.rule('bill',payee='Electricity',amount=2000,bill_kind='other',note='Monthly utility')
        state=self.state();rule=state['rules'][0];draft=state['drafts'][0]
        self.assertEqual(self.call('/payables')['bills'],[])
        self.call('/automation/drafts',dict(id=draft['id'],action='dismiss'))
        self.call('/automation/rules',dict(id=rule['id'],active=False))
        with patch('app.now',return_value='2026-12-23T12:00:00+05:30'):
            self.assertEqual(self.call('/automation/run',{})['created_drafts'],0)
            self.call('/automation/rules',dict(id=rule['id'],active=True))
            self.assertEqual(self.call('/automation/run',{})['created_drafts'],1)
            draft=self.state()['drafts'][0]
            self.call('/automation/drafts',dict(id=draft['id'],action='approve'))
            self.assertEqual(self.call('/payables')['bills'][0]['amount'],200000)
            self.assertEqual(self.call('/payables')['entries'],[])

    def test_calendar_end_catchup_and_salary_rules_do_not_duplicate(self):
        self.staff();self.rule();self.rule()
        self.assertEqual(len(self.state()['drafts']),1)
        self.rule('bill',payee='Rent',amount=1000,bill_kind='other',note='Rent')
        with closing(open_db(self.path)) as db,db:
            db.execute("UPDATE automation_rules SET start_month='2025-01',run_day=31,due_day=31 WHERE kind='bill'")
        with patch('app.now',return_value='2026-02-28T12:00:00+05:30'):
            state=self.state();bills=[r for r in state['drafts'] if r['kind']=='bill']
            self.assertEqual(len(bills),12)
            feb=next(r for r in bills if r['payload']['bill_date']=='2026-02-01')
            self.assertEqual(feb['payload']['due_date'],'2026-02-28')

    def test_import_mapping_duplicates_and_conflicting_rows(self):
        body=dict(kind='bank',date_format='dmy',csv='Txn Date,UTR,Deposit,Withdrawal,Narration\n23/11/2026,REF-1,"1,000.00",,Receipt\n23/11/2026,REF-2,,500.00,Bill\n',mapping={'date':'Txn Date','amount':'Deposit','debit':'Withdrawal','description':'Narration'})
        preview=self.call('/automation/imports/preview',body)
        self.assertEqual(preview['rows'][0]['data']['amount'],100000)
        self.assertEqual(preview['rows'][1]['data']['direction'],'debit')
        self.assertEqual(self.state()['imports'],[])
        self.assertEqual(self.call('/automation/imports',body)['created'],2)
        self.assertEqual(self.call('/automation/imports',body),dict(created=0,skipped=2))
        self.assertTrue(self.call('/automation/imports/preview',body)['rows'][0]['duplicate'])
        self.call('/automation/imports',body|{'csv':body['csv'].replace('1,000.00','1,001.00')},409)
        self.assertEqual(len(self.state()['imports']),2)
        self.call('/automation/imports',dict(kind='payments',rows=[dict(date='2026-11-23',reference='CREDIT',amount=10,method='credit')]),400,role='manager')
        self.call('/automation/imports',dict(kind='bank',rows=[{}]),403,role='manager')

    def test_bank_matching_partial_receipts_and_evidence_do_not_double_pay(self):
        self.submitted()
        before=self.call('/daily-report')
        rows=[dict(date='2026-11-23',reference='BANK-UPI',amount=49,fees=1,method='upi'),dict(date='2026-11-23',reference='BANK-DEBIT',amount=100,method='bank',direction='debit')]
        self.call('/automation/imports',dict(kind='bank',rows=rows));state=self.state();credit=next(r for r in state['imports'] if r['data']['reference']=='BANK-UPI')
        self.call('/automation/match',dict(id=credit['id'],source='shift:1',method='card'),400)
        self.call('/automation/match',dict(id=credit['id'],source='shift:1',method='upi'))
        self.call('/automation/match',dict(id=credit['id'],source='shift:1',method='upi'),409)
        remaining=next(s for s in self.call('/business')['settlements'] if s['method']=='upi')['remaining'];self.assertEqual(remaining,5000)
        self.call('/payables/bills',dict(kind='other',payee='Rent',reference='RENT',amount=100,bill_date='2026-11-01',due_date='2026-11-23',note='Rent'))
        self.call('/outgoings/payments',dict(kind='bill',source_id=1,amount=100,method='bank',paid_on='2026-11-23',reference='RENT-PAY'))
        debit=next(r for r in self.state()['imports'] if r['data']['direction']=='debit')
        self.call('/automation/match',dict(id=debit['id'],outgoing_id=1))
        self.assertEqual(len(self.call('/payables')['entries']),1)
        self.assertEqual(self.call('/daily-report'),before)

    def test_meter_and_payment_imports_fill_draft_without_submitting(self):
        self.shift()
        meters=dict(kind='meters',rows=[dict(date='2026-11-23',nozzle='P-01',reading=110),dict(date='2026-11-23',nozzle='D-01',reading=210)])
        payments=dict(kind='payments',rows=[dict(date='2026-11-23',reference='UTR-1',amount=100,method='upi',shift_id=1)])
        self.call('/automation/imports',meters,role='manager');self.call('/automation/imports',payments,role='manager')
        ids=[r['id'] for r in self.call('/automation',role='manager')['imports']]
        self.call('/automation/shift-inputs',dict(shift_id=1,row_ids=ids,version=1),409,role='manager')
        self.call('/automation/shift-inputs',dict(shift_id=1,row_ids=ids,version=0),role='manager')
        draft=self.call('/shifts/1/draft',role='manager')
        self.assertEqual(draft['data']['values']['closing_1'],'110.000')
        self.assertEqual(draft['data']['values']['upi'],'100.00')
        self.assertTrue(draft['data']['entries']['payments'][0]['reference'].startswith('IMPORT-'))
        self.assertIsNotNone(self.call('/shift',role='manager')['active'])
        self.assertEqual(self.call('/daily-report')['shifts'],[])
        self.call('/automation/shift-inputs',dict(shift_id=1,row_ids=ids,version=draft['version']),409,role='manager')

    def test_thousands_of_payments_become_method_totals_not_individual_entries(self):
        self.shift()
        rows=[dict(date='2026-11-23',reference='TXN-'+str(i),amount='1.25',method='upi' if i%2 else 'card') for i in range(1500)]
        self.call('/automation/imports',dict(kind='payments',rows=rows),role='manager')
        ids=[r['id'] for r in self.call('/automation',role='manager')['imports']]
        self.call('/automation/shift-inputs',dict(shift_id=1,row_ids=ids,version=0),role='manager')
        draft=self.call('/shifts/1/draft',role='manager')['data']
        self.assertEqual(len(draft['entries']['payments']),2)
        self.assertEqual(draft['values']['upi'],'937.50')
        self.assertEqual(draft['values']['card'],'937.50')
        self.assertTrue(all(r['status']=='applied' for r in self.call('/automation',role='manager')['imports']))

    def test_bad_meter_or_date_rolls_back_whole_apply(self):
        self.shift();self.call('/automation/imports',dict(kind='meters',rows=[dict(date='2026-11-23',nozzle='P-01',reading=110),dict(date='2026-11-23',nozzle='D-01',reading=100)]),role='manager')
        ids=[r['id'] for r in self.call('/automation',role='manager')['imports']]
        self.call('/automation/shift-inputs',dict(shift_id=1,row_ids=ids,version=0),400,role='manager')
        self.assertEqual(self.call('/shifts/1/draft',role='manager')['version'],0)
        self.assertTrue(all(r['status']=='pending' for r in self.call('/automation',role='manager')['imports']))
        self.call('/automation/shift-inputs',dict(shift_id=1,row_ids=[{}],version=0),400,role='manager')

    def test_feed_tokens_are_scoped_revocable_and_replays_are_idempotent(self):
        feed=self.call('/automation/feeds',dict(kind='payments',name='Gateway'))
        data=dict(rows=[dict(date='2026-11-23',reference='LIVE-1',amount=100,method='upi')])
        self.assertNotIn(feed['token'],json.dumps(self.state()))
        status,_=self.browser.request(feed['path'],data);self.assertEqual(status,401)
        headers={'HTTP_AUTHORIZATION':'Bearer '+feed['token']}
        status,result=self.browser.request(feed['path'],data,headers=headers);self.assertEqual(status,200,result);self.assertEqual(result['created'],1)
        self.assertEqual(self.browser.request(feed['path'],data,headers=headers)[1]['skipped'],1)
        self.call('/automation/feeds/disable',dict(id=feed['id']))
        self.assertEqual(self.browser.request(feed['path'],data,headers=headers)[0],401)
        self.assertEqual(len(self.state()['imports']),1)

    def test_documents_extract_only_suggestions_and_no_key_fails_clearly(self):
        text='Supplier: Fuel Co\nInvoice: INV-1\nDate: 2026-11-23\nDue date: 2026-11-30\nGrand total: ₹12,000.50\nQuantity: 100.500\nDiesel'
        result=self.call('/automation/documents',dict(kind='delivery',text=text),role='manager')
        self.assertEqual(result['fields']['amount'],'12000.50');self.assertEqual(result['fields']['reference'],'INV-1');self.assertEqual(result['fields']['fuel'],'Diesel')
        self.assertEqual(result['fields']['due_date'],'2026-11-30');self.assertEqual(self.call('/payables')['bills'],[])
        self.call('/automation/documents',dict(kind='bill',text=text),400,role='manager')
        data='data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\nfile').decode()
        self.call('/automation/documents',dict(kind='bill',file_data=data),503)

    def test_vision_contract_handles_refusals_bad_images_and_does_not_store_files(self):
        app=create_app(self.path,env={'OPENAI_API_KEY':'test-key'});self.browser=Browser(app)
        self.call('/login',dict(email='owner@demo.local',password='OwnerDemo123!'))
        extracted=dict(payee='Fuel Co',amount='100',reference='AI-1',date='2026-11-23',due_date='',quantity='',fuel='',description='Invoice')
        response=dict(status='completed',output=[dict(content=[dict(type='output_text',text=json.dumps(extracted))])])
        class Reply(io.BytesIO):
            def __enter__(self):return self
            def __exit__(self,*args):self.close()
        captured=[]
        def fake(request,timeout):
            payload=json.loads(request.data);captured.append(payload);self.assertFalse(payload['store']);self.assertEqual(timeout,45)
            self.assertEqual(request.get_header('Authorization'),'Bearer test-key')
            return Reply(json.dumps(response).encode())
        data='data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\nfile').decode()
        with patch('automation.urlopen',side_effect=fake):
            result=self.call('/automation/documents',dict(kind='bill',file_data=data));self.assertEqual(result['fields'],extracted)
        with closing(open_db(self.path)) as db:
            row=dict(db.execute('SELECT * FROM automation_documents').fetchone());self.assertNotIn('file_data',row);self.assertNotIn(data,json.dumps(row))
        self.call('/automation/documents',dict(kind='bill',file_data='data:image/png;base64,YmFk'),400)
        with patch('automation.urlopen',return_value=Reply(json.dumps(dict(status='incomplete',output=[])).encode())):
            self.call('/automation/documents',dict(kind='bill',file_data=data),502)
        self.assertEqual(captured[0]['text']['format']['type'],'json_schema')

    def test_forecasts_need_history_and_daily_summaries_refresh(self):
        self.assertIsNone(self.state()['forecasts'][0]['average_daily'])
        for index,day in enumerate(['2026-11-20','2026-11-21','2026-11-23'],1):
            with patch('app.now',return_value=day+'T12:00:00+05:30'):
                self.call('/shift',dict(openings={'1':100,'2':200}) if index==1 else {},role='manager')
                self.call(f'/shifts/{index}/submit',dict(closings={'1':100+index*10,'2':200+index*10},collections={'cash':1968},counted=1968),role='manager')
        forecast=self.state()['forecasts'][0];self.assertEqual(forecast['observed_days'],3);self.assertEqual(forecast['window_days'],4);self.assertEqual(forecast['average_daily'],7500)
        summary=self.call('/automation/summary?date=2026-11-23');self.assertEqual(summary['shifts'],1);self.assertEqual(summary['sales'],196800)
        self.call('/automation/summary?date=2026-11-24',status=400)
        self.assertEqual(self.call('/automation',role='manager').keys(),{'today','imports','ocr_available','columns'})

    def test_owner_records_and_imports_cannot_cross_stations(self):
        self.staff();self.rule();state=self.state();draft=state['drafts'][0]
        self.call('/automation/imports',dict(kind='bank',rows=[dict(date='2026-11-23',reference='REF',amount=10)]));import_id=self.state()['imports'][0]['id']
        self.call('/automation/run',{},404,role='manager');self.call('/automation/rules',{},404,role='manager')
        with closing(open_db(self.path)) as db,db:
            db.execute("INSERT INTO stations VALUES (2,'Other','OTHER')")
            db.execute("UPDATE users SET station_id=2 WHERE role='owner'")
        self.assertEqual(self.state()['imports'],[])
        self.call('/automation/drafts',dict(id=draft['id'],action='approve'),404)
        self.call('/automation/ignore',dict(id=import_id),404)
        self.assertEqual(Browser(self.app).request('/api/owner/automation')[0],401)

    def test_worker_is_idempotent_and_pending_approvals_survive_restart(self):
        self.staff();self.rule()
        with patch('automation_runner.now', return_value='2026-11-23T12:00:00+05:30'):
            self.assertEqual(run_once(self.path,{})[0]['created_drafts'],1)
            self.assertEqual(run_once(self.path,{})[0]['created_drafts'],0)
        self.assertEqual(len(self.state()['drafts']),1)
        with closing(open_db(self.path)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM automation_summaries').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM payroll_salaries').fetchone()[0],0)

    def test_concurrent_approvals_create_exactly_one_salary(self):
        self.staff();self.rule();draft=self.state()['drafts'][0]
        def approve(_):
            browser=Browser(self.app);browser.cookies=self.browser.cookies.copy()
            return browser.request('/api/owner/automation/drafts',dict(id=draft['id'],action='approve'))[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(approve,range(2))),[200,409])
        self.assertEqual(len(self.call('/payroll')['salaries']),1)

    def test_timestamps_follow_station_day_and_duplicate_documents_are_flagged(self):
        self.call('/automation/imports',dict(kind='meters',rows=[dict(date='2026-11-22T20:00:00Z',nozzle='P-01',reading=100)]),role='manager')
        row=self.call('/automation',role='manager')['imports'][0]
        self.assertEqual(row['data']['date'],'2026-11-23')
        self.call('/automation/imports',dict(kind='meters',rows=[dict(date='2026-11-23T01:30:00+05:30',nozzle='P-01',reading=100)]),role='manager')
        self.assertEqual(len(self.call('/automation',role='manager')['imports']),1)
        self.call('/automation/imports',dict(kind='meters',rows=[dict(date='2026-11-23T11:00:00',nozzle='P-01',reading=110)]),400,role='manager')
        text='Supplier: Fuel Co\nInvoice: I-1\nTotal: 100'
        self.assertFalse(self.call('/automation/documents',dict(kind='bill',text=text))['duplicate'])
        self.assertTrue(self.call('/automation/documents',dict(kind='bill',text=text))['duplicate'])

    def test_gunicorn_scheduler_starts_stops_and_can_be_disabled(self):
        import runpy
        import threading
        from types import SimpleNamespace
        from unittest.mock import Mock
        config=runpy.run_path(str(Path(__file__).resolve().parents[1]/'gunicorn.conf.py'))
        called=threading.Event();worker=SimpleNamespace(log=Mock())
        with patch.dict('os.environ',{'PETROLEUM_DB':str(self.path),'RENDER':'','PETROLEUM_HOSTED':'','TURSO_DATABASE_URL':'','TURSO_AUTH_TOKEN':'','AUTOMATION_BACKGROUND':'1'}),patch('automation_runner.run_once',side_effect=lambda database,env:called.set()):
            config['post_worker_init'](worker)
            self.assertTrue(called.wait(2))
            config['worker_exit'](None,worker)
            self.assertTrue(worker.station_automation_stop.is_set())
        disabled=SimpleNamespace(log=Mock())
        with patch.dict('os.environ',{'AUTOMATION_BACKGROUND':'0'}):config['post_worker_init'](disabled)
        self.assertFalse(hasattr(disabled,'station_automation_stop'))

    def test_photo_reading_limit_rejects_before_another_provider_call(self):
        self.browser=Browser(create_app(self.path,env={'OPENAI_API_KEY':'test-key'}))
        self.call('/login',dict(email='owner@demo.local',password='OwnerDemo123!'))
        fields=dict(payee='Fuel Co',amount='100',reference='I-1',date='',due_date='',quantity='',fuel='',description='Bill')
        data='data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\nfile').decode()
        with patch('automation.Automation.vision',return_value=fields) as provider:
            for _ in range(10):self.call('/automation/documents',dict(kind='bill',file_data=data))
            self.call('/automation/documents',dict(kind='bill',file_data=data),429)
            self.assertEqual(provider.call_count,10)

    def test_invalid_rows_and_rules_fail_without_writes(self):
        for body in [dict(kind='payments',rows=[]),dict(kind='bank',csv='date,reference,amount\n2026-11-23,R,-1'),dict(kind='meters',rows=[dict(date='2026-11-24',nozzle='P-01',reading=10)]),dict(kind='bank',date_format='bad',rows=[dict(date='23/11/2026',reference='R',amount=1)]),dict(kind='bank',csv='date,date\n2026-11-23,2026-11-23')]:
            self.call('/automation/imports',body,400)
        self.call('/automation/rules',dict(kind='salary',name='Bad',start_month='2026-13',run_day=1,due_day=28),400)
        self.call('/automation/rules',dict(kind='salary',name='Bad',start_month='2026-11',run_day=True,due_day=28),400)
        self.assertEqual(self.state()['imports'],[])
