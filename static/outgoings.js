"use strict";

const outgoingView = {payroll:'salaries',payables:'bills'};
let outgoingData, outgoingPage;
const outgoingLabels = {salary:'Salary payment',bill:'Bill payment',advance:'Staff advance',advance_return:'Advance returned'};
const outgoingStaff = id => outgoingData.staff.find(s=>s.id===id);
const outgoingParty = row => row.payee || outgoingStaff(row.staff_id)?.name || outgoingData.bills.find(b=>b.id===row.bill_id)?.payee || '';
const outgoingText = (label,name,value='',required=true) => `<label>${label}<input name="${name}" value="${safe(value)}" maxlength="150" ${required?'required':''}></label>`;
const outgoingAmount = (label,name,value='',zero=false) => numberField(label,name,{required:true,min:zero?0:0.01,value:value===''?'':(value/100).toFixed(2)});
const outgoingNote = () => '<label>Note (optional)<textarea name="note" maxlength="500" rows="2"></textarea></label>';
const outgoingButton = (action,id,label,style='text-button',accessibleName='') => `<button type="button" class="${style}" data-action="${action}" data-id="${id}"${accessibleName ? ` aria-label="${safe(accessibleName)}"` : ''}>${label}</button>`;
const outgoingStatus = row => row.voided_at ? moneyBadge('Voided') : row.balance===0 ? moneyBadge('Paid','positive') : row.overdue ? moneyBadge('Overdue','warning') : moneyBadge(row.paid?'Part paid':'Unpaid');

