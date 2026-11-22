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
  check: '<path d="M20 6 9 17l-5-5"/>',
  banknote: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  calculator: '<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M8 18h.01M12 18h.01"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
  print: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  tank: '<path d="M4 10a8 8 0 0 1 16 0v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7z"/><line x1="12" x2="12" y1="3" y2="7"/>',
};

function showToast(message, type = "info", duration = 3500) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${safe(message)}</span><button class="toast-close" type="button" aria-label="Dismiss">&times;</button>`;
  container.appendChild(toast);
  const dismiss = () => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    toast.style.transition = "all 0.2s ease";
    setTimeout(() => toast.remove(), 200);
  };
  toast.querySelector(".toast-close").addEventListener("click", dismiss);
  if (duration > 0) setTimeout(dismiss, duration);
}

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

function denominationTrayHtml() {
  const denoms = [500, 200, 100, 50, 20, 10];
  return `<div class="denom-toggle-card">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <div>
        <strong style="display:flex; align-items:center; gap:0.45rem;">${icon("banknote")} Denomination Tray</strong>
        <small>Tally currency notes to calculate counted cash</small>
      </div>
      <button type="button" class="secondary" id="denom-toggle-btn" style="min-height:36px; padding:0.25rem 0.75rem; font-size:0.82rem;">Open Tray</button>
    </div>
    <div id="denom-tray" class="denom-tray" hidden>
      <div class="denom-grid">
        ${denoms.map(d => `
          <div class="denom-row">
            <span>₹${d} note</span>
            <input type="number" min="0" max="100000" step="1" inputmode="numeric" placeholder="0" data-denom="${d}">
            <small id="denom-sub-${d}">₹0.00</small>
          </div>
        `).join("")}
        <div class="denom-row">
          <span>Coins (₹)</span>
          <input type="number" min="0" max="100000" step="0.5" inputmode="decimal" placeholder="0.00" data-denom="coins">
          <small id="denom-sub-coins">₹0.00</small>
        </div>
      </div>
      <div class="denom-total-bar">
        <span><strong>Counted Total:</strong> <span id="denom-total" style="font-weight:750; font-family:var(--font-mono);">₹0.00</span></span>
        <div style="display:flex; gap:0.5rem;">
          <button type="button" id="denom-reset-btn" class="text-button" style="font-size:0.8rem; color:var(--danger);">Clear</button>
          <button type="button" id="denom-apply-btn" class="secondary" style="min-height:32px; padding:0.2rem 0.65rem; font-size:0.8rem;">Apply</button>
        </div>
      </div>
    </div>
  </div>`;
}

function bindDenominationCalc(form) {
  const toggleBtn = form.querySelector("#denom-toggle-btn");
  const tray = form.querySelector("#denom-tray");
  if (!toggleBtn || !tray) return;

  toggleBtn.addEventListener("click", () => {
    tray.hidden = !tray.hidden;
    toggleBtn.textContent = tray.hidden ? "Open Tray" : "Close Tray";
  });

  const update = (syncToCounted = true) => {
    let totalPaisa = 0;
    let valid = true;
    form.querySelectorAll("[data-denom]").forEach(input => {
      valid = valid && input.validity.valid;
      const denom = input.dataset.denom;
      const count = Number(input.value || 0);
      let rowPaisa = 0;
      if (denom === "coins") {
        rowPaisa = Math.round(count * 100);
      } else {
        rowPaisa = Math.round(count * Number(denom) * 100);
      }
      totalPaisa += rowPaisa;
      const sub = form.querySelector("#denom-sub-" + denom);
      if (sub) sub.textContent = money(rowPaisa);
    });
    const totalEl = form.querySelector("#denom-total");
    if (totalEl) totalEl.textContent = valid ? money(totalPaisa) : "—";
    if (syncToCounted && valid) {
      form.elements.counted.value = (totalPaisa / 100).toFixed(2);
      form.elements.counted.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  form.querySelectorAll("[data-denom]").forEach(input => {
    input.addEventListener("input", () => update(true));
  });

  const resetBtn = form.querySelector("#denom-reset-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      form.querySelectorAll("[data-denom]").forEach(input => { input.value = ""; });
      update(false);
      form.elements.counted.value = "";
      form.elements.counted.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  const applyBtn = form.querySelector("#denom-apply-btn");
  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      const invalid = [...form.querySelectorAll("[data-denom]")].find(input => !input.validity.valid);
      if (invalid) {
        tray.hidden = false;
        toggleBtn.textContent = "Close Tray";
        invalid.reportValidity();
        return;
      }
      update(true);
    });
  }
  return () => update(false);
}

function saveShiftDraft(activeId, form) {
  try {
    const raw = fields(form);
    const entries = typeof collectEntries === "function" ? collectEntries(form) : {};
    const denoms = {};
    form.querySelectorAll("[data-denom]").forEach(input => {
      if (input.value) denoms[input.dataset.denom] = input.value;
    });
    localStorage.setItem("tuljai_draft_" + activeId, JSON.stringify({
      savedAt: Date.now(),
      fields: raw,
      entries,
      denoms,
    }));
  } catch {}
}

function restoreShiftDraft(activeId, form, active) {
  try {
    const raw = localStorage.getItem("tuljai_draft_" + activeId);
    if (!raw) return false;
    const draft = JSON.parse(raw);
    if (!draft || !draft.fields) return false;

    for (const [name, val] of Object.entries(draft.fields)) {
      if (form.elements[name] && val !== undefined && val !== "") {
        form.elements[name].value = val;
      }
    }
    if (draft.entries && typeof restoreEntries === "function") {
      restoreEntries(form, draft.entries);
    }
    if (draft.denoms) {
      for (const [d, val] of Object.entries(draft.denoms)) {
        const input = form.querySelector(`[data-denom="${d}"]`);
        if (input && val !== undefined) input.value = val;
      }
    }
    showToast("Restored unsaved draft from this device.", "info", 4000);
    return true;
  } catch {
    return false;
  }
}

function renderTankVisual(fuel, item) {
  const cap = Math.max(item.opening || 0, item.calculated || 0, 20000000);
  const percent = Math.min(100, Math.max(0, Math.round((Math.max(0, item.calculated) / cap) * 100)));
  const isLow = percent < 20;
  const isHigh = percent > 85;
  const statusClass = isLow ? "discrepancy" : "";
  return `<div class="tank-visual-wrap">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem; font-size:0.82rem;">
      <span style="font-weight:700; color:var(--ink-secondary);">${isLow ? "Low Stock Warning" : isHigh ? "High Level" : "Normal Stock"}</span>
      <span class="${statusClass}" style="font-weight:750; font-family:var(--font-mono);">${percent}% capacity</span>
    </div>
    <div class="tank-cylinder-bar">
      <div class="tank-cylinder-fill ${fuel.toLowerCase()}" style="width: ${percent}%;"></div>
    </div>
    <div class="tank-meta-row">
      <span>Book: ${volume(item.calculated)}</span>
      <span>${item.physical ? `Dip: ${volume(item.physical.litres)}` : `No physical dip`}</span>
    </div>
  </div>`;
}

function shareShiftWhatsApp(shift) {
  const m = val => rupees.format(val / 100);
  const l = val => litres.format(val / 1000) + " L";
  const lines = [
    `⛽ *${clientName} · Shift #${shift.id} Report*`,
    `📅 *Business Date:* ${shift.business_date}`,
    `👤 *Manager:* ${shift.submitter} (${timestamp(shift.submitted_at)})`,
    ``,
    `📊 *Metered Sales:* ${m(shift.sales)}`,
    `💵 *Collections:* ${m(shift.collection_total)} (Diff: ${m(shift.collection_difference)})`,
    `💰 *Cash Counted:* ${m(shift.counted)}`,
    `⚖️ *Cash Variance:* ${m(shift.cash_difference)}`,
  ];
  if (shift.expense_note) lines.push(`📝 *Expense Note:* ${shift.expense_note}`);
  if (shift.shift_note) lines.push(`📋 *Handover Notes:* ${shift.shift_note}`);
  window.open("https://api.whatsapp.com/send?text=" + encodeURIComponent(lines.join("\n")), "_blank");
}

