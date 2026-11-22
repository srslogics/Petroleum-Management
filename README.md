# Petroleum Management

Phase 1 serves two web apps from one Python backend and Turso database on Render. Local development uses SQLite by default. The repository started with a README, so the first version uses Python's standard library with plain HTML, CSS and JavaScript. It needs Python 3.10+ and an installed time zone database with `Asia/Kolkata`. There is no build step.

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

### Create the Turso database

Run these commands in your Mac terminal. Use a dedicated **libSQL** database, which is the default for this Turso CLI. If you already created a dedicated libSQL database, use its name and start with the second command.

```sh
turso db create petroleum-management --wait
turso db show petroleum-management --url
turso db tokens create petroleum-management
```

Use `turso auth login` if the CLI asks you to sign in. Copy the database URL and the database token into Render's environment settings. Keep the token out of Git and chat. For this deployment the token needs write access so the app can create its schema and save shifts.

### Create the owner in Turso once

From the repository, run:

```sh
python3 -m pip install -r requirements.txt
python3 app.py setup-owner
```

Enter the Turso URL and token when prompted, then enter the owner's mobile number and a password of 7–200 characters. The command saves the account in Turso with a password hash. An existing owner can continue signing in with their original credentials.

### Create the Render Web Service

In the [Render Dashboard](https://dashboard.render.com/), select **New → Web Service** and connect `srslogics/Petroleum-Management` through your GitHub account.

| Field | Value |
| --- | --- |
| Name | `petroleum-management` |
| Branch | `main` |
| Root Directory | Leave blank |
| Runtime | Python 3 |
| Region | Singapore |
| Instance Type | Starter |
| Build Command | `python -m pip install -r requirements.txt && python -m unittest discover -s tests -v` |
| Start Command | `gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 4 'app:create_app()'` |
| Health Check Path | `/healthz` |

Add these environment variables before selecting **Create Web Service**.

| Environment variable | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | Database URL from `turso db show` |
| `TURSO_AUTH_TOKEN` | Database token from `turso db tokens create` |

Turso keeps the records for this deployment, so the Web Service needs no persistent disk. If you already deployed with SQLite and entered real records, back up that database before switching. The Turso setup initializes the configured remote database and does not import existing SQLite records.

The station and tables are initialized on the first app start or when running owner setup, whichever happens first. To set the station label at creation, provide `PETROLEUM_STATION_NAME` and `PETROLEUM_STATION_CODE` in the environment of that first run.

Open `/owner` on the service's HTTPS URL. In **Settings**, enter the opening stock and current Petrol and Diesel rates and confirm the nozzle list. The initial list includes `P-01` and `D-01`. In **Team → Add a station manager**, enter the manager’s name, mobile number and password. Share the sign-in details privately. The manager can then sign in at `/manager` to enter the first shift’s meter readings.

If your dashboard offers **New → Blueprint**, you can import `render.yaml` from `main` instead of filling the Web Service form.

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

The tests call the WSGI application directly with temporary databases. Hosted-path tests use a local database through libSQL when installed, or SQLite otherwise. They do not require a Turso Cloud connection. They cover two consecutive shifts, carry-forward, rate history, duplicate protection, daily totals, stock, reviews, role and station access, HTTPS session cookies, and persistence across application restarts.
