"use strict";

const root = document.querySelector("#app");
const appName = "Tuljai Petroleum";
const clientName = "Tuljai Realtors & Petroleum";
const brandLogo = document.querySelector('meta[name="brand-logo"]')?.content || "/tuljai-logo.jpg";
const role = { "/": "owner", "/manager": "manager", "/owner": "owner" }[location.pathname];
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
  let response;
  try {
    response = await fetch("/api/" + role + path, options);
  } catch {
    throw new Error(`Could not reach ${appName}. Check your connection and try again.`);
  }
  const unavailable = `${appName} is temporarily unavailable. Please try again in a moment.`;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error(unavailable), { status: response.status });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error(unavailable), { status: response.status });
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error || unavailable), { status: response.status });
  }
  return payload;
}

const glyphs = {
  pump: '<path d="M4 20V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 20h12M7 7h4v4H7zM14 13h2a2 2 0 0 1 2 2v2a1.5 1.5 0 0 0 3 0V9l-3-3"/>',
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zm3 5h6m-6 4h6m-6 4h3"/>',
  warning: '<path d="M12 3 2.8 19h18.4L12 3zm0 6v4m0 3h.01"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${glyphs[name]}</svg>`;
}

function brand() {
  return `<a class="brand" href="/${role || "owner"}">
    <img class="brand-logo" src="${safe(brandLogo)}" width="54" height="48" alt="">
    <span class="brand-name">Tuljai<small>Realtors &amp; Petroleum</small></span>
  </a>`;
}

function showLogin(message = "") {
  const demoMode = document.querySelector('meta[name="demo-mode"]');
  root.innerHTML = `<div class="entry">
    <header class="entry-header">${brand()}</header>
    <main class="login card">
      <p class="eyebrow">${roleTitle}</p><h1>Sign in</h1>
      <form id="login">
        <label>Mobile number or email<input required name="identifier" autocomplete="username" autocapitalize="none" maxlength="254"></label>
        <div class="password-entry">
          <label for="password">Password</label>
          <div class="password-input">
            <input id="password" required name="password" type="password" autocomplete="current-password">
            <button id="password-toggle" class="password-toggle" type="button" aria-controls="password">Show password</button>
          </div>
        </div>
        <div class="form-error" role="alert">${safe(message)}</div>
        <button class="primary">Sign in ${icon("arrow")}</button>
      </form>
      ${demoMode ? '<button id="demo" type="button" class="text-button">Fill demo sign-in</button>' : ""}
    </main>
  </div>`;
  const login = document.querySelector("#login");
  if (message) login.elements.identifier.focus();
  const toggle = document.querySelector("#password-toggle");
  toggle.addEventListener("click", () => {
    const password = login.elements.password;
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    toggle.textContent = show ? "Hide password" : "Show password";
  });
  const demoButton = document.querySelector("#demo");
  demoButton?.addEventListener("click", () => {
    login.elements.identifier.value = role + "@demo.local";
    login.elements.password.value = role === "owner" ? "OwnerDemo123!" : "ManagerDemo123!";
    login.querySelector(".primary").focus();
  });
  bindForm("login", async form => {
    await api("/login", fields(form));
    await showHome();
  }, false);
}

function shell(content, view = "home") {
  const navigation = role === "owner"
    ? [["home", "Overview"], ["daily-report", "Daily report"], ["settings", "Settings"], ["team", "Team"]]
    : [["home", "Shift operations"]];
  const shouldFocus = document.activeElement && document.activeElement !== document.body;
  root.innerHTML = `<a class="skip-link" href="#main-content">Skip to main content</a>
    <header class="workspace-header">
      <div class="header-inner">
        ${brand()}
        <div class="header-station"><strong>${safe(session.station)}</strong><small>${safe(session.station_code)}</small></div>
        <div class="account"><span class="account-name">${safe(session.name)}</span>
          <button id="logout" class="sign-out" type="button">Sign out</button>
        </div>
      </div>
      <nav class="app-nav" aria-label="${roleTitle} navigation">${navigation.map(([id, label]) =>
        `<button class="nav-button" id="${id}" type="button" ${view === id ? 'aria-current="page"' : ""}>${label}</button>`
      ).join("")}</nav>
    </header>
    <main id="main-content" tabindex="-1" class="page"><p id="notice" role="alert" class="notice" hidden></p>${content}</main>`;
  if (shouldFocus) root.querySelector("main h1")?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  listen("logout", async () => {
    await api("/logout", {});
    session = null;
    selectedDate = undefined;
    lastSubmission = undefined;
    showLogin();
    document.querySelector("#login").elements.identifier.focus();
  });
  listen("home", role === "owner" ? showHome : () => {
    root.querySelector("main h1")?.focus();
  });
  if (role === "owner") {
    listen("settings", openSettings);
    listen("daily-report", openDailyReport);
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
      if (notice) {
        notice.hidden = false;
        notice.textContent = error.message;
      }
    }
  });
}