function openOutgoings(page, afterRender) {
  return loadOwnerView('/' + page, data => {
    outgoingPage = page;
    outgoingData = data;
    renderOutgoings();
    afterRender?.();
  });
}
function renderOutgoings() {
  const d=outgoingData, payroll=outgoingPage==='payroll', tab=outgoingView[outgoingPage];
  const salaries=d.salaries.filter(s=>!s.voided_at), bills=d.bills.filter(b=>!b.voided_at);
  const entries=d.entries.filter(e=>(payroll?e.kind!=='bill':e.kind==='bill'));
  const paid=entries.filter(e=>!e.voided_at && e.kind===(payroll?'salary':'bill') && e.paid_on.startsWith(d.today.slice(0,7))).reduce((s,e)=>s+e.amount,0);
  const stats=payroll ? [['Salary to pay',salaries.reduce((s,r)=>s+r.balance,0),'Unpaid salary balances'],['Advances to recover',d.staff.reduce((s,r)=>s+r.advance_balance,0),'Outstanding staff advances'],['Salaries paid',paid,'This month'],['Active staff',d.staff.filter(s=>s.active).length,'On the staff register',true]] :
    [['Bills to pay',bills.reduce((s,r)=>s+r.balance,0),'All unpaid bills'],['Overdue bills',bills.filter(r=>r.overdue).reduce((s,r)=>s+r.balance,0),'Past the due date'],['Due in 7 days',bills.filter(r=>r.due_date>=d.today && Date.parse(r.due_date)-Date.parse(d.today)<=7*86400000).reduce((s,r)=>s+r.balance,0),'Including today'],['Bills paid',paid,'This month']];
  const tabs=payroll?[['salaries','Salaries'],['advances','Advances'],['staff','Staff'],['activity','Activity']]:[['bills','Bills'],['activity','Activity']];
  shell(`<div class="money-heading"><div>${heading('',payroll?'Payroll':'Payables',payroll?'Staff salaries, advances and payment history.':'Supplier invoices and everyday business bills.')}</div><div class="money-heading-actions">${outgoingButton('automation',0,'Recurring drafts','secondary')}${payroll?outgoingButton('staff-new',0,'+ Add staff','secondary')+outgoingButton('advance-new',0,'+ Staff advance','secondary')+outgoingButton('salary-new',0,'+ Add salary','primary'):outgoingButton('bill-new',0,'+ Add bill','primary')}</div></div>
    <div class="money-stats">${stats.map(([label,value,caption,count])=>`<section class="money-stat"><div><span>${label}</span></div><strong>${count?value:money(value)}</strong><small>${caption}</small></section>`).join('')}</div>
    <section class="money-workspace outgoing-workspace" aria-label="${payroll?'Payroll':'Payables'} workspace"><div class="money-workspace-top"><div class="money-tabs" role="tablist" aria-label="${payroll?'Payroll':'Payables'} sections">${tabs.map(([id,label])=>`<button type="button" role="tab" id="out-tab-${id}" aria-controls="out-panel" aria-selected="${tab===id}" tabindex="${tab===id?0:-1}" data-tab="${id}">${label}</button>`).join('')}</div>${outgoingButton('help',0,'How this works')}</div>
    <div role="tabpanel" id="out-panel" aria-labelledby="out-tab-${tab}"><div class="money-toolbar"><h2>${tabs.find(t=>t[0]===tab)[1]}</h2><div class="money-tools">${moneySearch('out-search','Search names or references','')}<label><span class="sr-only">Record status</span><select id="out-status"><option value="all">All records</option>${tab==='staff'?'<option value="active">Active</option><option value="inactive">Inactive</option>':tab==='advances'?'<option value="outstanding">Outstanding</option>':tab==='activity'?'<option value="recorded">Recorded</option><option value="void">Voided</option>':'<option value="outstanding">Unpaid</option><option value="overdue">Overdue</option><option value="paid">Paid</option><option value="void">Voided</option>'}</select></label></div></div>
    ${outgoingTable(tab,entries)}<div id="out-no-match" hidden>${moneyEmpty('No matching records','Try another search or status.')}</div></div>
    <footer class="money-panel-footer"><span>Amounts in INR · All dates</span><span>Recorded payments only</span></footer></section>`,outgoingPage);
  document.querySelectorAll('[data-tab]').forEach(button=>{
    button.addEventListener('click',()=>{outgoingView[outgoingPage]=button.dataset.tab;renderOutgoings();document.querySelector('#out-tab-'+button.dataset.tab).focus();});
    button.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const i=tabs.findIndex(t=>t[0]===button.dataset.tab);const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;outgoingView[outgoingPage]=tabs[next][0];renderOutgoings();document.querySelector('#out-tab-'+tabs[next][0]).focus();});
  });
  bindOutgoingActions();
  listen('out-search',filterOutgoingRows,'input');listen('out-status',filterOutgoingRows,'change');
}
function outgoingTable(tab,entries) {
  const d=outgoingData;
  const rows=tab==='salaries'?d.salaries:tab==='bills'?d.bills:tab==='activity'?entries:d.staff;
  if(!rows.length)return moneyEmpty(tab==='staff'?'Add your first staff member':tab==='salaries'?'No salaries prepared':tab==='bills'?'No bills to pay yet':tab==='advances'?'No staff advances yet':'No payments recorded',tab==='staff'?'Set a monthly salary to prepare future salary records.':tab==='salaries'?'Add a salary month when the amount earned is ready.':tab==='bills'?'Add a supplier invoice or another business bill.':'Your records will appear here.');
  let heads, body;
  if(tab==='salaries'||tab==='bills'){
    const salary=tab==='salaries';heads=[salary?'Staff / month':'Payee / bill','Due date',salary?'Earned':'Bill amount',salary?'Advance applied':'Paid','To pay','Status',''];
    body=rows.map(row=>{
      const party=outgoingParty(row);
      const reference=row.period||row.reference;
      const detail=salary?'salary-detail':'bill-detail';
      const shareLabel=!salary&&!row.voided_at ? `Share bill ${row.reference} for ${party} on WhatsApp` : '';
      return `<tr ${outgoingRowData(row,party+' '+reference)}>
        <th scope="row">
          ${outgoingButton(detail,row.id,safe(party),'money-source-link')}
          <small>${safe(reference)}${salary?'':' · '+safe(row.kind)}</small>
          <small class="outgoing-mobile-status">${row.voided_at?'Voided':row.balance===0?'Paid':row.overdue?'Overdue':row.paid?'Part paid':'Unpaid'}</small>
          ${shareLabel ? outgoingButton('bill-share',row.id,'WhatsApp','text-button bill-share-mobile',shareLabel) : ''}
        </th>
        <td>${safe(row.due_date)}</td><td class="numeric">${money(row.amount)}</td>
        <td class="numeric">${money(salary?row.advance_applied:row.paid)}</td>
        <td class="numeric"><strong>${money(row.balance)}</strong></td><td>${outgoingStatus(row)}</td>
        <td><div class="outgoing-row-actions">
          ${outgoingButton(detail,row.id,row.balance?'Pay / details':'Details')}
          ${shareLabel ? outgoingButton('bill-share',row.id,'WhatsApp','text-button',shareLabel) : ''}
        </div></td>
      </tr>`;
    }).join('');
  }else if(tab==='staff'||tab==='advances'){
    heads=['Staff','Role',tab==='staff'?'Monthly salary':'Advance balance','Status',''];
    body=rows.map(r=>`<tr ${outgoingRowData({...r,balance:r.advance_balance},r.name+' '+r.code)}><th scope="row">${outgoingButton('staff-edit',r.id,safe(r.name),'money-source-link')}<small>${safe(r.code)}</small></th><td>${safe(r.job_title||'—')}</td><td class="numeric"><strong>${money(tab==='staff'?r.monthly_salary:r.advance_balance)}</strong></td><td>${moneyBadge(r.active?'Active':'Inactive',r.active?'positive':'neutral')}</td><td>${tab==='staff'?outgoingButton('staff-edit',r.id,'Edit staff'):r.advance_balance?outgoingButton('advance-return',r.id,'Record return'):outgoingButton('advance-new',r.id,'Give advance')}</td></tr>`).join('');
  }else{
    heads=['Payment / reference','Date','Method','Amount','Status',''];
    body=rows.map(r=>`<tr ${outgoingRowData(r,outgoingParty(r)+' '+r.reference)}><th scope="row">${outgoingButton('entry-detail',r.id,safe(outgoingParty(r)),'money-source-link')}<small>${safe(outgoingLabels[r.kind])} · ${safe(r.reference)}</small></th><td>${safe(r.paid_on)}</td><td>${safe(r.method)}</td><td class="numeric"><strong>${money(r.amount)}</strong></td><td>${moneyBadge(r.voided_at?'Voided':'Recorded',r.voided_at?'neutral':'positive')}</td><td>${outgoingButton('entry-detail',r.id,'Details')}</td></tr>`).join('');
  }
  return `<div class="table-scroll outgoing-table"><table class="money-table"><thead><tr>${heads.map((h,i)=>`<th${((tab==='salaries'||tab==='bills')&&[2,3,4].includes(i)||(tab==='staff'||tab==='advances')&&i===2||tab==='activity'&&i===3)?' class="numeric"':''}>${h||'<span class="sr-only">Actions</span>'}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function outgoingRowData(r,search){return `data-out-row data-search="${safe(search.toLocaleLowerCase())}" data-void="${Boolean(r.voided_at)}" data-balance="${r.balance??0}" data-overdue="${Boolean(r.overdue)}" data-active="${Boolean(r.active)}"`;}
function filterOutgoingRows(){
  const query=document.querySelector('#out-search').value.trim().toLocaleLowerCase(),status=document.querySelector('#out-status').value;
  let shown=0;document.querySelectorAll('[data-out-row]').forEach(row=>{const d=row.dataset;row.hidden=!(d.search.includes(query)&&(status==='all'||status==='void'&&d.void==='true'||status==='active'&&d.active==='true'||status==='inactive'&&d.active==='false'||d.void==='false'&&(status==='recorded'||status==='outstanding'&&Number(d.balance)>0||status==='paid'&&Number(d.balance)===0||status==='overdue'&&d.overdue==='true')));if(!row.hidden)shown++;});
  document.querySelector('#out-no-match').hidden=shown>0||!document.querySelector('[data-out-row]');
}
function outgoingForm(title,content,route,extra={},button='Save record'){
  const dialog=moneyDialog(title,`<form id="out-form" class="money-form">${content}${errorbox}<button class="primary">${button}</button></form>`);
  bindForm('out-form',async form=>{const body={...fields(form),...extra};for(const key of ['id','staff_id','source_id'])if(key in body)body[key]=Number(body[key]);if('active'in body)body.active=body.active==='true'||body.active===true;await api(route,body);await openOutgoings(outgoingPage);document.querySelector('main h1').focus({preventScroll:true});showBusinessNotice('Record saved.');});
  return dialog;
}
function staffOptions(selected,returns=false){return outgoingData.staff.filter(s=>s.active||returns&&s.advance_balance>0).map(s=>`<option value="${s.id}" ${s.id===selected?'selected':''}>${safe(s.name)} · ${safe(s.code)}</option>`).join('');}
function outgoingStaffForm(staff){
  outgoingForm(staff?'Edit staff':'Add staff',(staff ? outgoingText('Staff name','name',staff.name) : contactNameField('Staff name', 'name', '', {phoneField: 'phone'}))+outgoingText('Staff code','code',staff?.code||'STF-'+String(Math.max(0,...outgoingData.staff.map(s=>s.id))+1).padStart(3,'0'))+outgoingText('Job title (optional)','job_title',staff?.job_title,false)+outgoingText('Phone (optional)','phone',staff?.phone,false)+outgoingAmount('Monthly salary (₹)','monthly_salary',staff?.monthly_salary||0,true)+'<p class="money-form-hint">Used as the default for new salaries. Existing salary records keep their original amounts.</p>'+(staff?`<label>Staff status<select name="active"><option value="true" ${staff.active?'selected':''}>Active</option><option value="false" ${!staff.active?'selected':''}>Inactive</option></select></label>`:''),'/payroll/staff',staff?{id:staff.id}:{},'Save staff');
}
function outgoingSalaryForm(){
  const staff = outgoingData.staff.find(s => s.active);
  if (!staff) {
    moneyDialog('Add staff first', '<p>Add an active staff member before preparing a salary.</p><button id="salary-add-staff" class="primary" type="button">Add staff member</button>');
    listen('salary-add-staff', () => outgoingStaffForm());
    return;
  }
  const dialog=outgoingForm('Add salary',`<label>Staff member<select name="staff_id">${staffOptions(staff.id)}</select></label><div class="money-form-grid"><label>Salary month<input name="period" type="month" max="${outgoingData.today.slice(0,7)}" value="${outgoingData.today.slice(0,7)}" required></label>${businessDate('Payment due date','due_date',outgoingData.today)}</div>${outgoingAmount('Salary earned (₹)','amount',staff.monthly_salary)}${outgoingAmount('Apply advance (₹)','advance_applied',0,true)}<p class="money-form-hint" id="out-advance-hint"></p><div class="outgoing-net" id="out-net"></div>${outgoingNote()}`,'/payroll/salaries',{},'Add salary');
  const form=dialog.querySelector('form');const update=()=>{const person=outgoingStaff(Number(form.elements.staff_id.value));document.querySelector('#out-advance-hint').textContent=`${money(person.advance_balance)} in outstanding advances. Apply only the amount you want to recover this month.`;form.elements.advance_applied.max=(person.advance_balance/100).toFixed(2);document.querySelector('#out-net').textContent='Salary to pay: '+money(Math.round((Number(form.elements.amount.value)-Number(form.elements.advance_applied.value))*100));};form.elements.staff_id.addEventListener('change',()=>{form.elements.amount.value=(outgoingStaff(Number(form.elements.staff_id.value)).monthly_salary/100).toFixed(2);form.elements.advance_applied.value='0.00';update();});form.addEventListener('input',update);update();
}
function outgoingBillForm(){outgoingForm('Add bill',`<label>Bill type<select name="kind"><option value="supplier">Supplier invoice</option><option value="other">Other bill</option><option value="opening">Opening payable</option></select></label>${contactNameField('Supplier / payee', 'payee', '', {knownNames: outgoingData.bills.map(bill => bill.payee)})}${outgoingText('Invoice / bill reference','reference')}${outgoingAmount('Bill amount (₹)','amount')}<div class="money-form-grid">${businessDate('Bill date','bill_date',outgoingData.today)}${businessDate('Payment due date','due_date',outgoingData.today)}</div><label>Description<textarea name="note" rows="2" maxlength="500" required></textarea></label>`,'/payables/bills',{},'Add bill');}

function shareOutgoingBill(bill) {
  const message = [
    session.station,
    `Bill reference · ${bill.reference}`,
    `Payee · ${bill.payee}`,
    `Bill date · ${businessDay(bill.bill_date, 'medium')}`,
    `Payment due · ${businessDay(bill.due_date, 'medium')}`,
    `Bill amount · ${money(bill.amount)}`,
    `Paid · ${money(bill.paid)}`,
    `Balance due · ${money(bill.balance)}`,
    bill.note ? `\n${bill.note}` : '',
  ].filter(Boolean).join('\n');
  openWhatsAppComposer(message, 'Share bill on WhatsApp', bill.payee);
}
function outgoingPayment(kind,source){
  const advance=kind==='advance'||kind==='advance_return';
  if(advance&&!outgoingData.staff.some(s=>s.active||kind==='advance_return'&&s.advance_balance>0)){moneyDialog('Add staff first','<p>Add an active staff member before recording an advance.</p>');return;}
  const dialog=outgoingForm(outgoingLabels[kind],`${advance?`<label>Staff member<select name="source_id">${staffOptions(source?.id,kind==='advance_return')}</select></label><p id="out-payment-hint" class="money-form-hint"></p>`:`<div class="money-source"><span>${safe(outgoingParty(source))}</span><strong>${money(source.balance)} to pay</strong></div>`}${outgoingAmount(kind==='advance_return'?'Amount returned (₹)':'Amount paid (₹)','amount',advance?'':source.balance)}<div class="money-form-grid">${businessDate('Payment date','paid_on',outgoingData.today)}<label>Payment method<select name="method"><option value="bank">Bank / UPI</option><option value="cash">Cash</option></select></label></div>${outgoingText('Unique payment reference','reference')}${outgoingNote()}`,'/outgoings/payments',{kind,...(!advance?{source_id:source.id}:{})},kind==='advance_return'?'Record return':'Record payment');
  dialog.querySelector('[name=paid_on]').max=outgoingData.today;
  if(advance){const form=dialog.querySelector('form');const update=()=>{const staff=outgoingStaff(Number(form.elements.source_id.value));dialog.querySelector('#out-payment-hint').textContent=money(staff.advance_balance)+' outstanding in advances.';if(kind==='advance_return')form.elements.amount.max=(staff.advance_balance/100).toFixed(2);};form.elements.source_id.addEventListener('change',update);update();}
}
function outgoingDetail(kind,row){
  const entry=kind==='entry';const related=entry?[]:outgoingData.entries.filter(e=>e[kind==='salary'?'salary_id':'bill_id']===row.id);
  const actions = `<div class="outgoing-detail-actions">
    ${!entry&&row.balance ? outgoingButton(kind+'-pay',row.id,'Record payment','primary') : ''}
    ${kind==='bill' ? outgoingButton('bill-share',row.id,'Share on WhatsApp','secondary') : ''}
    ${outgoingButton(kind+'-void',row.id,'Void this record','text-button money-danger')}
  </div>`;
  moneyDialog(entry?outgoingLabels[row.kind]:kind==='salary'?'Salary details':'Bill details',`<div class="money-account-balance"><span>${safe(outgoingParty(row))} · ${safe(row.period||row.reference)}</span><strong>${money(entry?row.amount:row.balance)}</strong>${entry?moneyBadge(row.voided_at?'Voided':'Recorded'):outgoingStatus(row)}</div><dl class="money-entry-details">${(entry?[['Payment date',row.paid_on],['Method',row.method],['Reference',row.reference]]:[['Original amount',money(row.amount)],...(kind==='salary'?[['Advance recovered',money(row.advance_applied)],['Net salary',money(row.net)]]:[['Bill date',row.bill_date],['Bill type',row.kind]]),['Paid',money(row.paid)],['Payment due',row.due_date]]).concat([['Note',row.note||'—'],['Recorded at',timestamp(row.created_at)],['Recorded by',row.actor]]).map(([k,v])=>`<div><dt>${k}</dt><dd>${safe(v)}</dd></div>`).join('')}</dl>
  ${row.voided_at?`<div class="money-void-note"><strong>Void reason</strong><p>${safe(row.void_reason)}</p><small>${safe(timestamp(row.voided_at))} · ${safe(row.void_actor)}</small></div>`:actions}
  ${related.length?`<h3>Payment history</h3><ul class="outgoing-history">${related.map(e=>`<li>${outgoingButton('entry-detail',e.id,safe(e.reference))}<span>${money(e.amount)} · ${e.voided_at?'Voided':safe(e.paid_on)}</span></li>`).join('')}</ul>`:''}`,true);
  bindOutgoingActions(document.querySelector('#money-dialog'));
}
function bindOutgoingActions(scope=document){scope.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>{
  const action=button.dataset.action,id=Number(button.dataset.id),d=outgoingData;
  if(action==='automation')return openAutomation('recurring');
  if(action==='staff-new')return outgoingStaffForm();if(action==='staff-edit')return outgoingStaffForm(outgoingStaff(id));if(action==='salary-new')return outgoingSalaryForm();if(action==='bill-new')return outgoingBillForm();if(action==='advance-new')return outgoingPayment('advance',outgoingStaff(id));if(action==='advance-return')return outgoingPayment('advance_return',outgoingStaff(id));
  if(action==='help'){moneyDialog('How '+(outgoingPage==='payroll'?'Payroll':'Payables')+' works',`<div class="money-help-content">${outgoingPage==='payroll'?'<section><h3>Salaries and advances</h3><p>Add staff separately from manager sign-ins. Prepare one earned salary per staff member per month. Monthly salary is a starting amount; enter the actual salary earned.</p></section><section><h3>Recovering advances</h3><p>An advance stays outstanding until returned or applied to a salary. Apply advance when adding a salary to reduce the amount left to pay. No deductions or taxes are calculated automatically.</p></section>':'<section><h3>Supplier and other bills</h3><p>Add the amount owed, bill reference and due date. Record each payment to reduce the balance. Partial payments stay outstanding.</p></section>'}<section><h3>Recorded payments</h3><p>This is a record of payments you have already made. It does not transfer money or change shift cash, fuel sales or customer receipts.</p></section><section><h3>Correct a record</h3><p>Open a record and void it with a reason. Void linked payments before voiding a salary or bill. Reverse advance recovery or returns before voiding a used advance. Originals stay in history.</p></section></div>`);return;}
  const [kind,verb]=action.split('-'),row=(kind==='salary'?d.salaries:kind==='bill'?d.bills:d.entries).find(r=>r.id===id);
  if(!row)return;
  if(action==='bill-share'&&!row.voided_at)return shareOutgoingBill(row);
  if(verb==='detail')return outgoingDetail(kind,row);if(verb==='pay')return outgoingPayment(kind,row);if(verb==='void')return outgoingForm('Void record',`<p class="money-form-hint">The original remains in history. Its balance will be reversed.</p><label>Reason for voiding<textarea name="reason" rows="3" maxlength="500" required></textarea></label>`,`/outgoings/${kind}/${id}/void`,{},'Void record');
}));}
