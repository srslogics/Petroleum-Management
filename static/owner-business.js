"use strict";

function businessOverview(data) {
  const count = data.exceptions_count;
  const balance = data.customer_balance;
  return `<section class="owner-control-summary" aria-label="Current operations and balances">
    <button id="overview-operations" type="button" class="overview-action" aria-label="View operations">
      <span class="action-label">${navigationIcon('operations')} Current shift</span>
      <strong>${data.active ? 'Shift #' + data.active.id : 'No active shift'}</strong>
      <span class="action-detail">${data.active ? `${safe(data.active.opener)} · ${data.active.hours}h open${data.active.overdue ? ' · Overdue' : ''}` : 'Ready when your team is'}<span aria-hidden="true">↗</span></span>
    </button>
    <button id="overview-exceptions" type="button" class="overview-action ${count ? 'needs-attention' : ''}" aria-label="${count} exceptions need attention">
      <span class="action-label">${navigationIcon('exceptions')} Exceptions</span><strong>${count ? count + ' to check' : 'All clear'}</strong>
      <span class="action-detail">${count ? 'All dates · Open the inbox' : 'All dates · No open issues'}<span aria-hidden="true">↗</span></span>
    </button>
    <button id="overview-money" type="button" class="overview-action" aria-label="Customer credit ${money(balance)}">
      <span class="action-label">${navigationIcon('money')} Customer outstanding</span><strong>${money(balance)}</strong>
      <span class="action-detail">All dates · View credit ledger<span aria-hidden="true">↗</span></span>
    </button>
  </section>`;
}

function bindBusinessOverview() {
  for (const view of ['operations', 'exceptions', 'money']) listen('overview-' + view, () => openBusiness(view));
}

const businessText = (label, name, required = true, limit = 150) => `<label>${label}<input name="${name}" ${required ? 'required' : ''} maxlength="${limit}"></label>`;
const businessNote = (label = 'Note', name = 'note', required = false, limit = 500) => `<label>${label}<textarea name="${name}" ${required ? 'required' : ''} maxlength="${limit}" rows="2"></textarea></label>`;
const businessDate = (label, name, value, required = true) => `<label>${label}<input type="date" name="${name}" value="${safe(value)}" ${required ? 'required' : ''}></label>`;

async function openBusiness(view = 'operations') {
  const data = await api('/business/' + view);
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

function whatsappNumber(phone) {
  const digits = phone.replace(/[\s().-]/g, "").replace(/^\+/, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : "";
}

function whatsappUrl(message, digits = "") {
  const url = new URL("https://wa.me/" + digits);
  if (message) url.searchParams.set("text", message);
  return url.href;
}

function whatsappLink(label, message, digits = "") {
  return `<a class="secondary whatsapp-link" href="${safe(whatsappUrl(message, digits))}" target="_blank" rel="noopener noreferrer">${safe(label)}</a>`;
}

function openWhatsAppComposer(message = "") {
  moneyDialog("Send with WhatsApp", `<form id="whatsapp-form" class="money-form">
    <label>WhatsApp number (optional)<input name="recipient" type="tel" maxlength="24" placeholder="+91 …" autocomplete="off" aria-describedby="whatsapp-recipient-help"></label>
    <p id="whatsapp-recipient-help" class="money-form-hint">Include the country code, or leave this blank to choose a contact in WhatsApp.</p>
    <div><label for="whatsapp-message">Message</label><textarea id="whatsapp-message" name="message" rows="6" maxlength="2000">${safe(message)}</textarea></div>
    ${errorbox}<button class="primary" type="submit">Open WhatsApp</button>
  </form>`);
  bindForm("whatsapp-form", form => {
    const phone = form.elements.recipient.value.trim();
    const digits = whatsappNumber(phone);
    const text = form.elements.message.value.trim();
    if (phone && (!phone.startsWith("+") || !digits)) {
      throw new Error("Enter a mobile number starting with + and its country code.");
    }
    if (!digits && !text) throw new Error("Enter a number or write a message.");
    window.open(whatsappUrl(text, digits), "_blank", "noopener,noreferrer");
  }, false);
}

function managerControls(manager) {
  const phone = whatsappNumber(manager.login_id);
  return `<details class="business-record"><summary>${safe(manager.name)} · ${safe(manager.login_id)} · ${manager.disabled ? 'Inactive' : 'Active'}</summary>
    ${phone ? whatsappLink("WhatsApp " + manager.name, "", phone) : ""}
    <form id="edit-manager-${manager.id}" class="business-form"><label>Name<input name="name" value="${safe(manager.name)}" required maxlength="80"></label>
      <label>Mobile number<input name="phone" type="tel" value="${safe(manager.login_id)}" required maxlength="24"></label>${errorbox}<button class="secondary">Save manager details</button></form>
    <form id="reset-manager-${manager.id}" class="business-form"><label>New password<input name="password" type="password" required minlength="15" maxlength="200" autocomplete="new-password"></label>${errorbox}<button class="secondary">Reset password and sign out</button></form>
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

function showBusinessNotice(message) {
  const notice = document.querySelector('#notice');
  if (notice) { notice.className = 'success'; notice.hidden = false; notice.textContent = message; }
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
