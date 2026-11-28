"use strict";

const ledgerView = {tab: 'parties', date: '', search: '', status: 'all', account: ''};
const ledgerBookTabs = [['journal', 'Journal'], ['trial', 'Trial balance']];
const ledgerTools = [['collect', 'To collect'], ['pay', 'To pay'], ['banking', 'Banking'], ['books', 'Books']];
const ledgerTitles = {parties: 'Party ledger', collect: 'To collect', pay: 'To pay', banking: 'Banking', books: 'Books'};
const ledgerDescription = {
  parties: 'Open a person or business to see their transactions and balances.',
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
  return `<div class="money-heading">${heading('', ledgerTitles[active], ledgerDescription[active])}
    <div class="money-heading-actions">${actions}</div>
    </div>
    <nav class="ledger-tools" aria-label="Money tools">
      ${active !== 'parties' ? '<button id="ledger-back" type="button" class="text-button">← Party ledger</button>' : ''}
      <details>
        <summary>Money tools</summary>
        <div class="ledger-tool-links">${ledgerTools.map(([key, label]) => `<button id="ledger-tool-${key}"
          class="secondary" type="button"${key === active ? ' aria-current="page"' : ''}>${label}</button>`).join('')}</div>
      </details>
    </nav>
    ${body}`;
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
  if (active !== 'parties') listen('ledger-back', () => openLedgerSection('parties'));
  for (const [key] of ledgerTools) {
    listen('ledger-tool-' + key, () => {
      if (key !== active) return openLedgerSection(key);
    });
  }
}

const partyBalanceLabels = {incoming: 'to collect', outgoing: 'to pay', advances: 'in staff advances'};
const partyAccountSides = {'1100': 'incoming', '1110': 'incoming', '2000': 'outgoing', '2010': 'outgoing', '1130': 'advances'};

