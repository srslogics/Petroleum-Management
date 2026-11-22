"""SQLite locally and the Turso SQL-over-HTTP API on Render."""
import json
import sqlite3
import time
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
from http.client import HTTPException, HTTPSConnection
from urllib.parse import urlsplit


@dataclass(frozen=True)
class TursoDatabase:
    url: str
    token: str = field(repr=False)

    @classmethod
    def from_env(cls, env, required):
        url = env.get("TURSO_DATABASE_URL", "").strip()
        token = env.get("TURSO_AUTH_TOKEN", "").strip()
        if not (required or url or token):
            return None
        if not (url and token):
            raise RuntimeError("Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.")
        try:
            target = urlsplit(url)
            valid = (target.scheme in ("libsql", "https") and target.hostname
                     and target.username is None and target.port in (None, 443)
                     and target.path in ("", "/") and not (target.query or target.fragment))
        except ValueError:
            valid = False
        if not valid:
            raise RuntimeError("Set TURSO_DATABASE_URL to the database URL from Turso.")
        return cls("https://" + target.netloc, token)

    def connect(self):
        return TursoConnection(self.url, self.token)


def encode_arg(value):
    if value is None:
        return {"type": "null"}
    if isinstance(value, int):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, str):
        return {"type": "text", "value": value}
    raise TypeError("Unsupported SQL parameter type.")


def decode_value(cell):
    kind = cell["type"]
    if kind == "null":
        return None
    if kind == "integer":
        return int(cell["value"])
    if kind in ("float", "text"):
        return cell["value"]
    raise ValueError("Unsupported SQL result type.")


def execute_request(sql, params=(), want_rows=True):
    return {"type": "execute", "stmt": {
        "sql": sql, "args": [encode_arg(value) for value in params], "want_rows": want_rows,
    }}


def check_result(result):
    if result["type"] == "ok":
        return result["response"]
    code = result["error"].get("code") or ""
    if code.startswith("SQLITE_BUSY") or code in ("SQLITE_LOCKED", "TRANSACTION_BUSY"):
        error = sqlite3.OperationalError("Turso database is busy.")
        error.sqlite_errorcode = sqlite3.SQLITE_BUSY
        raise error
    if code == "SQLITE_CONSTRAINT_UNIQUE":
        raise sqlite3.IntegrityError("A unique database constraint failed.")
    raise sqlite3.OperationalError(f"Turso SQL request failed ({code or 'unknown error'}).")


