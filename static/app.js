"use strict";

const root = document.querySelector("#app");
const role = { "/manager": "manager", "/owner": "owner" }[location.pathname];
const fuelNames = ["Petrol", "Diesel"];
const methodNames = { cash: "Cash", upi: "UPI", card: "Card", credit: "Credit" };
const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const litres = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
const clock = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
});
const safe = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const money = minor => rupees.format(minor / 100);
const volume = milli => litres.format(milli / 1000) + " L";
const decimal = (value, scale) => value / scale;
const timestamp = value => clock.format(new Date(value));
const businessDay = value => new Intl.DateTimeFormat("en-IN", {
  dateStyle: "long", timeZone: "Asia/Kolkata",
}).format(new Date(value + "T00:00:00+05:30"));

const roleTitle = role === "owner" ? "Owner App" : "Station Manager App";
let session;
let selectedDate;
let lastSubmission;

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  };
  const response = await fetch("/api/" + role + path, options);
  const payload = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(payload.error), { status: response.status });
  }
  return payload;
}

function brand() {
  return '<a class="brand" href="/"><span class="brand-mark" aria-hidden="true">PL</span> Pump Ledger</a>';
}

function showLanding() {
  root.innerHTML = `<div class="entry">
    <header class="entry-header">${brand()}</header>
    <main class="welcome">
      <p class="eyebrow">Station operations</p>
      <h1>Petrol pump management</h1>
      <div class="portal-grid">
        <a class="portal" href="/manager"><span class="portal-icon" aria-hidden="true">↗</span>
          <h2>Station Manager App</h2><p>Open a shift, record fuel sales and reconcile the till.</p><span class="portal-action">Open manager app →</span>
        </a>
        <a class="portal" href="/owner"><span class="portal-icon" aria-hidden="true">↗</span>
          <h2>Owner App</h2><p>Review submitted shifts, daily sales and fuel stock.</p><span class="portal-action">Open owner app →</span>
        </a>
      </div>
    </main>
  </div>`;
}

function showLogin(message = "") {
  const demoMode = document.querySelector('meta[name="demo-mode"]');
  root.innerHTML = `<div class="entry">
    <header class="entry-header">${brand()}<a href="/${role === "owner" ? "manager" : "owner"}">Switch app ↗</a></header>
    <main class="login card">
      <p class="eyebrow">${roleTitle}</p><h1>Sign in</h1>
      <form id="login">
        <label>Mobile number or email<input required name="identifier" autocomplete="username" autocapitalize="none" maxlength="254"></label>
        <label>Password<input required name="password" type="password" autocomplete="current-password"></label>
        <div class="form-error" role="alert">${safe(message)}</div>
        <button class="primary">Sign in</button>
      </form>
      ${demoMode ? '<button id="demo" type="button" class="text-button">Fill demo sign-in</button>' : ""}
    </main>
  </div>`;
  const login = document.querySelector("#login");
  const demoButton = document.querySelector("#demo");
  demoButton?.addEventListener("click", () => {
    login.elements.identifier.value = role + "@demo.local";
    login.elements.password.value = role === "owner" ? "OwnerDemo123!" : "ManagerDemo123!";
    login.querySelector("button").focus();
  });
  bindForm("login", async form => {
    await api("/login", fields(form));
    session = await api("/session");
    await showHome();
  }, false);
}

function shell(content) {
  const ownerNav = role === "owner"
    ? '<button class="nav-button" id="home" type="button">Dashboard</button><button class="nav-button" id="settings" type="button">Settings</button><button class="nav-button" id="team" type="button">Team</button>'
    : '<span class="nav-label">Shift closing</span>';
  root.innerHTML = `<header class="top"><div class="top-inner">${brand()}
    <span class="app-name">${roleTitle}</span>
    <div class="account"><span>${safe(session.name)}</span><button id="logout" class="nav-button" type="button">Sign out</button></div>
  </div></header>
  <div class="subnav"><div class="subnav-inner">
    <div class="station"><span class="station-dot" aria-hidden="true"></span>${safe(session.station)} <small>${safe(session.station_code)}</small></div>
    <nav aria-label="App navigation">${ownerNav}</nav>
  </div></div>
  <main class="page"><p id="notice" role="alert" class="notice" hidden></p>${content}</main>`;
  listen("logout", async () => {
    await api("/logout", {});
    session = null;
    selectedDate = undefined;
    lastSubmission = undefined;
    showLogin();
  });
  if (role === "owner") {
    listen("home", showHome);
    listen("settings", openSettings);
    listen("team", openTeam);
  }
}

