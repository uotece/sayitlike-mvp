// Firebase web app config for SayItLike.
// app.js expects authUser to exist before its event handlers run.
var authUser = null;

window.SAYITLIKE_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBO-jyE_pYBwBi9OfnQ5rziH8_j3n3OrL0",
  authDomain: "sayitlike-90bd3.firebaseapp.com",
  projectId: "sayitlike-90bd3",
  appId: "1:906144855670:web:43b6948e2b39a43e831157"
};

(function setupAuthUpgrade() {
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else setTimeout(fn, 0);
  }

  function qs(selector) {
    return document.querySelector(selector);
  }

  function clean(value) {
    return String(value || "").trim();
  }

  function looksLikeEmail(value) {
    return /@/.test(clean(value));
  }

  function validUsername(username) {
    return /^[a-zA-Z0-9_-]{3,16}$/.test(clean(username));
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = label || "PLEASE WAIT...";
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
    }
  }

  function toast(message, isError = false) {
    if (typeof showToast === "function") showToast(message, isError);
    else alert(message);
  }

  function showAuthMode(mode) {
    const loginForm = qs("#authLoginForm");
    const signupForm = qs("#authSignupForm");
    const loginTab = qs("#authShowLogin");
    const signupTab = qs("#authShowSignup");

    const isLogin = mode !== "signup";
    if (loginForm) loginForm.hidden = !isLogin;
    if (signupForm) signupForm.hidden = isLogin;
    if (loginTab) loginTab.classList.toggle("dark", !isLogin);
    if (signupTab) signupTab.classList.toggle("dark", isLogin);
  }

  async function upgradedSignup() {
    const button = qs("#authSignupSubmit");
    try {
      requireFirebaseClient();

      const email = clean(qs("#authSignupEmail")?.value).toLowerCase();
      const username = clean(qs("#authSignupUsername")?.value);
      const password = qs("#authSignupPassword")?.value || "";

      if (!looksLikeEmail(email)) throw new Error("Enter a valid email address.");
      if (!validUsername(username)) throw new Error("Username must be 3-16 characters and use only letters, numbers, _ or -.");
      if (password.length < 6) throw new Error("Password must be at least 6 characters.");

      setBusy(button, true, "CREATING...");
      const credential = await firebaseAuth.createUserWithEmailAndPassword(email, password);
      await credential.user.updateProfile({ displayName: username });

      const idToken = await credential.user.getIdToken(true);
      try {
        authUser = await saveProfile(idToken, username);
      } catch (profileErr) {
        try { await credential.user.delete(); } catch (deleteErr) { console.warn("Could not delete incomplete signup:", deleteErr); }
        try { await firebaseAuth.signOut(); } catch (signOutErr) { console.warn("Could not sign out after failed signup:", signOutErr); }
        throw profileErr;
      }

      renderAuthUI();
      socket.emit("auth:set", { idToken });
      toast("Account created.");
      showScreen(qs("#roomCodeInput")?.value ? "customScreen" : "playScreen");
    } catch (err) {
      toast(err.message || "Could not create account.", true);
    } finally {
      setBusy(button, false);
    }
  }

  async function upgradedLogin() {
    const button = qs("#authLoginSubmit");
    try {
      requireFirebaseClient();

      const email = clean(qs("#authLoginEmail")?.value).toLowerCase();
      const password = qs("#authLoginPassword")?.value || "";
      if (!looksLikeEmail(email)) throw new Error("Enter a valid email address.");
      if (!password) throw new Error("Enter your password.");

      setBusy(button, true, "LOGGING IN...");
      const credential = await firebaseAuth.signInWithEmailAndPassword(email, password);
      const idToken = await credential.user.getIdToken(true);
      authUser = await fetchProfile(idToken);

      renderAuthUI();
      socket.emit("auth:set", { idToken });
      toast("Logged in.");
      showScreen(qs("#roomCodeInput")?.value ? "customScreen" : "playScreen");
    } catch (err) {
      toast(err.message || "Could not log in.", true);
    } finally {
      setBusy(button, false);
    }
  }

  async function sendPasswordReset() {
    const button = qs("#authForgotBtn");
    try {
      requireFirebaseClient();
      const email = clean(qs("#authLoginEmail")?.value).toLowerCase();
      if (!looksLikeEmail(email)) throw new Error("Enter your email first.");

      setBusy(button, true, "SENDING...");
      await firebaseAuth.sendPasswordResetEmail(email);
      toast("Password reset email sent.");
    } catch (err) {
      toast(err.message || "Could not send password reset email.", true);
    } finally {
      setBusy(button, false);
    }
  }

  function injectAuthStyles() {
    if (qs("#authUpgradeStyles")) return;
    const style = document.createElement("style");
    style.id = "authUpgradeStyles";
    style.textContent = `
      .auth-mode-picker{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
      .auth-form[hidden]{display:none!important}
      .auth-form input{text-transform:none}
      .auth-form label{display:block;color:var(--muted);font-size:8px;margin:12px 0 8px}
      .auth-form .action-row{margin-top:16px}
      .auth-form .pixel-btn.full{width:100%}
      .auth-link-btn{margin-top:12px;background:transparent;border:0;color:var(--muted);font-family:ui-monospace,monospace;font-size:12px;line-height:1.4;cursor:pointer;text-align:left;padding:0;text-transform:none}
      .auth-link-btn:hover{color:var(--green)}
      .auth-help{margin-top:12px}
      @media(max-width:700px){.auth-mode-picker{grid-template-columns:1fr}.auth-form .action-row{display:grid}.auth-form .pixel-btn{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function replaceAuthGuestPanel() {
    const panel = qs("#authGuestPanel");
    if (!panel || panel.dataset.upgraded === "true") return;
    panel.dataset.upgraded = "true";

    const kicker = qs("#accountScreen .modal-kicker");
    if (kicker) kicker.textContent = "LOGIN OR CREATE ACCOUNT";

    panel.innerHTML = `
      <div class="auth-mode-picker">
        <button class="pixel-btn" id="authShowLogin" type="button">LOGIN</button>
        <button class="pixel-btn dark" id="authShowSignup" type="button">CREATE ACCOUNT</button>
      </div>

      <div id="authLoginForm" class="auth-form">
        <label for="authLoginEmail">EMAIL</label>
        <input id="authLoginEmail" type="email" placeholder="you@example.com" autocomplete="email" />

        <label for="authLoginPassword">PASSWORD</label>
        <input id="authLoginPassword" type="password" maxlength="72" placeholder="password" autocomplete="current-password" />

        <div class="action-row">
          <button class="pixel-btn full" id="authLoginSubmit" type="button">LOGIN</button>
        </div>
        <button class="auth-link-btn" id="authForgotBtn" type="button">Forgot your password? Send reset email.</button>
        <p class="tiny-note auth-help">Login uses your email and password.</p>
      </div>

      <div id="authSignupForm" class="auth-form" hidden>
        <label for="authSignupEmail">EMAIL</label>
        <input id="authSignupEmail" type="email" placeholder="you@example.com" autocomplete="email" />

        <label for="authSignupUsername">USERNAME</label>
        <input id="authSignupUsername" maxlength="16" placeholder="username" autocomplete="username" />

        <label for="authSignupPassword">PASSWORD</label>
        <input id="authSignupPassword" type="password" maxlength="72" placeholder="password" autocomplete="new-password" />

        <div class="action-row">
          <button class="pixel-btn full" id="authSignupSubmit" type="button">CREATE ACCOUNT</button>
        </div>
        <p class="tiny-note auth-help">Usernames must be unique and use 3-16 letters, numbers, _ or -.</p>
      </div>
    `;

    qs("#authShowLogin")?.addEventListener("click", () => showAuthMode("login"));
    qs("#authShowSignup")?.addEventListener("click", () => showAuthMode("signup"));
    qs("#authLoginSubmit")?.addEventListener("click", upgradedLogin);
    qs("#authSignupSubmit")?.addEventListener("click", upgradedSignup);
    qs("#authForgotBtn")?.addEventListener("click", sendPasswordReset);

    qs("#authLoginPassword")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") upgradedLogin();
    });
    qs("#authLoginEmail")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") upgradedLogin();
    });
    qs("#authSignupPassword")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") upgradedSignup();
    });

    showAuthMode("login");
    if (typeof renderAuthUI === "function") renderAuthUI();
  }

  ready(() => {
    injectAuthStyles();
    replaceAuthGuestPanel();
  });
})();
