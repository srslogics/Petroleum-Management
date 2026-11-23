# Tuljai Petroleum

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
python3 app.py setup-owner
```

Enter the Turso URL and token when prompted, then enter the owner's mobile number and a password of 7–200 characters. The command saves the account in Turso with a password hash. An existing owner can continue signing in with their original credentials.

### Reset the existing owner sign-in

If owner setup reports that an owner already exists, run `python3 app.py reset-owner` from the repository with the same Turso database configuration as Render. Enter the mobile number you want to use at sign-in and confirm the new password. The command updates the existing owner and signs out their active sessions.

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
- Submitting locks a shift's figures. An owner can correct the latest report with a reason while no later shift, bank reconciliation, credit allocation or customer repayment depends on it. Original figures and correction history are retained, and the previous review is cleared. Closing inputs are saved on submission and need to be re-entered if the manager refreshes before submitting.

## Verify the workflow

```sh
python3 -m unittest discover -s tests -v
```

The tests call the WSGI application directly with temporary databases. Hosted-path tests exercise the Turso HTTP protocol against a local SQLite fixture. They do not require a Turso Cloud connection. They cover two consecutive shifts, carry-forward, rate history, duplicate protection, daily totals, stock, reviews, role and station access, HTTPS session cookies, and persistence across application restarts.

### Verify owner workflows in Chromium

Browser regression tests require Node.js 20+ as a development tool; the app still runs without Node.js or a build step.

```sh
npm ci
npx playwright install chromium
npm test
```

The test starts a local server on an available port with a temporary SQLite database and demo accounts, then removes it after the run. It covers owner credit allocation, repayments, settlements, deposits, correction requests and audited corrections, account deactivation, exception follow-up, phone layouts. Set `PYTHON` if your Python executable is named differently from `python3`.

## Install on a phone

Open `/owner` or `/manager` on the Render HTTPS URL, then tap **Install app**. Supported Android browsers show an installation prompt. In Safari on iPhone, use **Share → Add to Home Screen**. Each role has its own install identity and starts at its own sign-in page.

An installed app requires internet access for sign-in, reports and saving operations. Offline launches show a connection screen. The app displays an offline notice if the connection drops while entering a shift. Keep that page open to retain unsaved entries, then reconnect and check whether the shift was submitted before trying again. The service worker stores only the public offline screen, its typography assets and installation images.

## Social link previews

The home, owner and manager URLs serve Open Graph and social card metadata directly in their HTML, with the Tuljai logo as the preview image. On Render the public URL is read from `RENDER_EXTERNAL_URL`. Set `PUBLIC_APP_URL` to your HTTPS origin if you use a custom domain. Social platforms control when they refresh previously shared link previews.

## Direct app links

Share `/owner` with the owner and `/manager` with station managers. The root URL opens the Owner App. Each sign-in screen stays within its role.

## Manager shift entries

In an open shift, the manager can add payment transactions or settlement batches, individual fuel deliveries, and till expenses. Payment entries include method, amount, customer/account, reference and notes. Credit requires a customer name. Deliveries include fuel, litres, supplier/tanker and invoice/challan reference. Expenses include amount, payee, reference and description. Physical stock measurements and handover notes are entered at closing.

If detailed entries exist for a payment method or fuel, the server derives that total from those entries. Otherwise the direct total is used. Enter all entries for a method when using that detail list. Expense entries replace the direct expense total. All submitted entries and handover notes appear in the owner's shift report, daily report and CSV export. Closing form entries are saved on submission.

## Owner business controls

The owner navigation includes **Money**, **Operations** and **Exceptions** alongside the existing daily reports, settings and team screens. The new tables are created automatically on application startup for both SQLite and Turso. Existing shifts, accounts and opening stock are retained; tank capacities start unconfigured.

### Customer credit and repayments

In **Money**, named credit entries from submitted shifts create customer balances. Customer names are matched without letter case; managers should consistently use the same account name. Use **Add customer** to create an account. Open a customer and choose **Set due date** to update its account-level payment date. Each customer has a transaction statement and CSV download. Outstanding balances past their due date appear in Exceptions.

Credit entered only as a shift total remains visibly **unallocated**. Assign that credit to one or more customers in Money, within the remaining balance, using unique allocation references. Allocations do not change the shift's sales or collections.

Record repayments against a customer's outstanding balance using a unique receipt reference. A confirmed bank receipt reduces the balance immediately. Cash received also reduces the customer balance but remains awaiting deposit. These repayments are separate from fuel sales: do not enter them again as a shift's fuel collection or include the same repayment cash in its closing count. Overpayments, future receipt dates and duplicate references are rejected.

### Bank reconciliation and cash deposits

Each submitted shift creates sources for UPI, card and actual counted cash. Record the net amount received by the bank plus any settlement fee for digital payments, or the deposited amount for cash. Partial settlements remain pending; a completed receipt plus fees cannot exceed its source balance. Cash repayments create their own deposit source. Bank records require a date and a unique bank/deposit reference. This is manual reconciliation against your bank evidence; there is no automatic bank, UPI or card-provider connection.

Money record history retains repayments, deposits and settlements with who recorded them and when. Void a mistaken entry with a reason, then enter a replacement with a new reference. Voiding restores the related outstanding balance without deleting the original. Void a cash repayment's linked deposit first. Prior financial records continue to prevent rewriting their underlying shift, including after a void.

### Shift oversight and corrections

The overview and Operations show the current open shift, opener, opening time/readings and elapsed hours. A shift open for 12 hours or more is flagged overdue. Use Refresh status for the latest snapshot; closing inputs are visible only after submission.

From a submitted shift, request a correction or clarification with a reason. Managers see **Owner requests**, send the proposed figures and explanation, and the owner records the resolution. Each request allows one manager response and one owner resolution; create a new request for further discussion.

**Correct report figures** lets the owner amend the latest submitted shift before dependent records exist. It preserves the original submission attribution, stores complete before/after reports with the correction reason and owner, updates derived totals, and requires a fresh review. A later shift, a bank record for that shift, allocated credit for it, or any customer repayment blocks rewriting figures. Resolve older or reconciled reports through a documented clarification; this version does not cascade meter/stock corrections through later shifts.

### Team, exceptions and tanks

In **Team**, the owner can edit a manager's name/mobile number, reset their password, deactivate/reactivate their account or end their sessions. Every account change ends existing sessions. Deactivated accounts cannot sign in; their historical shifts are retained. These controls cannot modify owner accounts.

**Exceptions** spans all business dates: cash and collection differences, physical/book stock differences, pending reviews, overdue shifts, correction requests, unallocated credit, overdue customers, pending settlements/deposits and configured tank warnings. Acknowledge an issue with a follow-up note. Acknowledgement does not clear the actual discrepancy; a changed amount or status brings the issue back to attention. Exceptions whose underlying condition is fixed disappear from the active list.

In **Operations**, configure the usable combined tank capacity and low stock threshold for Petrol and Diesel. The overview shows percentages only after configuration, warns at the configured threshold and flags stock above capacity. These use calculated stock through submitted shifts, rather than live sensor readings.

## Typography

Both roles, sign-in, reports and the offline screen use the shared scale in `static/typography.css`. Layout styles in `styles.css` and `workspace.css` do not set their own font sizes or weights. Inputs stay at 16px on phones; labels and table text use the same sizes across screens. Currency and reconciliation figures use tabular numerals.

Inter Variable 5.3.0 is bundled in `static/fonts` under the adjacent SIL Open Font License. Fonts load from the app's origin, including the rupee glyph, with system fallback for scripts outside the bundled subsets. The service worker stores these public typography assets for the offline screen. No external font service is required.

`npm test` checks actual font loading, headings, inputs, buttons, tables, small text, overflow and offline typography across owner and manager screens at 1440px, 1024px, 390px and 320px widths.

### Money workspace

Money separates work into **Customers**, **Banking** and **Activity**. The summary cards show customer dues, pending UPI/card receipts, cash awaiting deposit and customer payments received this month. Unassigned credit appears only when an allocation is needed.

Search or filter the customer list, open an account for its statement, or choose **Record payment**. **Add customer**, payments, credit assignment and bank receipts open focused dialogs instead of showing every form at once. On phones, customer balances and pending bank amounts stay visible; tap a customer or banking source for its details and actions.

Banking filters pending/completed receipts and payment methods. Activity retains the money trail and provides the audited void workflow. **How this works** (or **Money help** on phones) contains accounting guidance outside the main working lists.

### Payroll and Payables

Owners can use **Payroll** for staff salaries and advances, and **Payables** for supplier invoices and other business bills. Staff are separate from manager login accounts. Both workspaces use the shared typography, focused forms and phone layouts.

In Payroll, add staff with a unique code and optional monthly salary default. Prepare one salary per staff member and month using the actual amount earned. An advance remains outstanding until it is returned or explicitly applied when preparing a salary. The amount applied reduces the salary left to pay. Salary payments may be partial; inactive staff can still receive existing dues or return advances. Changing a staff salary default does not change prepared salaries. Taxes, attendance and statutory deductions are not calculated automatically.

In Payables, record a supplier invoice or other bill with its payee, reference, amount, description, bill date and due date. The summary shows outstanding, overdue, due within seven days and payments recorded this month. Each partial payment reduces the remaining balance. The same active invoice reference cannot be entered twice for the same payee (case insensitive).

Payment records require an amount, payment date, cash/bank method and a unique reference across both outgoing ledgers. They record payments already made; they do not transfer funds or modify shift collections, till cash, sales or incoming customer receipts. Advance returns are receipts against the staff advance balance, not bill payments or salary payments.

Open a salary, bill or payment to see its details and payment history. To correct an error, void it with a reason and enter a replacement. Void linked payments before voiding their salary or bill; reverse returns or salary recovery before voiding an advance that has been used. Voided records remain in history, and payment references remain reserved to prevent accidental duplicates. A voided salary month or invoice may be replaced. Staff profile edits affect the current staff register; salary and payment amounts retain their original values.

The additive schema is initialized automatically for SQLite and Turso. Payroll and Payables are owner-only and scoped to the signed-in station. Balances are checked inside write transactions to prevent concurrent overpayments. `python3 -m unittest discover -s tests -v` tests ledger rules, station isolation, migrations, persistence and Turso compatibility. `npm test` exercises the actual forms, failures, searches, phone layouts and existing application workflows.
