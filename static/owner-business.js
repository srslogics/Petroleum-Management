"use strict";

function businessOverview(data) {
  const count = data.exceptions.filter(item => !item.acknowledgement).length;
  return `<section class="card owner-control-summary" aria-label="Owner actions">
    <div><strong>Current operations</strong><p>${data.active ? `Shift #${data.active.id} · ${safe(data.active.opener)} · open ${data.active.hours} hours${data.active.overdue ? ' · Overdue' : ''}` : 'No shift is currently open.'}</p></div>
    <button id="overview-operations" type="button" class="secondary">View operations</button>
    <button id="overview-exceptions" type="button" class="secondary">${count} exceptions need attention</button>
    <button id="overview-money" type="button" class="secondary">Customer credit ${money(data.customers.reduce((sum, item) => sum + item.balance, 0) + data.unallocated_credit)}</button>
    <small>Current operations and balances are independent of the report date selected above.</small>
  </section>`;
}

function bindBusinessOverview() {
  for (const view of ['operations', 'exceptions', 'money']) listen('overview-' + view, () => openBusiness(view));
}

const businessText = (label, name, required = true, limit = 150) => `<label>${label}<input name="${name}" ${required ? 'required' : ''} maxlength="${limit}"></label>`;
const businessNote = (label = 'Note', name = 'note', required = false, limit = 500) => `<label>${label}<textarea name="${name}" ${required ? 'required' : ''} maxlength="${limit}" rows="2"></textarea></label>`;
const businessDate = (label, name, value, required = true) => `<label>${label}<input type="date" name="${name}" value="${safe(value)}" ${required ? 'required' : ''}></label>`;

async function openBusiness(view = 'operations') {
  const data = await api('/business');
  if (view === 'money') showMoney(data);
  else if (view === 'exceptions') showExceptions(data);
  else showOperations(data);
}

function saveBusinessForm(id, route, extra, view) {
  bindForm(id, async form => {
    await api(route, { ...fields(form), ...extra });
    await openBusiness(view);
    showBusinessNotice('Saved successfully.');
  });
}

function showMoney(data) {
  const outstanding = data.customers.reduce((sum, item) => sum + item.balance, 0);
  shell(`${heading('Owner controls', 'Money', 'Customer credit, confirmed bank receipts and cash awaiting deposit.')}
    ${ledgerSummary([['Customer balances', money(outstanding)], ['Unallocated credit', money(data.unallocated_credit)],
      ['Awaiting digital settlement', money(data.settlements.filter(item => item.method !== 'cash').reduce((sum, item) => sum + item.remaining, 0))],
      ['Cash awaiting deposit', money(data.settlements.filter(item => item.method === 'cash').reduce((sum, item) => sum + item.remaining, 0))]])}
    <section class="card"><h2>Customer credit ledger</h2>
      <p>Credit sales are grouped by customer name, ignoring letter case. Use a consistent customer/account name in manager entries. Repayments do not add fuel sales.</p>
      ${data.unallocated_credit ? `<p class="notice">${money(data.unallocated_credit)} of credit was entered as totals without customer names. It is excluded from named customer balances. Allocate it below.</p>${unallocatedCreditForms(data)}` : ''}
      <details><summary>Add a customer or set a payment due date</summary><form id="customer-config" class="business-form">
        ${businessText('Customer / account name', 'name')}${businessDate('Account payment due date (optional)', 'due_date', '', false)}
        <small>Leave the date blank to clear it. This is an account-level follow-up date.</small>${errorbox}<button class="primary">Save customer</button>
      </form></details>
      ${data.customers.length ? data.customers.map((item, index) => `<details class="business-record"><summary>${safe(item.name)} · ${money(item.balance)} outstanding${item.overdue ? ' · Overdue' : ''}</summary>
        <p>Credit sales ${money(item.sales)} · Repaid ${money(item.repaid)} · Due ${safe(item.due_date || 'not set')}</p>
        <button type="button" class="secondary" id="statement-${index}">Download statement CSV</button>
        <div class="table-scroll"><table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Reference</th><th>Note</th></tr></thead><tbody>
        ${item.transactions.map(row => `<tr><td>${safe(row.date)}</td><td>${safe(row.type)}${row.shift_id ? ' · #' + row.shift_id : ''}</td><td>${money(row.amount)}</td><td>${safe(row.reference)}</td><td>${safe(row.note)}</td></tr>`).join('')}</tbody></table></div>
        ${item.balance > 0 ? `<form id="repayment-${index}" class="business-form"><h3>Record a repayment</h3>
          ${numberField('Amount received (₹)', 'amount', {required:true, min:0.01, max: item.balance / 100})}
          <label>Received as<select name="method"><option value="bank">Confirmed bank receipt (UPI / card / transfer)</option><option value="cash">Cash received — awaiting deposit</option></select></label>
          ${businessDate('Receipt date', 'paid_on', data.today)}${businessText('Unique receipt / bank reference', 'reference')}${businessNote()}
          ${errorbox}<button class="primary">Record repayment</button></form>` : ''}</details>`).join('') : '<p>No named credit customers yet.</p>'}
    </section>
    <section class="card"><h2>Bank settlements and cash deposits</h2>
      <p>Match recorded collections to bank evidence. Record net bank receipts and fees separately. Partial receipts remain pending. These are manual records; bank statements are not imported automatically.</p>
      <label>Show<select id="settlement-filter"><option value="pending">Pending only</option><option value="all">All sources</option></select></label>
      ${data.settlements.length ? data.settlements.map((item, index) => `<details class="business-record settlement-record" data-pending="${item.remaining > 0}" ${item.remaining ? '' : 'hidden'}><summary>${safe(item.label)} · ${safe(methodNames[item.method])} · ${money(item.remaining)} pending</summary>
        <p>${item.method === 'cash' ? 'Cash counted / received' : 'Recorded gross collections'} ${money(item.expected)} · Banked ${money(item.banked)} · Fees ${money(item.fees)}</p>
        ${item.records.map(record => `<p>Bank date ${safe(record.bank_date)} · ${money(record.amount)} + fees ${money(record.fees)} · Ref ${safe(record.reference)} · ${safe(record.note)}<small>Recorded by ${safe(record.actor)} · ${timestamp(record.created_at)}</small></p>`).join('')}
        ${item.remaining > 0 ? `<form id="bank-${index}" class="business-form">
          ${numberField(item.method === 'cash' ? 'Cash deposited (₹)' : 'Net bank receipt (₹)', 'amount', {required:true, min:0.01, max: item.remaining / 100})}
          ${item.method === 'cash' ? '' : numberField('Settlement fees (₹)', 'fees', {value:0})}
          ${businessDate('Bank receipt / deposit date', 'bank_date', data.today)}${businessText('Unique bank / deposit reference', 'reference')}${businessNote()}
          ${errorbox}<button class="primary">Record ${item.method === 'cash' ? 'deposit' : 'settlement'}</button></form>` : '<p class="success">Fully reconciled.</p>'}
        </details>`).join('') : '<p>Sources appear after a shift is submitted or a cash credit repayment is recorded.</p>'}
    </section>${moneyRecordHistory(data)}`, 'money');
  saveBusinessForm('customer-config', '/customers', {}, 'money');
  data.customers.forEach((item, index) => {
    listen('statement-' + index, () => downloadCustomerStatement(item, data.today));
    if (item.balance > 0) saveBusinessForm('repayment-' + index, '/repayments', {customer_key: item.customer_key}, 'money');
  });
  data.settlements.forEach((item, index) => {
    if (item.remaining > 0) saveBusinessForm('bank-' + index, '/bank-records', {source: item.source, method: item.method}, 'money');
  });
  listen('settlement-filter', event => {
    document.querySelectorAll('.settlement-record').forEach(row => { row.hidden = event.target.value === 'pending' && row.dataset.pending !== 'true'; });
  }, 'change');
  bindUnallocatedCredit(data);
  bindMoneyHistory(data);
}

function downloadCustomerStatement(customer, today) {
  const rows = [['Customer', customer.name], ['As of (IST)', today], ['Credit sales (INR)', customer.sales / 100],
    ['Repayments (INR)', customer.repaid / 100], ['Outstanding (INR)', customer.balance / 100], ['Due date', customer.due_date], [],
    ['Date', 'Type', 'Amount (INR)', 'Reference', 'Note'],
    ...customer.transactions.map(row => [row.date, row.type, row.amount / 100, row.reference, row.note])];
  const csv = '\ufeff' + rows.map(row => row.map(cell => {
    let value = String(cell ?? '');
    if (typeof cell === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(value)) value = "'" + value;
    return '"' + value.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = 'customer-statement-' + today + '.csv';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function showOperations(data) {
  const active = data.active;
  shell(`${heading('Owner controls', 'Operations', 'Current shift, tank capacities and correction requests.')}
    <section class="card"><h2>Current open shift</h2>${active ? `<p><strong>Shift #${active.id} · ${safe(active.opener)}</strong></p>
      <p>Opened ${timestamp(active.opened_at)} · Business date ${safe(active.business_date)} · Open ${active.hours} hours</p>
      ${active.overdue ? '<p class="notice">Overdue: this shift has been open for at least 12 hours.</p>' : ''}
      <p>Opening readings: ${active.nozzles.map(item => safe(item.code) + ' ' + volume(item.opening)).join(' · ')}</p>
      <small>Closing entries appear after submission. Unsaved entries remain on the manager’s device.</small>` : '<p>No shift is currently open.</p>'}
      <button id="refresh-operations" class="secondary" type="button">Refresh status</button></section>
    <section class="card"><h2>Tank capacities and low stock thresholds</h2><p>Enter the combined usable capacity for each fuel. Low stock warnings use the threshold you set, measured against calculated stock.</p>
      ${fuelNames.map(fuel => `<form class="business-form" id="tank-${fuel}"><h3>${fuel}</h3><p>Current book stock ${volume(data.stock[fuel])}</p>
        ${numberField('Usable capacity (L)', 'capacity', {required:true, step:'0.001', min:0.001, value: data.tanks[fuel] ? data.tanks[fuel].capacity / 1000 : undefined})}
        ${numberField('Low stock warning at or below (L)', 'low_level', {required:true, step:'0.001', value: data.tanks[fuel] ? data.tanks[fuel].low_level / 1000 : undefined})}
        ${errorbox}<button class="primary">Save ${fuel} tank</button></form>`).join('')}
    </section>
    <section class="card"><h2>Correction requests</h2><p>Request changes from a shift’s report. Manager responses appear here. Resolve only after checking the figures and recording what happened.</p>
      ${data.corrections.length ? data.corrections.map(item => `<details class="business-record"><summary>Shift #${item.shift_id} · ${item.resolved_at ? 'Closed' : item.responded_at ? 'Response received' : 'Awaiting manager'}</summary>
        <p>${safe(item.reason)}</p><small>Requested ${timestamp(item.requested_at)}</small>
        ${item.response ? `<p><strong>Manager response</strong> ${safe(item.response)}</p>` : ''}
        <button type="button" id="correction-shift-${item.id}" class="secondary">Open shift #${item.shift_id}</button>
        ${item.resolved_at ? `<p><strong>Resolution</strong> ${safe(item.resolution)}</p>` : `<form id="resolve-${item.id}" class="business-form">${businessNote('Resolution / adjustment made', 'resolution', true, 1000)}${errorbox}<button class="primary">Close request</button></form>`}</details>`).join('') : '<p>No correction requests.</p>'}
    </section>`, 'operations');
  listen('refresh-operations', () => openBusiness('operations'));
  fuelNames.forEach(fuel => saveBusinessForm('tank-' + fuel, '/tanks', {fuel}, 'operations'));
  data.corrections.forEach(item => {
    listen('correction-shift-' + item.id, async () => showReport(await api('/shifts/' + item.shift_id)));
    if (!item.resolved_at) saveBusinessForm('resolve-' + item.id, '/corrections/' + item.id + '/resolve', {}, 'operations');
  });
}

function showExceptions(data) {
  shell(`${heading('Owner controls', 'Exception inbox', 'Outstanding issues across all business dates. Acknowledging records a follow-up note; it does not change the underlying figures.')}
    <section class="card"><label>Show<select id="exception-filter"><option value="open">Needs attention</option><option value="all">All active exceptions</option></select></label>
    <p>${data.exceptions.filter(item => !item.acknowledgement).length} need attention · ${data.exceptions.length} active exceptions</p>
    ${data.exceptions.length ? data.exceptions.map((item, index) => `<details class="business-record exception-record" data-ack="${Boolean(item.acknowledgement)}" ${item.acknowledgement ? 'hidden' : ''}>
      <summary>${safe(item.kind)} · ${safe(item.message)}</summary>
      ${item.shift_id ? `<button type="button" class="secondary" id="exception-shift-${index}">Open shift #${item.shift_id}</button>` : ''}
      ${item.acknowledgement ? `<p><strong>Follow-up recorded</strong> ${safe(item.acknowledgement.note)}</p><small>${timestamp(item.acknowledgement.created_at)}</small>` : `<form id="ack-${index}" class="business-form">${businessNote('Follow-up / action taken', 'note', true)}${errorbox}<button class="primary">Acknowledge</button></form>`}
      </details>`).join('') : '<p>No active exceptions.</p>'}</section>`, 'exceptions');
  listen('exception-filter', event => {
    document.querySelectorAll('.exception-record').forEach(row => { row.hidden = event.target.value === 'open' && row.dataset.ack === 'true'; });
  }, 'change');
  data.exceptions.forEach((item, index) => {
    if (item.shift_id) listen('exception-shift-' + index, async () => {
      if (data.active?.id === item.shift_id) await openBusiness('operations');
      else showReport(await api('/shifts/' + item.shift_id));
    });
    if (!item.acknowledgement) saveBusinessForm('ack-' + index, '/exceptions/acknowledge', {key:item.key}, 'exceptions');
  });
}

function managerControls(manager) {
  return `<details class="business-record"><summary>${safe(manager.name)} · ${safe(manager.login_id)} · ${manager.disabled ? 'Inactive' : 'Active'}</summary>
    <form id="edit-manager-${manager.id}" class="business-form"><label>Name<input name="name" value="${safe(manager.name)}" required maxlength="80"></label>
      <label>Mobile number<input name="phone" type="tel" value="${safe(manager.login_id)}" required maxlength="24"></label>${errorbox}<button class="secondary">Save manager details</button></form>
    <form id="reset-manager-${manager.id}" class="business-form"><label>New password<input name="password" type="password" required minlength="7" maxlength="200" autocomplete="new-password"></label>${errorbox}<button class="secondary">Reset password and sign out</button></form>
    <form id="status-manager-${manager.id}" class="business-form"><p>${manager.disabled ? 'Enable sign-in for this manager.' : 'Deactivate sign-in and end all active sessions. Historical shifts are retained.'}</p>${errorbox}<button class="secondary">${manager.disabled ? 'Activate manager' : 'Deactivate manager'}</button></form>
    <form id="revoke-manager-${manager.id}" class="business-form">${errorbox}<button class="secondary">Sign out all manager sessions</button></form></details>`;
}

function bindManagerControls(managers) {
  managers.forEach(manager => {
    for (const [prefix, action] of [['edit','edit'], ['reset','reset_password'], ['status',manager.disabled ? 'enable' : 'disable'], ['revoke','revoke_sessions']]) {
      bindForm(prefix + '-manager-' + manager.id, async form => {
        await api('/managers/' + manager.id, {...fields(form), action});
        await openTeam();
        showBusinessNotice('Manager account updated. Previous sessions have ended.');
      });
    }
  });
}

function correctionPanel(shift) {
  return `<section class="card"><h2>Corrections and clarification</h2><p>The original report is retained when corrected. Figures can be corrected only before a later shift, bank reconciliation or customer repayment depends on them.</p>
    <button type="button" id="correct-report" class="secondary">Correct report figures</button>
    <form id="request-correction" class="business-form">${businessNote('Ask the manager to clarify or correct', 'reason', true)}${errorbox}<button class="secondary">Send correction request</button></form>
    ${(shift.corrections || []).map(item => `<p><strong>${item.resolved_at ? 'Closed' : 'Open'} request</strong> · ${safe(item.reason)}${item.response ? '<br>Manager: ' + safe(item.response) : ''}${item.resolution ? '<br>Resolution: ' + safe(item.resolution) : ''}</p>`).join('')}
    ${(shift.revisions || []).map(item => `<details class="business-record"><summary>Correction by ${safe(item.actor)} · ${timestamp(item.created_at)}</summary><p>${safe(item.reason)}</p>
      ${revisionComparison(item)}</details>`).join('')}</section>`;
}

function revisionComparison(item) {
  const describe = report => {
    const rows = { 'Metered sales': money(report.sales), 'Total collections': money(report.collection_total),
      'Cash counted': money(report.counted), 'Cash difference': money(report.cash_difference), 'Till expenses': money(report.expenses),
      'Expense note': report.expense_note || '—', 'Handover note': report.shift_note || '—' };
    Object.keys(methodNames).forEach(method => { rows[methodNames[method] + ' collections'] = money(report.collections[method]); });
    report.nozzles.forEach(nozzle => { rows[nozzle.code + ' closing meter'] = volume(nozzle.closing); });
    fuelNames.forEach(fuel => {
      rows[fuel + ' delivered'] = volume(report.fuels[fuel].delivery);
      rows[fuel + ' physical stock'] = report.fuels[fuel].physical === null ? 'No reading' : volume(report.fuels[fuel].physical);
    });
    Object.entries(report.entries || {}).forEach(([category, entries]) => {
      rows[category + ' detail'] = entries.map(entry => [entry.method || entry.fuel || '', entry.amount === undefined ? volume(entry.quantity) : money(entry.amount), entry.party, entry.reference, entry.note].filter(Boolean).join(' · ')).join('; ') || 'No entries';
    });
    return rows;
  };
  const before = describe(JSON.parse(item.original_json)), after = describe(JSON.parse(item.replacement_json));
  const priorReview = JSON.parse(item.original_review || 'null');
  return `${priorReview ? `<p>Previous review: ${timestamp(priorReview.reviewed_at)} · ${safe(priorReview.note || 'No note')}</p>` : ''}<div class="table-scroll"><table><thead><tr><th>Changed figure</th><th>Before</th><th>After</th></tr></thead><tbody>${Object.keys(before).filter(key => before[key] !== after[key]).map(key => `<tr><th>${safe(key)}</th><td>${safe(before[key])}</td><td>${safe(after[key])}</td></tr>`).join('')}</tbody></table></div>`;
}

function bindCorrectionPanel(shift, source) {
  listen('correct-report', () => showClosing({...shift, rates:Object.fromEntries(fuelNames.map(fuel => [fuel, shift.fuels[fuel].rate]))}, shift));
  bindForm('request-correction', async form => {
    await api('/shifts/' + shift.id + '/corrections', fields(form));
    showReport(await api('/shifts/' + shift.id), source);
  });
}

function fillCorrectionForm(form, shift) {
  const put = (name, value) => { form.elements[name].value = value; };
  shift.nozzles.forEach(item => put('closing_' + item.id, item.closing / 1000));
  fuelNames.forEach(fuel => {
    put('delivery_' + fuel, shift.fuels[fuel].delivery / 1000);
    put('physical_' + fuel, shift.fuels[fuel].physical === null ? '' : shift.fuels[fuel].physical / 1000);
  });
  Object.keys(methodNames).forEach(method => put(method, shift.collections[method] / 100));
  for (const name of ['expenses','counted']) put(name, shift[name] / 100);
  put('expense_note', shift.expense_note || ''); put('shift_note', shift.shift_note || '');
  const entries = Object.fromEntries(Object.entries(shift.entries || {}).map(([category, rows]) => [category, rows.map(row => ({...row,
    ...(row.amount === undefined ? {} : {amount: row.amount / 100}), ...(row.quantity === undefined ? {} : {quantity: row.quantity / 1000})}))]));
  restoreEntries(form, entries);
  form.dispatchEvent(new Event('change', {bubbles:true}));
}

async function openManagerRequests() {
  const requests = await api('/corrections');
  shell(`${heading('', 'Owner requests', 'Respond with the correct figures and explanation. The owner applies and records any report correction.')}
    <section class="card">${requests.length ? requests.map(item => `<article class="business-record"><h2>Shift #${item.shift_id} · ${item.resolved_at ? 'Closed' : 'Open'}</h2><p>${safe(item.reason)}</p><small>${timestamp(item.requested_at)} · ${safe(item.requester)}</small>
      ${item.response ? `<p><strong>Your station’s response</strong> ${safe(item.response)}</p>` : ''}
      ${item.resolved_at ? `<p><strong>Owner resolution</strong> ${safe(item.resolution)}</p>` : !item.responded_at ? `<form id="respond-${item.id}" class="business-form">${businessNote('Correct figures / explanation', 'response', true, 1000)}${errorbox}<button class="primary">Send response</button></form>` : '<p>Awaiting owner resolution.</p>'}</article>`).join('') : '<p>No requests from the owner.</p>'}</section>`, 'requests');
  requests.forEach(item => { if (!item.resolved_at && !item.responded_at) bindForm('respond-' + item.id, async form => {
    await api('/corrections/' + item.id + '/respond', fields(form)); await openManagerRequests();
  }); });
}

function unallocatedCreditForms(data) {
  return (data.unallocated_shifts || []).map(item => `<details class="business-record"><summary>Shift #${item.shift_id} · ${money(item.remaining)} credit to allocate</summary>
    <form id="allocate-${item.shift_id}" class="business-form">${businessText('Customer / account name', 'name')}${numberField('Credit amount to assign (₹)', 'amount', {required:true,min:0.01,max:item.remaining / 100})}
    ${businessText('Unique allocation reference', 'reference')}${errorbox}<button class="secondary">Assign credit to customer</button></form></details>`).join('');
}
function bindUnallocatedCredit(data) {
  (data.unallocated_shifts || []).forEach(item => saveBusinessForm('allocate-' + item.shift_id, '/credit-allocations', {shift_id:item.shift_id}, 'money'));
}

function moneyRecordHistory(data) {
  const records = [...data.repayments.map(item => ({...item, kind:'repayment', title:'Customer repayment', date:item.paid_on})),
    ...data.bank_records.map(item => ({...item, kind:'bank', title:item.method === 'cash' ? 'Cash deposit' : 'Bank settlement', date:item.bank_date}))];
  return `<section class="card"><h2>Money record history</h2><p>To correct a mistaken entry, void it with a reason and record a replacement using a new reference. Original records are retained.</p>
    ${records.length ? records.map(item => `<details class="business-record"><summary>${safe(item.title)} · ${safe(item.reference)} · ${money(item.amount)} · ${item.void ? 'Void' : 'Recorded'}</summary>
      <p>${safe(item.date)} · ${safe(item.method)} · ${safe(item.note)}${item.fees ? ' · Fees ' + money(item.fees) : ''}</p><small>Recorded by ${safe(item.actor)} · ${timestamp(item.created_at)}</small>
      ${item.void ? `<p><strong>Void reason</strong> ${safe(item.void.reason)}</p><small>${safe(item.void.actor)} · ${timestamp(item.void.created_at)}</small>` : `<form id="void-${item.kind}-${item.id}" class="business-form">${businessNote('Reason for voiding this entry', 'reason', true)}${errorbox}<button class="secondary">Void this entry</button></form>`}</details>`).join('') : '<p>No money entries recorded yet.</p>'}</section>`;
}
function bindMoneyHistory(data) {
  for (const [kind, rows] of [['repayment', data.repayments], ['bank', data.bank_records]]) rows.forEach(item => {
    if (!item.void) saveBusinessForm('void-' + kind + '-' + item.id, '/money-records/' + kind + '/' + item.id + '/void', {}, 'money');
  });
}

function showBusinessNotice(message) {
  const notice = document.querySelector('#notice');
  if (notice) { notice.hidden = false; notice.textContent = message; }
}
function configuredTankStatus(fuel, item, tank) {
  if (!tank) return '<p class="quiet">Capacity not configured. Set usable capacity and low stock threshold in Operations.</p>';
  const percent = Math.max(0, Math.round(item.calculated / tank.capacity * 100));
  const warning = item.calculated > tank.capacity ? 'Above configured capacity' : item.calculated <= tank.low_level ? 'Low stock warning' : '';
  return `<p class="${warning ? 'discrepancy' : 'quiet'}">${percent}% of ${volume(tank.capacity)} capacity${warning ? ' · ' + warning : ''}</p>`;
}
function restoreEntries(form, entries) {
  for (const [category, rows] of Object.entries(entries || {})) {
    const list = form.querySelector(`[data-entry-list="${category}"]`);
    if (!list || !Array.isArray(rows)) continue;
    list.textContent = '';
    for (const row of rows) {
      list.insertAdjacentHTML('beforeend', entryRow(category));
      const element = list.lastElementChild;
      element.querySelectorAll('[data-field]').forEach(input => {
        if (row[input.dataset.field] !== undefined) input.value = row[input.dataset.field];
      });
    }
  }
}
