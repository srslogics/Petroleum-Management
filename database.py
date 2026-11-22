"""SQLite for local development and libSQL for Turso Cloud."""
import sqlite3
import time
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
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
        return cls(url.rstrip("/"), token)

    def connect(self):
        import libsql

        try:
            connection = libsql.connect(database=self.url, auth_token=self.token, isolation_level=None)
        except (ValueError, libsql.Error):
            raise sqlite3.OperationalError("Turso connection failed.") from None
        return TursoConnection(connection)


@contextmanager
def turso_errors():
    # The official libsql driver exposes SQL failures as ValueError.
    import libsql

    try:
        yield
    except (ValueError, libsql.Error) as error:
        message = str(error).lower()
        if "unique constraint failed" in message:
            raise sqlite3.IntegrityError("A unique database constraint failed.") from None
        if "database is locked" in message or "sqlite_busy" in message or "transactionbusy" in message:
            busy = sqlite3.OperationalError("Turso database is busy.")
            busy.sqlite_errorcode = sqlite3.SQLITE_BUSY
            raise busy from None
        raise sqlite3.OperationalError("Turso request failed.") from None


class TursoConnection:
    def __init__(self, connection):
        self.connection = connection

    def execute(self, sql, params=()):
        with turso_errors():
            return TursoRows(self.connection.execute(sql, params))

    def close(self):
        self.connection.close()


class TursoRows:
    def __init__(self, cursor):
        self.cursor = cursor
        self.columns = [column[0] for column in cursor.description or ()]

    def fetchone(self):
        with turso_errors():
            row = self.cursor.fetchone()
        return dict(zip(self.columns, row)) if row is not None else None

    def __iter__(self):
        while (row := self.fetchone()) is not None:
            yield row


def open_db(database):
    if isinstance(database, TursoDatabase):
        db = database.connect()
    else:
        db = sqlite3.connect(database, timeout=10)
        db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys = ON")
    except BaseException:
        db.close()
        raise
    return db


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
