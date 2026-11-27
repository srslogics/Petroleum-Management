"use strict";

const ledgerView = {search: '', status: 'all'};

function buildPartyLedger(data) {
  const accounts = new Map();
  const byReceivable = new Map();
  const byBill = new Map();
  const accountFor = (name, key) => {
    if (!accounts.has(key)) accounts.set(key, {name, entries: [], incoming: 0, outgoing: 0, overdue: false});
    return accounts.get(key);
  };

  for (const customer of data.customers) {
    const account = accountFor(customer.name, customer.customer_key);
    account.customer = customer;
    account.overdue ||= customer.overdue;
    for (const row of customer.transactions) {
      account.entries.push({...row, side: 'incoming', type: row.amount < 0 ? 'Fuel credit payment' : 'Fuel credit sale'});
    }
  }
  for (const row of data.repayments) {
    const account = accounts.get(row.customer_key);
    if (!row.void || !account) continue;
    account.entries.push({date: row.paid_on, side: 'incoming', type: 'Fuel credit payment', amount: -row.amount,
      reference: row.reference, note: row.note, void: row.void});
  }
  for (const item of data.market_receivables) {
    const account = accountFor(item.party, item.party_key);
    byReceivable.set(item.id, account);
    account.overdue ||= item.overdue;
    account.entries.push({date: item.recorded_on, side: 'incoming', type: marketKinds[item.kind], amount: item.amount,
      reference: item.reference, note: item.note, receivable: item, void: item.void});
  }
  for (const row of data.market_receipts) {
    byReceivable.get(row.receivable_id).entries.push({date: row.paid_on, side: 'incoming', type: 'Receivable payment', amount: -row.amount,
      reference: row.reference, note: row.note, void: row.void});
  }
  for (const bill of data.bills) {
    const account = accountFor(bill.payee, bill.payee_key);
    byBill.set(bill.id, account);
    account.overdue ||= bill.overdue;
    account.entries.push({date: bill.bill_date, side: 'outgoing', type: bill.kind === 'supplier' ? 'Supplier invoice' : 'Bill',
      amount: bill.amount, reference: bill.reference, note: bill.note, billId: bill.id, void: bill.voided_at});
  }
  for (const row of data.bill_payments) {
    byBill.get(row.bill_id).entries.push({date: row.paid_on, side: 'outgoing', type: 'Bill payment', amount: -row.amount,
      reference: row.reference, note: row.note, void: row.voided_at});
  }
  for (const account of accounts.values()) {
    account.entries.sort((a, b) => a.date.localeCompare(b.date) || Number(a.amount < 0) - Number(b.amount < 0));
    for (const row of account.entries) {
      if (!row.void) account[row.side] += row.amount;
      row.balance = account[row.side];
    }
    account.entries.reverse();
  }
  return [...accounts.values()].sort((a, b) => Number(b.incoming + b.outgoing > 0) - Number(a.incoming + a.outgoing > 0) ||
    a.name.localeCompare(b.name));
}

