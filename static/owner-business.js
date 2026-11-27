"use strict";

function businessOverview(data) {
  const count = data.exceptions_count;
  const balance = data.customer_balance + data.market_balance;
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
    <button id="overview-money" type="button" class="overview-action" aria-label="Receivables ${money(balance)}">
      <span class="action-label">${navigationIcon('money')} Receivables</span><strong>${money(balance)}</strong>
      <span class="action-detail">All dates · View amounts owed<span aria-hidden="true">↗</span></span>
    </button>
  </section>`;
}

function bindBusinessOverview() {
  for (const view of ['operations', 'exceptions', 'money']) listen('overview-' + view, () => openBusiness(view));
}

const businessText = (label, name, required = true, limit = 150) => `<label>${label}<input name="${name}" ${required ? 'required' : ''} maxlength="${limit}"></label>`;
const businessNote = (label = 'Note', name = 'note', required = false, limit = 500) => `<label>${label}<textarea name="${name}" ${required ? 'required' : ''} maxlength="${limit}" rows="2"></textarea></label>`;
const businessDate = (label, name, value, required = true) => `<label>${label}<input type="date" name="${name}" value="${safe(value)}" ${required ? 'required' : ''}></label>`;

function openBusiness(view = 'operations', afterRender) {
  const render = {money: showMoney, banking: data => showMoney(data, true), exceptions: showExceptions, operations: showOperations}[view];
  return loadOwnerView('/business/' + view, data => {
    render(data);
    afterRender?.(data);
  });
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

function currentShiftCard(active) {
  return `<section class="card card-flow" aria-labelledby="current-shift-heading">
    <header class="section-head">
      <div><h2 id="current-shift-heading">Current open shift</h2>
        ${active ? `<p>Shift #${active.id} · Opened by ${safe(active.opener)}</p>` : ''}
      </div>
      <button id="refresh-operations" class="secondary" type="button">Refresh status</button>
    </header>
    ${active ? `<dl class="shift-facts">
      <div><dt>Status</dt><dd>${moneyBadge(active.overdue ? 'Overdue' : 'Open', active.overdue ? 'warning' : 'positive')}${active.overdue ? '<small>Open for 12 hours or more</small>' : ''}</dd></div>
      <div><dt>Time open</dt><dd>${active.hours} hours</dd></div>
      <div><dt>Opened</dt><dd><time datetime="${safe(active.opened_at)}">${timestamp(active.opened_at)}</time></dd></div>
      <div><dt>Business date</dt><dd><time datetime="${safe(active.business_date)}">${businessDay(active.business_date, 'medium')}</time></dd></div>
    </dl>
    <div class="opening-meters"><h3>Opening readings</h3>
      <dl class="meter-grid">${active.nozzles.map(item => `<div>
        <dt><strong>${safe(item.code)}</strong> ${fuelTag(item.fuel)}</dt><dd>${volume(item.opening)}</dd>
      </div>`).join('')}</dl>
    </div>
    <p class="quiet">Closing entries appear here after the manager submits the shift. Unsaved entries stay on the manager’s device.</p>`
      : '<p class="inline-empty">No shift is currently open.</p>'}
  </section>`;
}

function showOperations(data) {
  shell(`${heading('', 'Operations', 'Monitor the current shift, set stock alerts and follow up on corrections.')}
    ${currentShiftCard(data.active)}
    <section class="card card-flow">
      <header class="section-head"><div><h2>Tank capacities and low stock thresholds</h2><p>Set a combined usable capacity and low stock threshold for each fuel.</p></div></header>
      <div class="fuel-grid tank-grid">${fuelNames.map(fuel => `<form class="business-form tank-form" id="tank-${fuel}">
        <div><h3>${fuelTag(fuel)}</h3><p class="quiet">Book stock <strong>${volume(data.stock[fuel])}</strong></p></div>
        ${numberField('Usable capacity (L)', 'capacity', {required:true, step:'0.001', min:0.001, value: data.tanks[fuel] ? data.tanks[fuel].capacity / 1000 : undefined})}
        ${numberField('Low stock warning at or below (L)', 'low_level', {required:true, step:'0.001', value: data.tanks[fuel] ? data.tanks[fuel].low_level / 1000 : undefined})}
        ${errorbox}<button class="primary">Save ${fuel} tank</button></form>`).join('')}</div>
    </section>
    <section class="card card-flow">
      <header class="section-head"><div><h2>Correction requests</h2><p>Requests sent from shift reports and the manager’s responses.</p></div></header>
      ${data.corrections.length ? `<div class="record-list">${data.corrections.map(item => `<details class="business-record">
        <summary><span><strong>Shift #${item.shift_id}</strong><small>Requested ${timestamp(item.requested_at)}</small></span>
          ${moneyBadge(item.resolved_at ? 'Closed' : item.responded_at ? 'Response received' : 'Awaiting manager', item.resolved_at ? 'neutral' : item.responded_at ? 'positive' : 'warning')}</summary>
        <div class="record-body">${requestDetails(item)}
        <button type="button" id="correction-shift-${item.id}" class="secondary">Open shift #${item.shift_id}</button>
        ${item.resolved_at ? '' : `<form id="resolve-${item.id}" class="business-form">${businessNote('Resolution / adjustment made', 'resolution', true, 1000)}${errorbox}<button class="primary">Close request</button></form>`}</div>
      </details>`).join('')}</div>` : '<p class="inline-empty">No correction requests.</p>'}
    </section>`, 'operations');
  listen('refresh-operations', () => openBusiness('operations'));
  fuelNames.forEach(fuel => saveBusinessForm('tank-' + fuel, '/tanks', {fuel}, 'operations'));
  data.corrections.forEach(item => {
    listen('correction-shift-' + item.id, () => openShiftReport(item.shift_id, 'operations'));
    if (!item.resolved_at) saveBusinessForm('resolve-' + item.id, '/corrections/' + item.id + '/resolve', {}, 'operations');
  });
}

function requestDetails(item) {
  return `<dl class="record-notes">
    <div><dt>Request</dt><dd>${safe(item.reason)}</dd></div>
    ${item.response ? `<div><dt>Manager response</dt><dd>${safe(item.response)}</dd></div>` : ''}
    ${item.resolved_at ? `<div><dt>Owner resolution</dt><dd>${safe(item.resolution)}</dd></div>` : ''}
  </dl>`;
}

function showExceptions(data) {
  const pending = data.exceptions.filter(item => !item.acknowledgement).length;
  shell(`${heading('', 'Exception inbox', 'Review station issues across all business dates and record your follow-up.')}
    <section class="card card-flow">
    <header class="section-head"><div><h2>Station exceptions</h2><p>${pending} need attention · ${data.exceptions.length} active</p></div>
      <label class="compact-filter">Show<select id="exception-filter"><option value="open">Needs attention</option><option value="all">All active exceptions</option></select></label></header>
    <div class="record-list">${data.exceptions.map((item, index) => `<details class="business-record exception-record" data-ack="${Boolean(item.acknowledgement)}" ${item.acknowledgement ? 'hidden' : ''}>
      <summary><span><strong>${safe(item.kind)}</strong><small>${safe(item.message)}</small></span>
        ${moneyBadge(item.acknowledgement ? 'Acknowledged' : 'Needs attention', item.acknowledgement ? 'neutral' : 'warning')}</summary>
      <div class="record-body">
      ${item.shift_id ? `<button type="button" class="secondary" id="exception-shift-${index}">Open shift #${item.shift_id}</button>` : ''}
      ${item.acknowledgement ? `<dl class="record-notes"><div><dt>Follow-up recorded</dt><dd>${safe(item.acknowledgement.note)}</dd></div></dl><small>${timestamp(item.acknowledgement.created_at)}</small>` : `<form id="ack-${index}" class="business-form">${businessNote('Follow-up / action taken', 'note', true)}<p class="quiet">Acknowledging adds a note to this exception. The recorded figures stay as entered.</p>${errorbox}<button class="primary">Acknowledge</button></form>`}
      </div></details>`).join('')}</div>
    <p id="exception-empty" class="inline-empty" role="status" ${pending ? 'hidden' : ''}>${data.exceptions.length ? 'No exceptions need attention.' : 'No active exceptions.'}</p></section>`, 'exceptions');
  listen('exception-filter', event => {
    const showAll = event.target.value === 'all';
    document.querySelectorAll('.exception-record').forEach(row => { row.hidden = !showAll && row.dataset.ack === 'true'; });
    document.querySelector('#exception-empty').hidden = showAll ? data.exceptions.length > 0 : pending > 0;
  }, 'change');
  data.exceptions.forEach((item, index) => {
    if (item.shift_id) listen('exception-shift-' + index, async () => {
      if (data.active?.id === item.shift_id) await openBusiness('operations');
      else await openShiftReport(item.shift_id, 'exceptions');
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

function openWhatsAppComposer(message = "", title = "Send with WhatsApp") {
  moneyDialog(title, `<form id="whatsapp-form" class="money-form">
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
  return `<details class="business-record">
    <summary><span><strong>${safe(manager.name)}</strong><small>${safe(manager.login_id)}</small></span>
      ${moneyBadge(manager.disabled ? 'Inactive' : 'Active', manager.disabled ? 'neutral' : 'positive')}</summary>
    <div class="record-body">
      ${phone ? whatsappLink("WhatsApp " + manager.name, "", phone) : ""}
      <form id="edit-manager-${manager.id}" class="business-form"><h3>Manager details</h3>
        <div class="field-grid">
          <label>Name<input name="name" value="${safe(manager.name)}" required maxlength="80"></label>
          <label>Mobile number<input name="phone" type="tel" value="${safe(manager.login_id)}" required maxlength="24"></label>
        </div>${errorbox}<button class="secondary">Save manager details</button></form>
      <form id="reset-manager-${manager.id}" class="business-form"><h3>Password reset</h3>
        <label>New password<input name="password" type="password" required minlength="15" maxlength="200" autocomplete="new-password"></label>
        ${errorbox}<button class="secondary">Reset password and sign out</button></form>
      <div class="record-actions"><h3>Account access</h3>
        <p class="quiet">${manager.disabled ? 'This manager’s sign-in is disabled.' : 'Deactivation ends active sessions and keeps historical shifts.'}</p>
        <div class="workspace-actions">
          <form id="status-manager-${manager.id}" class="business-form">${errorbox}<button class="secondary">${manager.disabled ? 'Activate manager' : 'Deactivate manager'}</button></form>
          <form id="revoke-manager-${manager.id}" class="business-form">${errorbox}<button class="secondary">Sign out all manager sessions</button></form>
        </div>
      </div>
    </div></details>`;
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
  const requests = shift.corrections || [];
  const revisions = shift.revisions || [];
  return `<section class="card card-flow">
    <header class="section-head"><div><h2>Corrections and clarification</h2>
      <p>Corrections retain the original report and are available until another shift, bank record or repayment depends on it.</p></div></header>
    <button type="button" id="correct-report" class="secondary">Correct report figures</button>
    <form id="request-correction" class="business-form record-actions"><h3>Request clarification</h3>
      ${businessNote('Ask the manager to clarify or correct', 'reason', true)}${errorbox}<button class="secondary">Send correction request</button></form>
    ${requests.length || revisions.length ? `<div class="record-list">
      ${requests.map(item => `<article class="business-record">
        <header class="section-head record-heading"><h3>Correction request</h3>${moneyBadge(item.resolved_at ? 'Closed' : 'Open', item.resolved_at ? 'neutral' : 'warning')}</header>
        <div class="record-body">${requestDetails(item)}</div>
      </article>`).join('')}
      ${revisions.map(item => `<details class="business-record">
        <summary><span><strong>Correction by ${safe(item.actor)}</strong><small>${timestamp(item.created_at)}</small></span></summary>
        <div class="record-body"><p>${safe(item.reason)}</p>${revisionComparison(item)}</div>
      </details>`).join('')}
    </div>` : ''}</section>`;
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
  listen('correct-report', () => showClosing({...shift, rates:Object.fromEntries(fuelNames.map(fuel => [fuel, shift.fuels[fuel].rate]))}, shift, source));
  bindForm('request-correction', async form => {
    await api('/shifts/' + shift.id + '/corrections', fields(form));
    await openShiftReport(shift.id, source);
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
  shell(`${heading('', 'Owner requests', 'Send the correct figures and a short explanation so the owner can update the report.')}
    <div class="stack request-list">${requests.length ? requests.map(item => `<article class="card card-flow">
      <header class="section-head"><div><h2>Shift #${item.shift_id}</h2><p>${safe(item.requester)} · ${timestamp(item.requested_at)}</p></div>
        ${moneyBadge(item.resolved_at ? 'Closed' : item.responded_at ? 'Awaiting owner' : 'Needs response', item.resolved_at ? 'neutral' : item.responded_at ? 'positive' : 'warning')}</header>
      ${requestDetails(item)}
      ${!item.resolved_at && !item.responded_at ? `<form id="respond-${item.id}" class="business-form">${businessNote('Correct figures / explanation', 'response', true, 1000)}${errorbox}<button class="primary">Send response</button></form>` : ''}
    </article>`).join('') : `<section class="card empty-card">
      ${navigationIcon('requests')}<div><h2>No requests from the owner</h2><p>Requests for shift details will appear here.</p></div>
    </section>`}</div>`, 'requests');
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