class TursoConnection:
    def __init__(self, url, token):
        self.host = urlsplit(url).hostname
        self.connection = HTTPSConnection(self.host, timeout=4)
        self.token = token
        self.baton = None
        self.deadline = time.monotonic() + 18
        self.closed = False

    def pipeline(self, requests, *, closing=False, timeout_limit=4):
        remaining = self.deadline - time.monotonic()
        if self.closed or remaining <= 0:
            raise sqlite3.OperationalError("Turso request deadline expired.")
        timeout = min(timeout_limit, remaining)
        self.connection.timeout = timeout
        if self.connection.sock is not None:
            self.connection.sock.settimeout(timeout)
        body = json.dumps({"baton": self.baton, "requests": requests}).encode()
        try:
            self.connection.request("POST", "/v2/pipeline", body, {
                "Authorization": "Bearer " + self.token, "Content-Type": "application/json",
            })
            with self.connection.getresponse() as response:
                if response.status != 200:
                    raise sqlite3.OperationalError(f"Turso HTTP request failed ({response.status}).")
                payload = json.load(response)
            self.baton = payload["baton"]
            if alternate := payload.get("base_url"):
                target = urlsplit(alternate)
                if (target.scheme != "https" or not target.hostname
                        or target.username is not None or target.port not in (None, 443)
                        or target.path not in ("", "/") or target.query or target.fragment
                        or (target.hostname != self.host and not (
                            self.host.endswith(".turso.io") and target.hostname.endswith(".turso.io")
                        ))):
                    raise ValueError("Invalid Turso stream endpoint.")
                if target.hostname != self.connection.host:
                    self.connection.close()
                    self.connection = HTTPSConnection(target.hostname, timeout=timeout)
            results = payload["results"]
            if len(results) != len(requests) or (not closing and not self.baton):
                raise ValueError("Incomplete Turso stream response.")
            return results
        except (HTTPException, OSError, KeyError, TypeError, ValueError):
            self.closed = True
            self.connection.close()
            raise sqlite3.OperationalError("Turso connection failed or timed out.") from None
        except sqlite3.OperationalError:
            self.closed = True
            self.connection.close()
            raise

    def execute(self, sql, params=()):
        return self.execute_many(((sql, params),))[0]

    def execute_many(self, statements):
        requests = [execute_request(sql, params) for sql, params in statements]
        if not self.baton:
            requests.insert(0, execute_request("PRAGMA foreign_keys = ON", want_rows=False))
            first, *results = self.pipeline(requests)
            check_result(first)
        else:
            results = self.pipeline(requests)
        return [result_rows(result) for result in results]

    def snapshot(self, statements):
        # A read transaction gives all statements one view of the books. The
        # final rollback and close can run even if one of the reads fails.
        requests = [execute_request("BEGIN", want_rows=False)]
        requests.extend(execute_request(sql, params) for sql, params in statements)
        requests.extend((execute_request("ROLLBACK", want_rows=False), {"type": "close"}))
        begin, *results, rollback, closed = self.pipeline(requests, closing=True)
        for control in (begin, rollback, closed):
            check_result(control)
        return [list(result_rows(result)) for result in results]

    def close(self):
        try:
            if self.baton and not self.closed:
                with suppress(sqlite3.Error):
                    self.pipeline([{"type": "close"}], closing=True, timeout_limit=1)
        finally:
            self.closed = True
            self.connection.close()


def result_rows(result):
    try:
        block = check_result(result)["result"]
        columns = [column["name"] for column in block["cols"]]
        return TursoRows(dict(zip(columns, (decode_value(cell) for cell in row))) for row in block["rows"])
    except (KeyError, TypeError, ValueError):
        raise sqlite3.OperationalError("Invalid Turso SQL response.") from None


class TursoRows:
    def __init__(self, rows):
        self.rows = iter(rows)

    def fetchone(self):
        try:
            return next(self.rows, None)
        except (KeyError, TypeError, ValueError):
            raise sqlite3.OperationalError("Invalid Turso result row.") from None

    def __iter__(self):
        while (row := self.fetchone()) is not None:
            yield row


def open_db(database):
    if isinstance(database, TursoDatabase):
        return database.connect()
    db = sqlite3.connect(database, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys = ON")
    except BaseException:
        db.close()
        raise
    return db


def execute_many(db, statements):
    if isinstance(db, TursoConnection):
        return db.execute_many(statements)
    return [db.execute(sql, params) for sql, params in statements]


def read_snapshot(db, statements):
    if isinstance(db, TursoConnection):
        return db.snapshot(statements)
    with transaction(db):
        return [list(rows) for rows in execute_many(db, statements)]


@contextmanager
def transaction(db, *, immediate=False):
    statement = "BEGIN IMMEDIATE" if immediate else "BEGIN"
    for attempt in range(7):
        try:
            db.execute(statement)
            break
        except sqlite3.OperationalError as error:
            # Retry lock acquisition only. A failed commit can have an uncertain outcome.
            if getattr(error, "sqlite_errorcode", None) != sqlite3.SQLITE_BUSY or attempt == 6:
                raise
            time.sleep(0.025 * 2 ** attempt)
    try:
        yield
        db.execute("COMMIT")
    except BaseException:
        with suppress(sqlite3.Error):
            db.execute("ROLLBACK")
        raise
