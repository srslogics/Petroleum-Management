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

Enter the Turso URL and token when prompted, then enter the owner's mobile number and a password of 15–200 characters. The command saves the account in Turso with a password hash. An existing owner can continue signing in with their original credentials.

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

Open `/owner` on the service's HTTPS URL. From **Overview**, confirm the measured opening stock for both fuels before the first shift is submitted. You can confirm zero for an empty tank. Enter current Petrol and Diesel rates and confirm the nozzle list in **Settings**. The initial list includes `P-01` and `D-01`. In **Team → Add a station manager**, enter the manager’s name, mobile number and password. Share the sign-in details privately. The manager can then sign in at `/manager` to enter the first shift’s meter readings.

If your dashboard offers **New → Blueprint**, you can import `render.yaml` from `main` instead of filling the Web Service form.

## Reconciliation assumptions

- A station can have one open shift at a time. Its business date is the calendar date on which it opened in Asia/Kolkata, including shifts submitted after midnight. The daily summary includes every submitted shift assigned to that date.
- Rates are captured when a shift opens. Sales are litres sold multiplied by the captured rate, rounded to the nearest paisa per fuel per shift. Daily sales add those stored values.
- Expected cash equals cash collections minus till expenses. Cash difference equals actual counted cash minus expected cash. The shift starts with zero opening cash float for this version.
- Collections include cash, UPI, card and credit. Enter credit sales in the credit category. Collections difference equals total recorded collections and credit minus metered sales. Differences are saved for review, including shortages and overages.
- Enter one delivery total and an optional physical closing reading for each fuel per shift. Calculated stock equals the starting balance plus submitted deliveries minus submitted metered sales. The latest physical reading is shown separately and does not adjust the calculated balance.
- Submitting locks a shift's figures. An owner can correct the latest report with a reason while no later shift, bank reconciliation, credit allocation or customer repayment depends on it. Original figures and correction history are retained, and the previous review is cleared. Manager closing entries are saved as an editable draft before submission; successful submission clears that draft.

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

An installed app requires internet access for sign-in, reports and saving operations. Offline launches show a connection screen. The app displays an offline notice if the connection drops while entering a shift. Manager edits are mirrored in the current tab when browser storage is available; keep the page open, reconnect and retry Save now. Saved online drafts restore after sign-in. Offline launches still show the connection screen; there is no offline submission. Check whether the shift was submitted before trying again. The service worker stores only the public offline screen, its typography assets and installation images.

## Social link previews

The home, owner and manager URLs serve Open Graph and social card metadata directly in their HTML, with the Tuljai logo as the preview image. On Render the public URL is read from `RENDER_EXTERNAL_URL`. Set `PUBLIC_APP_URL` to your HTTPS origin if you use a custom domain. Social platforms control when they refresh previously shared link previews.

## Direct app links

Share `/owner` with the owner and `/manager` with station managers. The root URL opens the Owner App. Each sign-in screen stays within its role.

## Manager shift entries

The Manager app is an entry workspace with **Meters & stock**, **Collections**, **Deliveries** and **Expenses**. Managers enter cash, UPI and card totals without customer details. Credit belongs to the owner; the manager API rejects credit amounts and customer names on payment batches. Any collections-versus-sales difference stays visible for the owner to reconcile, without requiring managers to explain owner-managed credit.

Managers can enter delivery/expense totals directly, or optionally record individual deliveries with supplier/challan details and till expenses with a payee and description. Optional payment batches capture cash, UPI or card amounts and references without identifying motorists. Detailed entries replace their method/fuel/expense total; the total becomes read-only while entries exist. Switching a batch method or removing the final entry restores the previous direct total. All submitted entries and notes appear in owner reports and CSV exports.

Entries auto-save online after a short pause, with **Save now** and a visible status. Incomplete drafts can contain blank readings or unfinished rows; final submission still validates all amounts and required fields. Drafts are scoped to the station and open shift, include who last saved them, survive application restarts, and never change reports or stock until submission. Concurrent editors use version checks: a stale save or submission is rejected, and **Load saved draft** explicitly replaces the current editor with the latest saved entries.

A same-tab browser-session mirror keeps unsaved edits through refresh or temporary connection failures when storage is available. It is keyed by manager account, station and shift; it is not stored in the service worker. Unsaved edits trigger a browser navigation warning. A storage failure is reported if online saving also fails. Online drafts are shared by managers working on the same station shift; unsaved tab edits are not shared across devices. Completed drafts are cleared when their shift submits.

