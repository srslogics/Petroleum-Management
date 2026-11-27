"use strict";

const receivablesLedger = {search: '', status: 'all'};

function buildReceivablesLedger(data) {
  const byName = new Map();
  const byCustomerKey = new Map();
  const byDueId = new Map();
  const accountFor = name => {
    const key = contactKey(name);
    if (!byName.has(key)) byName.set(key, {name, entries: [], charged: 0, paid: 0, balance: 0, overdue: 0});
    return byName.get(key);
  };
  for (const customer of data.customers) {
    const account = accountFor(customer.name);
    byCustomerKey.set(customer.customer_key, account);
    account.customer = customer;
    account.entries.push(...customer.transactions.map(row => ({...row, type: row.amount < 0 ? 'Fuel credit payment' : 'Fuel credit sale'})));
    account.overdue += customer.overdue ? customer.balance : 0;
  }
  for (const item of data.market_receivables) {
    const account = accountFor(item.party);
    byDueId.set(item.id, account);
    account.entries.push({date: item.recorded_on, type: marketKinds[item.kind], amount: item.amount, reference: item.reference,
      note: item.note, due: item, void: item.void});
    account.overdue += item.overdue ? item.balance : 0;
  }
  for (const row of data.repayments) {
    if (!row.void || !byCustomerKey.has(row.customer_key)) continue;
    byCustomerKey.get(row.customer_key).entries.push({date: row.paid_on, type: 'Fuel credit payment', amount: -row.amount,
      reference: row.reference, note: row.note, void: row.void});
  }
  for (const row of data.market_receipts) {
    byDueId.get(row.receivable_id).entries.push({date: row.paid_on, type: 'Receivable payment', amount: -row.amount,
      reference: row.reference, note: row.note, void: row.void});
  }
  for (const account of byName.values()) {
    account.entries.sort((a, b) => a.date.localeCompare(b.date) || Number(a.amount < 0) - Number(b.amount < 0));
    for (const row of account.entries) {
      if (!row.void) {
        if (row.amount > 0) account.charged += row.amount;
        else account.paid -= row.amount;
        account.balance += row.amount;
      }
      row.balance = account.balance;
    }
    account.entries.reverse();
  }
  return [...byName.values()].sort((a, b) => (b.balance > 0) - (a.balance > 0) || a.name.localeCompare(b.name));
}

function receivablesLedgerPanel(accounts) {
  return `<div id="money-panel-ledger" role="tabpanel" aria-labelledby="money-tab-ledger" ${moneyView.tab === 'ledger' ? '' : 'hidden'}>
    <div class="money-toolbar"><h2>Party ledger <span id="ledger-count"></span></h2>
      <div class="money-tools">${moneySearch('ledger-search', 'Search people or businesses', receivablesLedger.search)}
        <label><span class="sr-only">Ledger status</span><select id="ledger-filter">${moneyOptions([
          ['all', 'All parties'], ['outstanding', 'With dues'], ['overdue', 'Overdue']
        ], receivablesLedger.status)}</select></label>
      </div>
    </div>
    ${accounts.length ? `<div class="table-scroll money-table-wrap" id="receivables-ledger-table"><table class="money-table">
      <thead><tr><th>Owed by</th><th class="numeric">Charged</th><th class="numeric">Received</th><th class="numeric">To collect</th></tr></thead>
      <tbody>${accounts.map((item, index) => `<tr data-ledger-row data-search="${safe(contactKey(item.name))}" data-balance="${item.balance}" data-overdue="${item.overdue}">
        <th scope="row"><button id="ledger-party-${index}" class="money-source-link market-detail" type="button"
          aria-label="View ledger for ${safe(item.name)}">${safe(item.name)}<small>${item.overdue ? 'Overdue · ' : ''}${item.entries.length} ${item.entries.length === 1 ? 'entry' : 'entries'}</small></button></th>
        <td class="numeric">${money(item.charged)}</td><td class="numeric">${money(item.paid)}</td>
        <td class="numeric"><strong>${money(item.balance)}</strong></td></tr>`).join('')}</tbody>
    </table></div><div id="ledger-no-match" hidden>${moneyEmpty('No matching parties', 'Try another name or change the filter.')}</div>`
    : moneyEmpty('No ledger entries yet', 'Recorded fuel credit and other receivables will appear here by person or business.')}
  </div>`;
}

