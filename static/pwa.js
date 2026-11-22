"use strict";

(() => {
  const banner = document.querySelector("#connection-banner");
  const bar = document.querySelector("#install-bar");
  const installButton = document.querySelector("#install-app");
  const help = document.querySelector("#install-help");
  const installed = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let installPrompt;
  const connectionChanged = () => {
    banner.hidden = navigator.onLine;
  };
  connectionChanged();
  window.addEventListener("online", connectionChanged);
  window.addEventListener("offline", connectionChanged);

  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register("/sw.js", {scope: "/", updateViaCache:"none"}).then(() => {
    if (location.pathname !== "/") bar.hidden = installed();
  }).catch(() => {
    bar.hidden = true;
  });
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    bar.hidden = installed();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    bar.hidden = true;
  });
  window.matchMedia("(display-mode: standalone)").addEventListener("change", () => {
    bar.hidden = installed();
  });
  installButton.addEventListener("click", async () => {
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") bar.hidden = true;
      return;
    }
    const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    document.querySelector("#install-instructions").textContent = isAppleMobile
      ? "In Safari, tap Share, then Add to Home Screen. Open the Owner App or Station Manager App before installing to save the right entry point."
      : "Open your browser’s menu and choose Install app or Add to Home screen. If it is unavailable, open this page in a browser that supports app installation.";
    help.showModal();
  });
})();