function buildPartyLedger(data) {
  const parties = new Map();
  const contactsByName = new Map(data.contacts.map(row => [row.name_key, row]));
  const contactsById = new Map(data.contacts.map(row => [row.id, row]));
  const staff = new Map(data.staff.map(row => [row.id, row]));
  const customers = new Map(data.customers.map(row => [row.customer_key, row]));
  const bills = new Map(data.bills.map(row => [row.id, row]));
  const salaries = new Map(data.salaries.map(row => [row.id, row]));
  const receivables = new Map(data.market_receivables.map(row => [row.id, row]));
  const outgoing = new Map([...data.bill_payments, ...data.staff_entries].map(row => [row.id, row]));
  const receipts = new Map(data.market_receipts.map(row => [row.id, receivables.get(row.receivable_id)]));
  const createParty = (key, name, contact, staffMember) => {
    if (!parties.has(key)) parties.set(key, {
      name, contact, staff: staffMember, entries: [], incoming: 0, outgoing: 0, advances: 0,
      openDocuments: new Map(), fuelBalance: 0, overdue: false,
      customer: customers.get(contact?.name_key ?? (key.startsWith('name:') ? key.slice(5) : undefined)),
    });
    const party = parties.get(key);
    if (staffMember) party.staff = staffMember;
    return party;
  };
  for (const contact of data.contacts) createParty('contact:' + contact.id, contact.name, contact);
  for (const person of data.staff) {
    const contact = contactsById.get(person.contact_id);
    const key = contact ? 'contact:' + contact.id : 'staff:' + person.id;
    createParty(key, contact?.name || person.name, contact, person);
  }

  const documentFor = entry => {
    switch (entry.source) {
      case 'bill': return {kind: 'bill', record: bills.get(entry.source_id)};
      case 'salary':
      case 'salary-recovery': return {kind: 'salary', record: salaries.get(entry.source_id)};
      case 'receivable': return {kind: 'receivable', record: receivables.get(entry.source_id)};
      case 'receivable-payment': return {kind: 'receivable', record: receipts.get(entry.source_id)};
      case 'outgoing-payment': {
        const payment = outgoing.get(entry.source_id);
        if (payment?.bill_id) return {kind: 'bill', record: bills.get(payment.bill_id)};
        if (payment?.salary_id) return {kind: 'salary', record: salaries.get(payment.salary_id)};
        return {kind: 'entry', record: payment};
      }
      default: return {};
    }
  };

  for (const entry of data.financial.entries) {
    const person = staff.get(entry.staff_id);
    const changesByParty = new Map();
    const document = documentFor(entry);
    for (const line of entry.lines) {
      const side = partyAccountSides[line.account];
      if (!side || (!line.party_key && !person)) continue;
      const contact = person ? contactsById.get(person.contact_id) : contactsByName.get(line.party_key);
      const key = contact ? 'contact:' + contact.id : person ? 'staff:' + person.id : 'name:' + line.party_key;
      const party = createParty(key, contact?.name || person?.name || customers.get(line.party_key)?.name || line.party, contact, person);
      const delta = side === 'outgoing' ? -line.amount : line.amount;
      party[side] += delta;
      if (line.account === '1100') party.fuelBalance += delta;
      if (document.record?.due_date && side !== 'advances') {
        const documentKey = document.kind + ':' + document.record.id;
        const previous = party.openDocuments.get(documentKey)?.balance || 0;
        party.openDocuments.set(documentKey, {date: document.record.due_date, balance: previous + delta});
      }
      if (!changesByParty.has(party)) changesByParty.set(party, {});
      const changes = changesByParty.get(party);
      changes[side] = (changes[side] || 0) + delta;
    }
    for (const [party, changes] of changesByParty) {
      const type = entry.source === 'shift'
        ? entry.reversal ? 'Reversal · Fuel credit sale' : 'Fuel credit sale'
        : entry.description;
      const record = ['bill', 'salary', 'receivable'].includes(entry.source) ? document
        : entry.source === 'outgoing-payment' ? {kind: 'entry', record: outgoing.get(entry.source_id)} : {};
      party.entries.push({...entry, type, changes, record,
        balances: {incoming: party.incoming, outgoing: party.outgoing, advances: party.advances}});
    }
  }
  const asOf = data.financial.as_of;
  const overdue = (date, balance) => date && date < asOf && balance > 0;
  for (const party of parties.values()) {
    party.overdue = overdue(party.customer?.due_date, party.fuelBalance) ||
      [...party.openDocuments.values()].some(item => overdue(item.date, item.balance));
    party.entries.reverse();
  }
  return [...parties.values()].filter(party => asOf === data.today || party.entries.length)
    .sort((a, b) => a.name.localeCompare(b.name));
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

function showLedger(data) {
  const {financial, today} = data;
  const tab = ledgerView.tab;
  const balances = tab === 'parties';
  const parties = balances ? buildPartyLedger(data) : [];
  const statementDate = ledgerStatementDate(financial, today);
  const actions = balances ? '<button id="ledger-add-contact" class="primary" type="button">+ Add contact</button>'
    : tab === 'journal' && financial.as_of === today
      ? '<button id="ledger-new-journal" class="primary" type="button">+ Journal entry</button>' : '';
  const body = balances ? `${statementDate}
    ${financial.unassigned ? `<div class="money-allocation-alert">
      <div>${navigationIcon('exceptions')}<span><strong>${money(financial.unassigned)} in unassigned fuel credit</strong></span></div>
      ${financial.as_of === today ? '<button id="ledger-assign-credit" class="text-button" type="button">Assign customer</button>' : ''}
    </div>` : ''}
    <section class="money-workspace" aria-label="Party balances">${partyList(parties)}</section>`
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
  if (tab === 'journal' && actions) listen('ledger-new-journal', () => openManualJournal(data));
  bindLedgerNavigation(balances ? 'parties' : 'books');
  if (balances) {
    if (document.getElementById('ledger-assign-credit')) listen('ledger-assign-credit', () => openBusiness('money', openAllocationForm));
    listen('ledger-add-contact', () => openContactForm(null, '', () => openBusiness('ledger')));
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
  return `<div class="money-toolbar"><h2>People and businesses <span id="ledger-count"></span></h2>
      <div class="money-tools">${moneySearch('ledger-search', 'Search names or references', ledgerView.search)}
        <label><span class="sr-only">Ledger status</span><select id="ledger-filter">${moneyOptions([
          ['all', 'All parties'], ['incoming', 'To collect'], ['outgoing', 'To pay'], ['advances', 'Staff advances'], ['overdue', 'Overdue']
        ], ledgerView.status)}</select></label>
      </div>
    </div>
    ${parties.length ? `<div class="table-scroll money-table-wrap" id="party-ledger-table"><table class="money-table">
      <thead><tr><th scope="col">Name</th><th scope="col" class="numeric">To collect</th><th scope="col" class="numeric">To pay</th></tr></thead>
      <tbody>${parties.map((party, index) => `<tr data-ledger-row="${index}">
        <th scope="row"><button id="ledger-party-${index}" class="money-source-link market-detail" type="button"
          aria-label="View ledger for ${safe(party.name)}${party.staff && !party.contact ? ` · Staff ${safe(party.staff.code)}` : ''}"><span class="ledger-party-name">${safe(party.name)}</span><small>${party.overdue ? 'Overdue · ' : ''}${party.entries.length} ${party.entries.length === 1 ? 'entry' : 'entries'}${party.staff ? ' · Staff ' + safe(party.staff.code) : ''}</small></button></th>
        <td class="numeric"><strong>${money(party.incoming)}</strong>${party.advances ? `<small>${money(party.advances)} staff advances</small>` : ''}</td>
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

function openPartyLedger(data, party) {
  const contact = party.contact;
  const current = data.financial.as_of === data.today;
  const showAdvances = party.staff || party.advances;
  const actions = current && (contact || !party.staff || party.staff.active || party.advances > 0) ? `<details class="ledger-party-actions">
    <summary>Record a transaction</summary>
    <div class="money-account-actions">
      ${contact || !party.staff ? `<button id="party-add-receivable" type="button" class="secondary">Record money owed</button>
      <button id="party-add-bill" type="button" class="secondary">Add bill</button>
      ${data.active ? '<button id="party-add-credit" type="button" class="secondary">Record fuel credit</button>' : ''}` : ''}
      ${party.staff?.active ? '<button id="party-add-salary" type="button" class="secondary">Add salary</button><button id="party-add-advance" type="button" class="secondary">Give advance</button>' : ''}
      ${party.advances > 0 ? '<button id="party-return-advance" type="button" class="secondary">Record advance return</button>' : ''}
    </div>
    </details>` : '';
  moneyDialog(party.name + ' · Ledger', `<p class="money-dialog-intro">As of ${safe(businessDay(data.financial.as_of, 'long'))}</p>
    <dl class="ledger-balances">
      <div><dt>To collect</dt><dd>${money(party.incoming)}</dd></div>
      <div><dt>To pay</dt><dd>${money(party.outgoing)}</dd></div>
      ${showAdvances ? `<div><dt>Staff advances</dt><dd>${money(party.advances)}</dd></div>` : ''}
    </dl>
    <div class="money-account-actions">
      <button id="ledger-party-export" class="secondary" type="button">Export statement</button>
      ${contact?.phone && current ? '<button id="ledger-whatsapp" class="secondary" type="button">WhatsApp</button>' : ''}
      ${contact || !party.staff ? `<button id="ledger-contact" class="secondary" type="button">${contact ? 'Edit contact' : 'Save contact'}</button>` : ''}
      ${party.staff && current ? `<button id="ledger-staff-contact" class="secondary" type="button">${contact ? 'Edit staff profile' : 'Link staff to contact'}</button>` : ''}
      ${party.customer && current ? '<button id="ledger-fuel-credit" class="secondary" type="button">Fuel credit account</button>' : ''}
    </div>
    ${actions}
    <h3>Transactions</h3>
    ${party.entries.length ? `<ul class="ledger-entries">${party.entries.map((row, index) => `<li>
      <div><strong>${safe(row.type)}</strong>${row.reversal ? moneyBadge('Reversal', 'warning') : ''}
        <small>${safe(businessDay(row.date, 'medium'))} · ${safe(row.reference)}</small>
        ${row.reason || row.note ? `<small>${safe(row.reason || row.note)}</small>` : ''}
        ${current && row.record.record && !row.reversal ? `<button id="ledger-record-${index}" class="text-button" type="button">Open ${row.record.kind === 'entry' ? 'payment' : row.record.kind}</button>` : ''}
      </div>
      <div>${Object.entries(row.changes).map(([side, amount]) => `<div>
        <strong>${amount < 0 ? '−' : '+'}${money(Math.abs(amount))}</strong>
        <small>${money(row.balances[side])} ${partyBalanceLabels[side]}</small>
      </div>`).join('')}</div>
    </li>`).join('')}</ul>` : '<p class="quiet">No transactions yet.</p>'}`, true);
  listen('ledger-party-export', () => ledgerCSV('party-statement', data.financial.as_of, [
    ['Party', party.name], ['As of', data.financial.as_of], ['To collect (INR)', party.incoming / 100], ['To pay (INR)', party.outgoing / 100],
    ['Staff advances (INR)', party.advances / 100],
    ['Date', 'Reference', 'Entry', 'Change to collect (INR)', 'Change to pay (INR)', 'Change to advances (INR)',
      'To collect balance (INR)', 'To pay balance (INR)', 'Staff advance balance (INR)', 'Notes'],
    ...party.entries.slice().reverse().map(row => [row.date, row.reference, row.type,
      ...['incoming', 'outgoing', 'advances'].map(side => (row.changes[side] || 0) / 100),
      ...['incoming', 'outgoing', 'advances'].map(side => row.balances[side] / 100), row.reason || row.note || ''])
  ]));
  if (contact || !party.staff) listen('ledger-contact', () => openContactForm(contact, party.name, () => openBusiness('ledger')));
  if (party.staff && current) listen('ledger-staff-contact', () => outgoingStaffForm(party.staff));
  if (party.customer && current) listen('ledger-fuel-credit', () => openCustomerAccount(data, party.customer));
  if (contact?.phone && current) listen('ledger-whatsapp', () => {
    const message = party.incoming > 0
      ? `Hello ${party.name}, this is a reminder from ${session.station}. Your outstanding balance is ${money(party.incoming)}. Please share the payment reference once paid.`
      : '';
    openWhatsAppComposer(message, 'Message ' + contact.name, contact.name, contact.phone);
  });
  if (!current) return;
  if (contact || !party.staff) {
    listen('party-add-receivable', () => openMarketForm(data, party.name));
    listen('party-add-bill', () => outgoingBillForm(data, party.name));
    if (data.active) listen('party-add-credit', () => openShiftCredit(data, null, party.name));
  }
  const outgoingModel = {...data, entries: [...data.bill_payments, ...data.staff_entries]};
  if (party.staff?.active) {
    listen('party-add-salary', () => outgoingSalaryForm(party.staff.id, data));
    listen('party-add-advance', () => outgoingPayment('advance', party.staff, outgoingModel));
  }
  if (party.advances > 0) listen('party-return-advance', () => outgoingPayment('advance_return', party.staff, outgoingModel));
  for (const [index, row] of party.entries.entries()) {
    if (row.reversal || !row.record.record) continue;
    const {kind, record} = row.record;
    listen('ledger-record-' + index, () => {
      if (kind === 'receivable') openMarketDetail(data, record);
      else outgoingDetail(kind, record, outgoingModel);
    });
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
