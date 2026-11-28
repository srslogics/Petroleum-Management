"use strict";

let contactRequest;
let contactFieldCount = 0;

function ownerContacts() {
  if (!contactRequest) {
    contactRequest = api('/contacts').then(data => data.contacts);
    const request = contactRequest;
    request.catch(() => { if (contactRequest === request) contactRequest = undefined; });
  }
  return contactRequest;
}

const contactKey = name => String(name ?? '').trim().toLocaleLowerCase();
const matchingContact = (contacts, name) => contacts.find(item => contactKey(item.name) === contactKey(name));

function contactNameField(label, name, value = '', options = {}) {
  const id = 'contact-name-' + ++contactFieldCount;
  return `<div class="contact-picker">
    <label for="${id}">${label}</label>
    <input id="${id}" ${options.entry ? 'data-field' : 'name'}="${name}" value="${safe(value)}" maxlength="150" autocomplete="off"
      ${options.required === false ? '' : 'required'} role="combobox" aria-autocomplete="list"
      aria-expanded="false" aria-controls="${id}-options" data-contact-field
      data-contact-names="${safe(JSON.stringify(options.knownNames || []))}" data-contact-phone="${options.phoneField || ''}" data-contact-select="${options.contactSelect || ''}">
    <div id="${id}-options" class="contact-options" role="listbox" aria-label="Matching contacts" hidden></div>
  </div>`;
}

function bindContactFields(dialog) {
  for (const input of dialog.querySelectorAll('[data-contact-field]')) bindContactField(input);
}

function bindContactField(input) {
  const list = document.getElementById(input.getAttribute('aria-controls'));
  let contacts = [];
  let choices = [];
  let active = -1;
  let typed = false;
  const otherNames = JSON.parse(input.dataset.contactNames);
  const phone = input.form?.elements[input.dataset.contactPhone];
  const whatsappPicker = input.dataset.contactPhone === 'recipient';
  const close = () => {
    active = -1;
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const choose = choice => {
    input.value = choice.name;
    const contactSelect = input.form?.elements[input.dataset.contactSelect];
    if (contactSelect && choice.id) contactSelect.value = String(choice.id);
    if (phone && choice.phone) {
      phone.value = choice.phone;
      if (whatsappPicker) phone.dataset.fromContact = 'true';
    }
    input.dispatchEvent(new Event('change', {bubbles: true}));
    close();
    input.focus();
  };
  const suggest = () => {
    close();
    const query = contactKey(input.value);
    if (!query) return;
    const names = new Map(contacts.filter(item => !whatsappPicker || item.phone).map(item => [contactKey(item.name), item]));
    for (const name of otherNames) {
      if (!names.has(contactKey(name))) names.set(contactKey(name), {name});
    }
    choices = [...names.values()].filter(item => contactKey(item.name).includes(query)).slice(0, 8);
    if (!choices.length) return;
    list.innerHTML = choices.map((item, index) =>
      `<div id="${list.id}-${index}" role="option" aria-selected="false" data-contact-choice="${index}">${safe(item.name)}</div>`).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  if (whatsappPicker) phone.addEventListener('input', () => { delete phone.dataset.fromContact; });
  input.addEventListener('input', () => {
    typed = true;
    if (whatsappPicker && phone.dataset.fromContact) {
      phone.value = '';
      delete phone.dataset.fromContact;
    }
    suggest();
  });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', event => {
    if (list.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      choose(choices[active]);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = active === -1 ? (step === 1 ? 0 : choices.length - 1) : (active + step + choices.length) % choices.length;
      for (const [index, option] of Array.from(list.children).entries()) option.setAttribute('aria-selected', String(index === active));
      input.setAttribute('aria-activedescendant', list.children[active].id);
      list.children[active].scrollIntoView({block: 'nearest'});
    }
  });
  list.addEventListener('pointerdown', event => {
    if (event.target.closest('[data-contact-choice]')) event.preventDefault();
  });
  list.addEventListener('click', event => {
    const option = event.target.closest('[data-contact-choice]');
    if (option) choose(choices[Number(option.dataset.contactChoice)]);
  });
  ownerContacts().then(items => {
    contacts = items;
    if (typed && input === document.activeElement) suggest();
  }).catch(() => {});
}

function openContacts() {
  return loadOwnerView('/contacts', data => {
    contactRequest = Promise.resolve(data.contacts);
    showContacts(data.contacts);
  });
}

function showContacts(contacts) {
  shell(`<div class="money-heading"><div>${heading('', 'Contacts', 'Save people and businesses you deal with regularly.')}</div>
    <button id="add-contact" class="primary" type="button">+ Add contact</button></div>
    <section class="money-workspace" aria-label="Saved contacts">
      ${contacts.length ? `<div class="money-toolbar"><h2>Saved contacts</h2><div class="money-tools">${moneySearch('contact-search', 'Search contacts', '')}</div></div>
        <ul class="contact-list">${contacts.map(item => `<li data-contact-row data-search="${safe(contactKey(item.name) + ' ' + item.phone)}">
          <button id="edit-contact-${item.id}" class="money-source-link" type="button" aria-label="Edit contact ${safe(item.name)}">
            <strong>${safe(item.name)}</strong><small>${safe(item.phone || 'No number saved')}</small>
          </button>
          ${item.phone ? `<button id="message-contact-${item.id}" class="secondary" type="button" aria-label="WhatsApp ${safe(item.name)}">WhatsApp</button>` : ''}
        </li>`).join('')}</ul><div id="contact-no-matches" hidden>${moneyEmpty('No matching contacts', 'Try another name or number.')}</div>`
        : moneyEmpty('No contacts saved yet', 'Save a name and WhatsApp number to use them again on bills and receivables.')}
    </section>`, 'contacts');
  listen('add-contact', () => openContactForm());
  for (const item of contacts) {
    listen('edit-contact-' + item.id, () => openContactForm(item));
    if (item.phone) listen('message-contact-' + item.id, () => openWhatsAppComposer('', 'Message ' + item.name, item.name, item.phone));
  }
  if (contacts.length) listen('contact-search', event => {
    const query = contactKey(event.target.value);
    let count = 0;
    for (const row of document.querySelectorAll('[data-contact-row]')) {
      row.hidden = !row.dataset.search.includes(query);
      if (!row.hidden) count++;
    }
    document.getElementById('contact-no-matches').hidden = count > 0;
  }, 'input');
}

function openContactForm(contact, name = '', afterSave = openContacts) {
  moneyDialog(contact ? 'Edit contact' : 'Add contact', `<form id="save-station-contact" class="money-form">
    <label>Contact name<input name="name" required maxlength="150" autocomplete="off" value="${safe(contact?.name || name)}" ${contact ? 'readonly' : ''}></label>
    <label>WhatsApp number (optional)<input name="phone" type="tel" maxlength="30" placeholder="+91 …" value="${safe(contact?.phone)}"></label>
    <p class="money-form-hint">Enter an Indian mobile number or include the country code.</p>
    ${errorbox}<button class="primary">Save contact</button>
  </form>`);
  bindForm('save-station-contact', async form => {
    await api('/contacts', {...fields(form), ...(contact ? {id: contact.id} : {})});
    contactRequest = undefined;
    await afterSave();
    showBusinessNotice('Contact saved.');
  });
}