function bindReceivablesLedger(data, accounts) {
  for (const [index, item] of accounts.entries()) listen('ledger-party-' + index, () => openPartyLedger(data, item));
  const filter = () => {
    let count = 0;
    for (const row of document.querySelectorAll('[data-ledger-row]')) {
      const {search, balance, overdue} = row.dataset;
      const status = receivablesLedger.status;
      row.hidden = !search.includes(contactKey(receivablesLedger.search)) ||
        (status === 'outstanding' && Number(balance) <= 0) || (status === 'overdue' && Number(overdue) <= 0);
      if (!row.hidden) count++;
    }
    document.getElementById('ledger-count').textContent = String(count);
    if (accounts.length) {
      document.getElementById('receivables-ledger-table').hidden = count === 0;
      document.getElementById('ledger-no-match').hidden = count > 0;
    }
  };
  listen('ledger-search', event => { receivablesLedger.search = event.target.value; filter(); }, 'input');
  listen('ledger-filter', event => { receivablesLedger.status = event.target.value; filter(); }, 'change');
  filter();
}

async function openPartyLedger(data, account) {
  const page = document.getElementById('main-content');
  const contact = matchingContact(await ownerContacts().catch(() => []), account.name);
  if (!page.isConnected) return;
  moneyDialog(account.name + ' · Ledger', `<div class="money-account-balance"><span>To collect</span>
    <strong>${money(account.balance)}</strong>${account.overdue ? moneyBadge(money(account.overdue) + ' overdue', 'warning') : ''}</div>
    <div class="money-account-actions">
      ${contact?.phone ? '<button id="ledger-whatsapp" class="secondary" type="button">WhatsApp</button>' : ''}
      <button id="ledger-contact" class="secondary" type="button">${contact ? 'Edit contact' : 'Save contact'}</button>
      ${account.customer ? '<button id="ledger-fuel-credit" class="secondary" type="button">Fuel credit account</button>' : ''}
    </div>
    <dl class="money-account-summary"><div><dt>Charged</dt><dd>${money(account.charged)}</dd></div>
      <div><dt>Received</dt><dd>${money(account.paid)}</dd></div><div><dt>WhatsApp number</dt><dd>${safe(contact?.phone || 'Not saved')}</dd></div></dl>
    <h3>Transactions</h3>
    ${account.entries.length ? `<ul class="ledger-entries">${account.entries.map((row, index) => `<li>
      <div><strong>${safe(row.type)}</strong>${row.void ? moneyBadge('Voided') : ''}
        <small>${safe(businessDay(row.date, 'medium'))}${row.reference ? ' · ' + safe(row.reference) : ''}</small>
        ${row.note ? `<small>${safe(row.note)}</small>` : ''}
        ${row.due ? `<button id="ledger-due-${index}" class="text-button" type="button">Open receivable</button>` : ''}
      </div>
      <div><strong>${row.amount < 0 ? '−' : '+'}${money(Math.abs(row.amount))}</strong><small>${money(row.balance)} balance</small></div>
    </li>`).join('')}</ul>` : '<p class="money-form-hint">No transactions recorded.</p>'}`, true);
  listen('ledger-contact', () => openContactForm(contact, account.name, () => openBusiness('money')));
  if (account.customer) listen('ledger-fuel-credit', () => openCustomerAccount(data, account.customer));
  if (contact?.phone) listen('ledger-whatsapp', () => {
    const message = account.balance > 0
      ? `Hello ${account.name}, this is a reminder from ${session.station}. Your outstanding balance is ${money(account.balance)}. Please share the payment reference once paid.`
      : '';
    openWhatsAppComposer(message, 'Message ' + contact.name, contact.name, contact.phone);
  });
  for (const [index, row] of account.entries.entries()) {
    if (row.due) listen('ledger-due-' + index, () => openMarketDetail(data, row.due));
  }
}
