"use strict";

const moneyView = {tab:'customers', bankTab:'banking', marketSearch:'', marketFilter:'outstanding', customerSearch:'', customerFilter:'all', bankFilter:'pending', method:'all'};
const moneyActivity = {money:{search:'', filter:'all'}, banking:{search:'', filter:'all'}};
const moneyBadge = (label, tone='neutral') => `<span class="money-badge ${tone}">${safe(label)}</span>`;
const moneyEmpty = (title, description, action='') => `<div class="money-empty"><span class="money-empty-icon">${navigationIcon('money')}</span><h3>${title}</h3><p>${description}</p>${action}</div>`;
const moneySearch = (id, label, value) => `<label class="money-search"><span class="sr-only">${label}</span><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input id="${id}" type="search" placeholder="${label}" value="${safe(value)}" autocomplete="off"></label>`;
const moneyOptions = (items, selected) => items.map(([key,label]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${label}</option>`).join('');

const marketKinds = {
  invoice: 'Invoice or service charge', supplier: 'Supplier refund or credit', loan: 'Loan or advance repayment',
  reimbursement: 'Reimbursement', opening: 'Opening balance', other: 'Other',
};
const moneyTabKey = view => view === 'banking' ? 'bankTab' : 'tab';

function moneyActivities(data, banking) {
  if (banking) return data.bank_records.slice().reverse().map(item=>({...item,kind:'bank',title:item.method === 'cash' ? 'Cash deposit' : 'Bank settlement',party:item.source.startsWith('shift:') ? 'Shift #' + item.source.split(':')[1] : 'Recorded payment',date:item.bank_date}));
  const customers = Object.fromEntries(data.customers.map(item=>[item.customer_key,item.name]));
  const market = Object.fromEntries(data.market_receivables.map(item=>[item.id,item.party]));
  const records = [...data.repayments.map(item=>({...item,kind:'repayment',title:'Customer payment',party:customers[item.customer_key] || '',date:item.paid_on})),
       ...data.market_receipts.map(item=>({...item,kind:'market-receipt',title:'Payment received',party:market[item.receivable_id],date:item.paid_on})),
       ...data.market_receivables.map(item=>({...item,title:marketKinds[item.kind],kind:'market-due',date:item.recorded_on}))];
  return records.sort((a,b)=>b.created_at.localeCompare(a.created_at) || b.id-a.id);
}

function showMoney(data, banking = false) {
  const credit = banking ? 0 : data.unallocated_credit + data.customers.reduce((sum,item)=>sum+item.balance,0);
  const market = banking ? 0 : data.market_receivables.reduce((sum,item)=>sum+item.balance,0);
  const overdue = banking ? 0 : [...data.customers,...data.market_receivables].filter(item=>item.overdue).reduce((sum,item)=>sum+item.balance,0);
  const digital = data.settlements.filter(item=>item.method !== 'cash');
  const cash = data.settlements.filter(item=>item.method === 'cash');
  const pending = data.settlements.filter(item=>item.remaining > 0).length;
  const activity = moneyActivities(data, banking);
  const view = banking ? 'banking' : 'money';
  const activityView = moneyActivity[view];
  const activeTab = moneyView[moneyTabKey(view)];
  const tabs = banking ? [['banking','Settlements',pending],['activity','Activity',activity.length]]
    : [['customers','Fuel credit',data.customers.length],['market','Other dues',data.market_receivables.filter(item=>item.balance>0).length],['activity','Activity',activity.length]];
  const stats = banking ? [
    ['Bank receipts pending',digital.reduce((sum,item)=>sum+item.remaining,0),'UPI and card settlements','','bank'],
    ['Cash to deposit',cash.reduce((sum,item)=>sum+item.remaining,0),'Cash awaiting deposit','','cash'],
  ] : [
    ['Total to collect',credit+market,'All outstanding dues','','dues'],
    ['Fuel credit',credit,'Customer credit sales','',''],
    ['Other dues',market,'Refunds, advances and other balances','',''],
    ['Overdue',overdue,'Past the due date','',''],
  ];
  const actions = `<button id="money-contacts" class="secondary" type="button">Manage contacts</button>
    <button id="money-record-credit" class="secondary" type="button">+ Record credit</button>
    <button id="money-add-receivable" class="primary" type="button">+ Add receivable</button>`;
  const body = `    <div class="money-stats">${stats.map(([label,value,caption,flag,tone])=>`<section class="money-stat ${tone}" aria-label="${label}"><div><span>${label}</span>${flag ? moneyBadge(flag,'warning') : ''}</div><strong>${money(value)}</strong><small>${caption}</small></section>`).join('')}</div>
    ${!banking && data.unallocated_credit ? `<div class="money-allocation-alert"><div>${navigationIcon('exceptions')}<span><strong>${money(data.unallocated_credit)} needs a customer</strong><span>Assign credit sales before recording a payment.</span></span></div><button id="money-allocate" type="button" class="text-button">Assign credit ${icon('arrow')}</button></div>` : ''}
    ${banking ? '' : pendingCreditSummary(data)}
    <section class="money-workspace" aria-label="${banking ? 'Banking' : 'To collect'} workspace">
      <div class="money-workspace-top"><div class="money-tabs" role="tablist" aria-label="${banking ? 'Banking' : 'To collect'} sections">${tabs.map(([key,label,count])=>`<button id="money-tab-${key}" role="tab" type="button" aria-selected="${activeTab===key}" aria-controls="money-panel-${key}" tabindex="${activeTab===key ? 0 : -1}">${label}<span class="tab-count">${count}</span></button>`).join('')}</div><button id="money-help" type="button" class="text-button money-help">How this works</button></div>
      ${banking ? '' : `<div id="money-panel-customers" role="tabpanel" aria-labelledby="money-tab-customers" ${moneyView.tab==='customers' ? '' : 'hidden'}>
        <div class="money-toolbar"><h2>Customer accounts <span id="money-customer-count"></span></h2><div class="money-tools">${moneySearch('money-customer-search','Search customers',moneyView.customerSearch)}<label><span class="sr-only">Customer status</span><select id="money-customer-filter">${moneyOptions([['all','All customers'],['outstanding','With dues'],['overdue','Overdue']],moneyView.customerFilter)}</select></label></div></div>
        <div class="money-toolbar credit-actions">
          <button id="money-add-customer" class="secondary" type="button">+ Add customer</button>
          <button id="money-record-payment" class="secondary" type="button" ${data.customers.some(item=>item.balance>0) ? '' : 'disabled title="There are no outstanding customer balances"'}>+ Record payment</button>
        </div>
        ${data.customers.length ? `<div class="table-scroll money-table-wrap" id="money-customer-table"><table class="money-table"><thead><tr><th>Customer</th><th>Payment due</th><th class="numeric">Credit sales</th><th class="numeric">Received</th><th class="numeric">Outstanding</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${data.customers.map((item,index)=>`<tr data-money-customer="${index}" data-search="${safe(item.name.toLocaleLowerCase())}" data-overdue="${Boolean(item.overdue)}" data-outstanding="${item.balance>0}"><th scope="row"><button class="money-account" id="money-customer-${index}" type="button" aria-label="Open account for ${safe(item.name)}"><span class="money-avatar" aria-hidden="true">${safe(Array.from(item.name)[0].toUpperCase())}</span><span>${safe(item.name)}<small>${item.overdue ? 'Overdue · ' : ''}${item.transactions.filter(row=>row.type !== 'Repayment').length} credit ${item.transactions.filter(row=>row.type !== 'Repayment').length===1 ? 'entry' : 'entries'}</small></span></button></th><td>${item.overdue ? moneyBadge('Overdue','warning')+'<small>'+safe(item.due_date)+'</small>' : safe(item.due_date || 'Not set')}</td><td class="numeric">${money(item.sales)}</td><td class="numeric money-muted">${money(item.repaid)}</td><td class="numeric"><strong>${money(item.balance)}</strong></td><td class="money-row-action"><button id="money-pay-${index}" class="text-button" type="button">${item.balance>0 ? 'Record payment' : 'View account'}</button></td></tr>`).join('')}</tbody></table></div><div id="money-no-customers" hidden>${moneyEmpty('No matching customers','Try another name or change the status filter.')}</div>` : moneyEmpty('Your credit customers, in one place','Add a customer to start tracking what they owe.','<button id="money-first-customer" class="primary" type="button">+ Add your first customer</button>')}
      </div>${marketPanel(data)}`}
      ${banking ? `<div id="money-panel-banking" role="tabpanel" aria-labelledby="money-tab-banking" ${activeTab==='banking' ? '' : 'hidden'}>
        <div class="money-toolbar"><h2>Settlements &amp; deposits <span id="money-bank-count"></span></h2><div class="money-tools"><label><span class="sr-only">Banking status</span><select id="money-bank-filter">${moneyOptions([['pending','Pending'],['all','All receipts'],['completed','Completed']],moneyView.bankFilter)}</select></label><label><span class="sr-only">Payment method</span><select id="money-method-filter">${moneyOptions([['all','All methods'],['upi','UPI'],['card','Card'],['cash','Cash']],moneyView.method)}</select></label></div></div>
        ${data.settlements.length ? `<div class="table-scroll money-table-wrap" id="money-bank-table"><table class="money-table"><thead><tr><th>Source</th><th>Method</th><th class="numeric">Expected</th><th class="numeric">Received</th><th class="numeric">Fees</th><th class="numeric">Pending</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${data.settlements.map((item,index)=>`<tr data-money-bank="${index}" data-pending="${item.remaining>0}" data-method="${item.method}"><th scope="row"><button id="money-bank-source-${index}" type="button" class="money-source-link" aria-label="Open ${safe(item.label)} ${safe(methodNames[item.method])} receipt">${safe(item.label)}<small class="money-mobile-line">${safe(methodNames[item.method])} · Open receipt ↗</small></button></th><td>${moneyBadge(methodNames[item.method])}</td><td class="numeric">${money(item.expected)}</td><td class="numeric money-muted">${money(item.banked)}</td><td class="numeric money-muted">${money(item.fees)}</td><td class="numeric"><strong>${money(item.remaining)}</strong></td><td class="money-row-action"><button id="money-bank-${index}" class="text-button" type="button">${item.remaining>0 ? item.method==='cash' ? 'Record deposit' : 'Record settlement' : 'View receipts'}</button></td></tr>`).join('')}</tbody></table></div><div id="money-no-banks" hidden>${moneyEmpty('You’re all caught up','No receipts match this view.')}</div>` : moneyEmpty('No receipts to reconcile yet','Submitted shift totals and cash payments awaiting deposit will appear here.')}
      </div>` : ''}
      <div id="money-panel-activity" role="tabpanel" aria-labelledby="money-tab-activity" ${activeTab==='activity' ? '' : 'hidden'}>
        <div class="money-toolbar"><h2>Recent activity <span id="money-activity-count"></span></h2><div class="money-tools">${moneySearch('money-activity-search','Search reference or name',activityView.search)}<label><span class="sr-only">Entry status</span><select id="money-activity-filter">${moneyOptions([['all','All entries'],['recorded','Recorded'],['void','Voided']],activityView.filter)}</select></label></div></div>
        ${activity.length ? `<div class="table-scroll money-table-wrap" id="money-activity-table"><table class="money-table"><thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th class="numeric">Amount</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${activity.map((item,index)=>`<tr data-money-activity="${index}" data-search="${safe((item.reference+' '+item.party).toLocaleLowerCase())}" data-void="${Boolean(item.void)}"><td>${safe(item.date)}</td><th scope="row"><button id="money-activity-source-${index}" type="button" class="money-source-link" aria-label="Open entry ${safe(item.reference)}">${item.title}<small>${safe(item.party)}</small><small class="money-mobile-line">${safe(item.reference)} · ${safe(item.date)} · ${item.void ? 'Voided' : 'Recorded'}</small></button></th><td>${safe(item.reference)}</td><td class="numeric"><strong>${money(item.amount)}</strong></td><td>${moneyBadge(item.void ? 'Voided' : 'Recorded',item.void ? 'neutral' : 'positive')}</td><td><button id="money-activity-${index}" class="text-button" type="button">View entry</button></td></tr>`).join('')}</tbody></table></div><div id="money-no-activity" hidden>${moneyEmpty('No matching entries','Try another reference or change the status filter.')}</div>` : moneyEmpty('No activity yet',banking ? 'Settlements and deposits will appear here.' : 'Recorded dues and payments will appear here.')}
      </div>
      <footer class="money-panel-footer"><span>All dates · Amounts in INR</span><span>Updated ${safe(timestamp(new Date().toISOString()))}</span><button id="money-mobile-help" class="text-button" type="button">${banking ? 'Banking help' : 'Collection help'}</button></footer>
    </section>`;
  shell(banking ? `<div class="money-heading"><div>${heading('', 'Banking', 'Confirm UPI and card receipts and record cash deposits.')}</div></div>${body}`
    : ledgerWorkspace('collect', 'Record credit and collect money owed to the station.', actions, body), view);
  if (!banking) {
    bindLedgerNavigation('collect');
    listen('money-add-receivable',()=>openMarketForm(data));
    bindMarketPanel(data);
    listen('money-contacts',openContacts);
    listen('money-add-customer',()=>openCustomerForm(data));
    listen('money-record-credit',()=>openShiftCredit(data));
    data.pending_credits.forEach(item=>listen('pending-credit-'+item.id,()=>openShiftCredit(data,item)));
    if (!data.customers.length) listen('money-first-customer',()=>openCustomerForm(data));
    listen('money-record-payment',()=>openPaymentForm(data));
    if (data.unallocated_credit) listen('money-allocate',()=>openAllocationForm(data));
    data.customers.forEach((item,index)=>{
      listen('money-customer-'+index,()=>openCustomerAccount(data,item));
      listen('money-pay-'+index,()=>item.balance>0 ? openPaymentForm(data,item) : openCustomerAccount(data,item));
    });
  } else {
    data.settlements.forEach((item,index)=>{
      listen('money-bank-'+index,()=>openBankForm(data,item));
      listen('money-bank-source-'+index,()=>openBankForm(data,item));
    });
  }
  listen('money-help',()=>openMoneyHelp(banking));
  listen('money-mobile-help',()=>openMoneyHelp(banking));
  const keys=tabs.map(([key])=>key);
  for (const key of keys) {
    listen('money-tab-'+key,()=>selectMoneyTab(key));
    document.getElementById('money-tab-'+key).addEventListener('keydown',event=>{
      let index=keys.indexOf(key);
      if (!['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) return;
      event.preventDefault(); index=event.key==='Home' ? 0 : event.key==='End' ? keys.length-1 : (index+(event.key==='ArrowRight' ? 1 : keys.length-1))%keys.length;
      selectMoneyTab(keys[index]); document.getElementById('money-tab-'+keys[index]).focus();
    });
  }
  for (const [id,key,event] of [['money-customer-search','customerSearch','input'],['money-customer-filter','customerFilter','change'],['money-bank-filter','bankFilter','change'],['money-method-filter','method','change']]) {
    if (document.getElementById(id)) listen(id,e=>{moneyView[key]=e.target.value;filterMoneyRows();},event);
  }
  listen('money-activity-search',event=>{activityView.search=event.target.value;filterMoneyRows();},'input');
  listen('money-activity-filter',event=>{activityView.filter=event.target.value;filterMoneyRows();},'change');
  activity.forEach((item,index)=>{listen('money-activity-'+index,()=>openMoneyEntry(item));listen('money-activity-source-'+index,()=>openMoneyEntry(item));});
  filterMoneyRows();
  if (!banking) filterMarketRows();
}

function selectMoneyTab(key) {
  const view=document.getElementById('main-content').dataset.view;
  moneyView[moneyTabKey(view)]=key;
  for (const name of view==='banking' ? ['banking','activity'] : ['customers','market','activity']) {
    const tab=document.getElementById('money-tab-'+name);tab.setAttribute('aria-selected',String(name===key));tab.tabIndex=name===key ? 0 : -1;
    document.getElementById('money-panel-'+name).hidden=name!==key;
  }
}
function filterMoneyRows() {
  const activityView=moneyActivity[document.getElementById('main-content').dataset.view];
  const groups=[['customer',row=>row.dataset.search.includes(moneyView.customerSearch.trim().toLocaleLowerCase()) && (moneyView.customerFilter==='all' || row.dataset[moneyView.customerFilter]==='true'),'customers'],
    ['bank',row=>(moneyView.bankFilter==='all' || row.dataset.pending===String(moneyView.bankFilter==='pending')) && (moneyView.method==='all' || row.dataset.method===moneyView.method),'banks'],
    ['activity',row=>row.dataset.search.includes(activityView.search.trim().toLocaleLowerCase()) && (activityView.filter==='all' || row.dataset.void===String(activityView.filter==='void')),'activity']];
  for (const [group,matches,empty] of groups) {
    const rows=[...document.querySelectorAll(`[data-money-${group}]`)];let count=0;
    rows.forEach(row=>{row.hidden=!matches(row);if(!row.hidden)count++;});
    const table=document.getElementById('money-'+group+'-table'), placeholder=document.getElementById('money-no-'+empty);
    if(table)table.hidden=count===0;if(placeholder)placeholder.hidden=count>0;
    const counter=document.getElementById('money-'+group+'-count');if(counter)counter.textContent=String(count);
  }
}

function moneyDialog(title, body, drawer=false) {
  const dialog=document.getElementById('money-dialog');if(dialog.open)dialog.close();
  dialog.className=drawer ? 'money-drawer' : '';
  dialog.innerHTML=`<header class="money-dialog-header"><h2 id="money-dialog-title">${safe(title)}</h2><button id="money-dialog-close" class="text-button" type="button" aria-label="Close dialog">✕</button></header><div class="money-dialog-body">${body}</div>`;
  listen('money-dialog-close',()=>dialog.close());dialog.showModal();bindContactFields(dialog);dialog.querySelector('input:not([readonly]),select,textarea')?.focus();return dialog;
}
function bindMoneyForm(id,route,extra={},message='Saved successfully.') {
  const view=document.getElementById('main-content').dataset.view;
  bindForm(id,async form=>{
    await api(route,{...fields(form),...extra});
    await openBusiness(view);
    showBusinessNotice(message);
    document.getElementById('money-tab-'+moneyView[moneyTabKey(view)])?.focus({preventScroll:true});
  });
}
function pendingCreditSummary(data) {
  if (!data.pending_credits.length) return '';
  const total = data.pending_credits.reduce((sum, item) => sum + item.amount, 0);
  return `<details class="card pending-shift-credit">
    <summary><strong>Pending shift credit</strong><span>Shift #${data.active.id} · ${money(total)}</span></summary>
    <p class="money-form-hint">These sales appear in the report and customer balances when the manager submits this shift.</p>
    <ul class="pending-credit-list">${data.pending_credits.map(item => `<li>
      <span><strong>${safe(item.party)}</strong><small>${safe(item.reference)}</small></span>
      <button id="pending-credit-${item.id}" class="secondary" type="button" aria-label="Edit credit for ${safe(item.party)}, reference ${safe(item.reference)}">${money(item.amount)} · Edit</button>
    </li>`).join('')}</ul></details>`;
}

function openShiftCredit(data, item = null) {
  if (!data.active) {
    moneyDialog('Record customer credit', `<p class="money-dialog-intro">Record credit while a shift is open. Ask the manager to open a shift, or open a submitted shift’s report if you need to correct its figures.</p>
      ${data.unallocated_credit ? '<button id="credit-assign-existing" class="secondary" type="button">Assign existing credit</button>' : ''}`);
    if (data.unallocated_credit) listen('credit-assign-existing', () => openAllocationForm(data));
    return;
  }
  const shiftId = data.active.id;
  const route = '/shift-credit' + (item ? '/' + item.id : '');
  moneyDialog(item ? 'Edit pending credit' : 'Record customer credit', `<form id="shift-credit-form" class="money-form">
    <div class="money-source"><span>Shift #${shiftId}</span><strong>${businessDay(data.active.business_date)}</strong></div>
    ${contactNameField('Customer / account name', 'party', item?.party, {knownNames: data.customers.map(customer => customer.name)})}
    ${numberField('Credit amount (₹)', 'amount', {required:true, min:0.01, value:item ? (item.amount / 100).toFixed(2) : undefined})}
    <label>Sale reference<input name="reference" value="${safe(item?.reference)}" placeholder="Receipt or invoice number" required maxlength="150"></label>
    <label>Note (optional)<textarea name="note" rows="2" maxlength="150">${safe(item?.note)}</textarea></label>
    <p class="money-form-hint">The credit posts to the customer’s account when this shift is submitted.</p>
    ${errorbox}<button class="primary">Save credit</button>
    ${item ? '<button id="void-pending-credit" class="secondary" type="button">Remove pending credit</button>' : ''}
  </form>`);
  bindMoneyForm('shift-credit-form', route, {shift_id:shiftId, action:item ? 'edit' : 'record'}, 'Credit saved for this shift.');
  if (item) listen('void-pending-credit', () => {
    moneyDialog('Remove pending credit?', `<form id="void-credit-form" class="money-form"><p>${safe(item.party)} · ${money(item.amount)} · ${safe(item.reference)}</p>${errorbox}<button class="primary">Remove credit</button></form>`);
    bindMoneyForm('void-credit-form', route, {shift_id:shiftId, action:'void'}, 'Pending credit removed.');
  });
}

function openCustomerForm(data,customer=null) {
  moneyDialog(customer ? 'Set payment due date' : 'Add customer',`<form id="money-customer-form" class="money-form">${customer ? `<label>Customer / account name<input name="name" value="${safe(customer.name)}" readonly></label>`
    : contactNameField('Customer / account name', 'name', '', {knownNames: data.customers.map(item => item.name)})}${businessDate('Payment due date (optional)','due_date',customer?.due_date || '',false)}${errorbox}<button class="primary">Save customer</button></form>`);
  bindMoneyForm('money-customer-form','/customers',{},'Customer saved.');
}
function openCustomerAccount(data,item) {
  moneyDialog(item.name,`<div class="money-account-balance"><span>Outstanding balance</span><strong>${money(item.balance)}</strong>${item.overdue ? moneyBadge('Overdue','warning') : ''}</div>
    <div class="money-account-actions"><button id="money-account-payment" class="primary" type="button" ${item.balance>0 ? '' : 'disabled'}>Record payment</button><button id="money-account-export" class="secondary" type="button">Export statement</button>${item.balance > 0 ? '<button id="money-account-whatsapp" class="secondary" type="button">WhatsApp reminder</button>' : ""}<button id="money-account-due" class="text-button" type="button">Set due date</button></div>
    <dl class="money-account-summary"><div><dt>Credit sales</dt><dd>${money(item.sales)}</dd></div><div><dt>Payments received</dt><dd>${money(item.repaid)}</dd></div><div><dt>Payment due</dt><dd>${safe(item.due_date || 'Not set')}</dd></div></dl>
    <h3>Account activity</h3><div class="table-scroll"><table class="money-table"><thead><tr><th>Date</th><th>Entry</th><th class="numeric">Amount</th></tr></thead><tbody>${item.transactions.map(row=>`<tr><td>${safe(row.date)}</td><td>${safe(row.type)}<small>${safe(row.reference)}${row.note ? ' · '+safe(row.note) : ''}</small></td><td class="numeric">${money(row.amount)}</td></tr>`).join('')}</tbody></table></div>`,true);
  if (item.balance > 0) listen('money-account-whatsapp', () => openWhatsAppComposer(
    `Hello ${item.name}, this is a payment reminder from ${session.station}. Your outstanding balance is ${money(item.balance)}` +
    (item.due_date ? `, due ${businessDay(item.due_date)}` : "") + ". Please share the payment reference once paid.",
    "Send with WhatsApp", item.name
  ));
  listen('money-account-payment',()=>openPaymentForm(data,item));listen('money-account-export',()=>downloadCustomerStatement(item,data.today));listen('money-account-due',()=>openCustomerForm(data,item));
}
function openPaymentForm(data,customer=null) {
  const accounts=data.customers.filter(item=>item.balance>0);
  if(!accounts.length)return;
  const dialog=moneyDialog('Record customer payment',`<form id="money-payment-form" class="money-form"><label>Customer<select name="customer_key" required><option value="">Choose a customer</option>${accounts.map(item=>`<option value="${safe(item.customer_key)}" ${item.customer_key===customer?.customer_key ? 'selected' : ''}>${safe(item.name)}</option>`).join('')}</select></label><p class="money-form-hint" id="money-balance-hint"></p>
    ${numberField('Amount received (₹)','amount',{required:true,min:0.01})}<div class="money-form-grid">${businessDate('Receipt date','paid_on',data.today)}<label>Received as<select name="method"><option value="bank">Bank / UPI / card</option><option value="cash">Cash</option></select></label></div>${businessText('Unique receipt reference','reference')}<details class="money-optional"><summary>Add a note</summary>${businessNote()}</details>${errorbox}<button class="primary">Record payment</button><p class="money-form-hint">Record bank payments only after the receipt is confirmed.</p></form>`);
  const form=dialog.querySelector('form');const update=()=>{const account=accounts.find(item=>item.customer_key===form.elements.customer_key.value);document.getElementById('money-balance-hint').textContent=account ? money(account.balance)+' outstanding' : 'Choose the customer who paid.';form.elements.amount.max=account ? account.balance/100 : 1000000000;};
  form.elements.customer_key.addEventListener('change',update);update();if(customer)form.elements.amount.focus();bindMoneyForm('money-payment-form','/repayments',{},'Customer payment recorded.');
}
function openBankForm(data,item) {
  moneyDialog(item.method==='cash' ? 'Record cash deposit' : 'Record bank settlement',`<div class="money-source"><span>${safe(item.label)} · ${safe(methodNames[item.method])}</span><strong>${money(item.remaining)} pending</strong></div>
    ${item.remaining>0 ? `<form id="money-bank-form" class="money-form">${numberField(item.method==='cash' ? 'Cash deposited (₹)' : 'Net bank receipt (₹)','amount',{required:true,min:0.01,max:item.remaining/100})}${item.method==='cash' ? '' : numberField('Settlement fees (₹)','fees',{value:0})}${businessDate('Bank receipt / deposit date','bank_date',data.today)}${businessText('Unique bank / deposit reference','reference')}<details class="money-optional"><summary>Add a note</summary>${businessNote()}</details>${errorbox}<button class="primary">Record ${item.method==='cash' ? 'deposit' : 'settlement'}</button></form>` : '<p class="money-confirmed">Fully reconciled</p>'}
    ${item.records.length ? `<h3>Recorded receipts</h3><div class="money-receipts">${item.records.map(row=>`<div><span>${safe(row.reference)}<small>${safe(row.bank_date)}</small></span><strong>${money(row.amount)}</strong></div>`).join('')}</div>` : ''}`);
  if(item.remaining>0)bindMoneyForm('money-bank-form','/bank-records',{source:item.source,method:item.method},item.method==='cash' ? 'Cash deposit recorded.' : 'Bank settlement recorded.');
}
function openAllocationForm(data) {
  moneyDialog('Assign credit to a customer',`<p class="money-dialog-intro">These credit sales need a customer name.</p><form id="money-allocation-form" class="money-form"><label>Shift<select name="shift_id" required>${data.unallocated_shifts.map(item=>`<option value="${item.shift_id}">Shift #${item.shift_id} · ${money(item.remaining)} to assign</option>`).join('')}</select></label>${contactNameField('Customer / account name', 'name', '', {knownNames: data.customers.map(item => item.name)})}${numberField('Credit amount to assign (₹)','amount',{required:true,min:0.01})}${businessText('Unique allocation reference','reference')}${errorbox}<button class="primary">Assign credit</button></form>`);
  const form=document.getElementById('money-allocation-form');const update=()=>{form.elements.amount.max=data.unallocated_shifts.find(item=>item.shift_id===Number(form.elements.shift_id.value)).remaining/100;};form.elements.shift_id.addEventListener('change',update);update();
  bindForm('money-allocation-form',async form=>{const values=fields(form);await api('/credit-allocations',{...values,shift_id:Number(values.shift_id)});await openBusiness('money');showBusinessNotice('Credit assigned to customer.');});
}
function openMoneyEntry(item) {
  moneyDialog(item.title,`<div class="money-account-balance"><span>${safe(item.reference)}</span><strong>${money(item.amount)}</strong>${moneyBadge(item.void ? 'Voided' : 'Recorded',item.void ? 'neutral' : 'positive')}</div><dl class="money-entry-details"><div><dt>Date</dt><dd>${safe(item.date)}</dd></div><div><dt>Party / source</dt><dd>${safe(item.party)}</dd></div>${item.method ? `<div><dt>Method</dt><dd>${safe(methodNames[item.method] || 'Bank')}</dd></div>` : ''}<div><dt>Recorded by</dt><dd>${safe(item.actor)}</dd></div><div><dt>Recorded at</dt><dd>${timestamp(item.created_at)}</dd></div>${item.fees ? `<div><dt>Fees</dt><dd>${money(item.fees)}</dd></div>` : ''}${item.note ? `<div><dt>Note</dt><dd>${safe(item.note)}</dd></div>` : ''}</dl>${item.void ? `<div class="money-void-note"><strong>Void reason</strong><p>${safe(item.void.reason)}</p><small>${safe(item.void.actor)} · ${timestamp(item.void.created_at)}</small></div>` : item.kind === 'market-due' && item.received ? '<p class="money-form-hint">Void the linked payments before voiding this receivable.</p>' : '<button id="money-void-entry" class="text-button money-danger" type="button">Void this entry</button>'}`,true);
  if(document.getElementById('money-void-entry'))listen('money-void-entry',()=>{
    moneyDialog('Void this entry?',`<p class="money-dialog-intro">${safe(item.reference)} · ${money(item.amount)}. The original entry stays in history. Voiding recalculates the outstanding balance.</p><form id="money-void-form" class="money-form">${businessNote('Reason for voiding this entry','reason',true)}${errorbox}<button class="primary money-danger-button">Void entry</button></form>`);
    bindMoneyForm('money-void-form','/money-records/'+item.kind+'/'+item.id+'/void',{},'Entry voided. Original retained in history.');
  });
}
function openMoneyHelp(banking) {
  const content = banking
    ? '<section><h3>Settlements and deposits</h3><p>Match UPI and card totals to confirmed bank receipts and enter any fees separately. Record cash deposits after the cash reaches the bank.</p></section>'
    : '<section><h3>Fuel credit</h3><p>Record credit during an open shift. It becomes due when the manager submits the shift.</p></section><section><h3>Other dues</h3><p>Add refunds, loans, reimbursements and other amounts owed. Open a receivable to record a full or partial payment against it.</p></section>';
  moneyDialog(banking ? 'How Banking works' : 'How collections work', `<div class="money-help-content">${content}<section><h3>Correct an entry</h3><p>Open the entry in Activity and void it with a reason. The original remains in history.</p></section></div>`);
}

function marketStatus(item) {
  if (item.void) return ['Voided', 'neutral'];
  if (!item.balance) return ['Paid', 'positive'];
  if (item.overdue) return ['Overdue', 'warning'];
  return [item.received ? 'Partially paid' : 'Outstanding', 'neutral'];
}

function marketPanel(data) {
  const rows = data.market_receivables.map(item => {
    const [status, tone] = marketStatus(item);
    const kind = marketKinds[item.kind];
    const search = [item.party, item.reference, kind].join(' ').toLocaleLowerCase();
    const due = item.due_date ? businessDay(item.due_date, 'medium') : '—';
    return `<tr data-money-market data-search="${safe(search)}" data-outstanding="${item.balance > 0}"
        data-overdue="${item.overdue}" data-paid="${!item.void && !item.balance}" data-void="${Boolean(item.void)}">
      <th scope="row"><button id="market-detail-${item.id}" class="money-source-link market-detail" type="button"
          aria-label="Open receivable ${safe(item.reference)} for ${safe(item.party)}">${safe(item.party)}
        <small>${safe(kind)} · ${safe(item.reference)}</small>
        <small class="money-mobile-line">${status}${item.due_date ? ' · Due ' + safe(due) : ''}</small>
      </button></th>
      <td>${safe(due)}</td><td>${moneyBadge(status, tone)}</td>
      <td class="numeric"><strong>${money(item.balance)}</strong></td>
    </tr>`;
  });
  return `<div id="money-panel-market" role="tabpanel" aria-labelledby="money-tab-market" ${moneyView.tab === 'market' ? '' : 'hidden'}>
    <div class="money-toolbar"><h2>Other dues <span id="market-visible-count"></span></h2><div class="money-tools">
      ${moneySearch('market-search', 'Search names or references', moneyView.marketSearch)}
      <label><span class="sr-only">Receivable status</span><select id="market-filter">${moneyOptions([
        ['outstanding', 'Outstanding'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['void', 'Voided'], ['all', 'All receivables']
      ], moneyView.marketFilter)}</select></label>
    </div></div>
    ${rows.length ? `<div class="table-scroll money-table-wrap" id="market-table">
      <table class="money-table"><thead><tr><th>Owed by</th><th>Due date</th><th>Status</th><th class="numeric">Balance</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table>
    </div><div id="market-no-matches" hidden>${moneyEmpty('No matching receivables', 'Try another name or change the status filter.')}</div>`
      : moneyEmpty('No other dues recorded', 'Add a refund, advance or any other amount owed to the station.',
        '<button id="market-first-due" class="primary" type="button">Add your first receivable</button>')}
  </div>`;
}

function bindMarketPanel(data) {
  listen('market-search', event => {
    moneyView.marketSearch = event.target.value;
    filterMarketRows();
  }, 'input');
  listen('market-filter', event => {
    moneyView.marketFilter = event.target.value;
    filterMarketRows();
  }, 'change');
  for (const item of data.market_receivables) listen('market-detail-' + item.id, () => openMarketDetail(data, item));
  if (!data.market_receivables.length) listen('market-first-due', () => openMarketForm(data));
}

function filterMarketRows() {
  const query = moneyView.marketSearch.trim().toLocaleLowerCase();
  const status = moneyView.marketFilter;
  let count = 0;
  for (const row of document.querySelectorAll('[data-money-market]')) {
    row.hidden = !row.dataset.search.includes(query) || (status !== 'all' && row.dataset[status] !== 'true');
    if (!row.hidden) count++;
  }
  document.getElementById('market-visible-count').textContent = String(count);
  const table = document.getElementById('market-table');
  if (table) {
    table.hidden = count === 0;
    document.getElementById('market-no-matches').hidden = count > 0;
  }
}

function openMarketForm(data) {
  const view = document.getElementById('main-content').dataset.view;
  moneyDialog('Add receivable', `<form id="market-receivable-form" class="money-form">
    ${contactNameField('Owed by (person or company)', 'party', '', {knownNames: data.market_receivables.map(item => item.party)})}
    <div><label for="market-kind">Receivable type</label><select id="market-kind" name="kind" required><option value="">Choose a type</option>${moneyOptions(Object.entries(marketKinds))}</select></div>
    ${numberField('Amount owed (₹)', 'amount', {min: 0.01, required: true})}
    <div class="money-form-grid">${businessDate('Date owed', 'recorded_on', data.today)}${businessDate('Due date (optional)', 'due_date', '', false)}</div>
    ${businessText('Reference', 'reference')}
    ${businessNote('Description (optional)')}
    ${errorbox}<button class="primary">Save receivable</button>
  </form>`);
  bindForm('market-receivable-form', async form => {
    await api('/receivables', fields(form));
    if (view === 'money') Object.assign(moneyView, {tab: 'market', marketSearch: '', marketFilter: 'outstanding'});
    await openBusiness(view);
    showBusinessNotice('Receivable added.');
    document.getElementById('money-tab-market')?.focus({preventScroll: true});
  });
}

function openMarketDetail(data, item) {
  const receipts = data.market_receipts.filter(row => row.receivable_id === item.id);
  const [status, tone] = marketStatus(item);
  moneyDialog(item.party, `<div class="money-account-balance"><span>Outstanding balance</span>
    <strong>${money(item.balance)}</strong>${moneyBadge(status, tone)}</div>
    ${item.balance ? '<div class="money-account-actions"><button id="market-record-payment" class="primary" type="button">Record payment</button></div>' : ''}
    <dl class="money-entry-details">
      <div><dt>Type</dt><dd>${safe(marketKinds[item.kind])}</dd></div><div><dt>Reference</dt><dd>${safe(item.reference)}</dd></div>
      <div><dt>Original amount</dt><dd>${money(item.amount)}</dd></div><div><dt>Paid so far</dt><dd>${money(item.received)}</dd></div>
      <div><dt>Date owed</dt><dd>${safe(businessDay(item.recorded_on, 'medium'))}</dd></div>
      <div><dt>Due date</dt><dd>${item.due_date ? safe(businessDay(item.due_date, 'medium')) : 'Not set'}</dd></div>
      ${item.note ? `<div class="market-description"><dt>Description</dt><dd>${safe(item.note)}</dd></div>` : ''}
    </dl>
    <h3>Payment history</h3>
    ${receipts.length ? `<div class="money-receipts">${receipts.map(row => `<div>
      <button id="market-receipt-${row.id}" class="money-source-link" type="button">${safe(row.reference)}<small>${safe(businessDay(row.paid_on, 'medium'))}${row.void ? ' · Voided' : ''}</small></button>
      <strong>${money(row.amount)}</strong>
    </div>`).join('')}</div>` : '<p class="money-form-hint">No payments recorded yet.</p>'}`, true);
  if (item.balance) listen('market-record-payment', () => openMarketPayment(data, item));
  for (const row of receipts) listen('market-receipt-' + row.id, () => openMoneyEntry({
    ...row, kind: 'market-receipt', title: 'Payment received', party: item.party, date: row.paid_on
  }));
}

function openMarketPayment(data, item) {
  moneyDialog('Record receivable payment', `<div class="money-source"><span>${safe(item.party)} · ${safe(item.reference)}</span>
    <strong>${money(item.balance)} outstanding</strong></div>
    <form id="market-payment-form" class="money-form">
      ${numberField('Amount received (₹)', 'amount', {min: 0.01, max: item.balance / 100, required: true})}
      <div class="money-form-grid">${businessDate('Receipt date', 'paid_on', data.today)}
        <label>Received as<select name="method"><option value="bank">Bank / UPI / card</option><option value="cash">Cash</option></select></label>
      </div>
      ${businessText('Unique receipt reference', 'reference')}
      <details class="money-optional"><summary>Add a note</summary>${businessNote()}</details>
      ${errorbox}<button class="primary">Record payment</button>
      <p class="money-form-hint">Record bank payments once you have confirmed the receipt.</p>
    </form>`);
  bindMoneyForm('market-payment-form', '/receivables/payments', {receivable_id: item.id}, 'Receivable payment recorded.');
}
