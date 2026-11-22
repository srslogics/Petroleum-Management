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

## Deploy on Render

1. In the [Render Dashboard](https://dashboard.render.com/), choose **New → Blueprint**, connect `srslogics/Petroleum-Management`, and select `main`. The repository's `render.yaml` configures one Python web service in Singapore with Gunicorn, a health check at `/healthz`, and a 1 GB persistent disk at `/var/data`. The Starter service and disk are paid resources.
2. When prompted, set `PETROLEUM_OWNER_EMAIL`, `PETROLEUM_OWNER_PASSWORD`, `PETROLEUM_MANAGER_EMAIL`, and `PETROLEUM_MANAGER_PASSWORD`. Use distinct emails and strong, unique passwords of at least 16 characters. To use your own station label, set `PETROLEUM_STATION_NAME` and `PETROLEUM_STATION_CODE` in the service environment before the first start.
3. Once the service is live, open `/owner` on its HTTPS URL. In **Settings**, enter the station's opening stock and current Petrol and Diesel rates, and confirm the nozzle list. The service starts with one nozzle per fuel (`P-01` and `D-01`), and **Add nozzle** lets you record additional meters. Open `/manager` to enter the first shift's meter readings.

The hosted database is created on first start at `/var/data/petroleum.sqlite3`. It starts with zero opening stock, unset selling rates and the two accounts you supplied. Account credentials and station labels are read when creating a new database. Changing those environment variables later does not update existing accounts or station labels.

Keep the disk mounted and use one service instance for this SQLite setup. The disk preserves records across restarts and deploys. Render briefly stops the old instance when deploying a service with a disk.

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

The tests call the WSGI application directly with temporary SQLite databases. They cover two consecutive shifts, carry-forward, rate history, duplicate protection, daily totals, stock, reviews, role and station access, HTTPS session cookies, and persistence across application restarts.