function showLedger(data) {
  const accounts = buildPartyLedger(data);
  const collect = accounts.reduce((sum, account) => sum + account.incoming, 0) + data.unallocated_credit;
  const pay = accounts.reduce((sum, account) => sum + account.outgoing, 0);
  shell(`<div class="money-heading"><div>${heading('', 'Ledger', 'See what each person or business owes you and what you owe them.')}</div>
    <div class="money-heading-actions">
      <button id="ledger-new-bill" class="secondary" type="button">+ Add bill</button>
      <button id="ledger-new-receivable" class="primary" type="button">+ Add receivable</button>
    </div></div>
    <div class="money-stats ledger-stats">
      <section class="money-stat dues" aria-label="Total to collect"><div>To collect</div><strong>${money(collect)}</strong></section>
      <section class="money-stat" aria-label="Total to pay"><div>To pay</div><strong>${money(pay)}</strong></section>
    </div>
    ${data.unallocated_credit ? `<div class="money-allocation-alert">
      <div>${navigationIcon('exceptions')}<span><strong>${money(data.unallocated_credit)} in unassigned fuel credit</strong></span></div>
      <button id="ledger-assign-credit" class="text-button" type="button">Assign customer</button>
    </div>` : ''}
    <section class="money-workspace" aria-label="Party ledger">
      <div class="money-toolbar"><h2>People and businesses <span id="ledger-count"></span></h2>
        <div class="money-tools">${moneySearch('ledger-search', 'Search names or references', ledgerView.search)}
          <label><span class="sr-only">Ledger status</span><select id="ledger-filter">${moneyOptions([
            ['all', 'All parties'], ['incoming', 'To collect'], ['outgoing', 'To pay'], ['overdue', 'Overdue']
          ], ledgerView.status)}</select></label>
        </div>
      </div>
      ${accounts.length ? `<div class="table-scroll money-table-wrap" id="party-ledger-table"><table class="money-table">
        <thead><tr><th scope="col">Name</th><th scope="col" class="numeric">To collect</th><th scope="col" class="numeric">To pay</th></tr></thead>
        <tbody>${accounts.map((item, index) => `<tr data-ledger-row="${index}">
          <th scope="row"><button id="ledger-party-${index}" class="money-source-link market-detail" type="button"
            aria-label="View ledger for ${safe(item.name)}">${safe(item.name)}<small>${item.overdue ? 'Overdue · ' : ''}${item.entries.length} ${item.entries.length === 1 ? 'entry' : 'entries'}</small></button></th>
          <td class="numeric"><strong>${money(item.incoming)}</strong></td>
          <td class="numeric"><strong>${money(item.outgoing)}</strong></td>
        </tr>`).join('')}</tbody>
      </table></div><div id="ledger-no-match" hidden>${moneyEmpty('No matching parties', 'Try another search or filter.')}</div>`
        : moneyEmpty('No ledger entries yet', 'Recorded fuel credit, receivables and bills will appear here.')}
    </section>`, 'ledger');
  listen('ledger-new-bill', () => openOutgoings('payables', outgoingBillForm));
  listen('ledger-new-receivable', () => openBusiness('money', openMarketForm));
  if (data.unallocated_credit) listen('ledger-assign-credit', () => openBusiness('money', openAllocationForm));
  for (const [index, account] of accounts.entries()) listen('ledger-party-' + index, () => openPartyLedger(data, account));

  const filter = () => {
    const query = contactKey(ledgerView.search);
    const status = ledgerView.status;
    let count = 0;
    for (const row of document.querySelectorAll('[data-ledger-row]')) {
      const account = accounts[Number(row.dataset.ledgerRow)];
      const matches = !query || contactKey(account.name).includes(query) || account.entries.some(entry => contactKey(entry.reference).includes(query));
      row.hidden = !matches || (status !== 'all' && !account[status]);
      if (!row.hidden) count++;
    }
    document.getElementById('ledger-count').textContent = String(count);
    if (accounts.length) {
      document.getElementById('party-ledger-table').hidden = count === 0;
      document.getElementById('ledger-no-match').hidden = count > 0;
    }
  };
  listen('ledger-search', event => { ledgerView.search = event.target.value; filter(); }, 'input');
  listen('ledger-filter', event => { ledgerView.status = event.target.value; filter(); }, 'change');
  filter();
}

async function openPartyLedger(data, account) {
  const page = document.getElementById('main-content');
  const contact = matchingContact(await ownerContacts().catch(() => []), account.name);
  if (!page.isConnected) return;
  const stats = `<dl class="ledger-balances">
    <div><dt>To collect</dt><dd>${money(account.incoming)}</dd></div>
    <div><dt>To pay</dt><dd>${money(account.outgoing)}</dd></div>
  </dl>`;
  moneyDialog(account.name + ' · Ledger', `${stats}
    <div class="money-account-actions">
      ${contact?.phone ? '<button id="ledger-whatsapp" class="secondary" type="button">WhatsApp</button>' : ''}
      <button id="ledger-contact" class="secondary" type="button">${contact ? 'Edit contact' : 'Save contact'}</button>
      ${account.customer ? '<button id="ledger-fuel-credit" class="secondary" type="button">Fuel credit account</button>' : ''}
    </div>
    <h3>Transactions</h3>
    ${account.entries.length ? `<ul class="ledger-entries">${account.entries.map((row, index) => `<li>
      <div><strong>${safe(row.type)}</strong>${row.void ? moneyBadge('Voided') : ''}
        <small>${safe(businessDay(row.date, 'medium'))}${row.reference ? ' · ' + safe(row.reference) : ''}</small>
        ${row.note ? `<small>${safe(row.note)}</small>` : ''}
        ${row.receivable ? `<button id="ledger-due-${index}" class="text-button" type="button">Open receivable</button>` : ''}
        ${row.billId ? `<button id="ledger-bill-${index}" class="text-button" type="button">Open bill</button>` : ''}
      </div>
      <div><strong>${row.amount < 0 ? '−' : '+'}${money(Math.abs(row.amount))}</strong>
        <small>${money(row.balance)} ${row.side === 'incoming' ? 'to collect' : 'to pay'}</small></div>
    </li>`).join('')}</ul>` : '<p class="money-form-hint">No transactions recorded.</p>'}`, true);
  listen('ledger-contact', () => openContactForm(contact, account.name, () => openBusiness('ledger')));
  if (account.customer) listen('ledger-fuel-credit', () => openCustomerAccount(data, account.customer));
  if (contact?.phone) listen('ledger-whatsapp', () => {
    const message = account.incoming > 0
      ? `Hello ${account.name}, this is a reminder from ${session.station}. Your outstanding balance is ${money(account.incoming)}. Please share the payment reference once paid.`
      : '';
    openWhatsAppComposer(message, 'Message ' + contact.name, contact.name, contact.phone);
  });
  for (const [index, row] of account.entries.entries()) {
    if (row.receivable) listen('ledger-due-' + index, () => openMarketDetail(data, row.receivable));
    if (row.billId) listen('ledger-bill-' + index, () => openOutgoings('payables', () => {
      const bill = outgoingData.bills.find(item => item.id === row.billId);
      if (bill) outgoingDetail('bill', bill);
    }));
  }
}
