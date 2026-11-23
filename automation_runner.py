"""Run station automations from a host scheduler; never sends messages or transfers funds."""
import argparse
import os
from pathlib import Path
from contextlib import closing
from time import sleep

from app import ROOT, initialize, now, fail, number, note, business_state, daily_owner_report
from automation import Automation
from database import TursoDatabase, open_db


def run_once(database, env):
    results=[]
    with closing(open_db(database)) as db:
        users=[dict(r) for r in db.execute("SELECT MIN(id) AS id,station_id,role FROM users WHERE role='owner' GROUP BY station_id")]
        for user in users:
            result=Automation(db,user,now=now,fail=fail,number=number,note=note,business_state=business_state,daily_report=daily_owner_report,env=env).run()
            results.append(dict(station_id=user['station_id'],**result))
    return results


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',type=Path)
    parser.add_argument('--watch',action='store_true',help='Run continuously in a separate worker, rather than once.')
    parser.add_argument('--interval',type=int,default=300)
    args=parser.parse_args()
    if not 60<=args.interval<=86400:parser.error('Use an interval from 60 to 86400 seconds.')
    env=os.environ.copy();hosted=env.get('PETROLEUM_HOSTED')=='1' or env.get('RENDER')=='true'
    database=TursoDatabase.from_env(env,required=hosted) or args.db or Path(env.get('PETROLEUM_DB') or ROOT/'data'/'petroleum.sqlite3')
    initialize(database,isinstance(database,Path),env)
    while True:
        try:
            results=run_once(database,env)
            print('Automations prepared:',len(results),'stations;',sum(r['created_drafts'] for r in results),'new drafts.',flush=True)
        except Exception:
            # Do not print credentials, document text or bank rows in worker logs.
            if not args.watch:raise
            print('Automation run failed; will retry on the next interval.',flush=True)
        if not args.watch:break
        sleep(args.interval)


if __name__=='__main__':main()