function showClosing(active) {
  shell(`${heading("Shift #" + active.id + " · " + businessDay(active.business_date), "Close shift",
    "Enter the closing readings and reconcile the till before submitting.")}
    <form id="close-shift">
      <div class="wizard-nav" role="tablist" aria-label="Shift closing sections">
        <button type="button" class="wizard-step-btn active" data-step-target="step-meters"><span class="wizard-step-num">1</span> Nozzle Meters</button>
        <button type="button" class="wizard-step-btn" data-step-target="step-stock"><span class="wizard-step-num">2</span> Stock &amp; Deliveries</button>
        <button type="button" class="wizard-step-btn" data-step-target="step-entries"><span class="wizard-step-num">3</span> Detailed Entries</button>
        <button type="button" class="wizard-step-btn" data-step-target="step-till"><span class="wizard-step-num">4</span> Collections &amp; Till</button>
      </div>
      <div class="work-grid">
        <div class="stack">
          <section class="card" id="step-meters">
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
          <section class="card" id="step-stock">
            <header class="section-head"><div><h2>Stock movements</h2><p>Enter delivery totals and any closing physical measurements.</p></div></header>
            <div class="fuel-grid">${fuelNames.map(fuel => `<div class="fuel-entry">${fuelTag(fuel)}
              ${numberField("Delivered (L)", "delivery_" + fuel, { step: "0.001" })}
              ${numberField("Physical stock (L)", "physical_" + fuel, { step: "0.001", placeholder: "Optional" })}
            </div>`).join("")}</div>
          </section>
          <div id="step-entries" class="stack">
            ${entrySection("deliveries", "Fuel delivery entries", "Record each delivery with its supplier and challan. Entries calculate the delivery totals above.")}
            ${entrySection("payments", "Payment entries", "Add transactions or settlement batches. Entries calculate the total for that payment method below. Credit entries require a customer name.")}
            ${entrySection("expenses", "Till expense entries", "Record each expense paid from the till. Entries calculate the expense total below.")}
          </div>
          <section class="card" id="step-till">
            <header class="section-head"><div><h2>Collections and till</h2><p>Enter totals directly or add detailed entries above. Totals with entries are calculated automatically.</p></div></header>
            ${denominationTrayHtml()}
            <div class="field-grid" style="margin-top:1rem;">
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
          <div id="recon-status"></div>
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
      entries: collectEntries(form), shift_note: values.shift_note,
    });
    try {
      localStorage.removeItem("tuljai_draft_" + active.id);
    } catch {}
    showToast("Shift #" + lastSubmission.id + " submitted successfully!", "success");
    await showHome();
  });
  bindManagerEntries(form, active);
  const refreshDenominations = bindDenominationCalc(form);

  // Stepper tab navigation
  form.querySelectorAll("[data-step-target]").forEach(btn => {
    btn.addEventListener("click", () => {
      form.querySelectorAll("[data-step-target]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const target = form.querySelector("#" + btn.dataset.stepTarget);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        target.querySelector("input, select, textarea, button")?.focus();
      }
    });
  });

  restoreShiftDraft(active.id, form, active);
  refreshDenominations();
  form.addEventListener("input", () => saveShiftDraft(active.id, form));
  form.addEventListener("change", () => saveShiftDraft(active.id, form));
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
  const variance = counted === null || expected === null ? null : counted - expected;
  showMetric("variance", variance, true);
  const reconStatusEl = document.getElementById("recon-status");
  if (reconStatusEl) {
    if (variance !== null) {
      if (variance === 0) {
        reconStatusEl.innerHTML = `<div class="recon-status-banner balanced">${icon("check")} Till Balanced · Perfect Match</div>`;
      } else if (variance < 0) {
        reconStatusEl.innerHTML = `<div class="recon-status-banner shortage">${icon("warning")} Cash Shortage: ${money(Math.abs(variance))}</div>`;
      } else {
        reconStatusEl.innerHTML = `<div class="recon-status-banner overage">${icon("warning")} Cash Overage: ${money(variance)}</div>`;
      }
    } else {
      reconStatusEl.innerHTML = "";
    }
  }
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
          ${renderTankVisual(fuel, item)}
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
  shell(`<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
      <button id="back" type="button" class="text-button back">← ${source === "daily-report" ? "Daily report" : "Daily dashboard"}</button>
      <button id="whatsapp-shift" class="share-btn" type="button">${icon("share")} WhatsApp</button>
    </div>
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
  listen("whatsapp-shift", () => shareShiftWhatsApp(shift));
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
    showToast("Manager account created successfully.", "success");
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
    showToast(feedback, "success");
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
