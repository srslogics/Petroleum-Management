"use strict";

function reportValues(values) {
  return `<dl class="key-values report-values">${values.map(([label, value, flagged]) =>
    `<div><dt>${label}</dt><dd class="${flagged ? "discrepancy" : ""}">${value}</dd></div>`
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

async function openDailyReport() {
  showDailyReport(await api("/daily-report" + (selectedDate ? "?date=" + encodeURIComponent(selectedDate) : "")));
}

function showDailyReport(data) {
  selectedDate = data.date;
  const { payments, till, shifts } = data;
  const pending = shifts.filter(shift => !shift.reviewed_at).length;
  const hasNotes = shifts.some(shift => shift.expense_note || shift.review_note);
  shell(`<div class="dashboard-heading">
    ${heading(businessDay(data.date), "Daily report", reportStation())}
    <div class="report-controls"><label class="date-control">Business date<input id="date" type="date" value="${safe(data.date)}"></label>
      <button id="print-day" class="secondary" type="button">Print / PDF</button>
      <button id="export-day" class="primary" type="button">Download CSV</button>
    </div>
  </div>
  ${shifts.length ? "" : '<p class="daily-empty">No shifts were submitted for this business date.</p>'}
  <section class="summary-grid" aria-label="Daily totals">
    ${dashboardMetric("Metered fuel sales", money(data.sales), volume(data.litres) + " sold", "sales", "summary-featured")}
    ${dashboardMetric("Recorded receipts", money(data.receipts), "Cash, UPI and card", "receipt", "summary-blue")}
    ${dashboardMetric("Credit sales", money(payments.credit), "Recorded on credit", "review", "summary-amber")}
    ${dashboardMetric("Submitted shifts", shifts.length, pending ? pending + " awaiting review" : "No pending reviews", "dashboard", "summary-green")}
  </section>
  <div class="dashboard-grid day-panels">
    <section class="card">
      <header class="section-head"><div><h2>Payment breakdown</h2><p>Recorded by shift managers.</p></div><span class="panel-icon">${icon("receipt")}</span></header>
      ${reportValues([
        ...Object.entries(methodNames).map(([key, label]) => [key === "credit" ? "Credit sales" : label, money(payments[key])]),
        ["Receipts excluding credit", money(data.receipts)],
        ["Receipts plus credit", money(data.accounted)],
        ["Receipts plus credit − metered sales", money(data.sales_difference), data.sales_difference !== 0],
      ])}
    </section>
    <section class="card">
      <header class="section-head"><div><h2>Cash and till reconciliation</h2><p>Expected cash equals recorded cash less till expenses.</p></div>
        <span class="panel-icon">${icon("review")}</span></header>
      ${reportValues([
        ["Recorded cash", money(payments.cash)],
        ["Till expenses", money(till.expenses)],
        ["Expected cash", money(till.expected)],
        ["Cash counted", money(till.counted)],
        ["Cash shortages across shifts", money(till.shortage), till.shortage > 0],
        ["Cash overages across shifts", money(till.overage), till.overage > 0],
        ["Net difference (counted − expected)", money(till.cash_difference), till.cash_difference !== 0],
      ])}
    </section>
  </div>
  <section class="card">
    <header class="section-head"><div><h2 id="day-sales-heading">Sales by fuel</h2><p>Rates are taken from submitted shifts.</p></div></header>
    ${reportTable("day-sales-heading", [["Fuel"], ["Volume sold", true], ["Selling rates per litre", true], ["Metered sales", true]],
      fuelNames.map(fuel => {
        const row = data.fuels[fuel];
        return [fuelTag(fuel), volume(row.litres), row.rates.length ? row.rates.map(money).join(" / ") : "—", money(row.sales)];
      }))}
  </section>
  <section class="card">
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
  <section class="card">
    <header class="section-head"><div><h2 id="day-shifts-heading">Collections by shift</h2><p>Select a shift to inspect the original readings and review.</p></div>
      <span class="count">${shifts.length} submitted</span></header>
    ${shifts.length ? reportTable("day-shifts-heading",
      [["Shift"], ["Cash", true], ["UPI", true], ["Card", true], ["Credit", true],
        ["Expenses", true], ["Cash difference", true], ["Review status"]],
      shifts.map(shift => [`<button id="day-shift-${shift.id}" class="text-button report-shift-link" type="button">Shift #${shift.id}</button>
        <small>${safe(shift.submitter)} · ${timestamp(shift.submitted_at)}</small>`,
        ...Object.keys(methodNames).map(method => money(shift.payments[method])), money(shift.expenses),
        `<span class="${shift.cash_difference ? "discrepancy" : ""}">${money(shift.cash_difference)}</span>`, reviewStatus(shift)]))
      : '<p class="quiet">Shift collections will appear after submission.</p>'}
  </section>
  <section class="card">
    <header class="section-head"><div><h2 id="day-meters-heading">Nozzle meter readings</h2><p>First opening reading, last closing reading, and total metered volume for the date.</p></div></header>
    ${data.nozzles.length ? reportTable("day-meters-heading",
      [["Nozzle"], ["Fuel"], ["Opening reading", true], ["Closing reading", true], ["Litres sold", true]],
      data.nozzles.map(row => [safe(row.code), fuelTag(row.fuel), volume(row.opening), volume(row.closing), volume(row.litres)]))
      : '<p class="quiet">No submitted meter readings for this date.</p>'}
  </section>
  ${hasNotes ? `<section class="card"><h2>Shift notes</h2><div class="daily-notes">
    ${shifts.filter(shift => shift.expense_note || shift.review_note).map(shift => `<div>
      <strong>Shift #${shift.id}</strong>
      ${shift.expense_note ? `<p><strong>Till expense note</strong> · ${safe(shift.expense_note)}</p>` : ""}
      ${shift.review_note ? `<p><strong>Owner review note</strong> · ${safe(shift.review_note)}</p>` : ""}
    </div>`).join("")}</div></section>` : ""}`, "daily-report");
  bindDateFilter("/daily-report", showDailyReport);
  listen("print-day", () => window.print());
  listen("export-day", () => downloadDailyReport(data));
  for (const shift of shifts) {
    listen("day-shift-" + shift.id, async () => showReport(await api("/shifts/" + shift.id), "daily-report"));
  }
}

function reportStation() {
  return session.station + " · " + session.station_code + " · Business time in IST";
}

function dailyCsv(data) {
  const m = value => value / 100;
  const l = value => value / 1000;
  const rows = [
    ["Daily station report"], ["Station", session.station], ["Station code", session.station_code],
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
      "Reviewed by", "Reviewed at (IST)", "Expense note", "Review note"],
    ...data.shifts.map(shift => [shift.id, shift.submitter, shift.opened_at, shift.submitted_at, m(shift.sales),
      ...Object.keys(methodNames).map(method => m(shift.payments[method])),
      m(shift.expenses), m(shift.cash_difference), m(shift.collection_difference), shift.reviewer,
      shift.reviewed_at, shift.expense_note, shift.review_note]), [],
    ["Nozzle", "Fuel", "Opening (L)", "Closing (L)", "Sold (L)"],
    ...data.nozzles.map(nozzle => [nozzle.code, nozzle.fuel, l(nozzle.opening), l(nozzle.closing), l(nozzle.litres)]),
  ];
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
  download.download = "pump-ledger-daily-" + data.date + ".csv";
  document.body.append(download);
  download.click();
  download.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
