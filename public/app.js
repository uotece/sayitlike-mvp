const socket = io();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let currentRoom = null;
let myId = null;
let currentVotingPayload = null;
let currentResultsPayload = null;
let mediaRecorder = null;
let mediaStream = null;
let recordedBlob = null;
let recordStopTimer = null;
let tickTimer = null;
let soundEnabled = true;
let uiVolume = Number(localStorage.getItem('sayitlike_volume') || 70);
let audioCtx = null;
let activePhaseKey = null;
let localTimerEnd = null;
let quickRooms = [];
let leaderboard = [];

const screens = {
  home: $('#homeScreen'),
  play: $('#playScreen'),
  quick: $('#quickScreen'),
  custom: $('#customScreen'),
  lobby: $('#lobbyScreen'),
  record: $('#recordScreen'),
  voting: $('#votingScreen'),
  results: $('#resultsScreen'),
  how: $('#howScreen'),
  hall: $('#hallScreen'),
  account: $('#accountScreen'),
  donate: $('#donateScreen'),
  patch: $('#patchScreen'),
  credits: $('#creditsScreen')
};

const screenIds = new Set(Object.values(screens).filter(Boolean).map((el) => el.id));

function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function beep(freq = 700, duration = 0.06, volume = 0.55, type = 'square') {
  if (!soundEnabled || uiVolume <= 0) return;
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime((uiVolume / 100) * volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (err) {
    // Browser probably blocked audio before first user interaction.
  }
}

function menuSound() { beep(740, 0.055, 0.7); setTimeout(() => beep(980, 0.045, 0.45), 45); }
function softSound() { beep(340, 0.055, 0.38, 'triangle'); }
function actionSound() { beep(620, 0.04, 0.55); setTimeout(() => beep(900, 0.04, 0.45), 40); }
function errorSound() { beep(180, 0.12, 0.55, 'sawtooth'); }
function winSound() { beep(660, 0.07, 0.55); setTimeout(() => beep(880, 0.07, 0.55), 80); setTimeout(() => beep(1320, 0.12, 0.55), 160); }

function showToast(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  toast.style.borderColor = isError ? '#fb7185' : 'var(--red)';
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3200);
  if (isError) errorSound();
}

function showScreen(screenId) {
  if (!screenIds.has(screenId)) {
    console.warn('Unknown screen:', screenId);
    return;
  }

  $$('.screen').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById(screenId);

  if (!target) {
    console.warn('Screen element missing:', screenId);
    return;
  }

  target.classList.add('active');
  if (screenId === 'quickScreen') socket.emit('quick:list');
  if (screenId === 'hallScreen') socket.emit('leaderboard:get');
}

function requireLoginToPlay() {
  if (authUser?.username) return true;
  showScreen('accountScreen');
  showToast('Create an account or log in before playing.');
  return false;
}

function getName() {
  if (authUser?.username) {
    $('#playerName').value = authUser.username;
    $('#accountName').textContent = authUser.username.toUpperCase().replace(/\s+/g, '_');
    return authUser.username;
  }

  $('#playerName').value = 'Guest';
  $('#accountName').textContent = 'GUEST';
  return 'Guest';
}

function setNameFromStorage() {
  const saved = localStorage.getItem('sayitlike_name') || 'Guest';
  $('#playerName').value = saved;
  $('#accountName').textContent = saved.toUpperCase().replace(/\s+/g, '_') + '_';
}

let firebaseAuth = null;
let firebaseConfigured = false;

function initFirebaseAuth() {
  try {
    const config = window.SAYITLIKE_FIREBASE_CONFIG || {};
    if (!config.apiKey || String(config.apiKey).startsWith('PASTE_')) {
      firebaseConfigured = false;
      console.warn('Firebase web config is missing. Edit public/firebase-config.js.');
      return;
    }

    if (!firebase.apps.length) firebase.initializeApp(config);
    firebaseAuth = firebase.auth();
    firebaseConfigured = true;

    firebaseAuth.onAuthStateChanged(async (user) => {
      if (!user) {
        authUser = null;
        renderAuthUI();
        socket.emit('auth:clear');
        return;
      }

      try {
        const idToken = await user.getIdToken();
        const profile = await fetchProfile(idToken);
        authUser = profile;
        renderAuthUI();
        socket.emit('auth:set', { idToken });
      } catch (err) {
        console.error('Could not load Firebase profile:', err);
        showToast(err.message || 'Could not load account profile.', true);
      }
    });
  } catch (err) {
    firebaseConfigured = false;
    console.error('Firebase init failed:', err);
    showToast('Firebase is not configured correctly.', true);
  }
}

