"use strict";

async function openAccountSecurity() {
  const state = await api("/mfa");
  shell(`${heading("", "Account security", "Use an authenticator app for a second sign-in check.")}
    <section class="card">
      <h2>Two-step verification</h2>
      <p>${state.enabled ? "On for this account." : "Off for this account."}</p>
      ${state.configured
        ? `<form id="mfa-settings"><label>Current password<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>
            ${state.enabled ? '<label>Authenticator or recovery code<input name="code" autocomplete="one-time-code" required maxlength="40"></label>' : ""}
            ${errorbox}<button class="primary">${state.enabled ? "Turn off verification" : "Set up authenticator"}</button></form>`
        : '<p>Authenticator setup is unavailable. Contact your administrator.</p>'}
    </section>`, "security");

  if (!state.configured) return;
  bindForm("mfa-settings", async form => {
    if (state.enabled) {
      await api("/mfa/disable", fields(form));
      session = null;
      showLogin("Verification turned off. Sign in again.");
      return;
    }
    const setup = await api("/mfa/setup", fields(form));
    showAuthenticatorSetup(setup.setup_key);
  });
}

function showAuthenticatorSetup(key) {
  shell(`${heading("", "Set up authenticator", "Add a time-based account in your authenticator app.")}
    <section class="card">
      <p>Choose manual setup, name the account Tuljai Petroleum, and enter this key. Keep the key private.</p>
      <label>Setup key<input id="mfa-key" readonly value="${safe(key)}" autocomplete="off" spellcheck="false"></label>
      <button id="mfa-copy-key" class="text-button" type="button">Copy key</button>
      <form id="mfa-enable">
        <label>Six-digit code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
        ${errorbox}<button class="primary">Turn on verification</button>
      </form>
    </section>`, "security");
  listen("mfa-copy-key", async event => {
    const input = document.querySelector("#mfa-key");
    try {
      await navigator.clipboard.writeText(input.value);
      event.target.textContent = "Copied";
    } catch {
      input.select();
    }
  });
  bindForm("mfa-enable", async form => {
    const result = await api("/mfa/enable", fields(form));
    showRecoveryCodes(result.recovery_codes);
  });
}

function showRecoveryCodes(codes) {
  session = null;
  mountAuth(`<main class="auth-form-panel">
    <header class="auth-heading"><p class="eyebrow">Account security</p><h1>Save your recovery codes</h1>
    <p>Keep these somewhere private. Each code works once in place of an authenticator code.</p></header>
    <div class="auth-form">
      <label>Recovery codes<textarea class="auth-recovery-codes" rows="8" readonly spellcheck="false">${safe(codes.join("\n"))}</textarea></label>
      <p>Wait for your authenticator to show a new code before signing in again.</p>
      <button id="mfa-sign-in" class="primary auth-primary" type="button">I saved my codes. Sign in ${icon("arrow")}</button>
    </div>
  </main>`);
  listen("mfa-sign-in", () => showLogin());
  root.querySelector("h1").setAttribute("tabindex", "-1");
  root.querySelector("h1").focus();
}