The optional **cash denomination counter** calculates counted cash from note/coin quantities and other cash. **Review entries** validates and shows a read-only summary of readings, collections, physical stock, deliveries, expenses and notes. Managers can return to editing; only **Submit shift closing** locks the report. Failed saves/submissions retain the form. Owner report corrections continue to support credit and customer information; owner-authorized shift completion also uses the full submission endpoint.

## Owner business controls

The owner navigation includes **Money**, **Operations** and **Exceptions** alongside the existing daily reports, settings and team screens. The new tables are created automatically on application startup for both SQLite and Turso. Existing shifts, accounts and opening stock are retained; tank capacities start unconfigured.

### Customer credit and repayments

In **Ledger → Money tools → To collect**, use **Record fuel credit** while a shift is open. Pending entries can be edited or removed until the manager submits the shift. At submission they appear in the Owner report and create customer balances. Customer names are matched without letter case; owners should consistently use the same account name. Enter the name on the credit sale or choose a saved contact. Open the credit account after submission and choose **Set due date** to update its payment date. Each customer has a transaction statement and CSV download. Outstanding balances past their due date appear in Exceptions.

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

### Owner Party ledger

**Ledger** opens a directory of people and businesses. Open a party for one dated transaction history, with separate running balances for money to collect, money to pay, and staff advances. Credit sales, bills, receipts, salary payments, advance recoveries and reversals appear in the same history when they belong to the party. Record a bill, amount owed, or fuel credit from their statement. Staff records can also open salary and advance forms.

Saved contacts collect existing customer and supplier records under the same name. A staff profile stays separate until it is explicitly linked to a saved contact. Use **Link staff to contact** in the staff statement or **Party ledger contact** when editing the staff profile. Linking brings existing salaries and advances into the saved contact’s history. The link follows the staff ID if their payroll name changes.

**Money tools** provides:

- **To collect** for the outstanding work across customers and other receivables.
- **To pay** for bills, salaries, staff advances, and payment history.
- **Banking** for UPI and card settlements, cash deposits, and bank statement imports.
- **Books** for the station Journal and Trial balance. Choose a statement date to view or export historical reports.

Recorded adjustments create dated reversals and leave the original postings visible.

Submitted shifts, outstanding dues, supplier bills, payments, bank settlements, cash deposits and payroll create balanced postings from their source records. Matching an outgoing payment to bank evidence does not post it again. New fuel repayments must fit the available balance on their date and on later dates. Opening receivables and opening payables retain the party balances without creating current income or expenses.

Use **Journal entry** for opening amounts, account adjustments, and valuation supported by purchase costs. Bills are initially debited to **Bills to classify** so the owner or accountant can allocate them to inventory, expenses or assets. The station records fuel quantities independently of their cost. Book inventory valuation and cost of sales with the corresponding journal entries. Review the collection and cash difference clearing accounts before closing the books.

**Contacts** saves names and optional WhatsApp numbers for the station. The same directory supplies name suggestions in owner money, bill and staff entry forms. WhatsApp opens a draft with the saved number when available. Owners can also save or update a contact from the party ledger.

Cash received against a receivable appears in **Ledger → Money tools → Banking** as a pending deposit until it is banked.

**Activity** keeps a history in each workspace. To correct an entry, void it with a reason and enter a replacement. Void linked deposits before their cash payments and linked payments before the underlying receivable.

### Payroll and Payables

Use **Ledger → Money tools → To pay → Bills** for supplier invoices and other business bills. Use **Salaries**, **Staff advances**, and **Staff** within **To pay** for payroll. Staff profiles are separate from manager login accounts.

Under **Staff**, add a staff member with a unique code and optional monthly salary default. Prepare one salary per staff member and month using the actual amount earned. An advance remains outstanding until it is returned or explicitly applied when preparing a salary. The amount applied reduces the salary left to pay. Salary payments may be partial; inactive staff can still receive existing dues or return advances. Changing a staff salary default does not change prepared salaries. Taxes, attendance and statutory deductions are not calculated automatically.

Under **Bills**, record a supplier invoice or other bill with its payee, reference, amount, description, bill date and due date. The summary shows outstanding, overdue, due within seven days and payments recorded this month. Each partial payment reduces the remaining balance. The same active invoice reference cannot be entered twice for the same payee (case insensitive).

Payment records require an amount, payment date, cash/bank method and a unique reference across bill and staff payments. They record payments already made; they do not transfer funds or modify shift collections, till cash, sales or incoming customer receipts. Advance returns are receipts against the staff advance balance, not bill payments or salary payments.

