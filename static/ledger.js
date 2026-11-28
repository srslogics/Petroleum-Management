"use strict";

const ledgerView = {tab: 'parties', date: '', search: '', status: 'all', account: ''};
const ledgerTabs = [['parties', 'Balances'], ['collect', 'To collect'], ['pay', 'To pay'], ['banking', 'Banking'], ['books', 'Books']];
const ledgerBookTabs = [['journal', 'Journal'], ['trial', 'Trial balance']];
const ledgerDescription = {
  parties: 'See what the station needs to collect and pay.',
  collect: 'Record fuel credit, other amounts owed and payments received.',
  pay: 'Manage bills and staff pay, and record payments already made.',
  banking: 'Confirm cash deposits and UPI or card receipts from the bank.',
  books: 'Review the journal and trial balance for the station.',
};

function ledgerTabButtons(tabs, active, prefix, panel) {
  return tabs.map(([key, title]) => `
    <button id="${prefix + key}" type="button" role="tab" aria-selected="${key === active}"
      aria-controls="${panel}" tabindex="${key === active ? 0 : -1}">${title}</button>`).join('');
}

function ledgerWorkspace(active, actions, body) {
  return `<div class="money-heading">${heading('', 'Ledger', ledgerDescription[active])}
    ${actions ? `<div class="money-heading-actions">${actions}</div>` : ''}
    </div>
    <div class="money-tabs ledger-workspace-tabs" role="tablist" aria-label="Ledger views">
      ${ledgerTabButtons(ledgerTabs, active, 'ledger-tab-', 'ledger-panel')}
    </div>
    <div id="ledger-panel" role="tabpanel" aria-labelledby="ledger-tab-${active}">${body}</div>`;
}

function bindLedgerTabs(tabs, prefix, active, select) {
  const activate = async key => {
    if (key !== active) await select(key);
    document.getElementById(prefix + key)?.focus({preventScroll: true});
  };
  for (const [index, [key]] of tabs.entries()) {
    const id = prefix + key;
    listen(id, () => activate(key));
    listen(id, event => {
      const target = {Home: 0, End: tabs.length - 1, ArrowRight: (index + 1) % tabs.length,
        ArrowLeft: (index + tabs.length - 1) % tabs.length}[event.key];
      if (target === undefined) return;
      event.preventDefault();
      return activate(tabs[target][0]);
    }, 'keydown');
  }
}

function openLedgerSection(tab) {
  if (tab === 'collect') return openBusiness('money');
  if (tab === 'pay') return openOutgoings();
  if (tab === 'banking') return openBusiness('banking');
  ledgerView.tab = tab === 'books' ? 'journal' : 'parties';
  return openBusiness('ledger');
}

function bindLedgerNavigation(active) {
  bindLedgerTabs(ledgerTabs, 'ledger-tab-', active, openLedgerSection);
}