function listen(id, action, event = "click") {
  document.getElementById(id).addEventListener(event, async e => {
    try {
      await action(e);
    } catch (error) {
      if (error.status === 401) {
        showLogin("Your session has expired. Sign in again.");
        return;
      }
      const notice = document.querySelector("#notice");
      notice.hidden = false;
      notice.textContent = error.message;
    }
  });
}

function bindForm(id, onSubmit, expire = true) {
  const form = document.getElementById(id);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter || form.querySelector("button");
    const errorbox = form.querySelector(".form-error");
    button.disabled = true;
    errorbox.textContent = "";
    try {
      await onSubmit(form);
    } catch (error) {
      if (expire && error.status === 401) {
        showLogin("Your session has expired. Sign in again.");
        return;
      }
      errorbox.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  return form;
}

function fields(form) {
  return Object.fromEntries(new FormData(form));
}

const errorbox = '<div class="form-error" role="alert"></div>';

function numberField(label, name, options = {}) {
  const { step = "0.01", value, required, readonly, min = 0, max = 1000000000, placeholder = "0.00" } = options;
  return `<label>${safe(label)}<input name="${safe(name)}" type="number" min="${min}" max="${max}" step="${step}"
    inputmode="decimal" ${value === undefined ? `placeholder="${placeholder}"` : `value="${safe(value)}"`}
    ${required ? "required" : ""} ${readonly ? "readonly" : ""}></label>`;
}

function heading(eyebrow, title, description = "") {
  return `<div class="page-heading"><p class="eyebrow">${safe(eyebrow)}</p><h1>${safe(title)}</h1>
    ${description ? `<p>${safe(description)}</p>` : ""}</div>`;
}

function fuelTag(fuel) {
  return `<span class="fuel-tag ${fuel.toLowerCase()}">${fuel}</span>`;
}

async function showHome() {
  if (role === "manager") {
    showManager(await api("/shift"));
  } else {
    showOwner(await api("/dashboard" + (selectedDate ? "?date=" + encodeURIComponent(selectedDate) : "")));
  }
}

function showManager(state) {
  if (state.active) {
    showClosing(state.active);
    return;
  }
  const setup = state.setup;
  shell(`${heading("Station operations", "Open a shift", "Confirm the opening meter readings before starting operations.")}
    ${lastSubmission ? `<div class="success" role="status">Shift #${lastSubmission.id} submitted by ${safe(lastSubmission.submitter)}.</div>` : ""}
    <form id="open-shift">
      <section class="card">
        <header class="section-head"><div><h2>Opening readings</h2>
          <p>${state.last ? "Readings carry forward from the last submitted shift for each nozzle." : "Enter the current meter reading for each nozzle."}</p>
        </div><span class="count">${setup.nozzles.length} nozzles</span></header>
        <div class="nozzle-list">${setup.nozzles.map(nozzle => `<div class="nozzle-row">
          <div><strong>${safe(nozzle.code)}</strong> ${fuelTag(nozzle.fuel)}
          <small>${nozzle.opening === null ? "Manual opening" : "Carried forward"}</small></div>
          ${numberField("Opening reading (L)", "opening_" + nozzle.id, {
            step: "0.001", required: true, readonly: nozzle.opening !== null,
            value: nozzle.opening === null ? undefined : decimal(nozzle.opening, 1000),
          })}
        </div>`).join("")}</div>
      </section>
      <section class="card compact"><h2>Selling rates</h2><dl class="key-values">
        ${fuelNames.map(fuel => `<div><dt>${fuel}</dt><dd>${money(setup.fuels[fuel].rate)} / L</dd></div>`).join("")}
      </dl></section>
      ${errorbox}<button class="primary">Open shift →</button>
    </form>`);
  bindForm("open-shift", async form => {
    const values = fields(form);
    const openings = Object.fromEntries(setup.nozzles.map(nozzle => [nozzle.id, values["opening_" + nozzle.id]]));
    const active = await api("/shift", { openings });
    lastSubmission = undefined;
    showClosing(active);
  });
}

function showClosing(active) {
  shell(`${heading("Shift #" + active.id + " · " + businessDay(active.business_date), "Close shift",
    "Enter the closing readings and reconcile the till before submitting.")}
    <form id="close-shift">
      <div class="work-grid">
        <div class="stack">
          <section class="card">
            <header class="section-head"><div><h2>Nozzle meters</h2><p>Litres sold = closing reading − opening reading.</p></div></header>
            <div class="nozzle-list">${active.nozzles.map(nozzle => `<div class="nozzle-row">
              <div><strong>${safe(nozzle.code)}</strong> ${fuelTag(nozzle.fuel)}
                <small>Opening ${volume(nozzle.opening)} · ${money(active.rates[nozzle.fuel])} / L</small>
                <small id="sold-${nozzle.id}">Sold —</small></div>
              ${numberField("Closing reading (L)", "closing_" + nozzle.id, {
                step: "0.001", min: decimal(nozzle.opening, 1000), required: true,
              })}
            </div>`).join("")}</div>
          </section>
          <section class="card">
            <header class="section-head"><div><h2>Stock movements</h2><p>Enter delivery totals and any closing physical measurements.</p></div></header>
            <div class="fuel-grid">${fuelNames.map(fuel => `<div class="fuel-entry">${fuelTag(fuel)}
              ${numberField("Delivered (L)", "delivery_" + fuel, { step: "0.001" })}
              ${numberField("Physical stock (L)", "physical_" + fuel, { step: "0.001", placeholder: "Optional" })}
            </div>`).join("")}</div>
          </section>
          <section class="card">
            <header class="section-head"><div><h2>Collections and till</h2><p>Enter the amount recorded for each payment method.</p></div></header>
            <div class="field-grid">
              ${Object.entries(methodNames).map(([key, label]) => numberField(label + " (₹)", key)).join("")}
              ${numberField("Till expenses (₹)", "expenses")}
              ${numberField("Actual cash counted (₹)", "counted", { required: true })}
            </div>
            <label>Expense note <span class="quiet">(optional)</span><textarea name="expense_note" maxlength="250" rows="2"></textarea></label>
          </section>
        </div>
        <aside class="card reconciliation">
          <h2>Reconciliation</h2>
          <dl class="key-values">
            <div><dt>Metered sales</dt><dd id="metered">—</dd></div>
            <div><dt>Total collections</dt><dd id="collections-total">—</dd></div>
            <div><dt>Collections − metered sales</dt><dd id="collections-diff">—</dd></div>
          </dl>
          <dl class="key-values">
            <div><dt>Cash collections</dt><dd id="cash">—</dd></div>
            <div><dt>Less till expenses</dt><dd id="expenses">—</dd></div>
            <div><dt>Expected cash</dt><dd id="expected">—</dd></div>
            <div><dt>Actual cash counted</dt><dd id="counted">—</dd></div>
          </dl>
          <div class="result"><div><strong>Cash difference</strong><small>Actual counted − expected cash</small></div><output id="variance">—</output></div>
          ${errorbox}<button class="primary">Submit shift closing</button>
          <p class="quiet submit-help">Submission locks the shift report and makes it available to the owner.</p>
        </aside>
      </div>
    </form>`);
  const form = bindForm("close-shift", async form => {
    const values = fields(form);
    const byFuel = prefix => Object.fromEntries(fuelNames.map(fuel => [fuel, values[prefix + fuel]]));
    lastSubmission = await api("/shifts/" + active.id + "/submit", {
      closings: Object.fromEntries(active.nozzles.map(nozzle => [nozzle.id, values["closing_" + nozzle.id]])),
      deliveries: byFuel("delivery_"), physical: byFuel("physical_"),
      collections: Object.fromEntries(Object.keys(methodNames).map(key => [key, values[key]])),
      expenses: values.expenses, counted: values.counted, expense_note: values.expense_note,
    });
    await showHome();
  });
  form.addEventListener("input", () => updatePreview(form, active));
  updatePreview(form, active);
}

function inputAmount(form, name, scale, required = false) {
  const input = form.elements[name];
  if (!input.validity.valid || (required && input.value === "")) return null;
  return Math.round(Number(input.value) * scale);
}

function updatePreview(form, active) {
  const sold = Object.fromEntries(fuelNames.map(fuel => [fuel, 0n]));
  let hasAllReadings = true;
  const showMetric = (id, value, discrepancy = false) => {
    const element = document.getElementById(id);
    element.textContent = value === null ? "—" : money(value);
    element.classList.toggle("discrepancy", discrepancy && value !== null && value !== 0);
  };
  for (const nozzle of active.nozzles) {
    const closing = inputAmount(form, "closing_" + nozzle.id, 1000, true);
    const output = document.getElementById("sold-" + nozzle.id);
    if (closing === null) {
      output.textContent = "Sold —";
      hasAllReadings = false;
    } else {
      const difference = closing - nozzle.opening;
      sold[nozzle.fuel] += BigInt(difference);
      output.textContent = "Sold " + volume(difference);
    }
  }
  const sales = hasAllReadings ? fuelNames.reduce((total, fuel) =>
    total + Number((sold[fuel] * BigInt(active.rates[fuel]) + 500n) / 1000n), 0) : null;
  const collections = Object.keys(methodNames).map(key => inputAmount(form, key, 100));
  const collectionTotal = collections.includes(null) ? null : collections.reduce((total, amount) => total + amount, 0);
  const cash = collections[0];
  const expenses = inputAmount(form, "expenses", 100);
  const counted = inputAmount(form, "counted", 100, true);
  const expected = cash === null || expenses === null ? null : cash - expenses;
  showMetric("metered", sales);
  showMetric("collections-total", collectionTotal);
  showMetric("collections-diff", sales === null || collectionTotal === null ? null : collectionTotal - sales, true);
  showMetric("cash", cash);
  showMetric("expenses", expenses);
  showMetric("expected", expected);
  showMetric("counted", counted);
  showMetric("variance", counted === null || expected === null ? null : counted - expected, true);
}

function showOwner(data) {
  selectedDate = data.date;
  shell(`${heading("Station performance", "Daily dashboard", "Sales and reconciliations from submitted shifts.")}
    <section class="card">
      <header class="section-head date-head"><div><h2>Fuel sales</h2><p>${safe(businessDay(data.date))}</p></div>
        <label>Business date<input id="date" type="date" value="${safe(data.date)}"></label>
      </header>
      <div class="fuel-grid">${fuelNames.map(fuel => `<div class="metric">
        ${fuelTag(fuel)}<strong>${money(data.daily[fuel].sales)}</strong>
        <span>${volume(data.daily[fuel].litres)} sold</span>
      </div>`).join("")}</div>
    </section>
    <section class="card">
      <header class="section-head"><div><h2>Submitted shifts</h2><p>Open a report to inspect readings and record your review.</p></div>
        <span class="count">${data.shifts.length} submitted</span></header>
      ${data.shifts.length ? `<div class="shift-list">${data.shifts.map(shift => `
        <button class="shift-row" id="shift-${shift.id}" type="button">
          <span><strong>Shift #${shift.id}</strong><small>${safe(shift.submitter)} · ${timestamp(shift.submitted_at)}</small></span>
          <span><strong>${money(shift.sales)}</strong><small>Cash difference ${money(shift.cash_difference)}</small></span>
          <span class="status ${shift.reviewed_at ? "reviewed" : ""}">${shift.reviewed_at ? "Reviewed" : "Awaiting review"}</span>
          <span class="shift-arrow" aria-hidden="true">→</span>
        </button>`).join("")}</div>` : '<p class="empty">No submitted shifts for this business date.</p>'}
    </section>
    <section class="card">
      <header class="section-head"><div><h2>Fuel stock</h2><p>Current station stock through the latest submitted shift.</p></div></header>
      <div class="fuel-grid">${fuelNames.map(fuel => {
        const item = data.stock[fuel];
        return `<div class="metric stock">${fuelTag(fuel)}
          <span>Calculated stock</span><strong>${volume(item.calculated)}</strong>
          <dl class="key-values">
            <div><dt>Opening stock</dt><dd>${volume(item.opening)}</dd></div>
            <div><dt>Delivered</dt><dd>+ ${volume(item.delivery)}</dd></div>
            <div><dt>Metered sales</dt><dd>− ${volume(item.sold)}</dd></div>
            <div><dt>Latest physical stock</dt><dd>${item.physical ? volume(item.physical.litres) : "No reading"}</dd></div>
          </dl>
          ${item.physical ? `<small>Measured in shift #${item.physical.shift_id} · ${timestamp(item.physical.at)}</small>` : ""}
        </div>`;
      }).join("")}</div>
    </section>`);
  listen("date", async event => {
    if (!event.target.value) return;
    const updated = await api("/dashboard?date=" + encodeURIComponent(event.target.value));
    showOwner(updated);
  }, "change");
  for (const shift of data.shifts) {
    listen("shift-" + shift.id, async () => showReport(await api("/shifts/" + shift.id)));
  }
}

function showReport(shift) {
  const cashRows = [
    ...Object.entries(methodNames).map(([method, label]) => [label, shift.collections[method]]),
    ["Total collections", shift.collection_total],
    ["Collections − metered sales", shift.collection_difference, true],
    ["Till expenses", shift.expenses],
    ["Expected cash (cash − expenses)", shift.expected],
    ["Actual cash counted", shift.counted],
    ["Cash difference (actual − expected)", shift.cash_difference, true],
  ];
  shell(`<button id="back" type="button" class="text-button back">← Daily dashboard</button>
    ${heading("Submitted shift", "Shift #" + shift.id, businessDay(shift.business_date) +
      " · Submitted by " + shift.submitter + " at " + timestamp(shift.submitted_at))}
    <div class="work-grid"><div class="stack">
      <section class="card"><h2>Nozzle readings</h2>
        <div class="nozzle-list">${shift.nozzles.map(nozzle => `<div class="report-nozzle">
          <strong>${safe(nozzle.code)} ${fuelTag(nozzle.fuel)}</strong>
          <dl class="key-values horizontal">
            <div><dt>Opening</dt><dd>${volume(nozzle.opening)}</dd></div>
            <div><dt>Closing</dt><dd>${volume(nozzle.closing)}</dd></div>
            <div><dt>Sold</dt><dd>${volume(nozzle.litres)}</dd></div>
          </dl>
        </div>`).join("")}</div>
      </section>
      <section class="card"><h2>Fuel sales and stock movements</h2>
        <div class="fuel-grid">${fuelNames.map(fuel => {
          const item = shift.fuels[fuel];
          return `<div class="metric">${fuelTag(fuel)}<strong>${money(item.sales)}</strong>
            <dl class="key-values">
              <div><dt>Rate used</dt><dd>${money(item.rate)} / L</dd></div>
              <div><dt>Sold</dt><dd>${volume(item.litres)}</dd></div>
              <div><dt>Delivered</dt><dd>${volume(item.delivery)}</dd></div>
              <div><dt>Physical stock</dt><dd>${item.physical === null ? "No reading" : volume(item.physical)}</dd></div>
            </dl>
          </div>`;
        }).join("")}</div>
      </section>
      <section class="card"><h2>Owner review</h2>
        ${shift.review ? `<p><span class="status reviewed">Reviewed</span> ${safe(shift.review.reviewer)} · ${timestamp(shift.review.reviewed_at)}</p>
          ${shift.review.review_note ? `<p class="review-note">${safe(shift.review.review_note)}</p>` : ""}`
          : `<form id="review"><label>Review note <span class="quiet">(optional)</span><textarea name="note" rows="3" maxlength="500"></textarea></label>
            ${errorbox}<button class="primary">Mark as reviewed</button></form>`}
      </section>
    </div>
    <aside class="card reconciliation"><h2>Collections and till</h2>
      <dl class="key-values">${cashRows.map(([label, value, discrepancy]) => `<div><dt>${label}</dt>
        <dd class="${discrepancy && value ? "discrepancy" : ""}">${money(value)}</dd></div>`).join("")}</dl>
      ${shift.expense_note ? `<p class="review-note"><strong>Expense note</strong> ${safe(shift.expense_note)}</p>` : ""}
    </aside></div>`);
  listen("back", showHome);
  if (!shift.review) {
    bindForm("review", async form => showReport(await api("/shifts/" + shift.id + "/review", fields(form))));
  }
}

async function openTeam() {
  showTeam(await api("/managers"));
}

function showTeam(managers, added = false) {
  shell(`${heading("Station access", "Team")}
    ${added ? '<p class="success" role="status">Manager account created. Share the sign-in details privately.</p>' : ""}
    <section class="card">
      <h2>Station managers</h2>
      ${managers.length ? `<dl class="key-values">${managers.map(manager =>
        `<div><dt>${safe(manager.name)}</dt><dd>${safe(manager.login_id)}</dd></div>`).join("")}</dl>`
        : '<p>No manager accounts yet.</p>'}
    </section>
    <section class="card">
      <h2>Add a station manager</h2>
      <form id="add-manager">
        <div class="field-grid">
          <label>Full name<input name="name" required maxlength="80" autocomplete="off"></label>
          <label>Mobile number<input name="phone" required type="tel" maxlength="24" placeholder="+91" autocomplete="off"></label>
        </div>
        <label>Password<input name="password" type="password" required minlength="16" maxlength="200"
          autocomplete="new-password" aria-describedby="manager-password-help"></label>
        <small id="manager-password-help">Use a unique password of at least 16 characters.</small>
        ${errorbox}<button class="primary">Create manager account</button>
      </form>
    </section>`);
  bindForm("add-manager", async form => {
    const manager = await api("/managers", fields(form));
    showTeam([...managers, manager], true);
  });
}

async function openSettings() {
  const dashboard = await api("/dashboard");
  showSettings(dashboard.setup, dashboard.can_edit_opening_stock);
}

function showSettings(setup, canEditStock, confirmation = "") {
  shell(`${heading("Station configuration", "Settings")}
    ${confirmation ? `<div class="success" role="status">${safe(confirmation)}</div>` : ""}
    <section class="card"><header class="section-head"><div><h2>Selling rates</h2><p>Rate changes apply when the manager opens a shift.</p></div></header>
      <form id="rates"><div class="field-grid">
        ${fuelNames.map(fuel => numberField(fuel + " (₹ / L)", fuel, {
          value: decimal(setup.fuels[fuel].rate, 100), required: true, min: 0.01, max: 1000,
        })).join("")}
      </div>${errorbox}<button class="primary">Save rates</button></form>
    </section>
    <section class="card"><h2>Nozzles</h2>
      <ul class="nozzle-config">${setup.nozzles.map(nozzle => `<li><strong>${safe(nozzle.code)}</strong> ${fuelTag(nozzle.fuel)}</li>`).join("")}</ul>
      <form id="nozzle"><div class="field-grid">
        <label>Nozzle code<input name="code" maxlength="20" required placeholder="P-02"></label>
        <label>Fuel<select name="fuel">${fuelNames.map(fuel => `<option>${fuel}</option>`).join("")}</select></label>
      </div>${errorbox}<button class="primary">Add nozzle</button></form>
    </section>
    <section class="card"><header class="section-head"><div><h2>Opening stock</h2>
      <p>${canEditStock ? "Set the starting balance for each fuel before the first submission." : "Starting balances were locked at the first submission."}</p></div></header>
      <form id="stock"><div class="field-grid">
        ${fuelNames.map(fuel => numberField(fuel + " (L)", fuel, { step: "0.001",
          value: decimal(setup.fuels[fuel].opening_stock, 1000), required: true, readonly: !canEditStock,
        })).join("")}
      </div>${canEditStock ? errorbox + '<button class="primary">Save opening stock</button>' : ""}</form>
    </section>`);
  const save = (id, field, feedback) => bindForm(id, async form => {
    await api("/settings", { [field]: fields(form) });
    const dashboard = await api("/dashboard");
    showSettings(dashboard.setup, dashboard.can_edit_opening_stock, feedback);
  });
  save("rates", "rates", "Selling rates saved.");
  save("nozzle", "nozzle", "Nozzle added.");
  if (canEditStock) save("stock", "opening_stock", "Opening stock saved.");
  else document.querySelector("#stock").addEventListener("submit", event => event.preventDefault());
}

async function initialize() {
  if (!role) {
    showLanding();
    return;
  }
  document.title = roleTitle + " | Pump Ledger";
  try {
    session = await api("/session");
    await showHome();
  } catch (error) {
    showLogin(error.status === 401 ? "" : error.message);
  }
}

initialize();