Open a salary, bill or payment to see its details and payment history. To correct an error, void it with a reason and enter a replacement. Void linked payments before voiding their salary or bill; reverse returns or salary recovery before voiding an advance that has been used. Voided records remain in history, and payment references remain reserved to prevent accidental duplicates. A voided salary month or invoice may be replaced. Staff profile edits affect the current staff register; salary and payment amounts retain their original values.

The additive schema is initialized automatically for SQLite and Turso. Payroll and Payables are owner-only and scoped to the signed-in station. Balances are checked inside write transactions to prevent concurrent overpayments. `python3 -m unittest discover -s tests -v` tests ledger rules, station isolation, migrations, persistence and Turso compatibility. `npm test` exercises the actual forms, failures, searches, phone layouts and existing application workflows.

## Station automation

Owners have an **Automation** workspace with Imports, Recurring drafts, Alerts, Reports and Connections. Managers have **Import figures** and **Read receipt / challan** inside the shift entry screen. No automation transfers money or sends messages to another person.

### Imports and matching

Import comma-separated CSV files (up to 2,000 rows / 1.5 MB) or paste their contents. Download a template, choose ISO / day-first / month-first dates, and optionally map provider-specific column headers. Preview first; confirmation stages records for review. Reimporting the same normalized reference is idempotent. A repeated reference with different figures is rejected rather than silently replaced. Bank debits remain separate from credits. Unsupported or malformed rows reject the whole import.

Canonical payment columns are `date,reference,amount,method,shift_id`; methods are cash, upi or card, with an optional shift ID. Meter columns are `date,nozzle,reading`; readings are cumulative litres. Bank columns are `date,reference,amount,debit,method,direction,fees,description,source`. `amount` is a positive credit/net receipt unless direction is debit; an explicit debit column also works. Dates with timestamps must have a timezone and are assigned to the station's IST calendar date. Currency values are INR; no currency conversion is performed. Existing parser aliases include UTR, narration, credit amount and withdrawal.

Managers select imports for the active shift's business date. One closing reading per nozzle is allowed, and it cannot precede the opening reading. Payment transactions become one batch per selected method, replacing that method's direct total; source references remain in Automation. Applying imports updates an editable, version-checked draft, not a submitted report. Used rows cannot be applied to a second shift. Check totals before applying additional batches, and submit through the normal review flow.

Bank imports are owner-only. A unique matching amount is suggested; the owner must select and confirm the actual source. Credits record a bank receipt against an existing pending UPI/card settlement or cash deposit, including separately imported fees. Partial receipts are allowed. Debits attach evidence to an existing bank payment with the same amount and a date within three days; they never create another payroll/bill payment. A payment cannot be matched twice. Voiding a linked record preserves the import match and creates a follow-up alert. Unrelated bank rows can be ignored with their history retained.

### Recurring preparation and reports

Create monthly salary or bill rules with a start month, preparation day and due day. Short months use their final day. Salary rules use current defaults for active staff; staff with zero defaults are skipped. At most twelve months are caught up. Overlapping salary rules do not duplicate staff/month drafts. Bills use a generated rule/month reference that the owner can replace with the actual invoice reference during review. Rules can be paused or resumed.

Prepared drafts require approval or dismissal. Approval reuses all normal ledger validation inside the same transaction as the draft decision. It cannot pay a bill, deduct an advance automatically, or override an existing salary month. Owners can edit the salary/bill amount, due date, note, bill reference and the explicit salary advance recovery before approving. Reviewed drafts remain in history and are not recreated after dismissal or a later void.

`gunicorn.conf.py` starts one lightweight preparation loop per Gunicorn worker after application initialization; the existing one-worker deployment checks every five minutes without adding another hosting service. Runs use independent DB connections and idempotent keys, so retries/restarts or overlapping workers do not duplicate drafts. Set `AUTOMATION_BACKGROUND=0` to disable this loop. Opening Automation also catches up due records when the station has no recent run. `python3 automation_runner.py --db /path/to/local.sqlite3` runs once; `--watch --interval 300` runs a standalone worker. Hosted runs use the existing Turso environment settings. Nothing can run while its hosting service is stopped.

Daily summaries are calculated from stored shifts and can be downloaded as CSV. Scheduled runs retain yesterday's summary, refreshed on subsequent runs. Stock forecasts use up to fourteen calendar days of submitted sales, including intervening days with no recorded sales, and require three distinct sales dates. A three-day forecast to the low-level threshold raises a reorder alert. Suggested top-ups require configured tank capacity; they never place an order and are estimates from book stock, not sensor readings. Alerts include existing shift/stock/customer issues and upcoming or overdue bills/salaries. Owners can open WhatsApp from the app header, contact managers via Team, and share prepared customer reminders or daily report summaries. The owner reviews the recipient and sends the message in WhatsApp. Optional desktop notifications require a user click/browser permission; they are not push delivery while the app is closed.

