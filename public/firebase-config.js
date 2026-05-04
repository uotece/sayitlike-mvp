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
  const FIRESTORE_SCRIPT = "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore-compat.js";
  let firestoreLoader = null;

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

  function usernameKey(username) {
    return clean(username).toLowerCase();
  }

  function looksLikeEmail(value) {
    return /@/.test(clean(value));
  }

  function validUsername(username) {
    return /^[a-zA-Z0-9_-]{3,16}$/.test(clean(username));
  }

  function cacheUsernameEmail(username, email) {
    const key = usernameKey(username);
    const value = clean(email).toLowerCase();
    if (!key || !value) return;
    localStorage.setItem(`sayitlike_username_email_${key}`, value);
  }

  function getCachedUsernameEmail(username) {
    return localStorage.getItem(`sayitlike_username_email_${usernameKey(username)}`) || "";
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

  function loadFirestoreCompat() {
    if (window.firebase?.firestore) return Promise.resolve();
    if (firestoreLoader) return firestoreLoader;

    firestoreLoader = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${FIRESTORE_SCRIPT}"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = FIRESTORE_SCRIPT;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Could not load username login support."));
      document.head.appendChild(script);
    });

    return firestoreLoader;
  }

  async function resolveEmailFromUsername(username) {
    const key = usernameKey(username);
    const cached = getCachedUsernameEmail(key);
    if (cached) return cached;

    await loadFirestoreCompat();

    if (!window.firebase?.apps?.length) firebase.initializeApp(window.SAYITLIKE_FIREBASE_CONFIG);

    const db = firebase.firestore();
    const usernameSnap = await db.collection("usernames").doc(key).get();
    if (!usernameSnap.exists) {
      throw new Error("No account found with that username. Try your email instead.");
    }

    const usernameData = usernameSnap.data() || {};
    if (usernameData.email) {
      cacheUsernameEmail(key, usernameData.email);
      return usernameData.email;
    }

    if (usernameData.uid) {
      const userSnap = await db.collection("users").doc(usernameData.uid).get();
      const userData = userSnap.exists ? (userSnap.data() || {}) : {};
      if (userData.email) {
        cacheUsernameEmail(key, userData.email);
        return userData.email;
      }
    }

    throw new Error("Username login could not resolve this account. Use your email this time.");
  }

  async function emailFromIdentifier(identifier) {
    const value = clean(identifier);
    if (looksLikeEmail(value)) return value.toLowerCase();
    return resolveEmailFromUsername(value);
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

      cacheUsernameEmail(authUser.username, authUser.email || email);
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

      const identifier = clean(qs("#authLoginIdentifier")?.value);
      const password = qs("#authLoginPassword")?.value || "";
      if (!identifier) throw new Error("Enter your email or username.");
      if (!password) throw new Error("Enter your password.");

      setBusy(button, true, "LOGGING IN...");
      const email = await emailFromIdentifier(identifier);
      const credential = await firebaseAuth.signInWithEmailAndPassword(email, password);
      const idToken = await credential.user.getIdToken(true);
      authUser = await fetchProfile(idToken);

      cacheUsernameEmail(authUser.username, authUser.email || email);
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
      const identifier = clean(qs("#authLoginIdentifier")?.value);
      if (!identifier) throw new Error("Enter your email or username first.");

      setBusy(button, true, "SENDING...");
      const email = await emailFromIdentifier(identifier);
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
        <label for="authLoginIdentifier">EMAIL OR USERNAME</label>
        <input id="authLoginIdentifier" placeholder="email or username" autocomplete="username" />

        <label for="authLoginPassword">PASSWORD</label>
        <input id="authLoginPassword" type="password" maxlength="72" placeholder="password" autocomplete="current-password" />

        <div class="action-row">
          <button class="pixel-btn full" id="authLoginSubmit" type="button">LOGIN</button>
        </div>
        <button class="auth-link-btn" id="authForgotBtn" type="button">Forgot your password? Send reset email.</button>
        <p class="tiny-note auth-help">Login only needs your email or username plus your password.</p>
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
    qs("#authLoginIdentifier")?.addEventListener("keydown", (event) => {
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