function requireFirebaseClient() {
  if (!firebaseConfigured || !firebaseAuth) {
    throw new Error('Firebase is not configured. Edit firebase-config.js first.');
  }
}

async function apiRequest(path, idToken, body = null) {
  const options = {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`
    }
  };

  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify({ ...body, idToken });
  }

  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Account request failed.');
  return data;
}

async function fetchProfile(idToken) {
  const data = await apiRequest('/api/users/me', idToken);
  return data.user;
}

async function saveProfile(idToken, username) {
  const data = await apiRequest('/api/users/profile', idToken, { username });
  return data.user;
}

async function resolveLoginEmail(identifier) {
  const res = await fetch('/api/users/resolve-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not find that account.');
  return data.email;
}

function renderAuthUI() {
  const isSignedIn = !!authUser;

  $('#authChoicePanel').hidden = isSignedIn;
  $('#authSignupPanel').hidden = true;
  $('#authLoginPanel').hidden = true;
  $('#authForgotPanel').hidden = true;
  $('#authUserPanel').hidden = !isSignedIn;
  $('#authKicker').textContent = isSignedIn ? 'SIGNED IN' : 'CREATE ACCOUNT OR SIGN IN';

  if (isSignedIn) {
    const display = authUser.username.toUpperCase().replace(/\s+/g, '_');
    $('#accountName').textContent = display;
    $('#playerName').value = authUser.username;
    $('#playerName').disabled = true;
    $('#authSignedUsername').textContent = display;
    $('#authSignedStats').textContent = `${authUser.wins || 0} WINS • ${authUser.gamesPlayed || 0} GAMES`;
    $('#accountWins').textContent = `${authUser.wins || 0} W`;
    $('#accountLevel').textContent = String(Math.max(1, Math.floor((authUser.wins || 0) / 3) + 1));
  } else {
    $('#playerName').disabled = false;
    $('#playerName').value = 'Guest';
    $('#accountName').textContent = 'GUEST';
    $('#accountWins').textContent = '0 W';
    $('#accountLevel').textContent = '1';
  }
}

function showAuthPanel(panelName) {
  if (authUser) {
    renderAuthUI();
    return;
  }

  $('#authChoicePanel').hidden = panelName !== 'choice';
  $('#authSignupPanel').hidden = panelName !== 'signup';
  $('#authLoginPanel').hidden = panelName !== 'login';
  $('#authForgotPanel').hidden = panelName !== 'forgot';
  $('#authUserPanel').hidden = true;

  const titles = {
    choice: 'CREATE ACCOUNT OR SIGN IN',
    signup: 'CREATE ACCOUNT',
    login: 'LOGIN',
    forgot: 'PASSWORD RECOVERY'
  };

  $('#authKicker').textContent = titles[panelName] || titles.choice;
}

async function loadAuthUser() {
  initFirebaseAuth();
}

async function signup() {
  try {
    requireFirebaseClient();
    const email = $('#signupEmail').value.trim();
    const username = $('#signupUsername').value.trim();
    const password = $('#signupPassword').value;

    if (!email || !username || !password) {
      showToast('Fill email, username, and password.', true);
      return;
    }

    const credential = await firebaseAuth.createUserWithEmailAndPassword(email, password);
    await credential.user.updateProfile({ displayName: username });
    const idToken = await credential.user.getIdToken(true);
    authUser = await saveProfile(idToken, username);
    renderAuthUI();
    socket.emit('auth:set', { idToken });
    showToast('Account created.');
    showScreen($('#roomCodeInput').value ? 'customScreen' : 'playScreen');
  } catch (err) {
    showToast(err.message, true);
  }
}

async function login() {
  try {
    requireFirebaseClient();
    const identifier = $('#loginIdentifier').value.trim();
    const password = $('#loginPassword').value;

    if (!identifier || !password) {
      showToast('Enter email/username and password.', true);
      return;
    }

    const email = await resolveLoginEmail(identifier);
    const credential = await firebaseAuth.signInWithEmailAndPassword(email, password);
    const idToken = await credential.user.getIdToken(true);
    authUser = await fetchProfile(idToken);
    renderAuthUI();
    socket.emit('auth:set', { idToken });
    showToast('Logged in.');
    showScreen($('#roomCodeInput').value ? 'customScreen' : 'playScreen');
  } catch (err) {
    showToast(err.message, true);
  }
}

async function sendPasswordReset() {
  try {
    requireFirebaseClient();
    const identifier = $('#forgotIdentifier').value.trim();

    if (!identifier) {
      showToast('Enter your email or username.', true);
      return;
    }

    const email = await resolveLoginEmail(identifier);
    await firebaseAuth.sendPasswordResetEmail(email);
    showToast('Password reset email sent.');
    showAuthPanel('login');
    $('#loginIdentifier').value = identifier;
  } catch (err) {
    showToast(err.message, true);
  }
}

async function logout() {
  try {
    requireFirebaseClient();
    await firebaseAuth.signOut();
  } catch {
    // Keep going locally even if Firebase signout fails.
  }
  authUser = null;
  renderAuthUI();
  socket.emit('auth:clear');
  showToast('Logged out.');
  showScreen('homeScreen');
}

function onSafe(selector, eventName, handler) {
  const element = $(selector);
  if (!element) {
    console.warn('Missing element for event listener:', selector);
    return;
  }
  element.addEventListener(eventName, handler);
}

function onClickSafe(selector, handler) {
  onSafe(selector, 'click', handler);
}

function setQuickTab(tab) {
  $$('.browser-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.quickTab === tab));
  $('#quickRoomsPane').classList.toggle('active', tab === 'rooms');
  $('#quickCreatePane').classList.toggle('active', tab === 'create');
}

function initEvents() {
  setNameFromStorage();
  setVolumeUI();
  loadAuthUser();
  renderQuickRooms([]);
  renderLeaderboard([]);

  // Navigation is attached first so a missing account-form element cannot kill the whole UI.
  $$('[data-screen]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      const targetScreen = el.dataset.screen;
      if (['playScreen', 'quickScreen', 'customScreen', 'lobbyScreen', 'recordScreen', 'votingScreen'].includes(targetScreen) && !requireLoginToPlay()) {
        return;
      }
      showScreen(targetScreen);
    });
  });

  onSafe('#playerName', 'input', getName);

  onClickSafe('#accountCard', () => showScreen('accountScreen'));
  onSafe('#accountCard', 'keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') showScreen('accountScreen');
  });

  onClickSafe('#showSignupBtn', () => showAuthPanel('signup'));
  onClickSafe('#showLoginBtn', () => showAuthPanel('login'));
  onClickSafe('#signupBackBtn', () => showAuthPanel('choice'));
  onClickSafe('#loginBackBtn', () => showAuthPanel('choice'));
  onClickSafe('#forgotBackBtn', () => showAuthPanel('login'));
  onClickSafe('#showForgotBtn', () => showAuthPanel('forgot'));

  onClickSafe('#signupBtn', signup);
  onClickSafe('#loginBtn', login);
  onClickSafe('#resetPasswordBtn', sendPasswordReset);
  onClickSafe('#logoutBtn', logout);

  localStorage.removeItem('sayitlike_last_username');

  onSafe('#signupPassword', 'keydown', (event) => {
    if (event.key === 'Enter') signup();
  });
  onSafe('#loginPassword', 'keydown', (event) => {
    if (event.key === 'Enter') login();
  });
  onSafe('#forgotIdentifier', 'keydown', (event) => {
    if (event.key === 'Enter') sendPasswordReset();
  });

  document.addEventListener('pointerdown', (event) => {
    const clicky = event.target.closest('button, a');
    if (!clicky) return;
    if (clicky.classList.contains('back-btn') || clicky.classList.contains('modal-close')) softSound();
    else if (clicky.classList.contains('menu-btn') || clicky.classList.contains('browser-tab') || clicky.classList.contains('room-card')) menuSound();
    else if (clicky.classList.contains('pixel-btn') || clicky.classList.contains('vote-btn')) actionSound();
  });

  onClickSafe('#soundToggle', (event) => {
    event.stopPropagation();
    $('#volumePanel')?.classList.toggle('open');
    softSound();
  });

  document.addEventListener('click', (event) => {
    const panel = $('#volumePanel');
    const toggle = $('#soundToggle');
    if (panel && toggle && !panel.contains(event.target) && !toggle.contains(event.target)) {
      panel.classList.remove('open');
    }
  });

  onSafe('#volumeSlider', 'input', () => {
    uiVolume = Number($('#volumeSlider').value);
    $('#volumeValue').textContent = `${uiVolume}%`;
    localStorage.setItem('sayitlike_volume', String(uiVolume));
  });

  onSafe('#volumeSlider', 'change', () => beep(740, 0.055, 0.7));

  onClickSafe('#quickBattleMenuBtn', () => {
    if (!requireLoginToPlay()) return;
    setQuickTab('rooms');
    socket.emit('quick:list');
  });

  $$('.browser-tab').forEach((btn) => btn.addEventListener('click', () => setQuickTab(btn.dataset.quickTab)));

  onClickSafe('#refreshQuickRoomsBtn', () => socket.emit('quick:list'));

  onClickSafe('#createQuickRoomBtn', () => {
    if (!requireLoginToPlay()) return;
    socket.emit('quick:create', { name: getName() });
  });

  onClickSafe('#joinQuickRoomBtn', () => {
    if (!requireLoginToPlay()) return;
    socket.emit('quick:join', { name: getName(), code: $('#quickRoomCodeInput')?.value || '' });
  });

  onSafe('#quickRoomCodeInput', 'input', (e) => { e.target.value = e.target.value.toUpperCase(); });
  onSafe('#quickRoomCodeInput', 'keydown', (e) => { if (e.key === 'Enter') $('#joinQuickRoomBtn')?.click(); });

  onSafe('#quickRoomsList', 'click', (e) => {
    const card = e.target.closest('.room-card');
    if (!card) return;
    if (!requireLoginToPlay()) return;
    socket.emit('quick:join', { name: getName(), code: card.dataset.code });
  });

  onClickSafe('#createRoomBtn', () => {
    if (!requireLoginToPlay()) return;
    socket.emit('custom:create', { name: getName() });
  });

  onClickSafe('#joinRoomBtn', () => {
    if (!requireLoginToPlay()) return;
    socket.emit('custom:join', { name: getName(), code: $('#roomCodeInput')?.value || '' });
  });

  onSafe('#roomCodeInput', 'input', (e) => { e.target.value = e.target.value.toUpperCase(); });
  onSafe('#roomCodeInput', 'keydown', (e) => { if (e.key === 'Enter') $('#joinRoomBtn')?.click(); });

  onClickSafe('#startRoundBtn', () => socket.emit('round:start'));
  onClickSafe('#playAgainBtn', () => socket.emit('round:start'));
  onClickSafe('#backToLobbyBtn', () => showScreen('lobbyScreen'));
  onClickSafe('#leaveLobbyBtn', leaveRoom);
  onClickSafe('#leaveLobbyBtn2', leaveRoom);
  onClickSafe('#copyRoomBtn', () => copyText($('#roomLink')?.value || ''));

  onClickSafe('#recordBtn', startRecording);
  onClickSafe('#stopBtn', stopRecording);
  onClickSafe('#submitClipBtn', submitClip);

  onSafe('#clipList', 'click', (event) => {
    const button = event.target.closest('.vote-btn');
    if (!button || button.disabled) return;
    submitVote(button.dataset.clipId);
  });

  const roomFromUrl = new URLSearchParams(location.search).get('room');
  if (roomFromUrl) {
    const roomInput = $('#roomCodeInput');
    if (roomInput) roomInput.value = roomFromUrl.toUpperCase();

    if (authUser?.username) {
      showScreen('customScreen');
      showToast('Room code loaded. Click JOIN.');
    } else {
      showScreen('accountScreen');
      showToast('Log in or create an account, then click JOIN.');
    }
  }
}

socket.on('app:hello', (payload) => {
  myId = payload.playerId;
  if ('user' in payload) {
    authUser = payload.user || authUser;
    renderAuthUI();
  }
});
socket.on('app:error', (message) => showToast(message, true));
socket.on('game:notice', (message) => showToast(message));
socket.on('quick:list', renderQuickRooms);
socket.on('leaderboard:update', renderLeaderboard);
socket.on('room:joined', (payload) => {
  currentRoom = { ...(currentRoom || {}), code: payload.code };
  showToast(`Joined room ${payload.code}.`);
});
socket.on('room:update', renderRoom);
socket.on('clip:submitted', () => {
  lockRecorderAfterSubmit();
  showToast('Clip submitted.');
});
socket.on('round:voting', renderVoting);
socket.on('vote:submitted', () => showToast('Vote submitted.'));
socket.on('round:results', renderResults);

initEvents();