### Documents and live connections

Pasted document text works without an external account. The parser extracts explicitly labeled invoice/receipt/challan values and leaves unknown fields blank. Reviewed delivery/expense figures can fill the manager draft; reviewed bills use the normal owner bill form. Duplicate document fingerprints are flagged and duplicate invoice references remain blocked. Images are not saved to SQLite/Turso; the extracted text and document fingerprint are retained for review history.

For photo/PDF extraction, configure `OPENAI_API_KEY` securely on the hosting service; optionally set `AUTOMATION_OCR_MODEL` (default `gpt-4.1-mini`). The browser clearly shows when this connection is absent. PNG/JPEG/WebP/PDF files up to 4 MB go to the fixed OpenAI Responses API endpoint using structured fields and `store:false`. Reading is limited to ten requests per hour per account. A refusal, incomplete response, missing key, invalid file or service error leaves the ledger unchanged. Every extracted value needs human confirmation; the feature does not independently authenticate an invoice. See [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision) and [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

The pump controller, UPI/card provider and bank are currently unknown, so no provider-specific adapter or payout connection is claimed. Owners can create a feed endpoint for meters, payments or bank evidence. A random bearer token is shown once and stored only as a hash. The endpoint accepts `POST /api/feeds/<id>` with `Authorization: Bearer <token>` and JSON `{"rows":[...]}` using the canonical field names above and ISO dates. A compatible on-site gateway/provider adapter must send the data. Feed scope is fixed to its station/type; incoming data is staged, not posted, and repeated references are idempotent. Disable a feed to revoke its token; create a new one to rotate credentials. HTTPS is required on hosted deployments. Tokens must never be committed, placed in CSVs, or shared as URLs.

Photo reading needs the API key; live hardware/payment sync needs device/provider details and credentials. Automated email and WhatsApp delivery, statutory payroll calculations and actual bank payouts require separate integrations. The product UI distinguishes these setup dependencies from working CSV, text extraction and draft automation.

## Account security

New and reset passwords must be 15–200 characters. Existing passwords continue to work. Hosted cookies are Secure, HttpOnly and SameSite=Strict. Sign-ins expire after 12 hours, replace the previous session in the same browser for that account, and retain at most ten sessions per account. Owners can view the last 100 account changes in **Team → Account activity**. The journal records who changed which account and when, without storing passwords or session tokens.

The current single Gunicorn worker limits repeated sign-in attempts by account and client network. Limits are held in memory and reset when the worker restarts. A multi-worker deployment should use a shared limiter. Render client addresses use the last address appended by its proxy. A non-Render deployment uses the direct peer address. Keep the app behind its configured HTTPS ingress and set `PUBLIC_APP_URL` to the public origin. Browser API requests presenting an origin must come from the same origin. Only public assets are eligible for offline caching. Manager drafts saved online stay on the server. Unsaved browser copies remain in the current tab until saved or the manager signs out.

Feed credentials must be kept private and can be revoked in Connections. The app checks the bearer credential before reading import content, limits feed requests and keeps rejected uploads out of the ledger. Document extraction sends uploads only to the configured OpenAI API endpoint. Review hosting access, database backups and provider keys as separate operational controls. See Authenticator verification for enrollment and hosting setup.

### Authenticator verification

In either app, open **Account security**, enter your current password, and choose **Set up authenticator**. Add a time-based account manually with the displayed key, then enter the six-digit code. Save the eight recovery codes when shown and sign in again with a fresh code. Each recovery code works once with your password and signs out existing sessions. Verification is opt-in so existing accounts can enroll without being locked out. Enabling or disabling it signs out all sessions for that account. Turning it off requires the current password and a fresh authenticator or unused recovery code. A manager password reset preserves their authenticator enrollment.

Set the persistent `MFA_ENCRYPTION_KEY` environment variable to a base64-encoded, random 32-byte value. Render's Blueprint requests a generated value. For an existing service managed outside the Blueprint, configure the value in its Environment settings. Keep that key in your password vault or secrets backup. Losing or replacing it makes enrolled accounts unable to verify codes. Store a different key for each environment and do not put it in Git. Local development can generate a suitable value with `python3 -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'`. With no key, enrollment is unavailable and existing MFA accounts fail closed. Authenticator setup and recovery codes are delivered over HTTPS on hosted deployments and are not cached.
