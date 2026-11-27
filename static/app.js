"use strict";

const root = document.querySelector("#app");
const installBar = document.querySelector("#install-bar");
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
const businessDay = (value, dateStyle = "long") => new Intl.DateTimeFormat("en-IN", {
  dateStyle, timeZone: "Asia/Kolkata",
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

function authPage(content) {
  const owner = role === "owner";
  return `<div class="auth-page">
    <aside class="auth-brand-panel" aria-label="Tuljai Petroleum">
      ${brand()}
      <div class="auth-brand-copy">
        <span class="auth-brand-line" aria-hidden="true"></span>
        <p class="auth-brand-title">Fuel station<br>workspace</p>
        <p class="auth-brand-detail">${owner
          ? "Track sales, stock and the station’s finances."
          : "Record readings, collections and deliveries."}</p>
      </div>
    </aside>
    <div class="auth-content">${content}</div>
    <footer class="auth-footer">
      <a href="/${owner ? "manager" : "owner"}">${owner ? "Manager sign-in" : "Owner sign-in"}</a>
      <div id="auth-install"></div>
    </footer>
  </div>`;
}

function mountAuth(content) {
  if (installBar) document.body.append(installBar);
  root.innerHTML = authPage(content);
  if (installBar) root.querySelector("#auth-install").append(installBar);
}

function showLogin(message = "") {
  contactRequest = undefined;
  const demoMode = document.querySelector('meta[name="demo-mode"]');
  mountAuth(`<main class="auth-form-panel">
    <header class="auth-heading">
      <p class="eyebrow">${roleTitle}</p>
      <h1 id="auth-title" tabindex="-1">Sign in</h1>
      <p id="auth-description">Enter your account details to continue.</p>
    </header>
    <form id="login" class="auth-form" data-step="password">
      <div id="sign-in-credentials" class="auth-fields">
        <label>Mobile number or email<input required name="identifier" autocomplete="username" autocapitalize="none" maxlength="254"></label>
        <div>
          <label for="password">Password</label>
          <div class="password-input">
            <input id="password" required name="password" type="password" autocomplete="current-password" maxlength="200">
            <button id="password-toggle" class="password-toggle" type="button" aria-controls="password">Show password</button>
          </div>
        </div>
      </div>
      <div id="sign-in-verification" hidden>
        <label>Authenticator or recovery code<input name="code" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" maxlength="40" disabled></label>
      </div>
      <div class="form-error" role="alert">${safe(message)}</div>
      <button class="primary auth-primary">
        <span class="auth-password-label">Sign in</span><span class="auth-verification-label">Verify and sign in</span>${icon("arrow")}
      </button>
      <button id="auth-back" type="button" class="text-button auth-back" hidden>Back to sign in</button>
    </form>
    ${demoMode ? '<button id="demo" type="button" class="text-button auth-demo">Fill demo sign-in</button>' : ""}
  </main>`);
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
  const showVerification = active => {
    login.dataset.step = active ? "verification" : "password";
    document.querySelector("#auth-title").textContent = active ? "Verify your sign-in" : "Sign in";
    document.querySelector("#auth-description").textContent = active
      ? "Enter the six-digit code from your authenticator app, or use a recovery code."
      : "Enter your account details to continue.";
    document.querySelector("#sign-in-credentials").hidden = active;
    document.querySelector("#sign-in-verification").hidden = !active;
    document.querySelector("#auth-back").hidden = !active;
    if (demoButton) demoButton.hidden = active;
    login.elements.code.disabled = !active;
    login.elements.code.required = active;
    if (active) {
      login.elements.password.type = "password";
      toggle.textContent = "Show password";
      login.elements.code.focus();
    } else {
      login.elements.code.value = "";
      login.querySelector(".form-error").textContent = "";
      login.elements.identifier.focus();
    }
  };
  listen("auth-back", () => showVerification(false));
  bindForm("login", async form => {
    const result = await api("/login", fields(form));
    if (result.mfa_required) {
      showVerification(true);
      return;
    }
    await showHome();
  }, false);
}

const ownerNavigation = [
  ["Station", [["home", "Overview"], ["daily-report", "Daily report"], ["money", "Receivables"]]],
  ["Payments", [["payroll", "Payroll"], ["payables", "Payables"]]],
  ["Station operations", [["operations", "Operations"], ["banking", "Banking"], ["exceptions", "Exceptions"], ["automation", "Automation"]]],
  ["Administration", [["settings", "Settings"], ["contacts", "Contacts"], ["team", "Team"], ["security", "Account security"]]],
];

function workspaceNavigation(view) {
  const links = items => items.map(([id, label]) =>
    `<button class="nav-button" id="${id}" type="button" ${view === id ? 'aria-current="page"' : ""}>${navigationIcon(id)}<span>${label}</span></button>`
  ).join("");
  if (role === "manager") return links([["home", "Shift operations"], ["requests", "Owner requests"], ["security", "Account security"]]);
  const [[label, primary], ...other] = ownerNavigation;
  const group = ([heading, items]) => `<div class="owner-nav-group" role="group" aria-label="${heading}"><span class="owner-nav-label" aria-hidden="true">${heading}</span>${links(items)}</div>`;
  const moreActive = other.some(([, items]) => items.some(([id]) => id === view));
  return `${group([label, primary])}
    <button id="owner-more" class="nav-button" type="button" aria-expanded="false" aria-controls="owner-nav-more"${moreActive ? ' data-current' : ''}>${navigationIcon("more")}<span>More</span></button>
    <div id="owner-nav-more">${other.map(group).join("")}</div>`;
}

function shell(content, view = "home") {
  stopManagerDraft?.();
  const shouldFocus = document.activeElement && document.activeElement !== document.body;
  if (installBar) document.body.append(installBar);
  root.innerHTML = `<a class="skip-link" href="#main-content">Skip to main content</a>
    <div class="app-shell ${role === "owner" ? "owner-shell" : "manager-shell"}">
      <aside class="workspace-sidebar" aria-label="Workspace">
        ${brand()}
        ${role === "manager" ? '<p class="sidebar-caption">Daily operations</p>' : ""}
        <nav class="app-nav" aria-label="${roleTitle} navigation">${workspaceNavigation(view)}</nav>
        <div class="sidebar-footer"><span class="sidebar-role">${roleTitle}</span><div id="sidebar-install"></div></div>
      </aside>
      <div class="workspace-body">
        <header class="workspace-header"><div class="header-inner">
          <div class="header-station"><strong>${safe(session.station)}</strong><small>${safe(session.station_code)}</small></div>
          <div class="account"><span class="account-avatar" aria-hidden="true">${safe(session.name.slice(0, 1))}</span><span class="account-name">${safe(session.name)}</span>
            ${role === "owner" ? '<button id="whatsapp-compose" class="text-button" type="button">WhatsApp</button>' : ""}
            <button id="logout" class="sign-out" type="button">Sign out</button>
          </div>
        </div></header>
        <main id="main-content" data-view="${view}" tabindex="-1" class="page"><p id="notice" role="alert" class="notice" hidden></p>${content}${role === "owner" ? '<dialog id="money-dialog" aria-labelledby="money-dialog-title"></dialog>' : ""}</main>
      </div>
    </div>`;
  if (installBar) document.querySelector('#sidebar-install').append(installBar);
  const nav = document.querySelector('.app-nav'), currentNav = nav.querySelector('[aria-current="page"]');
  if (currentNav && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = currentNav.offsetLeft - nav.offsetLeft - (nav.clientWidth - currentNav.offsetWidth) / 2;
  if (shouldFocus) root.querySelector("main h1")?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  listen("logout", async () => {
    if (role === "manager" && saveManagerDraftBeforeLogout && !await saveManagerDraftBeforeLogout()
        && !window.confirm("Some shift entries could not be saved. Sign out and discard the unsaved entries in this tab?")) return;
    await api("/logout", {});
    ownerViewRequest++;
    if (role === "manager") {
      stopManagerDraft?.();
      clearManagerDrafts(session);
    }
    session = null;
    selectedDate = undefined;
    lastSubmission = undefined;
    showLogin();
    document.querySelector("#login").elements.identifier.focus();
  });
  listen("home", showHome);
  listen("security", openAccountSecurity);
  if (role === "manager") listen("requests", openManagerRequests);
  if (role === "owner") {
    const more = document.getElementById("owner-more");
    const setMore = expanded => more.setAttribute("aria-expanded", String(expanded));
    listen("owner-more", () => setMore(more.getAttribute("aria-expanded") !== "true"));
    nav.addEventListener("keydown", event => {
      if (event.key !== "Escape" || more.getAttribute("aria-expanded") !== "true") return;
      event.preventDefault();
      setMore(false);
      more.focus();
    });
    listen("whatsapp-compose", () => openWhatsAppComposer());
    listen("settings", openSettings);
    listen("daily-report", openDailyReport);
    listen("team", openTeam);
    listen("contacts", openContacts);
    listen("automation", () => openAutomation());
    for (const view of ["payroll", "payables"]) listen(view, () => openOutgoings(view));
    for (const view of ["money", "banking", "operations", "exceptions"]) listen(view, () => openBusiness(view));
  }
}

function listen(id, action, event = "click") {
  document.getElementById(id).addEventListener(event, async e => {
    const control = e.currentTarget;
    const isNavigation = control.classList.contains("nav-button");
    if (isNavigation && control.getAttribute("aria-busy") === "true") return;
    if (isNavigation) control.setAttribute("aria-busy", "true");
    try {
      await action(e);
    } catch (error) {
      if (error.status === 401) {
        showLogin("Your session has expired. Sign in again.");
        return;
      }
      const notice = document.querySelector("#notice");
      if (notice) {
        notice.className = "notice";
        notice.hidden = false;
        notice.textContent = error.message;
      }
    } finally {
      if (isNavigation) control.removeAttribute("aria-busy");
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

let ownerViewRequest = 0;

async function loadOwnerView(path, render) {
  const request = ++ownerViewRequest;
  try {
    const state = await api(path);
    if (request === ownerViewRequest) render(state);
  } catch (error) {
    if (request === ownerViewRequest) throw error;
  }
}

function ownerDatePath(path, date = selectedDate) {
  return date ? path + "?date=" + encodeURIComponent(date) : path;
}

async function showHome() {
  if (role === "owner") {
    return loadOwnerView(ownerDatePath("/dashboard"), state => {
      session = state.session;
      showOwner(state);
    });
  }
  const state = await api("/shift");
  session = state.session;
  showManager(state);
}

function showManager(state) {
  if (state.active) {
    showManagerEntry(state.active);
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
      <section class="card card-flow shift-start"><h2>Selling rates</h2><dl class="key-values">
        ${fuelNames.map(fuel => `<div><dt>${fuel}</dt><dd>${setup.fuels[fuel].rate ? money(setup.fuels[fuel].rate) + " / L" : "Not set"}</dd></div>`).join("")}
      </dl>
      ${missingRates ? `<div class="inline-warning">${icon("warning")}<div><strong>Waiting for fuel rates</strong><p>Ask the owner to set the selling rates in Station settings before you open the shift.</p></div></div>`
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
    showManagerEntry(active);
  });
}

function showClosing(active, original = null, source = "home") {
  shell(`${heading("Shift #" + active.id + " · " + businessDay(active.business_date), original ? "Correct submitted shift" : "Close shift",
    "Enter the closing readings and reconcile the till before submitting.")}
    <form id="close-shift">
      ${original ? '<label class="card">Reason for correcting this report<textarea name="correction_reason" required maxlength="500"></textarea><small>The original report is retained. Later shifts, bank reconciliation records or customer repayments can prevent a correction.</small></label>' : ""}
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
          ${entrySection("deliveries", "Fuel delivery entries", "Record each delivery with its supplier and challan. Entries calculate the delivery totals above.")}
          ${entrySection("payments", "Payment entries", "Add transactions or settlement batches. Entries calculate the total for that payment method below. Credit entries require a customer name.")}
          ${entrySection("expenses", "Till expense entries", "Record each expense paid from the till. Entries calculate the expense total below.")}
          <section class="card">
            <header class="section-head"><div><h2>Collections and till</h2><p>Enter totals directly or add detailed entries above. Totals with entries are calculated automatically.</p></div></header>
            <div class="field-grid">
              ${Object.entries(methodNames).map(([key, label]) => numberField(label + " (₹)", key)).join("")}
              ${numberField("Till expenses (₹)", "expenses")}
              ${numberField("Actual cash counted (₹)", "counted", { required: true })}
            </div>
            <label>Expense note <span class="quiet">(optional)</span><textarea name="expense_note" maxlength="250" rows="2"></textarea></label>
            <label>Shift notes / handover<textarea name="shift_note" maxlength="1000" rows="3" placeholder="Equipment issues, delivery concerns or handover instructions"></textarea></label>
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
          ${errorbox}<button class="primary">${original ? "Save report correction" : "Submit shift closing"}</button>
          ${original ? '<button type="button" id="cancel-correction" class="secondary">Cancel correction</button>' : ""}
          <p class="quiet submit-help">${original ? "The original report is retained and the corrected report will need review again." : "Submission locks the shift report and makes it available to the owner."}</p>
        </aside>
      </div>
    </form>`);
  const form = bindForm("close-shift", async form => {
    const values = fields(form);
    const byFuel = prefix => Object.fromEntries(fuelNames.map(fuel => [fuel, values[prefix + fuel]]));
    lastSubmission = await api("/shifts/" + active.id + (original ? "/revise" : "/submit"), {
      correction_reason: values.correction_reason, expected_version: original?.version,
      closings: Object.fromEntries(active.nozzles.map(nozzle => [nozzle.id, values["closing_" + nozzle.id]])),
      deliveries: byFuel("delivery_"), physical: byFuel("physical_"),
      collections: Object.fromEntries(Object.keys(methodNames).map(key => [key, values[key]])),
      expenses: values.expenses, counted: values.counted, expense_note: values.expense_note,
      entries: collectEntries(form), shift_note: values.shift_note,
    });
    if (original) {
      showReport(lastSubmission, source);
      showBusinessNotice("Correction saved. Original report retained.");
      return;
    }
    await showHome();
  });
  bindManagerEntries(form, active);
  if (original) {
    listen("cancel-correction", () => showReport(original, source));
    fillCorrectionForm(form, original);
  }
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
  const collections = Object.keys(methodNames).filter(key => form.elements[key]).map(key => inputAmount(form, key, 100));
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

function ownerToday() {
  const parts = new Intl.DateTimeFormat("en-IN", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Kolkata",
  }).formatToParts(new Date());
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return [date.year, date.month, date.day].join("-");
}

function bindDateFilter(endpoint, render) {
  const control = document.querySelector("#date");
  const controls = document.querySelector(".report-controls");
  const buttons = [...controls.querySelectorAll("button")];
  let dateRequest = 0;
  const update = async (source = "date") => {
    if (!control.value) control.value = selectedDate;
    const date = control.value;
    const request = ++ownerViewRequest;
    const localRequest = ++dateRequest;
    const isCurrent = () => control.isConnected && request === ownerViewRequest && control.value === date;
    const setBusy = busy => {
      control.setAttribute("aria-busy", String(busy));
      for (const button of buttons) button.disabled = busy;
    };
    if (date === selectedDate && source !== "refresh-day") {
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const updated = await api(ownerDatePath(endpoint, date));
      if (!isCurrent()) return;
      render(updated);
      document.getElementById(source)?.focus({ preventScroll: true });
    } catch (error) {
      if (!isCurrent()) return;
      control.value = selectedDate;
      throw error;
    } finally {
      // A newer date within this view owns the busy state until its request settles.
      if (localRequest === dateRequest && control.isConnected) {
        control.value = selectedDate;
        setBusy(false);
      }
    }
  };
  listen("date", () => update(), "change");
  listen("date-today", () => {
    control.value = ownerToday();
    return update("date-today");
  });
  if (document.querySelector("#refresh-day")) listen("refresh-day", () => update("refresh-day"));
}

function showOwner(data) {
  const business = data.business;
  selectedDate = data.date;
  const totalSales = fuelNames.reduce((total, fuel) => total + data.daily[fuel].sales, 0);
  const totalVolume = fuelNames.reduce((total, fuel) => total + data.daily[fuel].litres, 0);
  const waiting = data.shifts.filter(shift => !shift.reviewed_at);
  const pending = waiting.length;
  const missingRates = fuelNames.some(fuel => !data.setup.fuels[fuel].rate);
  const needsOpeningStock = data.can_edit_opening_stock && !data.opening_stock_confirmed;
  shell(`<div class="dashboard-heading">
    ${heading("", "Station overview")}
    <div class="report-controls"><label class="date-control">Business date<input id="date" type="date" value="${safe(data.date)}"></label>
      <button id="date-today" class="secondary" type="button">Today</button>
      <button id="open-daily-report" class="primary" type="button">Open daily report ${icon("arrow")}</button></div>
  </div>
  ${missingRates || needsOpeningStock ? `<section class="setup-notice" aria-label="First-shift setup"><span class="setup-icon">${icon("warning")}</span>
    <div><strong>Set up your first shift</strong>
      <p>${needsOpeningStock ? "Confirm how much fuel is already in each tank before the first shift is submitted." : "Add Petrol and Diesel selling rates."}</p></div>
    <div class="owner-setup-actions">
      ${missingRates ? '<button id="setup-rates" class="secondary" type="button">Set fuel rates</button>' : ""}
      ${needsOpeningStock ? '<button id="setup-stock" class="secondary" type="button">Confirm opening stock</button>' : ""}
    </div></section>` : ""}
  <section class="owner-quick-actions" aria-label="Quick actions">
    <button id="quick-customer" class="secondary" type="button">${navigationIcon("money")} Add customer</button>
    <button id="quick-bill" class="secondary" type="button">${navigationIcon("payables")} Add bill</button>
    <button id="quick-salary" class="secondary" type="button">${navigationIcon("payroll")} Add salary</button>
  </section>
  <div class="owner-layout">
    <section class="sales-surface" aria-label="Daily fuel sales">
      <div class="sales-head"><h2>Fuel sales</h2><span class="sales-period">${businessDay(data.date)}</span></div>
      <strong class="sales-amount">${money(totalSales)}</strong>
      <p class="sales-caption">${volume(totalVolume)} sold across Petrol and Diesel</p>
      <div class="fuel-performance">${fuelNames.map(fuel => {
        const sales = data.daily[fuel];
        return `<div><span class="fuel-name">${fuel}</span><strong>${money(sales.sales)}</strong>
          <span>${volume(sales.litres)} sold</span><small>Selling rate ${data.setup.fuels[fuel].rate ? money(data.setup.fuels[fuel].rate) + " / L" : "not configured"}</small></div>`;
      }).join("")}</div>
    </section>
    <section class="attention-surface" aria-label="Shift review">
      <h2>Shift review</h2>
      <strong class="review-number">${pending}<span>awaiting review</span></strong>
      ${pending ? "" : `<p>${data.shifts.length ? "All submitted shifts have been reviewed." : "Submitted shifts will appear here for review."}</p>`}
      <dl class="review-breakdown"><div><dt>Submitted</dt><dd>${data.shifts.length}</dd></div>
        <div><dt>Reviewed</dt><dd>${data.shifts.length - pending}</dd></div>
        <div><dt>Cash differences</dt><dd>${data.shifts.filter(shift => shift.cash_difference !== 0).length} shifts</dd></div></dl>
      ${pending ? '<button id="review-next-shift" class="primary owner-review-next" type="button">Review next shift ' + icon("arrow") + '</button>' : ""}
    </section>
    ${businessOverview(business)}
    <div class="ledger-sheet owner-submitted">
      <section class="ledger-section">
        <header class="section-head"><h2 id="shift-heading">Submitted shifts</h2></header>
        ${data.shifts.length ? `<div class="table-scroll" role="region" aria-labelledby="shift-heading" tabindex="0">
          <table class="shift-table" role="table">
          <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Shift / submitted by</th><th scope="col" role="columnheader">Submitted at</th><th scope="col" role="columnheader" class="numeric">Metered sales</th>
            <th scope="col" role="columnheader" class="numeric">Cash difference</th><th scope="col" role="columnheader">Review status</th><th scope="col" role="columnheader"><span class="sr-only">Open report</span></th></tr></thead>
          <tbody role="rowgroup">${data.shifts.map(shift => `<tr role="row">
            <th scope="row" role="rowheader"><strong>Shift #${shift.id}</strong><small>${safe(shift.submitter)}</small></th>
            <td role="cell" class="shift-submitted-at">${timestamp(shift.submitted_at)}</td>
            <td role="cell" class="numeric"><span class="shift-mobile-label" aria-hidden="true">Metered sales</span>${money(shift.sales)}</td>
            <td role="cell" class="numeric ${shift.cash_difference ? "discrepancy" : ""}"><span class="shift-mobile-label" aria-hidden="true">Cash difference</span>${money(shift.cash_difference)}</td>
            <td role="cell">${reviewStatus(shift)}</td>
            <td role="cell" class="shift-report-action"><button class="row-action" id="shift-${shift.id}" type="button" aria-label="Open shift ${shift.id} report"><span class="shift-mobile-label">Open shift</span>${icon("arrow")}</button></td>
          </tr>`).join("")}</tbody>
        </table></div>` : '<div class="shift-empty">' + icon("receipt") + '<strong>No submitted shifts yet</strong><p>Once a manager closes a shift, its sales and reconciliation will appear here.</p></div>'}
      </section></div>
    <section class="inventory-surface">
      <header class="section-head"><div><h2>Fuel inventory</h2><p>Book stock through the latest submitted shift</p></div></header>
      <div class="inventory-grid">${fuelNames.map(fuel => {
        const item = data.stock[fuel];
        return `<details class="stock-detail">
          <summary><span>${fuelTag(fuel)}<small>Calculated stock</small></span>
            <strong class="${item.calculated < 0 ? "discrepancy" : ""}">${volume(item.calculated)}</strong></summary>
          ${configuredTankStatus(fuel, item, business.tanks[fuel])}
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
  </div>`);
  bindBusinessOverview();
  listen("quick-customer", () => openBusiness("money", data => openCustomerForm(data)));
  listen("quick-bill", () => openOutgoings("payables", outgoingBillForm));
  listen("quick-salary", () => openOutgoings("payroll", outgoingSalaryForm));
  if (pending) listen("review-next-shift", () => openShiftReport(Math.min(...waiting.map(shift => shift.id))));
  if (missingRates) listen("setup-rates", openSettings);
  if (needsOpeningStock) listen("setup-stock", () => openOpeningStock(data.setup));
  bindDateFilter("/dashboard", showOwner);
  listen("open-daily-report", openDailyReport);
  for (const shift of data.shifts) {
    listen("shift-" + shift.id, () => openShiftReport(shift.id));
  }
}

function openShiftReport(id, source = "home") {
  return loadOwnerView("/shifts/" + id, shift => showReport(shift, source));
}

function showReport(shift, source = "home") {
  const sourceLabel = { home: "Overview", "daily-report": "Daily report", operations: "Operations", exceptions: "Exceptions" }[source];
  const cashRows = [
    ...Object.entries(methodNames).map(([method, label]) => [label, shift.collections[method]]),
    ["Total collections", shift.collection_total],
    ["Collections − metered sales", shift.collection_difference, true],
    ["Till expenses", shift.expenses],
    ["Expected cash (cash − expenses)", shift.expected],
    ["Actual cash counted", shift.counted],
    ["Cash difference (actual − expected)", shift.cash_difference, true],
  ];
  shell(`<button id="back" type="button" class="text-button back">← ${sourceLabel}</button>
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
      ${recordedEntries(shift.entries, shift.shift_note)}
      ${correctionPanel(shift)}
      <section class="card card-flow"><h2>Owner review</h2>
        ${shift.review ? `<p><span class="status reviewed">Reviewed</span> ${safe(shift.review.reviewer)} · ${timestamp(shift.review.reviewed_at)}</p>
          ${shift.review.review_note ? `<p class="review-note">${safe(shift.review.review_note)}</p>` : ""}`
          : `<form id="review" class="business-form"><label>Review note <span class="quiet">(optional)</span><textarea name="note" rows="3" maxlength="500"></textarea></label>
            ${errorbox}<button class="primary">Mark as reviewed</button></form>`}
      </section>
    </div>
    <aside class="card reconciliation"><h2>Collections and till</h2>
      <dl class="key-values">${cashRows.map(([label, value, discrepancy]) => `<div><dt>${label}</dt>
        <dd class="${discrepancy && value ? "discrepancy" : ""}">${money(value)}</dd></div>`).join("")}</dl>
      ${shift.expense_note ? `<p class="review-note"><strong>Expense note</strong> ${safe(shift.expense_note)}</p>` : ""}
    </aside></div>`, source);
  bindCorrectionPanel(shift, source);
  listen("back", () => {
    if (source === "home") return showHome();
    if (source === "daily-report") return openDailyReport();
    return openBusiness(source);
  });
  if (!shift.review) {
    bindForm("review", async form => showReport(await api("/shifts/" + shift.id + "/review", fields(form)), source));
  }
}

function openTeam() {
  return loadOwnerView("/managers", showTeam);
}

function showTeam(managers, added = false) {
  shell(`${heading("", "Team", "Create and view station manager accounts.")}
    ${added ? '<p class="success" role="status">Manager account created. Share the sign-in details privately.</p>' : ""}
    <div class="control-columns">
    <section class="card card-flow">
      <header class="section-head"><h2>Station managers</h2>
        <button id="account-audit" class="secondary" type="button">Account activity</button></header>
      ${managers.length ? '<div class="record-list">' + managers.map(managerControls).join("") + '</div>'
        : '<p class="inline-empty">No manager accounts yet.</p>'}
    </section>
    <section class="card card-flow">
      <h2>Add a station manager</h2>
      <form id="add-manager" class="business-form">
        <div class="field-grid">
          <label>Full name<input name="name" required maxlength="80" autocomplete="off"></label>
          <label>Mobile number<input name="phone" required type="tel" maxlength="24" placeholder="+91" autocomplete="off"></label>
        </div>
        <div><label for="manager-password">Password</label>
          <input id="manager-password" name="password" type="password" required minlength="15" maxlength="200"
            autocomplete="new-password" aria-describedby="manager-password-help">
          <small id="manager-password-help" class="field-help">Use a password of 15–200 characters.</small>
        </div>
        ${errorbox}<button class="primary">Create manager account</button>
      </form>
    </section></div>`, "team");
  listen("account-audit", async () => {
    const events = await api("/account-audit");
    const labels = {create: "Account created", disable: "Account disabled", enable: "Account enabled",
      edit: "Account updated", reset_password: "Password reset", revoke_sessions: "Sessions revoked",
      owner_reset: "Owner credentials reset", mfa_enabled: "Verification enabled",
      mfa_disabled: "Verification disabled", mfa_recovery: "Recovery code used"};
    moneyDialog("Account activity", events.length
      ? '<div class="recorded-entries">' + events.map(event =>
        `<div><strong>${safe(labels[event.action] || event.action)}</strong><p>${safe(event.target)}</p>
        <small>${safe(timestamp(event.created_at))} · ${safe(event.actor)}</small></div>`).join("") + '</div>'
      : "<p>No account changes recorded yet.</p>");
  });
  bindManagerControls(managers);
  bindForm("add-manager", async form => {
    await api("/managers", fields(form));
    showTeam(await api("/managers"), true);
  });
}

function openSettings() {
  return loadOwnerView("/settings", data => showSettings(data.setup, data.can_edit_opening_stock));
}

function openingStockFields(setup, readonly = false) {
  return fuelNames.map(fuel => numberField(fuel + " (L)", fuel, {
    step: "0.001", value: decimal(setup.fuels[fuel].opening_stock, 1000), required: true, readonly,
  })).join("");
}

function openOpeningStock(setup) {
  moneyDialog("Confirm opening stock", `<form id="confirm-opening-stock" class="money-form">
    <p class="money-form-hint">Use the measured starting balance for each fuel. Enter 0 for an empty tank. These balances lock when the first shift is submitted.</p>
    <div class="money-form-grid">${openingStockFields(setup)}</div>
    ${errorbox}<button class="primary">Save opening stock</button>
  </form>`);
  bindForm("confirm-opening-stock", async form => {
    await api("/settings", { opening_stock: fields(form) });
    await showHome();
    showBusinessNotice("Opening stock confirmed.");
  });
}

function showSettings(setup, canEditStock, confirmation = "") {
  shell(`${heading("", "Station settings", "Manage selling rates, nozzles and opening stock.")}
    ${confirmation ? `<div class="success" role="status">${safe(confirmation)}</div>` : ""}
    <div class="control-columns">
    <section class="card card-flow"><header class="section-head"><div><h2>Selling rates</h2><p>Rate changes apply when the manager opens a shift.</p></div></header>
      <form id="rates" class="business-form"><div class="field-grid">
        ${fuelNames.map(fuel => numberField(fuel + " (₹ / L)", fuel, {
          value: setup.fuels[fuel].rate ? decimal(setup.fuels[fuel].rate, 100) : undefined, required: true, min: 0.01, max: 1000,
        })).join("")}
      </div>${errorbox}<button class="primary">Save rates</button></form>
    </section>
    <section class="card card-flow"><header class="section-head"><div><h2>Opening stock</h2>
      <p>${canEditStock ? "Set the starting balance for each fuel before the first submission." : "Starting balances were locked at the first submission."}</p></div>
      ${canEditStock ? "" : moneyBadge("Locked")}</header>
      <form id="stock" class="business-form"><div class="field-grid">
        ${openingStockFields(setup, !canEditStock)}
      </div>${canEditStock ? errorbox + '<button class="primary">Save opening stock</button>' : ""}</form>
    </section>
    <section class="card card-flow full-width-card"><header class="section-head"><div><h2>Nozzles</h2><p>Manage the nozzles used for shift readings.</p></div></header>
      <ul class="nozzle-config">${setup.nozzles.map(nozzle => `<li><strong>${safe(nozzle.code)}</strong> ${fuelTag(nozzle.fuel)}</li>`).join("")}</ul>
      <form id="nozzle" class="business-form record-actions"><div class="field-grid">
        <label>Nozzle code<input name="code" maxlength="20" required placeholder="P-02"></label>
        <label>Fuel<select name="fuel">${fuelNames.map(fuel => `<option>${fuel}</option>`).join("")}</select></label>
      </div>${errorbox}<button class="primary">Add nozzle</button></form>
    </section></div>`, "settings");
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

function navigationIcon(id) {
  const paths = {
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    'daily-report': '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
    money: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M16 14h2"/>',
    banking: '<path d="m3 9 9-5 9 5M4 10h16M6 11v6m6-6v6m6-6v6M4 20h16"/>',
    payroll: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 12h5m-5 4h5m-5 4h5"/>',
    payables: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 8h6m-6 4h6m-6 4h3"/>',
    automation: '<path d="m13 2-9 12h7l-1 8L21 9h-8l0-7Z"/>',
    operations: '<path d="M5 20V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 20h14M8 7h4v4H8zM15 12h2a2 2 0 0 1 2 2v3a1 1 0 0 0 2 0V8l-3-3"/>',
    exceptions: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v4m0 4h.01"/>',
    security: '<path d="M12 22s7-4 7-11V6l-7-3-7 3v5c0 7 7 11 7 11Z"/><path d="m9 12 2 2 4-4"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
    contacts: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="9" r="2.5"/><path d="M8 16a4 4 0 0 1 8 0"/>',
    team: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v2"/>',
    requests: '<path d="M21 11a8 8 0 0 1-8 8H4l-2 3V11a9 9 0 0 1 19 0Z"/><path d="M7 10h9m-9 4h6"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[id] || paths.home}</svg>`;
}
