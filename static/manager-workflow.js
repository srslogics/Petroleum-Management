"use strict";

let stopManagerDraft = null;
let saveManagerDraftBeforeLogout = null;
const managerMethods = {cash:'Cash',upi:'UPI',card:'Card'};
const managerDenominations = [500,200,100,50,20,10,5,2,1];
const managerDraftKey = active => `tuljai-draft:${session.id}:${session.station_id}:${active.id}`;

function clearManagerDrafts(account) {
  const prefix = `tuljai-draft:${account.id}:${account.station_id}:`;
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch {
    // Some browsers disable session storage.
  }
}

function managerPayload(form,active) {
  const values=fields(form),byFuel=prefix=>Object.fromEntries(fuelNames.map(fuel=>[fuel,values[prefix+fuel]]));
  return {closings:Object.fromEntries(active.nozzles.map(n=>[n.id,values['closing_'+n.id]])),deliveries:byFuel('delivery_'),physical:byFuel('physical_'),
    collections:Object.fromEntries(Object.keys(managerMethods).map(key=>[key,values[key]])),expenses:values.expenses,counted:values.counted,
    expense_note:values.expense_note,shift_note:values.shift_note,entries:collectEntries(form)};
}
function managerDraftData(form){return {values:fields(form),entries:collectEntries(form)};}
function restoreManagerDraft(form,data){
  if(!data)return;
  for(const [name,value] of Object.entries(data.values||{}))if(form.elements[name])form.elements[name].value=value;
  for(const category of ['payments','deliveries','expenses']){
    const list=form.querySelector(`[data-entry-list="${category}"]`);list.innerHTML='';
    for(const row of (data.entries?.[category]||[]).slice(0,100)){
      list.insertAdjacentHTML('beforeend',entryRow(category));
      for(const input of list.lastElementChild.querySelectorAll('[data-field]'))input.value=row[input.dataset.field]||'';
    }
    if(list.children.length)list.closest('details')?.setAttribute('open','');
  }
  form.syncEntries();
}
function showManagerEntry(active){
  shell(`<div class="manager-heading"><div>${heading('Shift #'+active.id+' · '+businessDay(active.business_date),'Shift entries','Enter totals as you work. Review once before submitting.')}</div><div class="manager-draft"><span id="manager-save-status" role="status" aria-live="polite">Loading draft…</span><button id="manager-import-figures" type="button" class="text-button">Import figures</button><button id="manager-read-document" type="button" class="text-button">Read receipt / challan</button><button id="manager-save-now" type="button" class="text-button">Save now</button><button id="manager-load-draft" type="button" class="text-button" hidden>Load saved draft</button></div></div>
    <form id="close-shift" class="manager-entry-form"><div class="manager-entry-layout"><div class="manager-entry-main">
    <nav class="manager-entry-tabs" aria-label="Entry sections">${[['meters','Meters & stock'],['collections','Collections'],['deliveries','Deliveries'],['expenses','Expenses']].map(([id,label],i)=>`<button id="manager-tab-${id}" type="button" class="${i?'':'selected'}" aria-controls="manager-panel-${id}" ${i?'':'aria-current="true"'} data-manager-tab="${id}">${label}</button>`).join('')}</nav>
    <section id="manager-panel-meters" class="card manager-panel"><header class="section-head"><div><h2>Meter readings</h2><p>Enter the current closing reading for each nozzle.</p></div></header><div class="nozzle-list">${active.nozzles.map(n=>`<div class="nozzle-row"><div><strong>${safe(n.code)}</strong> ${fuelTag(n.fuel)}<small>Opening ${volume(n.opening)} · ${money(active.rates[n.fuel])} / L</small><small id="sold-${n.id}">Sold —</small></div>${numberField(n.code+' closing reading (L)','closing_'+n.id,{step:'0.001',min:decimal(n.opening,1000),required:true})}</div>`).join('')}</div>
    <div class="manager-stock"><h3>Physical closing stock <span class="quiet">(optional)</span></h3><div class="fuel-grid">${fuelNames.map(f=>numberField(f+' physical stock (L)','physical_'+f,{step:'0.001',placeholder:'Optional'})).join('')}</div></div></section>
    <section id="manager-panel-collections" class="card manager-panel" hidden><header class="section-head"><div><h2>Collections</h2><p>Enter shift totals. No individual customer details are needed.</p></div></header><div class="field-grid">${Object.entries(managerMethods).map(([key,label])=>numberField(label+' collected (₹)',key)).join('')}${numberField('Actual cash counted (₹)','counted',{required:true})}</div><button id="manager-count-cash" type="button" class="text-button">Count cash by denomination</button>
    <details class="manager-optional"><summary>Payment batch references (optional)</summary><p class="form-help">Use totals above, or enter every batch for a method here. Batch entries replace that method’s total.</p>${entrySection('payments','Payment batches','Cash, UPI or card batches only.')}</details></section>
    <section id="manager-panel-deliveries" class="card manager-panel" hidden><header class="section-head"><div><h2>Fuel deliveries</h2><p>Enter total litres delivered, or add each delivery below.</p></div></header><div class="fuel-grid">${fuelNames.map(f=>numberField(f+' delivered (L)','delivery_'+f,{step:'0.001'})).join('')}</div><details class="manager-optional"><summary>Supplier and challan details (optional)</summary>${entrySection('deliveries','Delivery entries','Detailed entries replace the total for that fuel.')}</details></section>
    <section id="manager-panel-expenses" class="card manager-panel" hidden><header class="section-head"><div><h2>Till expenses</h2><p>Record only expenses paid from this shift’s cash.</p></div></header>${numberField('Till expenses (₹)','expenses')}<label>Expense note (optional)<textarea name="expense_note" maxlength="250" rows="2"></textarea></label><details class="manager-optional"><summary>Individual expenses (optional)</summary>${entrySection('expenses','Expense entries','Detailed entries replace the expense total.')}</details><label>Shift note (optional)<textarea name="shift_note" maxlength="1000" rows="3" placeholder="Anything the owner should know"></textarea></label></section>
    </div><aside class="card reconciliation manager-totals"><h2>Shift totals</h2><dl class="key-values"><div><dt>Metered sales</dt><dd id="metered">—</dd></div><div><dt>Cash + UPI + card</dt><dd id="collections-total">—</dd></div><div><dt>Collections − sales</dt><dd id="collections-diff">—</dd></div></dl><p class="form-help">The owner handles credit and reconciles any difference.</p><dl class="key-values"><div><dt>Cash collected</dt><dd id="cash">—</dd></div><div><dt>Till expenses</dt><dd id="expenses">—</dd></div><div><dt>Expected cash</dt><dd id="expected">—</dd></div><div><dt>Counted cash</dt><dd id="counted">—</dd></div></dl><div class="result"><div><strong>Cash difference</strong><small>Counted − expected</small></div><output id="variance">—</output></div>${errorbox}<button class="primary">Review entries</button><p class="quiet submit-help">Reviewing won’t submit or lock your entries.</p></aside></div>
    <dialog id="manager-cash-dialog" aria-labelledby="manager-cash-title"><header class="money-dialog-header"><h2 id="manager-cash-title">Count cash</h2><button id="manager-cash-close" class="text-button" type="button" aria-label="Close cash counter">✕</button></header><div class="money-dialog-body"><div class="manager-cash-grid">${managerDenominations.map(value=>`<label>₹${value} × quantity<input name="cash_count_${value}" type="number" inputmode="numeric" step="1" min="0" max="1000000" placeholder="0"></label>`).join('')}</div>${numberField('Other cash (₹)','cash_count_other')}<div class="outgoing-net" id="manager-cash-total">₹0.00</div><button id="manager-cash-apply" type="button" class="primary">Use counted total</button><p class="form-error" role="alert" id="manager-cash-error"></p></div></dialog></form>
    <dialog id="money-dialog" aria-labelledby="money-dialog-title"></dialog>`);
  const form=document.querySelector('#close-shift');
  bindManagerEntries(form,active);
  const select=id=>{for(const button of document.querySelectorAll('[data-manager-tab]')){const current=button.dataset.managerTab===id;button.classList.toggle('selected',current);if(current)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');document.querySelector('#manager-panel-'+button.dataset.managerTab).hidden=!current;}};
  document.querySelectorAll('[data-manager-tab]').forEach(button=>button.addEventListener('click',()=>select(button.dataset.managerTab)));
  let handlingInvalid=false;
  form.addEventListener('invalid',event=>{if(handlingInvalid){event.preventDefault();return;}handlingInvalid=true;setTimeout(()=>handlingInvalid=false,0);const panel=event.target.closest('.manager-panel');if(event.target.closest('#manager-cash-dialog')&&!document.querySelector('#manager-cash-dialog').open)document.querySelector('#manager-cash-dialog').showModal();if(panel){select(panel.id.replace('manager-panel-',''));const details=event.target.closest('details');if(details)details.open=true;}},true);
  const saved=active.draft||{version:0,data:null};
  let local=null;try{local=JSON.parse(sessionStorage.getItem(managerDraftKey(active)));}catch{}
  const localDirty=Boolean(local?.dirty), localConflict=localDirty&&(local.version!==saved.version||local.conflict);
  const restore=localDirty?local.data:saved.data;
  restoreManagerDraft(form,restore);updatePreview(form,active);
  const draft=bindShiftDraft(form,active,saved,localDirty,localConflict);
  bindManagerCash(form);
  listen("manager-import-figures",()=>openShiftImports(active,form,draft));
  listen("manager-read-document",async()=>{automationData=await api("/automation");openDocumentReader({active,form,draft});});
  bindForm('close-shift',async()=>showManagerReview(form,active,draft));
}
function bindShiftDraft(form,active,saved,dirty,localConflict=false){
  let version=saved.version,changed=dirty,stopped=false,timer=null,inFlight=null,conflict=localConflict,failed=false;
  const status=document.querySelector('#manager-save-status'), key=managerDraftKey(active);
  let canMirror=true;
  const mirror = () => {
    try {
      if (changed) sessionStorage.setItem(key, JSON.stringify({version, data:managerDraftData(form), dirty:true, conflict}));
      else sessionStorage.removeItem(key);
    } catch {
      canMirror = false;
    }
  };
  const message=text=>{if(!stopped)status.textContent=text;};
  const capture=()=>JSON.stringify(managerDraftData(form));
  const save=async()=>{
    clearTimeout(timer);if(stopped||conflict||!changed)return;
    if(inFlight){await inFlight;if(changed&&!stopped&&!conflict)return save();return;}
    const data=capture();failed=false;message('Saving…');
    inFlight=(async()=>{try{
      const result=await api('/shifts/'+active.id+'/draft',{version,data:JSON.parse(data)});
      version=result.version;changed=capture()!==data;if(!stopped)mirror();message(changed?'Unsaved changes':'Saved '+timestamp(result.saved_at));
    }catch(error){failed=true;if(error.status===409){conflict=true;if(!stopped)mirror();if(!stopped)document.querySelector('#manager-load-draft')?.removeAttribute('hidden');message('Draft changed elsewhere. Load saved draft to continue.');}else message(canMirror?'Not saved online · kept in this tab. Retry save.':'Not saved. Keep this page open and retry.');
    }finally{inFlight=null;}})();
    await inFlight;if(changed&&!failed&&!conflict&&!stopped)timer=setTimeout(save,1500);
  };
  const edited=()=>{changed=true;mirror();message(conflict?'Draft changed elsewhere. Load saved draft to continue.':'Unsaved changes');clearTimeout(timer);timer=setTimeout(save,500);};
  form.addEventListener('input',edited);form.addEventListener('change',edited);
  listen('manager-save-now',save);
  listen('manager-load-draft',()=>{moneyDialog('Load saved entries?',`<p class="money-dialog-intro">This replaces the entries on this page with the latest saved draft. Your unsaved edits on this page will be discarded.</p><button id="manager-confirm-load" type="button" class="primary">Load saved draft</button>`);listen('manager-confirm-load',async()=>{const latest=await api('/shifts/'+active.id+'/draft');stopManagerDraft();try{sessionStorage.removeItem(key);}catch{}active.draft=latest;showManagerEntry(active);});});
  const unload=event=>{if(changed){mirror();event.preventDefault();event.returnValue='';}};
  window.addEventListener('beforeunload',unload);
  window.addEventListener('online',save);
  saveManagerDraftBeforeLogout = async () => {
    await save();
    return !changed;
  };
  stopManagerDraft=()=>{if(stopped)return;mirror();stopped=true;saveManagerDraftBeforeLogout=null;clearTimeout(timer);window.removeEventListener('beforeunload',unload);window.removeEventListener('online',save);};
  message(dirty?'Restored unsaved entries from this tab':saved.data?'Draft restored · '+timestamp(saved.saved_at):'Ready for entries');
  if(conflict){document.querySelector('#manager-load-draft').hidden=false;message('Draft changed elsewhere. Your local edits are kept. Load saved draft to continue.');}
  else if(dirty)timer=setTimeout(save,500);
  return {save,version:()=>version,isDirty:()=>changed,conflicted:()=>conflict,finish:()=>{changed=false;stopManagerDraft();try{sessionStorage.removeItem(key);}catch{}}};
}
function bindManagerCash(form){
  const dialog=document.querySelector('#manager-cash-dialog');
  const total=()=>managerDenominations.reduce((sum,value)=>sum+Math.round(Number(form.elements['cash_count_'+value].value||0))*value*100,0)+Math.round(Number(form.elements.cash_count_other.value||0)*100);
  const update=()=>document.querySelector('#manager-cash-total').textContent=money(total());
  listen('manager-count-cash',()=>{update();dialog.showModal();dialog.querySelector('input').focus();});listen('manager-cash-close',()=>dialog.close());
  dialog.addEventListener('input',update);
  listen('manager-cash-apply',()=>{for(const input of dialog.querySelectorAll('input'))if(!input.checkValidity()){input.reportValidity();return;}form.elements.counted.value=(total()/100).toFixed(2);dialog.close();form.elements.counted.dispatchEvent(new Event('input',{bubbles:true}));});
}
function showManagerReview(form,active,draft){
  const payload=managerPayload(form,active);
  const amounts=Object.fromEntries(Object.entries(payload.collections).map(([key,value])=>[key,Math.round(Number(value||0)*100)]));
  const expenses=Math.round(Number(payload.expenses||0)*100),counted=Math.round(Number(payload.counted)*100);
  const reviewRows=active.nozzles.map(n=>`<tr><th scope="row">${safe(n.code)}</th><td>${volume(n.opening)}</td><td>${volume(Math.round(Number(payload.closings[n.id])*1000))}</td></tr>`).join('');
  const entries=Object.fromEntries(Object.entries(payload.entries).map(([category,rows])=>[category,rows.map(r=>({...r,...(category==='deliveries'?{quantity:Math.round(Number(r.quantity)*1000)}:{amount:Math.round(Number(r.amount)*100)})}))]));
  moneyDialog('Review shift entries',`<p class="money-dialog-intro">Shift #${active.id} · ${safe(businessDay(active.business_date))}. Check these figures before locking the shift.</p><div class="table-scroll"><table class="manager-review-table"><thead><tr><th>Nozzle</th><th>Opening</th><th>Closing</th></tr></thead><tbody>${reviewRows}</tbody></table></div><dl class="money-entry-details">${Object.entries(managerMethods).map(([key,label])=>`<div><dt>${label} collected</dt><dd>${money(amounts[key])}</dd></div>`).join('')}<div><dt>Till expenses</dt><dd>${money(expenses)}</dd></div><div><dt>Counted cash</dt><dd>${money(counted)}</dd></div><div><dt>Cash difference</dt><dd>${money(counted-amounts.cash+expenses)}</dd></div>${fuelNames.map(f=>`<div><dt>${f} delivered</dt><dd>${volume(Math.round(Number(payload.deliveries[f]||0)*1000))}</dd></div><div><dt>${f} physical stock</dt><dd>${payload.physical[f]===''?'Not entered':volume(Math.round(Number(payload.physical[f])*1000))}</dd></div>`).join('')}</dl>${payload.expense_note?`<h3>Expense note</h3><p>${safe(payload.expense_note)}</p>`:''}${recordedEntries(entries,payload.shift_note)}<form id="manager-final-submit" class="money-form"><p class="money-form-hint">Credit and collection differences are handled by the owner. Submission locks your entries.</p>${errorbox}<button class="primary">Submit shift closing</button><button id="manager-edit-entries" type="button" class="secondary">Back to entries</button></form>`,true);
  listen('manager-edit-entries',()=>{document.querySelector('#money-dialog').close();form.querySelector('button.primary').focus();});
  bindForm('manager-final-submit',async()=>{
    if(draft.conflicted())throw Error('This draft changed elsewhere. Go back and load the saved draft before submitting.');
    await draft.save();
    if(draft.conflicted())throw Error('This draft changed elsewhere. Go back and load the saved draft before submitting.');
    lastSubmission=await api('/shifts/'+active.id+'/submit',{...payload,draft_version:draft.version()});draft.finish();await showHome();
  });
}
