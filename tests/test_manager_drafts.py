"""Draft persistence, station isolation, conflicts and submission boundaries."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from app import create_app
from database import open_db
from test_workflow import Browser


class ManagerDraftTest(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        self.path=Path(folder.name)/'draft.sqlite3'
        self.app=create_app(self.path,env={});self.browser=Browser(self.app)
        clock=patch('app.now',return_value='2026-11-23T12:00:00+05:30');clock.start();self.addCleanup(clock.stop)
        self.call('/login',dict(email='manager@demo.local',password='ManagerDemo123!'))
        self.browser.request('/api/owner/login',dict(email='owner@demo.local',password='OwnerDemo123!'))
        self.call('/shift',dict(openings={'1':100,'2':200}))
        self.data=dict(values={'closing_1':'110.123','closing_2':'','cash':'100','counted':'','cash_count_500':'2','shift_note':'Unfinished draft'},entries={'payments':[{'method':'upi','amount':'','reference':'UTR'}],'deliveries':[],'expenses':[]})

    def call(self,path,body=None,status=200):
        code,data=self.browser.request('/api/manager'+path,body)
        self.assertEqual(code,status,data);return data

    def test_incomplete_draft_persists_without_changing_reports(self):
        self.assertEqual(self.call('/shifts/1/draft')['version'],0)
        before=self.browser.request('/api/owner/daily-report')[1]
        self.call('/shifts/1/draft',dict(version=0,data=self.data))
        restarted=Browser(create_app(self.path,env={}));restarted.cookies=self.browser.cookies.copy()
        code,saved=restarted.request('/api/manager/shifts/1/draft')
        self.assertEqual(code,200);self.assertEqual(saved['data'],self.data)
        self.assertEqual(saved['version'],1);self.assertEqual(saved['actor'],'Asha Patil')
        self.assertEqual(self.browser.request('/api/owner/daily-report')[1],before)
        self.call('/shifts/1/submit',dict(closings={'1':110,'2':210},collections={'cash':100},counted=100,draft_version=1))
        self.call('/shifts/1/draft',status=409)
        self.call('/shifts/1/draft',dict(version=1,data=self.data),409)
        with closing(open_db(self.path)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM manager_shift_drafts').fetchone()[0],0)

    def test_stale_saves_and_submission_are_rejected(self):
        self.call('/shifts/1/draft',dict(version=0,data=self.data))
        self.call('/shifts/1/draft',dict(version=0,data=self.data),409)
        self.call('/shifts/1/submit',dict(closings={'1':110,'2':210},counted=0,collections={},draft_version=0),409)
        self.call('/shifts/1/submit',dict(closings={'1':110,'2':210},counted=0,collections={}),409)
        self.assertIsNotNone(self.call('/shift')['active'])
        self.assertEqual(self.call('/shifts/1/draft')['version'],1)

    def test_concurrent_saves_never_overwrite(self):
        def save(name):
            browser=Browser(self.app);browser.cookies=self.browser.cookies.copy()
            data={**self.data,'values':{**self.data['values'],'shift_note':name}}
            return browser.request('/api/manager/shifts/1/draft',dict(version=0,data=data))[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(save,['First','Second'])),[200,409])
        self.assertEqual(self.call('/shifts/1/draft')['version'],1)

    def test_draft_validation_and_credit_are_owner_only(self):
        for data in [None,[],{},dict(values={'not_a_field':'x'},entries={}),dict(values={},entries={'payments':[dict(method='credit',amount='10')]}),dict(values={},entries={'payments':[dict(method='cash',party='Customer',amount='10')]}),dict(values={},entries={'expenses':[dict(amount='1',note='x'*151)]}),dict(values={},entries={'deliveries':[dict(fuel='Gas',quantity='1')]}),dict(values={},entries={'expenses':[{}]*101})]:
            self.call('/shifts/1/draft',dict(version=0,data=data),400)
        for version in [True,-1,'0',None]:
            self.call('/shifts/1/draft',dict(version=version,data=self.data),400)
        closing=dict(closings={'1':110,'2':210},collections={'cash':100},counted=100)
        for change in [dict(collections={'credit':10}),dict(entries={'payments':[dict(method='credit',amount=10,party='Fleet')]}),dict(entries={'payments':[dict(method='cash',amount=10,party='Customer')]})]:
            self.call('/shifts/1/submit',closing|change,400)
        # Owner entry/correction workflows retain credit support.
        code,report=self.browser.request('/api/owner/shifts/1/submit',closing|dict(collections={'credit':100},counted=0))
        self.assertEqual(code,200,report);self.assertEqual(report['collections']['credit'],10000)

    def test_drafts_cannot_cross_station_or_owner_routes(self):
        self.call('/shifts/1/draft',dict(version=0,data=self.data))
        self.assertEqual(self.browser.request('/api/owner/shifts/1/draft')[0],404)
        self.assertEqual(self.browser.request('/api/owner/shifts/1/draft',dict(version=1,data=self.data))[0],404)
        self.assertEqual(Browser(self.app).request('/api/manager/shifts/1/draft')[0],401)
        with closing(open_db(self.path)) as db,db:
            db.execute("INSERT INTO stations VALUES (2,'Other','OTHER')")
            db.execute("UPDATE users SET station_id=2 WHERE role='manager'")
        self.call('/shifts/1/draft',status=404)
        self.call('/shifts/1/draft',dict(version=1,data=self.data),404)

    def test_full_detail_capacity_saves_over_normal_body_limit(self):
        data=dict(values={},entries={
            'payments':[dict(method='upi',amount='',reference='r'*150,note='n'*150)]*100,
            'deliveries':[dict(fuel='Petrol',quantity='',party='p'*150,reference='r'*150,note='n'*150)]*100,
            'expenses':[dict(amount='',party='p'*150,reference='r'*150,note='n'*150)]*100})
        self.call('/shifts/1/draft',dict(version=0,data=data))
        self.assertEqual(self.call('/shifts/1/draft')['data'],data)
