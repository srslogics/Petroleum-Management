"use strict";

function entrySection(category, title, description) {
  return `<section class="card entry-section"><header class="section-head"><div><h2>${title}</h2><p>${description}</p></div>
    <button class="secondary" type="button" data-add-entry="${category}">Add entry</button></header>
    <div data-entry-list="${category}"></div></section>`;
}

function entryRow(category) {
  const select = (label, field, choices) => `<label>${label}<select data-field="${field}">${choices.map(([value, text]) =>
    `<option value="${value}">${text}</option>`).join("")}</select></label>`;
  const text = (label, field, required = false) => `<label>${label}<input data-field="${field}" maxlength="150" ${required ? "required" : ""}></label>`;
  return `<fieldset class="manager-entry" data-entry="${category}"><legend>${{payments:"Payment",deliveries:"Fuel delivery",expenses:"Till expense"}[category]}</legend>
    <div class="field-grid">
      ${category === "payments" ? select("Payment method", "method", Object.entries(methodNames).filter(([key])=>role === "owner" || key !== "credit")) : ""}
      ${category === "deliveries" ? select("Fuel", "fuel", fuelNames.map(fuel => [fuel, fuel])) : ""}
      <label>${category === "deliveries" ? "Quantity (L)" : "Amount (₹)"}<input data-field="${category === "deliveries" ? "quantity" : "amount"}"
        type="number" inputmode="decimal" min="${category === "deliveries" ? "0.001" : "0.01"}" max="1000000000"
        step="${category === "deliveries" ? "0.001" : "0.01"}" required></label>
      ${category === "payments" && role === "manager" ? "" : text(category === "deliveries" ? "Supplier / tanker" : category === "payments" ? "Customer / account" : "Paid to", "party")}
      ${text(category === "deliveries" ? "Invoice / challan number" : "Receipt / transaction reference", "reference")}
      ${text(category === "expenses" ? "Expense description" : "Notes", "note", category === "expenses")}
    </div>
    <button type="button" class="text-button" data-remove-entry>Remove entry</button>
  </fieldset>`;
}

function collectEntries(form) {
  return Object.fromEntries(["payments", "deliveries", "expenses"].map(category =>
    [category, [...form.querySelectorAll(`[data-entry="${category}"]`)].map(row =>
      Object.fromEntries([...row.querySelectorAll("[data-field]")].map(input => [input.dataset.field, input.value.trim()]))
    )]
  ));
}

function bindManagerEntries(form, active) {
  let calculated = new Set();
  const manualTotals = new Map();
  const sync = () => {
    const entries = collectEntries(form);
    const sums = {};
    for (const entry of entries.payments) sums[entry.method] = (sums[entry.method] || 0) + Math.round(Number(entry.amount || 0) * 100);
    for (const entry of entries.deliveries) {
      const key = "delivery_" + entry.fuel;
      sums[key] = (sums[key] || 0) + Math.round(Number(entry.quantity || 0) * 1000);
    }
    if (entries.expenses.length) sums.expenses = entries.expenses.reduce((sum, entry) => sum + Math.round(Number(entry.amount || 0) * 100), 0);
    for (const name of new Set([...calculated, ...Object.keys(sums)])) {
      const input = form.elements[name];
      if (name in sums && !calculated.has(name)) manualTotals.set(name, input.value);
      input.readOnly = name in sums;
      input.value = name in sums
        ? (sums[name] / (name.startsWith("delivery_") ? 1000 : 100)).toFixed(name.startsWith("delivery_") ? 3 : 2)
        : manualTotals.get(name) || "";
    }
    calculated = new Set(Object.keys(sums));
    updatePreview(form, active);
  };
  form.syncEntries = sync;
  form.addEventListener("click", event => {
    const add = event.target.closest("[data-add-entry]");
    const remove = event.target.closest("[data-remove-entry]");
    if (add) {
      const list = form.querySelector(`[data-entry-list="${add.dataset.addEntry}"]`);
      if (list.children.length >= 100) {
        add.setAttribute("aria-label", "Maximum 100 entries reached");
        return;
      }
      list.insertAdjacentHTML("beforeend", entryRow(add.dataset.addEntry));
      list.lastElementChild.querySelector("input").focus();
      sync();
      form.dispatchEvent(new Event("input", {bubbles:true}));
    }
    if (remove) {
      const category = remove.closest("[data-entry]").dataset.entry;
      remove.closest("[data-entry]").remove();
      form.querySelector(`[data-add-entry="${category}"]`).removeAttribute("aria-label");
      form.querySelector(`[data-add-entry="${category}"]`).focus();
      sync();
      form.dispatchEvent(new Event("input", {bubbles:true}));
    }
  });
  form.addEventListener("input", sync);
  form.addEventListener("change", sync);
}

function recordedEntries(entries, shiftNote = "") {
  const tables = [];
  for (const [category, title] of [["payments","Payment entries"],["deliveries","Fuel deliveries"],["expenses","Till expenses"]]) {
    const rows = entries?.[category] || [];
    if (!rows.length) continue;
    tables.push(`<section class="card"><h2>${title}</h2><div class="recorded-entries">${rows.map(row => `<div>
      <strong>${category === "deliveries" ? safe(row.fuel) + " · " + volume(row.quantity) :
        (category === "payments" ? safe(methodNames[row.method]) + " · " : "") + money(row.amount)}</strong>
      ${row.party ? `<p>${safe(row.party)}</p>` : ""}
      ${row.reference ? `<p>Reference · ${safe(row.reference)}</p>` : ""}
      ${row.note ? `<p class="review-note">${safe(row.note)}</p>` : ""}
    </div>`).join("")}</div></section>`);
  }
  if (shiftNote) tables.push(`<section class="card"><h2>Manager’s shift notes</h2><p class="review-note">${safe(shiftNote)}</p></section>`);
  return tables.join("");
}
