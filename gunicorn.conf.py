"""Run lightweight draft preparation alongside the existing single web worker."""
import os
import threading


def post_worker_init(worker):
    # Gunicorn loads this configuration automatically from the repository root.
    # A separate DB connection per run avoids sharing request transactions.
    from pathlib import Path
    from app import ROOT
    from automation_runner import run_once
    from database import TursoDatabase

    env = os.environ.copy()
    if env.get('AUTOMATION_BACKGROUND', '1') != '1':
        return
    hosted = env.get('PETROLEUM_HOSTED') == '1' or env.get('RENDER') == 'true'
    database = TursoDatabase.from_env(env, required=hosted) or Path(env.get('PETROLEUM_DB') or ROOT/'data'/'petroleum.sqlite3')
    stop = threading.Event()
    worker.station_automation_stop = stop

    def prepare():
        while not stop.is_set():
            try:
                run_once(database, env)
            except Exception:
                # Keep bank details, documents and tokens out of scheduler logs.
                worker.log.warning('Station automation preparation failed; retrying in five minutes.')
            stop.wait(300)

    thread = threading.Thread(target=prepare, name='station-automation', daemon=True)
    thread.start()


def worker_exit(server, worker):
    stop = getattr(worker, 'station_automation_stop', None)
    if stop:
        stop.set()