function bindForm(id, onSubmit, expire = true) {
  const form = document.getElementById(id);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter || form.querySelector('button:not([type="button"])');
    const errorbox = form.querySelector(".form-error");
    if (button.disabled) return;
    const label = button.innerHTML;
    button.disabled = true;
    button.textContent = "Working…";
    form.setAttribute("aria-busy", "true");
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
      button.innerHTML = label;
      form.removeAttribute("aria-busy");
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
  return `<div class="page-heading">${eyebrow ? `<p class="eyebrow">${safe(eyebrow)}</p>` : ""}<h1 tabindex="-1">${safe(title)}</h1>
    ${description ? `<p>${safe(description)}</p>` : ""}</div>`;
}

function fuelTag(fuel) {
  return `<span class="fuel-tag ${fuel.toLowerCase()}">${fuel}</span>`;
}

async function showHome() {
  const state = await api(role === "manager" ? "/shift" :
    "/dashboard" + (selectedDate ? "?date=" + encodeURIComponent(selectedDate) : ""));
  session = state.session;
  if (role === "manager") showManager(state);
  else showOwner(state);
}

function showManager(state) {
  if (state.active) {
    showClosing(state.active);
    return;
  }
  const setup = state.setup;
  const missingRates = fuelNames.some(fuel => !setup.fuels[fuel].rate);
  shell(`${heading("Station operations", "Open a shift", "Confirm the opening meter readings before starting operations.")}
    ${lastSubmission ? `<div class="success" role="status">Shift #${lastSubmission.id} submitted by ${safe(lastSubmission.submitter)}.</div>` : ""}
    <form id="open-shift" class="work-grid">
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
      <section class="card shift-start"><h2>Selling rates</h2><dl class="key-values">
        ${fuelNames.map(fuel => `<div><dt>${fuel}</dt><dd>${setup.fuels[fuel].rate ? money(setup.fuels[fuel].rate) + " / L" : "Not set"}</dd></div>`).join("")}
      </dl>
      ${missingRates ? '<p class="form-help">Ask the owner to set both fuel rates before opening a shift.</p>'
        : `${errorbox}<button class="primary">Open shift ${icon("arrow")}</button>`}</section>
    </form>`);
  if (missingRates) {
    document.querySelector("#open-shift").addEventListener("submit", event => event.preventDefault());
    return;
  }
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

function ledgerSummary(items) {
  return `<dl class="ledger-summary">${items.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

function reviewStatus(shift) {
  return `<span class="status ${shift.reviewed_at ? "reviewed" : ""}">${shift.reviewed_at ? "Reviewed" : "Awaiting review"}</span>`;
}

function bindDateFilter(endpoint, render) {
  listen("date", async event => {
    const control = event.target;
    const date = control.value;
    if (!date || date === selectedDate) return;
    control.setAttribute("aria-busy", "true");
    try {
      const updated = await api(endpoint + "?date=" + encodeURIComponent(date));
      if (!control.isConnected || control.value !== date) return;
      render(updated);
      document.querySelector("#date").focus({ preventScroll: true });
    } catch (error) {
      if (!control.isConnected || control.value !== date) return;
      control.value = selectedDate;
      throw error;
    } finally {
      control.removeAttribute("aria-busy");
    }
  }, "change");
}

function showOwner(data) {
  selectedDate = data.date;
  const totalSales = fuelNames.reduce((total, fuel) => total + data.daily[fuel].sales, 0);
  const totalVolume = fuelNames.reduce((total, fuel) => total + data.daily[fuel].litres, 0);
  const pending = data.shifts.filter(shift => !shift.reviewed_at).length;
  const missingRates = fuelNames.some(fuel => !data.setup.fuels[fuel].rate);
  shell(`<div class="dashboard-heading">
    ${heading("OWNER WORKSPACE", "Station overview", businessDay(data.date))}
    <div class="report-controls"><label class="date-control">Business date<input id="date" type="date" value="${safe(data.date)}"></label>
      <button id="open-daily-report" class="secondary" type="button">Open daily report ${icon("arrow")}</button></div>
  </div>
  ${missingRates ? `<div class="setup-notice"><span class="setup-icon">${icon("warning")}</span>
    <div><strong>Complete your station setup</strong><p>Set selling rates for Petrol and Diesel to enable the first shift.</p></div>
    <button id="setup-rates" class="secondary" type="button">Set fuel rates ${icon("arrow")}</button></div>` : ""}
  <div class="owner-layout">
    <section class="sales-surface" aria-label="Daily fuel sales">
      <div class="sales-head"><span>Fuel sales</span><span>${data.shifts.length} submitted shifts</span></div>
      <strong class="sales-amount">${money(totalSales)}</strong>
      <p class="sales-caption">${volume(totalVolume)} sold across Petrol and Diesel</p>
      <div class="fuel-performance">${fuelNames.map(fuel => {
        const sales = data.daily[fuel];
        return `<div><span class="fuel-name">${fuel}</span><strong>${money(sales.sales)}</strong>
          <span>${volume(sales.litres)} sold</span><small>Selling rate ${data.setup.fuels[fuel].rate ? money(data.setup.fuels[fuel].rate) + " / L" : "not configured"}</small></div>`;
      }).join("")}</div>
      <div class="sales-foot">Sales recorded for ${safe(businessDay(data.date))}</div>
    </section>
    <aside class="attention-surface">
      <h2>Shift review</h2>
      <strong class="review-number">${pending}<span>awaiting review</span></strong>
      <p>${pending ? "Open a submitted shift below to check collections and cash differences." :
        data.shifts.length ? "All submitted shifts for this date have been reviewed." : "Your manager’s submitted shifts will appear here."}</p>
      <dl class="review-breakdown"><div><dt>Submitted</dt><dd>${data.shifts.length}</dd></div>
        <div><dt>Reviewed</dt><dd>${data.shifts.length - pending}</dd></div>
        <div><dt>Cash differences</dt><dd>${data.shifts.filter(shift => shift.cash_difference !== 0).length} shifts</dd></div></dl>
    </aside>
    <section class="inventory-surface">
      <header class="section-head"><div><h2>Fuel inventory</h2><p>Calculated through the latest submitted shift</p></div></header>
      <div class="inventory-grid">${fuelNames.map(fuel => {
        const item = data.stock[fuel];
        return `<details class="stock-detail">
          <summary><span>${fuelTag(fuel)}<small>Calculated stock</small></span>
            <strong class="${item.calculated < 0 ? "discrepancy" : ""}">${volume(item.calculated)}</strong></summary>
          <dl class="key-values">
            <div><dt>Opening stock</dt><dd>${volume(item.opening)}</dd></div>
            <div><dt>Delivered</dt><dd>${volume(item.delivery)}</dd></div>
            <div><dt>Metered sales</dt><dd>${volume(item.sold)}</dd></div>
            <div><dt>Latest physical stock</dt><dd>${item.physical ? volume(item.physical.litres) : "No reading"}</dd></div>
          </dl>
          ${item.physical ? `<small>Measured in shift #${item.physical.shift_id} · ${timestamp(item.physical.at)}</small>` : ""}
        </details>`;
      }).join("")}</div>
    </section>
  </div>
  <div class="ledger-sheet">
  <section class="ledger-section">
    <header class="section-head"><h2 id="shift-heading">Submitted shifts</h2></header>
    ${data.shifts.length ? `<div class="table-scroll" role="region" aria-labelledby="shift-heading" tabindex="0">
      <table class="shift-table">
        <thead><tr><th scope="col">Shift / submitted by</th><th scope="col">Submitted at</th><th scope="col" class="numeric">Metered sales</th>
          <th scope="col" class="numeric">Cash difference</th><th scope="col">Review status</th><th scope="col"><span class="sr-only">Open report</span></th></tr></thead>
        <tbody>${data.shifts.map(shift => `<tr>
          <th scope="row"><strong>Shift #${shift.id}</strong><small>${safe(shift.submitter)}</small></th>
          <td>${timestamp(shift.submitted_at)}</td><td class="numeric">${money(shift.sales)}</td>
          <td class="numeric ${shift.cash_difference ? "discrepancy" : ""}">${money(shift.cash_difference)}</td>
          <td>${reviewStatus(shift)}</td>
          <td><button class="row-action" id="shift-${shift.id}" type="button" aria-label="Open shift ${shift.id} report">${icon("arrow")}</button></td>
        </tr>`).join("")}</tbody>
      </table></div>` : '<p class="ledger-empty">No shifts submitted for this business date.</p>'}
  </section></div>`);
  if (missingRates) listen("setup-rates", openSettings);
  bindDateFilter("/dashboard", showOwner);
  listen("open-daily-report", openDailyReport);
  for (const shift of data.shifts) {
    listen("shift-" + shift.id, async () => showReport(await api("/shifts/" + shift.id)));
  }
}

function showReport(shift, source = "home") {
  const cashRows = [
    ...Object.entries(methodNames).map(([method, label]) => [label, shift.collections[method]]),
    ["Total collections", shift.collection_total],
    ["Collections − metered sales", shift.collection_difference, true],
    ["Till expenses", shift.expenses],
    ["Expected cash (cash − expenses)", shift.expected],
    ["Actual cash counted", shift.counted],
    ["Cash difference (actual − expected)", shift.cash_difference, true],
  ];
  shell(`<button id="back" type="button" class="text-button back">← ${source === "daily-report" ? "Daily report" : "Daily dashboard"}</button>
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
    </aside></div>`, source);
  listen("back", source === "daily-report" ? openDailyReport : showHome);
  if (!shift.review) {
    bindForm("review", async form => showReport(await api("/shifts/" + shift.id + "/review", fields(form)), source));
  }
}

async function openTeam() {
  showTeam(await api("/managers"));
}

function showTeam(managers, added = false) {
  shell(`${heading("", "Team", "Create and view station manager accounts.")}
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
        <label>Password<input name="password" type="password" required minlength="7" maxlength="200"
          autocomplete="new-password" aria-describedby="manager-password-help"></label>
        <small id="manager-password-help">Use a password of 7–200 characters.</small>
        ${errorbox}<button class="primary">Create manager account</button>
      </form>
    </section>`, "team");
  bindForm("add-manager", async form => {
    const manager = await api("/managers", fields(form));
    showTeam([...managers, manager], true);
  });
}

async function openSettings() {
  const dashboard = await api("/settings");
  showSettings(dashboard.setup, dashboard.can_edit_opening_stock);
}

function showSettings(setup, canEditStock, confirmation = "") {
  shell(`${heading("", "Station settings", "Manage selling rates, nozzles and opening stock.")}
    ${confirmation ? `<div class="success" role="status">${safe(confirmation)}</div>` : ""}
    <section class="card"><header class="section-head"><div><h2>Selling rates</h2><p>Rate changes apply when the manager opens a shift.</p></div></header>
      <form id="rates"><div class="field-grid">
        ${fuelNames.map(fuel => numberField(fuel + " (₹ / L)", fuel, {
          value: setup.fuels[fuel].rate ? decimal(setup.fuels[fuel].rate, 100) : undefined, required: true, min: 0.01, max: 1000,
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
    </section>`, "settings");
  const save = (id, field, feedback) => bindForm(id, async form => {
    await api("/settings", { [field]: fields(form) });
    const dashboard = await api("/settings");
    showSettings(dashboard.setup, dashboard.can_edit_opening_stock, feedback);
  });
  save("rates", "rates", "Selling rates saved.");
  save("nozzle", "nozzle", "Nozzle added.");
  if (canEditStock) save("stock", "opening_stock", "Opening stock saved.");
  else document.querySelector("#stock").addEventListener("submit", event => event.preventDefault());
}

async function initialize() {
  document.title = roleTitle + " | " + appName;
  try {
    await showHome();
  } catch (error) {
    showLogin(error.status === 401 ? "" : error.message);
  }
}

initialize();
