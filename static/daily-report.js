"use strict";

function reportValues(values) {
  return `<dl class="key-values report-values">${values.map(([label, value, flagged]) =>
    `<div class="${flagged === "total" ? "ledger-total" : ""}"><dt>${label}</dt><dd class="${flagged === true ? "discrepancy" : ""}">${value}</dd></div>`
  ).join("")}</dl>`;
}

function reportTable(id, columns, rows) {
  return `<div class="table-scroll report-scroll" role="region" aria-labelledby="${id}" tabindex="0">
    <table class="shift-table report-table">
      <thead><tr>${columns.map(([label, numeric]) =>
        `<th scope="col" class="${numeric ? "numeric" : ""}">${label}</th>`
      ).join("")}</tr></thead>
      <tbody>${rows.map(row => `<tr><th scope="row">${row[0]}</th>${
        row.slice(1).map((value, index) =>
          `<td class="${columns[index + 1][1] ? "numeric" : ""}">${value}</td>`).join("")
      }</tr>`).join("")}</tbody>
    </table>
  </div>`;
}

function openDailyReport() {
  return loadOwnerView(ownerDatePath("/daily-report"), showDailyReport);
}

function showDailyReport(data) {
  selectedDate = data.date;
  const { payments, till, shifts } = data;
  const pending = shifts.filter(shift => !shift.reviewed_at).length;
  const hasNotes = shifts.some(shift => shift.expense_note || shift.review_note);
  shell(`<div class="report-client-print">
    <img src="${safe(brandLogo)}" width="70" height="62" alt=""><strong>${safe(clientName)}</strong>
  </div><div class="dashboard-heading">
    ${heading(businessDay(data.date), "Daily report", reportStation())}
    <div class="report-controls"><label class="date-control">Business date<input id="date" type="date" value="${safe(data.date)}"></label>
      <button id="date-today" class="secondary" type="button">Today</button>
      <button id="refresh-day" class="secondary" type="button">Refresh report</button>
      <button id="whatsapp-day" class="secondary" type="button">Share via WhatsApp</button>
      <button id="print-day" class="secondary" type="button">Print</button>
      <button id="export-day" class="primary" type="button">Export CSV</button>
    </div>
  </div>
  ${shifts.length ? "" : '<p class="ledger-empty">No shifts were submitted for this business date.</p>'}
  <div class="ledger-sheet">
  <div class="ledger-columns">
    <section class="ledger-section">
      <header class="section-head"><h2>Payments recorded</h2></header>
      ${reportValues([
        ["Cash", money(payments.cash)], ["UPI", money(payments.upi)], ["Card", money(payments.card)],
        ["Payments received", money(data.receipts), "total"],
        ["Credit sales", money(payments.credit)],
        ["Payments plus credit", money(data.accounted)],
        ["Metered fuel sales", money(data.sales)],
        ["Difference against metered sales", money(data.sales_difference), data.sales_difference !== 0],
      ])}
    </section>
    <section class="ledger-section">
      <header class="section-head"><h2>Cash counted at close</h2></header>
      ${reportValues([
        ["Recorded cash", money(payments.cash)],
        ["Till expenses", money(till.expenses)],
        ["Expected cash", money(till.expected)],
        ["Cash counted", money(till.counted), "total"],
        ["Cash shortages across shifts", money(till.shortage), till.shortage > 0],
        ["Cash overages across shifts", money(till.overage), till.overage > 0],
        ["Net difference (counted − expected)", money(till.cash_difference), till.cash_difference !== 0],
      ])}
    </section>
  </div>
  ${ledgerSummary([
    ["Volume sold", volume(data.litres)], ["Submitted shifts", shifts.length], ["Awaiting review", pending],
  ])}
  <section class="ledger-section">
    <header class="section-head"><h2 id="day-sales-heading">Sales by fuel</h2></header>
    ${reportTable("day-sales-heading", [["Fuel"], ["Volume sold", true], ["Selling rates per litre", true], ["Metered sales", true]],
      fuelNames.map(fuel => {
        const row = data.fuels[fuel];
        return [fuelTag(fuel), volume(row.litres), row.rates.length ? row.rates.map(money).join(" / ") : "—", money(row.sales)];
      }))}
  </section>
  <section class="ledger-section">
    <header class="section-head"><div><h2 id="day-stock-heading">Fuel stock movements</h2><p>Stock balances are calculated from submitted shifts. Physical variance is measured against book stock at the reading’s shift.</p></div></header>
    ${reportTable("day-stock-heading", [["Fuel"], ["Opening stock", true], ["Delivered", true], ["Sold", true], ["Closing book stock", true], ["Physical reading", true], ["Physical − book", true]],
      fuelNames.map(fuel => {
        const row = data.fuels[fuel];
        const reading = row.physical;
        return [fuelTag(fuel), volume(row.opening_stock), volume(row.delivery), volume(row.litres), volume(row.closing_stock),
          reading ? `${volume(reading.litres)}<small>Shift #${reading.shift_id}</small>` : "No reading",
          reading ? `<span class="${reading.difference ? "discrepancy" : ""}">${volume(reading.difference)}</span>` : "—"];
      }))}
  </section>
  <section class="ledger-section">
    <header class="section-head"><div><h2 id="day-shifts-heading">Collections by shift</h2><p>Open a shift to review the original readings.</p></div></header>
    ${shifts.length ? reportTable("day-shifts-heading",
      [["Shift"], ["Cash", true], ["UPI", true], ["Card", true], ["Credit", true],
        ["Expenses", true], ["Cash difference", true], ["Review status"]],
      shifts.map(shift => [`<button id="day-shift-${shift.id}" class="text-button report-shift-link" type="button">Shift #${shift.id}</button>
        <small>${safe(shift.submitter)} · ${timestamp(shift.submitted_at)}</small>`,
        ...Object.keys(methodNames).map(method => money(shift.payments[method])), money(shift.expenses),
        `<span class="${shift.cash_difference ? "discrepancy" : ""}">${money(shift.cash_difference)}</span>`, reviewStatus(shift)]))
      : '<p class="quiet">Shift collections will appear after submission.</p>'}
  </section>
  <section class="ledger-section">
    <header class="section-head"><div><h2 id="day-meters-heading">Nozzle meter readings</h2><p>First opening reading, last closing reading, and total metered volume for the date.</p></div></header>
    ${data.nozzles.length ? reportTable("day-meters-heading",
      [["Nozzle"], ["Fuel"], ["Opening reading", true], ["Closing reading", true], ["Litres sold", true]],
      data.nozzles.map(row => [safe(row.code), fuelTag(row.fuel), volume(row.opening), volume(row.closing), volume(row.litres)]))
      : '<p class="quiet">No submitted meter readings for this date.</p>'}
  </section>
  ${shifts.some(shift => shift.shift_note || Object.values(shift.entries || {}).some(rows => rows.length)) ?
    `<section class="ledger-section"><h2>Manager entries by shift</h2>${shifts.map(shift =>
      `<div class="day-entry-group"><h3>Shift #${shift.id}</h3>${recordedEntries(shift.entries, shift.shift_note)}</div>`).join("")}</section>` : ""}
  ${hasNotes ? `<section class="ledger-section"><h2>Shift notes</h2><div class="daily-notes">
    ${shifts.filter(shift => shift.expense_note || shift.review_note).map(shift => `<div>
      <strong>Shift #${shift.id}</strong>
      ${shift.expense_note ? `<p><strong>Till expense note</strong> · ${safe(shift.expense_note)}</p>` : ""}
      ${shift.review_note ? `<p><strong>Owner review note</strong> · ${safe(shift.review_note)}</p>` : ""}
    </div>`).join("")}</div></section>` : ""}</div>`, "daily-report");
  bindDateFilter("/daily-report", showDailyReport);
  listen("whatsapp-day", () => openWhatsAppComposer([
    `${session.station} (${session.station_code}) · Daily report · ${businessDay(data.date)}`,
    shifts.length ? [
      `Submitted shifts: ${shifts.length} (${pending} awaiting review)`,
      `Metered fuel sales: ${money(data.sales)} · ${volume(data.litres)}`,
      `Payments received: ${money(data.receipts)}`,
      `Cash: ${money(payments.cash)} · UPI: ${money(payments.upi)} · Card: ${money(payments.card)}`,
      `Credit sales: ${money(payments.credit)}`,
      `Cash counted: ${money(till.counted)} · Cash difference: ${money(till.cash_difference)}`,
    ].join("\n") : "No shifts were submitted for this business date.",
  ].join("\n\n")));
  listen("print-day", () => window.print());
  listen("export-day", () => downloadDailyReport(data));
  for (const shift of shifts) {
    listen("day-shift-" + shift.id, () => openShiftReport(shift.id, "daily-report"));
  }
}

function reportStation() {
  return session.station + " · " + session.station_code + " · Business time in IST";
}

function dailyCsv(data) {
  const m = value => value / 100;
  const l = value => value / 1000;
  const rows = [
    ["Daily station report"], ["Company", clientName], ["Station", session.station], ["Station code", session.station_code],
    ["Business date (IST)", data.date], [],
    ["Summary", "Value"], ["Submitted shifts", data.shifts.length],
    ["Awaiting review", data.shifts.filter(shift => !shift.reviewed_at).length],
    ["Litres sold", l(data.litres)], ["Metered sales (INR)", m(data.sales)],
    ["Cash (INR)", m(data.payments.cash)], ["UPI (INR)", m(data.payments.upi)],
    ["Card (INR)", m(data.payments.card)], ["Credit sales (INR)", m(data.payments.credit)],
    ["Receipts excluding credit (INR)", m(data.receipts)], ["Receipts plus credit (INR)", m(data.accounted)],
    ["Receipts plus credit minus metered sales (INR)", m(data.sales_difference)],
    ["Till expenses (INR)", m(data.till.expenses)], ["Expected cash (INR)", m(data.till.expected)],
    ["Counted cash (INR)", m(data.till.counted)], ["Net cash difference (INR)", m(data.till.cash_difference)],
    ["Shift shortages (INR)", m(data.till.shortage)], ["Shift overages (INR)", m(data.till.overage)], [],
    ["Fuel", "Litres sold", "Sales (INR)", "Rates (INR/L)", "Opening stock (L)", "Deliveries (L)",
      "Closing book stock (L)", "Physical reading (L)", "Reading shift", "Shift submitted (IST)",
      "Book stock at reading (L)", "Physical minus book (L)"],
    ...fuelNames.map(fuel => {
      const row = data.fuels[fuel];
      const reading = row.physical;
      return [fuel, l(row.litres), m(row.sales), row.rates.map(rate => m(rate).toFixed(2)).join(" / "),
        l(row.opening_stock), l(row.delivery), l(row.closing_stock),
        ...(reading ? [l(reading.litres), reading.shift_id, reading.submitted_at, l(reading.book_at_reading), l(reading.difference)]
          : ["", "", "", "", ""])];
    }), [],
    ["Shift", "Manager", "Opened (IST)", "Submitted (IST)", "Metered sales (INR)", "Cash (INR)", "UPI (INR)",
      "Card (INR)", "Credit (INR)", "Expenses (INR)", "Cash difference (INR)", "Receipts plus credit minus sales (INR)",
      "Reviewed by", "Reviewed at (IST)", "Expense note", "Review note", "Expected cash (INR)", "Counted cash (INR)"],
    ...data.shifts.map(shift => [shift.id, shift.submitter, shift.opened_at, shift.submitted_at, m(shift.sales),
      ...Object.keys(methodNames).map(method => m(shift.payments[method])),
      m(shift.expenses), m(shift.cash_difference), m(shift.collection_difference), shift.reviewer,
      shift.reviewed_at, shift.expense_note, shift.review_note, m(shift.expected), m(shift.counted)]), [],
    ["Nozzle", "Fuel", "Opening (L)", "Closing (L)", "Sold (L)"],
    ...data.nozzles.map(nozzle => [nozzle.code, nozzle.fuel, l(nozzle.opening), l(nozzle.closing), l(nozzle.litres)]),
  ];
  rows.push([], ["Shift", "Entry type", "Method / fuel", "Amount (INR)", "Quantity (L)", "Customer / supplier / payee", "Reference", "Description"]);
  for (const shift of data.shifts) {
    for (const [category, entries] of Object.entries(shift.entries || {})) {
      for (const entry of entries) rows.push([shift.id, category, entry.method || entry.fuel || "",
        entry.amount === undefined ? "" : m(entry.amount), entry.quantity === undefined ? "" : l(entry.quantity),
        entry.party, entry.reference, entry.note]);
    }
    if (shift.shift_note) rows.push([shift.id, "Shift note", "", "", "", "", "", shift.shift_note]);
  }
  return "\ufeff" + rows.map(row => row.map(cell => {
    let value = String(cell ?? "");
    // Spreadsheet apps can interpret operator-prefixed text as formulas.
    if (typeof cell === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(value)) value = "'" + value;
    return '"' + value.replace(/"/g, '""') + '"';
  }).join(",")).join("\r\n");
}

function downloadDailyReport(data) {
  const url = URL.createObjectURL(new Blob([dailyCsv(data)], {type: "text/csv;charset=utf-8"}));
  const download = document.createElement("a");
  download.href = url;
  download.download = "tuljai-petroleum-daily-" + data.date + ".csv";
  document.body.append(download);
  download.click();
  download.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
