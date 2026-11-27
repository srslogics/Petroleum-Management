"use strict";

function openAccountSecurity() {
  return role === "owner" ? loadOwnerView("/mfa", showAccountSecurity) : api("/mfa").then(showAccountSecurity);
}

function showAccountSecurity(state) {
  shell(`${heading("", "Account security", "Use an authenticator app for a second sign-in check.")}
    <section class="card card-flow security-card">
      <header class="section-head">
        <div><h2>Two-step verification</h2><p>Confirm your password to change this setting.</p></div>
        ${moneyBadge(state.enabled ? "On" : "Off", state.enabled ? "positive" : "neutral")}
      </header>
      ${state.configured
        ? `<form id="mfa-settings" class="business-form"><label>Current password<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>
            ${state.enabled ? '<label>Authenticator or recovery code<input name="code" autocomplete="one-time-code" required maxlength="40"></label>' : ""}
            ${errorbox}<button class="primary">${state.enabled ? "Turn off verification" : "Set up authenticator"}</button></form>`
        : `<div class="inline-warning">${icon("warning")}<div><strong>Authenticator setup is unavailable</strong><p>Contact your administrator to enable setup.</p></div></div>`}
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
    <section class="card card-flow security-card">
      <header class="section-head"><div><h2>Add the setup key</h2><p>Choose manual setup in your authenticator and name the account Tuljai Petroleum. Keep the key private.</p></div></header>
      <div class="setup-key">
        <label>Setup key<input id="mfa-key" readonly value="${safe(key)}" autocomplete="off" spellcheck="false"></label>
        <button id="mfa-copy-key" class="secondary" type="button">Copy key</button>
      </div>
      <form id="mfa-enable" class="business-form record-actions"><h3>Verify your authenticator</h3>
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
