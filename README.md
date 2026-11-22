# Petroleum Management

Phase 1 serves two web apps from one Python backend and SQLite database. The repository started with a README, so the first version uses Python's standard library with plain HTML, CSS and JavaScript. It needs Python 3.10+ and an installed time zone database with `Asia/Kolkata`. There is no build step.

## Run locally

```sh
python3 app.py
```

The server listens on loopback. The first start creates `data/petroleum.sqlite3` with a fictional station, two accounts, two nozzles, starting stock and rates. Use `--port 8001` for a different port or `--db path/to/demo.sqlite3` to use a separate database.

| App | Email | Password |
| --- | --- | --- |
| [Station Manager App](http://127.0.0.1:8000/manager) | `manager@demo.local` | `ManagerDemo123!` |
| [Owner App](http://127.0.0.1:8000/owner) | `owner@demo.local` | `OwnerDemo123!` |

Each app has a **Fill demo sign-in** button. Keep both apps open in separate tabs to switch between roles. The owner can set starting stock before the first submission and add nozzles or change rates in **Settings**. A newly added nozzle needs a manual opening reading the first time it appears in a shift.

## Reconciliation assumptions

- A station can have one open shift at a time. Its business date is the calendar date on which it opened in Asia/Kolkata, including shifts submitted after midnight. The daily summary includes every submitted shift assigned to that date.
- Rates are captured when a shift opens. Sales are litres sold multiplied by the captured rate, rounded to the nearest paisa per fuel per shift. Daily sales add those stored values.
- Expected cash equals cash collections minus till expenses. Cash difference equals actual counted cash minus expected cash. The shift starts with zero opening cash float for this version.
- Collections include cash, UPI, card and credit. Enter credit sales in the credit category. Collections difference equals total recorded collections and credit minus metered sales. Differences are saved for review, including shortages and overages.
- Enter one delivery total and an optional physical closing reading for each fuel per shift. Calculated stock equals the starting balance plus submitted deliveries minus submitted metered sales. The latest physical reading is shown separately and does not adjust the calculated balance.
- Submitting locks a shift's figures. An owner's review is recorded separately and saved once with their name, the timestamp and an optional note. Only the shift opening and submitted report are persisted. Closing form inputs need to be re-entered if the page is refreshed before submission.

## Verify the workflow

```sh
python3 -m unittest discover -s tests -v
```

The tests use a temporary database and send HTTP requests to the real request handler through a local socket pair. They verify manual opening, two consecutive submissions, carry-forward, rate history, validation, duplicate protection, daily totals, stock, review and role and station access.
