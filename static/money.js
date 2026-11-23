"use strict";

const moneyView = {tab:'customers', customerSearch:'', customerFilter:'all', bankFilter:'pending', method:'all', activitySearch:'', activityFilter:'all'};
const moneyBadge = (label, tone='neutral') => `<span class="money-badge ${tone}">${safe(label)}</span>`;
const moneyEmpty = (title, description, action='') => `<div class="money-empty"><span class="money-empty-icon">${navigationIcon('money')}</span><h3>${title}</h3><p>${description}</p>${action}</div>`;
const moneySearch = (id, label, value) => `<label class="money-search"><span class="sr-only">${label}</span><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></svg><input id="${id}" type="search" placeholder="${label}" value="${safe(value)}" autocomplete="off"></label>`;
const moneyOptions = (items, selected) => items.map(([key,label]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${label}</option>`).join('');

function moneyActivities(data) {
  const customers = Object.fromEntries(data.customers.map(item=>[item.customer_key,item.name]));
  return [...data.repayments.map(item=>({...item,kind:'repayment',title:'Customer payment',party:customers[item.customer_key] || '',date:item.paid_on})),
    ...data.bank_records.map(item=>({...item,kind:'bank',title:item.method === 'cash' ? 'Cash deposit' : 'Bank settlement',party:item.source.startsWith('shift:') ? 'Shift #' + item.source.split(':')[1] : 'Customer payment',date:item.bank_date}))]
    .sort((a,b)=>b.created_at.localeCompare(a.created_at) || b.id-a.id);
}

function showMoney(data) {
  const outstanding = data.customers.reduce((sum,item)=>sum+item.balance,0);
  const overdue = data.customers.filter(item=>item.overdue).length;
  const digital = data.settlements.filter(item=>item.method !== 'cash');
  const cash = data.settlements.filter(item=>item.method === 'cash');
  const pending = data.settlements.filter(item=>item.remaining > 0).length;
  const received = data.repayments.filter(item=>!item.void && item.paid_on.startsWith(data.today.slice(0,7))).reduce((sum,item)=>sum+item.amount,0);
  const activity = moneyActivities(data);
  const stats = [
    ['Customer dues',outstanding,`${data.customers.filter(item=>item.balance>0).length} outstanding accounts`,overdue ? overdue+' overdue' : '', 'dues'],
    ['Bank receipts pending',digital.reduce((sum,item)=>sum+item.remaining,0),`${digital.filter(item=>item.remaining>0).length} UPI / card settlements`,'','bank'],
    ['Cash to deposit',cash.reduce((sum,item)=>sum+item.remaining,0),`${cash.filter(item=>item.remaining>0).length} pending deposits`,'','cash'],
    ['Customer payments',received,'Received this month','','received'],
  ];
  shell(`<div class="money-heading"><div>${heading('', 'Money', 'Stay on top of dues, receipts and deposits.')}</div><div class="money-heading-actions">
      <button id="money-add-customer" class="secondary" type="button">+ Add customer</button>
      <button id="money-record-payment" class="primary" type="button" ${data.customers.some(item=>item.balance>0) ? '' : 'disabled title="There are no outstanding customer balances"'}>+ Record payment</button>
    </div></div>
    <div class="money-stats">${stats.map(([label,value,caption,flag,tone])=>`<section class="money-stat ${tone}" aria-label="${label}"><div><span>${label}</span>${flag ? moneyBadge(flag,'warning') : ''}</div><strong>${money(value)}</strong><small>${caption}</small></section>`).join('')}</div>
    ${data.unallocated_credit ? `<div class="money-allocation-alert"><div>${navigationIcon('exceptions')}<span><strong>${money(data.unallocated_credit)} needs a customer</strong><span>Assign credit sales before recording a payment.</span></span></div><button id="money-allocate" type="button" class="text-button">Assign credit ${icon('arrow')}</button></div>` : ''}
    <section class="money-workspace" aria-label="Money workspace">
      <div class="money-workspace-top"><div class="money-tabs" role="tablist" aria-label="Money sections">${[['customers','Customers',data.customers.length],['banking','Banking',pending],['activity','Activity',activity.length]].map(([key,label,count])=>`<button id="money-tab-${key}" role="tab" type="button" aria-selected="${moneyView.tab===key}" aria-controls="money-panel-${key}" tabindex="${moneyView.tab===key ? 0 : -1}">${label}<span class="tab-count">${count}</span></button>`).join('')}</div><button id="money-help" type="button" class="text-button money-help">How this works</button></div>
      <div id="money-panel-customers" role="tabpanel" aria-labelledby="money-tab-customers" ${moneyView.tab==='customers' ? '' : 'hidden'}>
        <div class="money-toolbar"><h2>Customer accounts <span id="money-customer-count"></span></h2><div class="money-tools">${moneySearch('money-customer-search','Search customers',moneyView.customerSearch)}<label><span class="sr-only">Customer status</span><select id="money-customer-filter">${moneyOptions([['all','All customers'],['outstanding','With dues'],['overdue','Overdue']],moneyView.customerFilter)}</select></label></div></div>
        ${data.customers.length ? `<div class="table-scroll money-table-wrap" id="money-customer-table"><table class="money-table"><thead><tr><th>Customer</th><th>Payment due</th><th class="numeric">Credit sales</th><th class="numeric">Received</th><th class="numeric">Outstanding</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${data.customers.map((item,index)=>`<tr data-money-customer="${index}" data-search="${safe(item.name.toLocaleLowerCase())}" data-overdue="${Boolean(item.overdue)}" data-outstanding="${item.balance>0}"><th scope="row"><button class="money-account" id="money-customer-${index}" type="button" aria-label="Open account for ${safe(item.name)}"><span class="money-avatar" aria-hidden="true">${safe(Array.from(item.name)[0].toUpperCase())}</span><span>${safe(item.name)}<small>${item.overdue ? 'Overdue · ' : ''}${item.transactions.filter(row=>row.type !== 'Repayment').length} credit ${item.transactions.filter(row=>row.type !== 'Repayment').length===1 ? 'entry' : 'entries'}</small></span></button></th><td>${item.overdue ? moneyBadge('Overdue','warning')+'<small>'+safe(item.due_date)+'</small>' : safe(item.due_date || 'Not set')}</td><td class="numeric">${money(item.sales)}</td><td class="numeric money-muted">${money(item.repaid)}</td><td class="numeric"><strong>${money(item.balance)}</strong></td><td class="money-row-action"><button id="money-pay-${index}" class="text-button" type="button">${item.balance>0 ? 'Record payment' : 'View account'}</button></td></tr>`).join('')}</tbody></table></div><div id="money-no-customers" hidden>${moneyEmpty('No matching customers','Try another name or change the status filter.')}</div>` : moneyEmpty('Your credit customers, in one place','Add a customer to start tracking what they owe.','<button id="money-first-customer" class="primary" type="button">+ Add your first customer</button>')}
      </div>
      <div id="money-panel-banking" role="tabpanel" aria-labelledby="money-tab-banking" ${moneyView.tab==='banking' ? '' : 'hidden'}>
        <div class="money-toolbar"><h2>Settlements &amp; deposits <span id="money-bank-count"></span></h2><div class="money-tools"><label><span class="sr-only">Banking status</span><select id="money-bank-filter">${moneyOptions([['pending','Pending'],['all','All receipts'],['completed','Completed']],moneyView.bankFilter)}</select></label><label><span class="sr-only">Payment method</span><select id="money-method-filter">${moneyOptions([['all','All methods'],['upi','UPI'],['card','Card'],['cash','Cash']],moneyView.method)}</select></label></div></div>
        ${data.settlements.length ? `<div class="table-scroll money-table-wrap" id="money-bank-table"><table class="money-table"><thead><tr><th>Source</th><th>Method</th><th class="numeric">Expected</th><th class="numeric">Received</th><th class="numeric">Fees</th><th class="numeric">Pending</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${data.settlements.map((item,index)=>`<tr data-money-bank="${index}" data-pending="${item.remaining>0}" data-method="${item.method}"><th scope="row"><button id="money-bank-source-${index}" type="button" class="money-source-link" aria-label="Open ${safe(item.label)} ${safe(methodNames[item.method])} receipt">${safe(item.label)}<small class="money-mobile-line">${safe(methodNames[item.method])} · Open receipt ↗</small></button></th><td>${moneyBadge(methodNames[item.method])}</td><td class="numeric">${money(item.expected)}</td><td class="numeric money-muted">${money(item.banked)}</td><td class="numeric money-muted">${money(item.fees)}</td><td class="numeric"><strong>${money(item.remaining)}</strong></td><td class="money-row-action"><button id="money-bank-${index}" class="text-button" type="button">${item.remaining>0 ? item.method==='cash' ? 'Record deposit' : 'Record settlement' : 'View receipts'}</button></td></tr>`).join('')}</tbody></table></div><div id="money-no-banks" hidden>${moneyEmpty('You’re all caught up','No receipts match this view.')}</div>` : moneyEmpty('No receipts to reconcile yet','UPI, card and cash totals appear here after a shift is submitted.')}
      </div>
      <div id="money-panel-activity" role="tabpanel" aria-labelledby="money-tab-activity" ${moneyView.tab==='activity' ? '' : 'hidden'}>
        <div class="money-toolbar"><h2>Recent activity <span id="money-activity-count"></span></h2><div class="money-tools">${moneySearch('money-activity-search','Search reference or customer',moneyView.activitySearch)}<label><span class="sr-only">Entry status</span><select id="money-activity-filter">${moneyOptions([['all','All entries'],['recorded','Recorded'],['void','Voided']],moneyView.activityFilter)}</select></label></div></div>
        ${activity.length ? `<div class="table-scroll money-table-wrap" id="money-activity-table"><table class="money-table"><thead><tr><th>Date</th><th>Entry</th><th>Reference</th><th class="numeric">Amount</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${activity.map((item,index)=>`<tr data-money-activity="${index}" data-search="${safe((item.reference+' '+item.party).toLocaleLowerCase())}" data-void="${Boolean(item.void)}"><td>${safe(item.date)}</td><th scope="row"><button id="money-activity-source-${index}" type="button" class="money-source-link" aria-label="Open entry ${safe(item.reference)}">${item.title}<small>${safe(item.party)}</small><small class="money-mobile-line">${safe(item.reference)} · ${safe(item.date)} · ${item.void ? 'Voided' : 'Recorded'}</small></button></th><td>${safe(item.reference)}</td><td class="numeric"><strong>${money(item.amount)}</strong></td><td>${moneyBadge(item.void ? 'Voided' : 'Recorded',item.void ? 'neutral' : 'positive')}</td><td><button id="money-activity-${index}" class="text-button" type="button">View entry</button></td></tr>`).join('')}</tbody></table></div><div id="money-no-activity" hidden>${moneyEmpty('No matching entries','Try another reference or change the status filter.')}</div>` : moneyEmpty('Your money trail starts here','Recorded payments, settlements and deposits will appear in this list.')}
      </div>
      <footer class="money-panel-footer"><span>All dates · Amounts in INR</span><span>Updated ${safe(timestamp(new Date().toISOString()))}</span><button id="money-mobile-help" class="text-button" type="button">Money help</button></footer>
    </section><dialog id="money-dialog" aria-labelledby="money-dialog-title"></dialog>`, 'money');
  listen('money-add-customer',()=>openCustomerForm(data));
  if (!data.customers.length) listen('money-first-customer',()=>openCustomerForm(data));
  listen('money-record-payment',()=>openPaymentForm(data));
  listen('money-help',()=>openMoneyHelp());
  listen('money-mobile-help',()=>openMoneyHelp());
  if (data.unallocated_credit) listen('money-allocate',()=>openAllocationForm(data));
  for (const key of ['customers','banking','activity']) {
    listen('money-tab-'+key,()=>selectMoneyTab(key));
    document.getElementById('money-tab-'+key).addEventListener('keydown',event=>{
      const keys=['customers','banking','activity']; let index=keys.indexOf(key);
      if (!['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) return;
      event.preventDefault(); index=event.key==='Home' ? 0 : event.key==='End' ? 2 : (index+(event.key==='ArrowRight' ? 1 : 2))%3;
      selectMoneyTab(keys[index]); document.getElementById('money-tab-'+keys[index]).focus();
    });
  }
  for (const [id,key,event] of [['money-customer-search','customerSearch','input'],['money-customer-filter','customerFilter','change'],['money-bank-filter','bankFilter','change'],['money-method-filter','method','change'],['money-activity-search','activitySearch','input'],['money-activity-filter','activityFilter','change']]) listen(id,e=>{moneyView[key]=e.target.value;filterMoneyRows();},event);
  data.customers.forEach((item,index)=>{listen('money-customer-'+index,()=>openCustomerAccount(data,item));listen('money-pay-'+index,()=>item.balance>0 ? openPaymentForm(data,item) : openCustomerAccount(data,item));});
  data.settlements.forEach((item,index)=>{listen('money-bank-'+index,()=>openBankForm(data,item));listen('money-bank-source-'+index,()=>openBankForm(data,item));});
  activity.forEach((item,index)=>{listen('money-activity-'+index,()=>openMoneyEntry(data,item));listen('money-activity-source-'+index,()=>openMoneyEntry(data,item));});
  filterMoneyRows();
}

function selectMoneyTab(key) {
  moneyView.tab=key;
  for (const name of ['customers','banking','activity']) {
    const tab=document.getElementById('money-tab-'+name);tab.setAttribute('aria-selected',String(name===key));tab.tabIndex=name===key ? 0 : -1;
    document.getElementById('money-panel-'+name).hidden=name!==key;
  }
}
function filterMoneyRows() {
  const groups=[['customer',row=>row.dataset.search.includes(moneyView.customerSearch.trim().toLocaleLowerCase()) && (moneyView.customerFilter==='all' || row.dataset[moneyView.customerFilter]==='true'),'customers'],
    ['bank',row=>(moneyView.bankFilter==='all' || row.dataset.pending===String(moneyView.bankFilter==='pending')) && (moneyView.method==='all' || row.dataset.method===moneyView.method),'banks'],
    ['activity',row=>row.dataset.search.includes(moneyView.activitySearch.trim().toLocaleLowerCase()) && (moneyView.activityFilter==='all' || row.dataset.void===String(moneyView.activityFilter==='void')),'activity']];
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
  listen('money-dialog-close',()=>dialog.close());dialog.showModal();dialog.querySelector('input:not([readonly]),select,textarea')?.focus();return dialog;
}
function bindMoneyForm(id,route,extra={},message='Saved successfully.') {
  bindForm(id,async form=>{await api(route,{...fields(form),...extra});await openBusiness('money');showBusinessNotice(message);document.getElementById('money-tab-'+moneyView.tab).focus({preventScroll:true});});
}
function openCustomerForm(data,customer=null) {
  moneyDialog(customer ? 'Set payment due date' : 'Add customer',`<form id="money-customer-form" class="money-form"><label>Customer / account name<input name="name" value="${safe(customer?.name || '')}" required maxlength="150" ${customer ? 'readonly' : 'autocomplete="organization"'}></label>${businessDate('Payment due date (optional)','due_date',customer?.due_date || '',false)}${errorbox}<button class="primary">Save customer</button></form>`);
  bindMoneyForm('money-customer-form','/customers',{},'Customer saved.');
}
function openCustomerAccount(data,item) {
  moneyDialog(item.name,`<div class="money-account-balance"><span>Outstanding balance</span><strong>${money(item.balance)}</strong>${item.overdue ? moneyBadge('Overdue','warning') : ''}</div>
    <div class="money-account-actions"><button id="money-account-payment" class="primary" type="button" ${item.balance>0 ? '' : 'disabled'}>Record payment</button><button id="money-account-export" class="secondary" type="button">Export statement</button><button id="money-account-due" class="text-button" type="button">Set due date</button></div>
    <dl class="money-account-summary"><div><dt>Credit sales</dt><dd>${money(item.sales)}</dd></div><div><dt>Payments received</dt><dd>${money(item.repaid)}</dd></div><div><dt>Payment due</dt><dd>${safe(item.due_date || 'Not set')}</dd></div></dl>
    <h3>Account activity</h3><div class="table-scroll"><table class="money-table"><thead><tr><th>Date</th><th>Entry</th><th class="numeric">Amount</th></tr></thead><tbody>${item.transactions.map(row=>`<tr><td>${safe(row.date)}</td><td>${safe(row.type)}<small>${safe(row.reference)}${row.note ? ' · '+safe(row.note) : ''}</small></td><td class="numeric">${money(row.amount)}</td></tr>`).join('')}</tbody></table></div>`,true);
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
  moneyDialog('Assign credit to a customer',`<p class="money-dialog-intro">These credit sales need a customer name.</p><form id="money-allocation-form" class="money-form"><label>Shift<select name="shift_id" required>${data.unallocated_shifts.map(item=>`<option value="${item.shift_id}">Shift #${item.shift_id} · ${money(item.remaining)} to assign</option>`).join('')}</select></label><label>Customer / account name<input name="name" list="money-account-names" required maxlength="150"></label><datalist id="money-account-names">${data.customers.map(item=>`<option value="${safe(item.name)}"></option>`).join('')}</datalist>${numberField('Credit amount to assign (₹)','amount',{required:true,min:0.01})}${businessText('Unique allocation reference','reference')}${errorbox}<button class="primary">Assign credit</button></form>`);
  const form=document.getElementById('money-allocation-form');const update=()=>{form.elements.amount.max=data.unallocated_shifts.find(item=>item.shift_id===Number(form.elements.shift_id.value)).remaining/100;};form.elements.shift_id.addEventListener('change',update);update();
  bindForm('money-allocation-form',async form=>{const values=fields(form);await api('/credit-allocations',{...values,shift_id:Number(values.shift_id)});await openBusiness('money');showBusinessNotice('Credit assigned to customer.');});
}
function openMoneyEntry(data,item) {
  moneyDialog(item.title,`<div class="money-account-balance"><span>${safe(item.reference)}</span><strong>${money(item.amount)}</strong>${moneyBadge(item.void ? 'Voided' : 'Recorded',item.void ? 'neutral' : 'positive')}</div><dl class="money-entry-details"><div><dt>Date</dt><dd>${safe(item.date)}</dd></div><div><dt>Customer / source</dt><dd>${safe(item.party)}</dd></div><div><dt>Method</dt><dd>${safe(methodNames[item.method] || 'Bank')}</dd></div><div><dt>Recorded by</dt><dd>${safe(item.actor)}</dd></div><div><dt>Recorded at</dt><dd>${timestamp(item.created_at)}</dd></div>${item.fees ? `<div><dt>Fees</dt><dd>${money(item.fees)}</dd></div>` : ''}${item.note ? `<div><dt>Note</dt><dd>${safe(item.note)}</dd></div>` : ''}</dl>${item.void ? `<div class="money-void-note"><strong>Void reason</strong><p>${safe(item.void.reason)}</p><small>${safe(item.void.actor)} · ${timestamp(item.void.created_at)}</small></div>` : '<button id="money-void-entry" class="text-button money-danger" type="button">Void this entry</button>'}`,true);
  if(!item.void)listen('money-void-entry',()=>{
    moneyDialog('Void this entry?',`<p class="money-dialog-intro">${safe(item.reference)} · ${money(item.amount)}. The original entry stays in history and its balance is restored.</p><form id="money-void-form" class="money-form">${businessNote('Reason for voiding this entry','reason',true)}${errorbox}<button class="primary money-danger-button">Void entry</button></form>`);
    bindMoneyForm('money-void-form','/money-records/'+item.kind+'/'+item.id+'/void',{},'Entry voided. Original retained in history.');
  });
}
function openMoneyHelp() {
  moneyDialog('How Money works',`<div class="money-help-content"><section><h3>Customer dues</h3><p>Credit sales from submitted shifts create customer balances. Record payments here to reduce what a customer owes.</p></section><section><h3>Banking</h3><p>Match UPI and card collections to confirmed bank receipts. Enter the net receipt and any fees separately. Cash stays pending until a deposit is recorded.</p></section><section><h3>Keep payments separate</h3><p>Customer payments here are separate from fuel sales. Don’t enter the same payment again in a shift’s collections or cash count.</p></section><section><h3>Correct a mistake</h3><p>Open an entry in Activity and void it with a reason, then enter its replacement with a new reference. The original remains in history.</p></section></div>`);
}