function buildPartyLedger(data) {
  const parties = new Map();
  const customers = new Map(data.customers.map(row => [row.customer_key, row]));
  const bills = new Map(data.bills.map(row => [row.id, row]));
  const receivables = new Map(data.market_receivables.map(row => [row.id, row]));
  const billPayments = new Map(data.bill_payments.map(row => [row.id, bills.get(row.bill_id)]));
  const receipts = new Map(data.market_receipts.map(row => [row.id, receivables.get(row.receivable_id)]));
  const documents = {bill: bills, 'outgoing-payment': billPayments, receivable: receivables, 'receivable-payment': receipts};
  for (const entry of data.financial.entries) {
    const partyLines = new Map();
    for (const line of entry.lines) {
      if (!line.party_key) continue;
      const merged = partyLines.get(line.party_key);
      partyLines.set(line.party_key, {...line, amount: line.amount + (merged?.amount || 0)});
    }
    for (const line of partyLines.values()) {
      const {party_key: key, account: code} = line;
      if (!parties.has(key)) {
        const customer = customers.get(key);
        parties.set(key, {name: customer?.name || line.party, customer, entries: [], incoming: 0, outgoing: 0,
          openDocuments: new Map(), fuelBalance: 0, overdue: false});
      }
      const party = parties.get(key);
      const side = code === '2000' ? 'outgoing' : 'incoming';
      const amount = side === 'outgoing' ? -line.amount : line.amount;
      party[side] += amount;
      if (code === '1100') party.fuelBalance += amount;
      const document = documents[entry.source]?.get(entry.source_id);
      if (document) {
        const documentKey = side + ':' + document.id;
        const prior = party.openDocuments.get(documentKey)?.balance || 0;
        party.openDocuments.set(documentKey, {date: document.due_date, balance: prior + amount});
      }
      const type = entry.source === 'shift'
        ? entry.reversal ? 'Reversal · Fuel credit sale' : 'Fuel credit sale'
        : entry.description;
      party.entries.push({...entry, type, amount, side, balance: party[side],
        billId: entry.source === 'bill' ? entry.source_id : null,
        receivable: entry.source === 'receivable' ? document : null});
    }
  }
  const overdue = (date, balance) => date && date < data.financial.as_of && balance > 0;
  for (const party of parties.values()) {
    party.overdue = overdue(party.customer?.due_date, party.fuelBalance) ||
      [...party.openDocuments.values()].some(item => overdue(item.date, item.balance));
    party.entries.reverse();
  }
  return [...parties.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function ledgerStatementDate(financial, today) {
  const current = financial.as_of === today;
  return `<details class="ledger-statement-date"${current ? '' : ' open'}>
    <summary>${current ? 'Change statement date' : `Statement as of ${safe(businessDay(financial.as_of, 'medium'))}`}</summary>
    <form id="ledger-date-form" class="ledger-date-form" aria-label="Statement date">
      <label>As of date<input name="date" type="date" value="${safe(financial.as_of)}" max="${safe(today)}" required></label>
      <button class="secondary">View statement</button>
      ${errorbox}
    </form>
  </details>`;
}

function ledgerTotals(financial) {
  const accounts = new Map(financial.trial.map(account => [account.code, account]));
  const receivable = code => accounts.get(code).debit - accounts.get(code).credit;
  const payable = code => accounts.get(code).credit - accounts.get(code).debit;
  const fuelCredit = receivable('1100') + receivable('1120');
  const other = receivable('1110');
  const bills = payable('2000');
  const salaries = payable('2010');
  return `<div class="money-stats ledger-stats">
    <section class="money-stat dues" aria-label="Total to collect">
      <div>To collect</div><strong>${money(fuelCredit + other)}</strong>
      <small>Fuel credit ${money(fuelCredit)} · Other dues ${money(other)}</small>
      <button id="ledger-open-collect" class="text-button" type="button">Open collections ${icon('arrow')}</button>
    </section>
    <section class="money-stat" aria-label="Total to pay">
      <div>To pay</div><strong>${money(bills + salaries)}</strong>
      <small>Bills ${money(bills)} · Salaries ${money(salaries)}</small>
      <button id="ledger-open-pay" class="text-button" type="button">Open payments ${icon('arrow')}</button>
    </section>
  </div>`;
}

function showLedger(data) {
  const {financial, today} = data;
  const tab = ledgerView.tab;
  const balances = tab === 'parties';
  const parties = balances ? buildPartyLedger(data) : [];
  const statementDate = ledgerStatementDate(financial, today);
  const actions = tab === 'journal' && financial.as_of === today
    ? '<button id="ledger-new-journal" class="primary" type="button">+ Journal entry</button>' : '';
  const historical = financial.as_of !== today;
  const body = balances ? `${historical ? statementDate : ''}${ledgerTotals(financial)}${historical ? '' : statementDate}
    ${financial.unassigned ? `<div class="money-allocation-alert">
      <div>${navigationIcon('exceptions')}<span><strong>${money(financial.unassigned)} in unassigned fuel credit</strong></span></div>
      ${financial.as_of === today ? '<button id="ledger-assign-credit" class="text-button" type="button">Assign customer</button>' : ''}
    </div>` : ''}
    <section class="money-workspace" aria-label="Customer and supplier balances">${partyList(parties)}</section>`
    : `<div class="money-tabs ledger-book-tabs" role="tablist" aria-label="Books">
        ${ledgerTabButtons(ledgerBookTabs, tab, 'ledger-book-', 'ledger-book-panel')}
      </div>
      ${statementDate}
      <section class="money-workspace" id="ledger-book-panel" role="tabpanel" aria-labelledby="ledger-book-${tab}">
        ${tab === 'journal' ? journalPanel(data) : trialBalancePanel(financial)}
      </section>`;
  shell(ledgerWorkspace(balances ? 'parties' : 'books', actions, body), 'ledger');
  bindForm('ledger-date-form', async form => {
    const prior = ledgerView.date;
    ledgerView.date = form.elements.date.value === today ? '' : form.elements.date.value;
    try { await openBusiness('ledger'); }
    catch (error) { ledgerView.date = prior; throw error; }
  });
  if (actions) listen('ledger-new-journal', () => openManualJournal(data));
  bindLedgerNavigation(balances ? 'parties' : 'books');
  if (balances) {
    if (document.getElementById('ledger-assign-credit')) listen('ledger-assign-credit', () => openBusiness('money', openAllocationForm));
    listen('ledger-open-collect', () => openLedgerSection('collect'));
    listen('ledger-open-pay', () => openLedgerSection('pay'));
    bindPartyList(data, parties);
    return;
  }
  bindLedgerTabs(ledgerBookTabs, 'ledger-book-', tab, next => {
    ledgerView.tab = next;
    showLedger(data);
  });
  if (tab === 'journal') bindJournal(data);
  else listen('trial-export', () => ledgerCSV('trial-balance', financial.as_of, [
    ['As of', financial.as_of], ['Code', 'Account', 'Category', 'Debit (INR)', 'Credit (INR)'],
    ...financial.trial.map(row => [row.code, row.name, row.category, row.debit / 100, row.credit / 100]),
    ['', 'Totals', '', financial.total_debit / 100, financial.total_credit / 100]
  ]));
}

function partyList(parties) {
  return `<div class="money-toolbar"><h2>Customer and supplier balances <span id="ledger-count"></span></h2>
      <div class="money-tools">${moneySearch('ledger-search', 'Search names or references', ledgerView.search)}
        <label><span class="sr-only">Ledger status</span><select id="ledger-filter">${moneyOptions([
          ['all', 'All parties'], ['incoming', 'To collect'], ['outgoing', 'To pay'], ['overdue', 'Overdue']
        ], ledgerView.status)}</select></label>
      </div>
    </div>
    ${parties.length ? `<div class="table-scroll money-table-wrap" id="party-ledger-table"><table class="money-table">
      <thead><tr><th scope="col">Name</th><th scope="col" class="numeric">To collect</th><th scope="col" class="numeric">To pay</th></tr></thead>
      <tbody>${parties.map((party, index) => `<tr data-ledger-row="${index}">
        <th scope="row"><button id="ledger-party-${index}" class="money-source-link market-detail" type="button"
          aria-label="View ledger for ${safe(party.name)}">${safe(party.name)}<small>${party.overdue ? 'Overdue · ' : ''}${party.entries.length} ${party.entries.length === 1 ? 'entry' : 'entries'}</small></button></th>
        <td class="numeric"><strong>${money(party.incoming)}</strong></td>
        <td class="numeric"><strong>${money(party.outgoing)}</strong></td>
      </tr>`).join('')}</tbody>
    </table></div><div id="ledger-no-match" hidden>${moneyEmpty('No matching parties', 'Try another search or filter.')}</div>`
    : moneyEmpty('No ledger entries yet', 'Recorded fuel credit, receivables and bills will appear here.')}`;
}

function bindPartyList(data, parties) {
  for (const [index, party] of parties.entries()) listen('ledger-party-' + index, () => openPartyLedger(data, party));
  const filter = () => {
    const query = contactKey(ledgerView.search);
    const status = ledgerView.status;
    let count = 0;
    for (const row of document.querySelectorAll('[data-ledger-row]')) {
      const party = parties[Number(row.dataset.ledgerRow)];
      const matches = contactKey(party.name).includes(query) || party.entries.some(entry => contactKey(entry.reference).includes(query));
      row.hidden = !matches || (status !== 'all' && !party[status]);
      if (!row.hidden) count++;
    }
    document.getElementById('ledger-count').textContent = String(count);
    if (parties.length) {
      document.getElementById('party-ledger-table').hidden = count === 0;
      document.getElementById('ledger-no-match').hidden = count > 0;
    }
  };
  listen('ledger-search', event => { ledgerView.search = event.target.value; filter(); }, 'input');
  listen('ledger-filter', event => { ledgerView.status = event.target.value; filter(); }, 'change');
  filter();
}

async function openPartyLedger(data, party) {
  const page = document.getElementById('main-content');
  const contact = matchingContact(await ownerContacts().catch(() => []), party.name);
  if (!page.isConnected) return;
  const current = data.financial.as_of === data.today;
  moneyDialog(party.name + ' · Ledger', `<p class="money-dialog-intro">As of ${safe(businessDay(data.financial.as_of, 'long'))}</p>
    <dl class="ledger-balances">
      <div><dt>To collect</dt><dd>${money(party.incoming)}</dd></div>
      <div><dt>To pay</dt><dd>${money(party.outgoing)}</dd></div>
    </dl>
    <div class="money-account-actions">
      <button id="ledger-party-export" class="secondary" type="button">Export statement</button>
      ${contact?.phone && current ? '<button id="ledger-whatsapp" class="secondary" type="button">WhatsApp</button>' : ''}
      <button id="ledger-contact" class="secondary" type="button">${contact ? 'Edit contact' : 'Save contact'}</button>
      ${party.customer && current ? '<button id="ledger-fuel-credit" class="secondary" type="button">Fuel credit account</button>' : ''}
    </div>
    <h3>Transactions</h3>
    <ul class="ledger-entries">${party.entries.map((row, index) => `<li>
      <div><strong>${safe(row.type)}</strong>${row.reversal ? moneyBadge('Reversal', 'warning') : ''}
        <small>${safe(businessDay(row.date, 'medium'))} · ${safe(row.reference)}</small>
        ${row.reason || row.note ? `<small>${safe(row.reason || row.note)}</small>` : ''}
        ${row.receivable && current && !row.reversal ? `<button id="ledger-due-${index}" class="text-button" type="button">Open receivable</button>` : ''}
        ${row.billId && current && !row.reversal ? `<button id="ledger-bill-${index}" class="text-button" type="button">Open bill</button>` : ''}
      </div>
      <div><strong>${row.amount < 0 ? '−' : '+'}${money(Math.abs(row.amount))}</strong>
        <small>${money(row.balance)} ${row.side === 'incoming' ? 'to collect' : 'to pay'}</small></div>
    </li>`).join('')}</ul>`, true);
  listen('ledger-party-export', () => ledgerCSV('party-statement', data.financial.as_of, [
    ['Party', party.name], ['As of', data.financial.as_of], ['To collect (INR)', party.incoming / 100], ['To pay (INR)', party.outgoing / 100],
    ['Date', 'Reference', 'Entry', 'Direction', 'Amount (INR)', 'Running balance (INR)', 'Notes'],
    ...party.entries.slice().reverse().map(row => [row.date, row.reference, row.type, row.side,
      row.amount / 100, row.balance / 100, row.reason || row.note || ''])
  ]));
  listen('ledger-contact', () => openContactForm(contact, party.name, () => openBusiness('ledger')));
  if (party.customer && current) listen('ledger-fuel-credit', () => openCustomerAccount(data, party.customer));
  if (contact?.phone && current) listen('ledger-whatsapp', () => {
    const message = party.incoming > 0
      ? `Hello ${party.name}, this is a reminder from ${session.station}. Your outstanding balance is ${money(party.incoming)}. Please share the payment reference once paid.`
      : '';
    openWhatsAppComposer(message, 'Message ' + contact.name, contact.name, contact.phone);
  });
  if (current) {
    const bills = new Map(data.bills.map(bill => [bill.id, bill]));
    const billModel = {bills: data.bills, entries: data.bill_payments, staff: [], today: data.today};
    for (const [index, row] of party.entries.entries()) {
      if (row.reversal) continue;
      if (row.receivable) listen('ledger-due-' + index, () => openMarketDetail(data, row.receivable));
      if (row.billId) listen('ledger-bill-' + index, () => {
        const bill = bills.get(row.billId);
        if (bill) outgoingDetail('bill', bill, billModel);
      });
    }
  }
}

function journalPanel(data) {
  const options = [['', 'All accounts'], ...data.financial.accounts.map(row => [row.code, row.name])];
  return `<div class="money-toolbar"><h2>Journal</h2><div class="money-tools">
    <label><span class="sr-only">Journal account</span><select id="journal-account">${moneyOptions(options, ledgerView.account)}</select></label>
    <button id="journal-export" class="secondary" type="button">Export journal</button>
  </div></div><div id="journal-results"></div>`;
}

function bindJournal(data) {
  const {financial} = data;
  const accounts = new Map(financial.accounts.map(row => [row.code, row.name]));
  const visibleEntries = () => financial.entries.filter(entry =>
    !ledgerView.account || entry.lines.some(line => line.account === ledgerView.account));
  const render = () => {
    let balance = 0;
    const entries = visibleEntries().map(entry => {
      balance += entry.lines.reduce((sum, line) => line.account === ledgerView.account ? sum + line.amount : sum, 0);
      return {entry, balance};
    }).reverse();
    document.getElementById('journal-results').innerHTML = entries.length ? `<ul class="journal-list">${entries.map(({entry, balance}, i) => `<li>
      <button id="journal-entry-${i}" class="money-source-link market-detail" type="button"><strong>${safe(entry.description)}</strong>
        <small>${safe(businessDay(entry.date, 'medium'))} · ${safe(entry.reference)}</small></button>
      <div class="journal-amount"><strong>${money(entry.lines.reduce((sum, line) => sum + Math.max(0, line.amount), 0))}</strong>
        ${ledgerView.account ? `<small>${money(Math.abs(balance))} ${balance < 0 ? 'Cr' : 'Dr'} balance</small>` : ''}</div>
    </li>`).join('')}</ul>` : moneyEmpty('No journal entries', 'Choose another account or statement date.');
    entries.forEach(({entry}, i) => listen('journal-entry-' + i, () => openJournalEntry(data, entry, accounts)));
  };
  listen('journal-account', event => { ledgerView.account = event.target.value; render(); }, 'change');
  listen('journal-export', () => ledgerCSV('journal', financial.as_of, [
    ['As of', financial.as_of],
    ['Date', 'Recorded at', 'Reference', 'Entry', 'Account code', 'Account', 'Party', 'Debit (INR)', 'Credit (INR)', 'Reason'],
    ...visibleEntries().flatMap(entry => entry.lines.map(line => [entry.date, entry.recorded_at, entry.reference,
      entry.description, line.account, accounts.get(line.account), line.party || '', Math.max(0, line.amount) / 100,
      Math.max(0, -line.amount) / 100, entry.reason || '']))
  ]));
  render();
}

function openJournalEntry(data, entry, accounts) {
  const canReverse = entry.source === 'journal' && !entry.reversal && data.financial.as_of === data.today &&
    !data.financial.entries.some(row => row.source === 'journal' && row.reversal_of === entry.source_id);
  moneyDialog(entry.description, `<p class="money-dialog-intro">${safe(businessDay(entry.date, 'medium'))} · ${safe(entry.reference)}
    ${entry.actor ? ' · ' + safe(entry.actor) : ''}</p>
    ${entry.reason ? `<p class="money-dialog-intro">${safe(entry.reason)}</p>` : ''}
    <div class="table-scroll"><table class="money-table">
      <thead><tr><th>Account</th><th class="numeric">Debit</th><th class="numeric">Credit</th></tr></thead>
      <tbody>${entry.lines.map(line => `<tr><th scope="row">${safe(accounts.get(line.account))}${line.party ? `<small>${safe(line.party)}</small>` : ''}</th>
        <td class="numeric">${line.amount > 0 ? money(line.amount) : '—'}</td>
        <td class="numeric">${line.amount < 0 ? money(-line.amount) : '—'}</td></tr>`).join('')}</tbody>
    </table></div>
    ${canReverse ? '<button id="manual-journal-reverse" class="secondary" type="button">Reverse entry</button>' : ''}`, true);
  if (canReverse) listen('manual-journal-reverse', () => {
    moneyDialog('Reverse journal entry', `<form id="journal-reversal-form" class="money-form">
      <p class="money-form-hint">An opposite entry will be posted today. The original will remain in the journal.</p>
      ${businessNote('Reason', 'reason', true, 350)}${errorbox}<button class="primary">Post reversal</button>
    </form>`);
    bindForm('journal-reversal-form', async form => {
      await api('/ledger/journals/reverse', {id: entry.source_id, ...fields(form)});
      await openBusiness('ledger');
      showBusinessNotice('Reversal posted.');
    });
  });
}

function trialBalancePanel(financial) {
  const rows = financial.trial.filter(row => row.debit || row.credit);
  return `<div class="money-toolbar"><h2>Trial balance</h2><div class="money-tools">
    ${moneyBadge(financial.total_debit === financial.total_credit ? 'Balanced' : 'Out of balance', financial.total_debit === financial.total_credit ? 'positive' : 'warning')}
    <button id="trial-export" class="secondary" type="button">Export trial balance</button>
  </div></div>
  <div class="table-scroll money-table-wrap" id="trial-balance-table"><table class="money-table">
    <thead><tr><th scope="col">Account</th><th scope="col" class="numeric">Debit</th><th scope="col" class="numeric">Credit</th></tr></thead>
    <tbody>${rows.map(row => `<tr><th scope="row">${safe(row.name)}<small>${safe(row.code)} · ${safe(row.category)}</small></th>
      <td class="numeric">${row.debit ? money(row.debit) : '—'}</td>
      <td class="numeric">${row.credit ? money(row.credit) : '—'}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th scope="row">Totals</th><td class="numeric"><strong>${money(financial.total_debit)}</strong></td>
      <td class="numeric"><strong>${money(financial.total_credit)}</strong></td></tr></tfoot>
  </table></div>
  <p class="ledger-account-note">Review balances in clearing accounts. Use purchase costs to post fuel inventory value and cost of sales.</p>`;
}

function openManualJournal(data) {
  const options = moneyOptions(data.financial.accounts.filter(row => row.manual).map(row => [row.code, row.code + ' · ' + row.name]));
  const line = () => `<fieldset class="journal-line"><legend>Journal line</legend>
    <label>Account<select data-journal-account required><option value="">Choose account</option>${options}</select></label>
    <div class="money-form-grid">${numberField('Debit (₹)', 'debit')}${numberField('Credit (₹)', 'credit')}</div>
    <button type="button" class="text-button" data-remove-journal-line>Remove line</button>
  </fieldset>`;
  const dialog = moneyDialog('New journal entry', `<form id="manual-journal-form" class="money-form">
    ${businessDate('Posting date', 'date', data.today)}${businessText('Reference', 'reference')}
    ${businessNote('Description', 'description', true)}
    <p class="money-form-hint">Use this for opening balances, adjustments and inventory valuation. Sales, bills and payments from station workflows post automatically.</p>
    <div id="journal-lines">${line()}${line()}</div>
    <button id="add-journal-line" class="secondary" type="button">Add line</button>
    ${errorbox}<button class="primary">Post journal entry</button>
  </form>`, true);
  const container = dialog.querySelector('#journal-lines');
  const add = dialog.querySelector('#add-journal-line');
  const refreshLines = () => {
    for (const button of container.querySelectorAll('[data-remove-journal-line]')) button.disabled = container.children.length <= 2;
    add.disabled = container.children.length >= 20;
  };
  listen('add-journal-line', () => {
    container.insertAdjacentHTML('beforeend', line());
    refreshLines();
    container.lastElementChild.querySelector('select').focus();
  });
  container.addEventListener('click', event => {
    if (!event.target.matches('[data-remove-journal-line]')) return;
    event.target.closest('fieldset').remove();
    refreshLines();
    add.focus();
  });
  refreshLines();
  bindForm('manual-journal-form', async form => {
    const lines = [...container.children].map(row => ({account: row.querySelector('select').value,
      debit: row.querySelector('[name=debit]').value, credit: row.querySelector('[name=credit]').value}));
    await api('/ledger/journals', {date: form.elements.date.value, reference: form.elements.reference.value,
      description: form.elements.description.value, lines});
    ledgerView.tab = 'journal';
    ledgerView.date = '';
    await openBusiness('ledger');
    showBusinessNotice('Journal entry posted.');
  });
}

function ledgerCSV(name, date, rows) {
  const csv = '\ufeff' + rows.map(row => row.map(cell => {
    const text = String(cell ?? '');
    const value = typeof cell === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? "'" + text : text;
    return '"' + value.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name + '-' + date + '.csv';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
