const socket = io();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let currentRoom = null;
let myId = null;
let currentPromptVotingPayload = null;
let currentPerformanceVotingPayload = null;
let currentResultsPayload = null;
let mediaRecorder = null;
let mediaStream = null;
let recordedBlob = null;
let recordStopTimer = null;
let tickTimer = null;
let soundEnabled = true;
let uiVolume = Number(localStorage.getItem('sayitlike_volume') || 70);
let audioCtx = null;
let quickRooms = [];
let leaderboard = [];
let firebaseAuth = null;
let firebaseConfigured = false;
let selectedLineId = null;
let selectedScenarioId = null;
let phaseIntroShown = new Set();
let localResultsDone = false;
let lastRecordingResetKey = null;
let previewAudioUrl = null;
let localAwardAppliedKey = null;

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
  } catch {}
}
function menuSound() { beep(740, 0.055, 0.7); setTimeout(() => beep(980, 0.045, 0.45), 45); }
function softSound() { beep(340, 0.055, 0.38, 'triangle'); }
function actionSound() { beep(620, 0.04, 0.55); setTimeout(() => beep(900, 0.04, 0.45), 40); }
function errorSound() { beep(180, 0.12, 0.55, 'sawtooth'); }
function winSound() { beep(660, 0.07, 0.55); setTimeout(() => beep(880, 0.07, 0.55), 80); setTimeout(() => beep(1320, 0.12, 0.55), 160); }

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  }[ch]));
}

function showToast(message, isError = false) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  toast.style.borderColor = isError ? '#fb7185' : 'var(--red)';
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3200);
  if (isError) errorSound();
}

function showScreen(screenId) {
  const target = document.getElementById(screenId);
  if (!target) return;
  $$('.screen').forEach((el) => el.classList.remove('active'));
  target.classList.add('active');
  if (screenId === 'quickScreen') socket.emit('quick:list');
  if (screenId === 'hallScreen') socket.emit('leaderboard:get');
}

function scenarioText(prompt) {
  const raw = String(prompt?.scenario || prompt?.style || '—').trim();
  return raw.replace(/^like\s+/i, '').trim() || '—';
}

function promptText(prompt) {
  if (!prompt) return '—';
  const line = prompt.line || '—';
  const scenario = scenarioText(prompt);
  return `Say "${line}" like ${scenario}.`;
}

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function pauseOtherAudioPlayers(activeAudio) {
  document.querySelectorAll('.themed-audio audio').forEach((audio) => {
    if (audio !== activeAudio) audio.pause();
  });
}

function createThemedAudioPlayer(src) {
  const wrap = document.createElement('div');
  wrap.className = 'themed-audio';

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'audio-play-btn';
  play.textContent = '▶';
  play.setAttribute('aria-label', 'Play audio');

  const progress = document.createElement('input');
  progress.type = 'range';
  progress.min = '0';
  progress.max = '1000';
  progress.value = '0';
  progress.className = 'audio-progress';
  progress.setAttribute('aria-label', 'Audio progress');

  const time = document.createElement('span');
  time.className = 'audio-time';
  time.textContent = '0:00';

  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  audio.src = src;

  const updateProgress = () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (duration > 0) progress.value = String(Math.round((audio.currentTime / duration) * 1000));
    else progress.value = '0';
    time.textContent = `${formatAudioTime(audio.currentTime)} / ${formatAudioTime(duration)}`;
  };

  play.addEventListener('click', async () => {
    try {
      if (audio.paused) {
        pauseOtherAudioPlayers(audio);
        await audio.play();
      } else {
        audio.pause();
      }
    } catch (err) {
      showToast('Could not play audio.', true);
    }
  });

  progress.addEventListener('input', () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (duration > 0) audio.currentTime = (Number(progress.value) / 1000) * duration;
  });

  audio.addEventListener('play', () => { play.textContent = 'Ⅱ'; });
  audio.addEventListener('pause', () => { play.textContent = '▶'; });
  audio.addEventListener('ended', () => { play.textContent = '▶'; progress.value = '0'; });
  audio.addEventListener('loadedmetadata', updateProgress);
  audio.addEventListener('timeupdate', updateProgress);

  wrap.append(play, progress, time, audio);
  return wrap;
}

function ensurePreviewAudioSlot() {
  let slot = $('#previewAudioSlot');
  if (slot) return slot;
  const nativePreview = $('#previewAudio');
  if (!nativePreview) return null;
  slot = document.createElement('div');
  slot.id = 'previewAudioSlot';
  slot.className = 'themed-audio-slot preview-audio-slot';
  nativePreview.insertAdjacentElement('afterend', slot);
  nativePreview.hidden = true;
  return slot;
}

function renderPreviewAudio(src = '') {
  const nativePreview = $('#previewAudio');
  if (nativePreview) {
    nativePreview.pause?.();
    nativePreview.removeAttribute('src');
    nativePreview.load?.();
    nativePreview.hidden = true;
  }
  const slot = ensurePreviewAudioSlot();
  if (!slot) return;
  slot.innerHTML = '';
  if (previewAudioUrl && previewAudioUrl.startsWith('blob:') && previewAudioUrl !== src) {
    try { URL.revokeObjectURL(previewAudioUrl); } catch {}
  }
  previewAudioUrl = src || null;
  if (src) slot.appendChild(createThemedAudioPlayer(src));
}

function myPlayer(room = currentRoom) {
  return room?.players?.find((player) => player.id === myId) || null;
}

function requireLoginToPlay() {
  if (authUser?.username) return true;
  showScreen('accountScreen');
  showToast('Create an account or log in before playing.');
  return false;
}

function getName() {
  if (authUser?.username) {
    const playerName = $('#playerName');
    if (playerName) playerName.value = authUser.username;
    const accountName = $('#accountName');
    if (accountName) accountName.textContent = authUser.username.toUpperCase().replace(/\s+/g, '_');
    return authUser.username;
  }
  const playerName = $('#playerName');
  if (playerName) playerName.value = 'Guest';
  const accountName = $('#accountName');
  if (accountName) accountName.textContent = 'GUEST';
  return 'Guest';
}

function setNameFromStorage() {
  getName();
}

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
        authUser = await fetchProfile(idToken);
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
  if (!firebaseConfigured || !firebaseAuth) throw new Error('Firebase is not configured. Edit firebase-config.js first.');
}

async function apiRequest(path, idToken, body = null) {
  const options = {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${idToken}` }
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

function renderAuthUI() {
  const isSignedIn = !!authUser;
  const guestPanel = $('#authGuestPanel');
  const userPanel = $('#authUserPanel');
  if (guestPanel) guestPanel.hidden = isSignedIn;
  if (userPanel) userPanel.hidden = !isSignedIn;

  const accountName = $('#accountName');
  const accountWins = $('#accountWins');
  const accountLevel = $('#accountLevel');
  const playerName = $('#playerName');
  if (isSignedIn) {
    const display = authUser.username.toUpperCase().replace(/\s+/g, '_');
    if (accountName) accountName.textContent = display;
    if (playerName) { playerName.value = authUser.username; playerName.disabled = true; }
    const signedUsername = $('#authSignedUsername');
    const signedStats = $('#authSignedStats');
    if (signedUsername) signedUsername.textContent = display;
    if (signedStats) signedStats.textContent = `${authUser.wins || 0} BUCKS • ${authUser.gamesPlayed || 0} GAMES`;
    if (accountWins) accountWins.textContent = `${authUser.wins || 0} B`;
    const shopBucks = $('#shopBucks');
    if (shopBucks) shopBucks.textContent = `${authUser.wins || 0} B`;
    if (accountLevel) accountLevel.textContent = String(Math.max(1, Math.floor((authUser.wins || 0) / 300) + 1));
  } else {
    if (playerName) { playerName.disabled = false; playerName.value = 'Guest'; }
    if (accountName) accountName.textContent = 'GUEST';
    if (accountWins) accountWins.textContent = '0 B';
    const shopBucks = $('#shopBucks');
    if (shopBucks) shopBucks.textContent = '0 B';
    if (accountLevel) accountLevel.textContent = '1';
  }
}

async function loadAuthUser() {
  initFirebaseAuth();
}

function setVolumeUI() {
  const slider = $('#volumeSlider');
  const value = $('#volumeValue');
  if (slider) slider.value = uiVolume;
  if (value) value.textContent = `${uiVolume}%`;
}

function copyText(value) {
  navigator.clipboard?.writeText(value).then(() => showToast('Copied.')).catch(() => showToast('Could not copy. Copy manually.', true));
}

function updateTimer(remainingSeconds, elementId) {
  clearInterval(tickTimer);
  const el = document.getElementById(elementId);
  if (remainingSeconds == null || !el) return;
  const overlay = $('#phaseIntroOverlay');
  if (overlay && !overlay.hidden) {
    el.textContent = String(Math.max(0, Math.ceil(Number(remainingSeconds)))).padStart(2, '0');
    return;
  }
  const end = Date.now() + Math.max(0, Number(remainingSeconds)) * 1000;
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    el.textContent = String(remaining).padStart(2, '0');
    if (remaining <= 0) clearInterval(tickTimer);
  };
  tick();
  tickTimer = setInterval(tick, 250);
}

function injectPhaseIntro() {
  if ($('#phaseIntroOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'phaseIntroOverlay';
  overlay.className = 'phase-intro';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="phase-intro-card">
      <div class="phase-intro-kicker" id="phaseIntroKicker">NEXT PHASE</div>
      <h2 id="phaseIntroTitle">ROUND STARTING</h2>
      <p id="phaseIntroText">Get ready.</p>
    </div>`;
  document.body.appendChild(overlay);

  const style = document.createElement('style');
  style.id = 'phaseIntroStyles';
  style.textContent = `
    .phase-intro{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(6,3,18,.86);backdrop-filter:blur(2px)}
    .phase-intro[hidden]{display:none!important}
    .phase-intro-card{width:min(820px,88vw);border:3px solid var(--purple);background:#120822;box-shadow:0 0 44px rgba(124,58,237,.35);padding:34px;text-align:center;animation:phasePop .24s ease-out both}
    .phase-intro-kicker{color:var(--green);font-family:ui-monospace,monospace;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px}
    .phase-intro h2{font-size:clamp(32px,6.4vw,70px);line-height:.95;margin:0 0 16px;color:#fff4e4;text-transform:uppercase;overflow-wrap:normal}
    .phase-intro p{font-family:ui-monospace,monospace;color:var(--muted);font-size:15px;line-height:1.5;margin:0 auto;max-width:640px}
    @keyframes phasePop{from{transform:scale(.9);opacity:0}to{transform:scale(1);opacity:1}}
  `;
  document.head.appendChild(style);
}

function showPhaseIntro(key, kicker, title, text, duration = 7600) {
  if (!key || phaseIntroShown.has(key)) return;
  phaseIntroShown.add(key);
  const overlay = $('#phaseIntroOverlay');
  if (!overlay) return;
  const kickerEl = $('#phaseIntroKicker');
  const titleEl = $('#phaseIntroTitle');
  const textEl = $('#phaseIntroText');
  if (kickerEl) kickerEl.textContent = kicker;
  if (titleEl) titleEl.textContent = title;
  if (textEl) textEl.textContent = text;
  overlay.hidden = false;
  clearInterval(tickTimer);
  clearTimeout(showPhaseIntro.timer);
  showPhaseIntro.timer = setTimeout(() => {
    overlay.hidden = true;
    if (currentRoom) renderRoom(currentRoom);
  }, duration);
}

function updateLobbyControls(room) {
  const start = $('#startRoundBtn');
  const note = document.querySelector('.players-section .tiny-note');
  const me = myPlayer(room);
  const playerCount = room?.roomPlayersCount || room?.players?.length || room?.totalPlayers || 0;
  const isHost = !!me?.isHost;
  const waiting = !!me?.waiting;

  if (note) {
    if (waiting && room?.status !== 'lobby') {
      note.textContent = 'A round is already in progress. You are in the room and will join the next round.';
    } else if (room?.status === 'results') {
      const remaining = room.remainingSeconds != null ? ` Results close in ${room.remainingSeconds}s.` : '';
      note.textContent = `Waiting for players to return from the awards screen.${remaining}`;
    } else {
      note.textContent = 'Awards Mode needs an even number of players. Max 10 players. Host starts the round.';
    }
  }

  if (!start) return;
  const shouldShowStart = isHost && !waiting;
  start.hidden = !shouldShowStart;
  start.style.display = shouldShowStart ? '' : 'none';
  if (!shouldShowStart) return;

  if (room?.status !== 'lobby') {
    start.disabled = true;
    start.textContent = room?.status === 'results' ? 'WAITING PLAYERS' : 'ROUND IN PROGRESS';
    return;
  }

  const hasEnough = playerCount >= 2;
  const isEven = playerCount % 2 === 0;
  start.disabled = !(hasEnough && isEven);
  if (!hasEnough) start.textContent = 'NEED 2 PLAYERS';
  else if (!isEven) start.textContent = 'NEED EVEN PLAYERS';
  else start.textContent = 'START ROUND';
}

function leaveRoom() {
  socket.emit('room:leave');
  currentRoom = null;
  currentPromptVotingPayload = null;
  currentPerformanceVotingPayload = null;
  currentResultsPayload = null;
  selectedLineId = null;
  selectedScenarioId = null;
  phaseIntroShown.clear();
  localResultsDone = false;
  showScreen('playScreen');
  socket.emit('quick:list');
}

function stopActiveRecorder() {
  clearTimeout(recordStopTimer);
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  } catch {}
  try { mediaStream?.getTracks().forEach((track) => track.stop()); } catch {}
  mediaRecorder = null;
  mediaStream = null;
}

function resetRecorderUI() {
  stopActiveRecorder();
  recordedBlob = null;
  renderPreviewAudio('');
  const recordBtn = $('#recordBtn');
  const stopBtn = $('#stopBtn');
  const submitBtn = $('#submitClipBtn');
  if (recordBtn) recordBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = true;
  if (submitBtn) submitBtn.disabled = true;
  const status = $('#clipStatus');
  if (status) status.textContent = 'Waiting for microphone.';
}

function resetLocalRoundState() {
  currentPromptVotingPayload = null;
  currentPerformanceVotingPayload = null;
  currentResultsPayload = null;
  selectedLineId = null;
  selectedScenarioId = null;
  lastRecordingResetKey = null;
  localResultsDone = false;
  localAwardAppliedKey = null;
  resetRecorderUI();
  const clipList = $('#clipList');
  if (clipList) clipList.innerHTML = '';
  const promptInput = $('#promptSubmissionInput');
  if (promptInput) promptInput.value = '';
  const submitPromptBtn = $('#submitPromptBtn');
  if (submitPromptBtn) submitPromptBtn.disabled = false;
  const submitPromptVoteBtn = $('#submitPromptVoteBtn');
  if (submitPromptVoteBtn) submitPromptVoteBtn.disabled = false;
}

function playAgain() {
  localResultsDone = true;
  socket.emit('results:done');
  showScreen('lobbyScreen');
  updateLobbyControls(currentRoom);
  showToast('Back in the room. Waiting for the next round.');
}

function injectAwardsScreens() {
  if ($('#writingScreen')) return;
  const recordScreen = $('#recordScreen');
  if (!recordScreen) return;

  const writing = document.createElement('section');
  writing.className = 'modal-wrap screen';
  writing.id = 'writingScreen';
  writing.innerHTML = `
    <div class="modal">
      <div class="modal-inner">
        <h2 class="modal-title" id="writingMainTitle">WRITE</h2>
        <div class="modal-kicker" id="writingKicker" hidden></div>
        <div class="timer" id="writingTimer">45</div>
        <div class="section">
          <h3 id="writingRoleTitle">YOUR CATEGORY</h3>
          <p id="writingInstructions">Write something short.</p>
          <textarea id="promptSubmissionInput" class="prompt-input" maxlength="130" placeholder="Type here..."></textarea>
          <div class="action-row"><button class="pixel-btn" id="submitPromptBtn">SUBMIT</button></div>
          <p class="tiny-note" id="writingHint">Keep it short. The winning line and scenario will be performed by everyone.</p>
        </div>
        <div class="waiting-bar"><span id="writingSubmittedCount">0</span>/<span id="writingTotalPlayers">0</span> submitted</div>
      </div>
    </div>`;

  const promptVote = document.createElement('section');
  promptVote.className = 'modal-wrap screen';
  promptVote.id = 'promptVoteScreen';
  promptVote.innerHTML = `
    <div class="modal">
      <div class="modal-inner">
        <h2 class="modal-title prompt-vote-title">VOTE FOR THE BEST LINE AND SCENARIO</h2>
        <div class="modal-kicker">THE MOST VOTED LINE AND SCENARIO WILL BE PERFORMED BY EVERYONE.</div>
        <div class="timer" id="promptVoteTimer">25</div>
        <div class="awards-vote-grid">
          <div class="section"><h3>BEST LINE</h3><div id="lineOptionsList" class="option-list"></div></div>
          <div class="section"><h3>BEST SCENARIO</h3><div id="scenarioOptionsList" class="option-list"></div></div>
        </div>
        <div class="action-row"><button class="pixel-btn" id="submitPromptVoteBtn">LOCK IN VOTES</button></div>
        <div class="waiting-bar"><span id="promptVotedCount">0</span> votes in</div>
      </div>
    </div>`;

  recordScreen.before(writing, promptVote);

  const style = document.createElement('style');
  style.id = 'awardsModeStyles';
  style.textContent = `
    #startRoundBtn{display:none}.modal-title{padding-right:130px}.timer{position:relative;z-index:2}#writingScreen .modal-title,#promptVoteScreen .modal-title,#votingScreen .modal-title{font-size:clamp(24px,4.4vw,48px);line-height:.95}.prompt-input{width:100%;min-height:110px;background:#140a24;color:#fff4e4;border:2px solid var(--purple);border-radius:12px;padding:14px;font-family:ui-monospace,monospace;font-size:14px;resize:vertical;box-sizing:border-box;text-transform:none}
    .awards-vote-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .option-list{display:grid;gap:10px}
    .option-card{display:block;width:100%;text-align:left;background:#140a24;color:#fff4e4;border:2px solid #3f1d70;border-radius:14px;padding:12px;cursor:pointer;font-family:ui-monospace,monospace;text-transform:none}
    .option-card.selected{border-color:var(--green);box-shadow:0 0 0 2px rgba(34,197,94,.2)}
    .option-card small{display:block;color:var(--muted);margin-top:6px;text-transform:uppercase;font-size:9px}
    .award-card{position:relative;overflow:hidden;background:#140a24;border:2px solid #3f1d70;border-radius:16px;padding:16px;margin:12px 0;animation:awardReveal .62s ease-out both}
    .award-card:nth-child(1){animation-delay:.08s}.award-card:nth-child(2){animation-delay:.34s}.award-card:nth-child(3){animation-delay:.58s}.award-card:nth-child(4){animation-delay:.82s}
    .award-card:before{content:'';position:absolute;inset:0;background:linear-gradient(110deg,transparent 0%,rgba(45,212,191,.18) 45%,transparent 62%);transform:translateX(-130%);animation:awardShine 1.4s ease-out both;animation-delay:.35s;pointer-events:none}
    .main-award{border-color:var(--green);box-shadow:0 0 28px rgba(45,212,191,.25);animation:awardReveal .62s ease-out both,awardPulse 1.7s ease-in-out .7s 2}
    .award-title{color:var(--green);font-size:12px;text-transform:uppercase;margin-bottom:6px;letter-spacing:1px}
    .award-value{font-size:20px;color:#fff4e4;margin-bottom:6px;line-height:1.15}
    .award-winner{color:var(--muted);font-size:11px;text-transform:uppercase}.award-bucks{color:var(--green);font-size:13px;text-transform:uppercase;margin-top:6px}
    .prompt-vote-title{font-size:clamp(28px,4.8vw,56px);line-height:.95}
    #votingScreen .modal-title{font-size:clamp(30px,5vw,58px);line-height:.96}
    .clip-card{background:#10091d;border:2px solid #3f1d70;border-radius:14px;padding:16px;margin:14px 0;box-shadow:0 0 0 1px rgba(124,58,237,.12)}
    .clip-title{color:#fff4e4;margin-bottom:10px;letter-spacing:.5px}
    .clip-card .vote-btn{margin-top:10px}.own-clip-note{margin-top:10px;color:var(--muted);font-size:9px;text-transform:uppercase}
    .preview-audio-slot{margin-top:12px}.themed-audio{display:grid;grid-template-columns:48px 1fr 118px;gap:12px;align-items:center;width:100%;padding:12px;background:#070a18;border:1px solid rgba(45,212,191,.25);box-shadow:inset 0 0 20px rgba(45,212,191,.05)}
    .themed-audio audio{display:none}
    .audio-play-btn{height:38px;width:42px;border:1px solid var(--green);background:#111827;color:#fff4e4;cursor:pointer;font-family:inherit;font-size:12px;box-shadow:0 0 12px rgba(45,212,191,.12)}
    .audio-play-btn:hover{background:#172033;color:var(--green)}
    .audio-progress{-webkit-appearance:none!important;appearance:none!important;width:100%;height:16px;background:#050816!important;border:1px solid rgba(139,92,246,.35);cursor:pointer;border-radius:0!important;padding:0!important;accent-color:var(--green)}
    .audio-progress::-webkit-slider-runnable-track{height:16px;background:linear-gradient(90deg,rgba(45,212,191,.92),rgba(139,92,246,.92));box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
    .audio-progress::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:26px;margin-top:-6px;background:#fff4e4;border:2px solid var(--green);box-shadow:3px 3px 0 #050816}
    .audio-progress::-moz-range-track{height:16px;background:linear-gradient(90deg,rgba(45,212,191,.92),rgba(139,92,246,.92));border:1px solid rgba(255,255,255,.06)}
    .audio-progress::-moz-range-thumb{width:16px;height:26px;background:#fff4e4;border:2px solid var(--green);border-radius:0}
    .audio-time{font-family:ui-monospace,monospace;font-size:12px;color:var(--muted);white-space:nowrap;text-align:right}
    .shop-grid{display:grid;gap:16px}.shop-row{border:1px solid rgba(139,92,246,.22);background:rgba(7,10,24,.62);padding:16px}.shop-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.shop-item{border:1px solid rgba(45,212,191,.24);background:#0a1020;padding:14px;min-height:96px}.shop-item strong{display:block;font-size:18px;color:#fff4e4;margin-bottom:9px}.shop-item small{display:block;color:var(--muted);font-size:8px}.shop-price{color:var(--green);font-size:11px;margin-top:10px}.shop-locked{margin-top:10px;border:1px solid rgba(255,255,255,.1);padding:8px;text-align:center;color:var(--muted);font-size:8px}
    @keyframes awardReveal{from{opacity:0;transform:translateY(28px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
    @keyframes awardPulse{0%,100%{box-shadow:0 0 28px rgba(45,212,191,.25)}50%{box-shadow:0 0 52px rgba(45,212,191,.55)}}
    @keyframes awardShine{to{transform:translateX(130%)}}
    @media(max-width:700px){.awards-vote-grid{grid-template-columns:1fr}.prompt-input{min-height:90px}.award-value{font-size:17px}}
  `;
  document.head.appendChild(style);

  $('#submitPromptBtn')?.addEventListener('click', submitPromptEntry);
  $('#submitPromptVoteBtn')?.addEventListener('click', submitPromptVote);
}

function renderPlayers(players = []) {
  const playersList = $('#playersList');
  if (!playersList) return;
  playersList.innerHTML = '';
  players.forEach((player) => {
    const div = document.createElement('div');
    div.className = 'player-chip';
    let status = player.isHost ? 'HOST' : 'READY';
    if (player.waiting) status = 'NEXT ROUND';
    else if (currentRoom?.status === 'writing') status = player.submitted ? 'WRITTEN' : (player.role === 'line' ? 'LINE' : 'SCENARIO');
    if (currentRoom?.status === 'promptVoting') status = player.voted ? 'VOTED' : 'VOTING';
    if (currentRoom?.status === 'recording') status = player.submitted ? 'SUBMITTED' : 'RECORDING';
    if (!player.waiting && currentRoom?.status === 'performanceVoting') status = player.voted ? 'VOTED' : 'VOTING';
    if (!player.waiting && currentRoom?.status === 'results') status = player.voted ? 'IN ROOM' : 'AWARDS';
    div.innerHTML = `<span>${escapeHtml(player.name)}</span><small>${status}</small>`;
    playersList.appendChild(div);
  });
}

function renderQuickRooms(list = quickRooms) {
  quickRooms = list;
  const wrap = $('#quickRoomsList');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-state">NO ACTIVE QUICK ROOMS RIGHT NOW.</div>';
    return;
  }
  list.forEach((room) => {
    const card = document.createElement('button');
    card.className = 'room-card';
    card.type = 'button';
    card.dataset.code = room.code;
    card.innerHTML = `
      <div><div class="room-host">${escapeHtml(room.hostName)}</div><div class="room-sub">${room.playersCount}/${room.maxPlayers} PLAYERS</div></div>
      <div class="room-right"><span class="room-code">${room.code}</span><small>QUICK</small></div>`;
    wrap.appendChild(card);
  });
}

function renderLeaderboard(list = leaderboard) {
  leaderboard = list;
  const body = $('#leaderboardBody');
  if (!body) return;
  body.innerHTML = '';
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="4" class="tiny-note">No results yet. Play a round and the leaderboard will populate.</td></tr>';
    return;
  }
  list.forEach((entry) => {
    const rankClass = entry.rank === 1 ? 'gold' : entry.rank === 2 ? 'silver' : entry.rank === 3 ? 'bronze' : '';
    const row = document.createElement('tr');
    row.innerHTML = `<td class="rank ${rankClass}">${entry.rank}</td><td class="player">${escapeHtml(entry.name)}${entry.isAccount ? ' ✓' : ''}</td><td class="score">${entry.wins}</td><td>${entry.winRate}%</td>`;
    body.appendChild(row);
  });
}

function renderWriting(room) {
  showScreen('writingScreen');
  updateTimer(room.remainingSeconds, 'writingTimer');
  const me = myPlayer(room);
  const role = me?.role || 'line';
  const mainTitle = $('#writingMainTitle');
  const roleTitle = $('#writingRoleTitle');
  const instructions = $('#writingInstructions');
  const input = $('#promptSubmissionInput');
  const submit = $('#submitPromptBtn');
  if (roleTitle) roleTitle.hidden = true;
  if (instructions) instructions.hidden = true;
  if (role === 'scenario') {
    if (mainTitle) mainTitle.textContent = 'WRITE A SCENARIO';
    if (input) input.placeholder = 'you just got caught eating the wedding cake';
    if (submit) submit.textContent = 'SUBMIT SCENARIO';
  } else {
    if (mainTitle) mainTitle.textContent = 'WRITE A LINE';
    if (input) input.placeholder = 'I can explain.';
    if (submit) submit.textContent = 'SUBMIT LINE';
  }
  if (submit) submit.disabled = !!me?.submitted;
  const submitted = $('#writingSubmittedCount');
  const total = $('#writingTotalPlayers');
  if (submitted) submitted.textContent = room.submittedCount || 0;
  if (total) total.textContent = room.totalPlayers || 0;
}

function submitPromptEntry() {
  const input = $('#promptSubmissionInput');
  const text = input?.value.trim() || '';
  socket.emit('prompt:submit', { text });
}

function renderPromptOptions(containerId, options, selectedId, type) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  options.forEach((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `option-card${option.id === selectedId ? ' selected' : ''}`;
    button.dataset.id = option.id;
    button.innerHTML = `${type === 'line' ? `"${escapeHtml(option.text)}"` : `like ${escapeHtml(option.text)}`}<small>by ${escapeHtml(option.authorName || 'THE ACADEMY')}</small>`;
    button.addEventListener('click', () => {
      if (type === 'line') selectedLineId = option.id;
      else selectedScenarioId = option.id;
      renderPromptVoting(currentRoom, currentPromptVotingPayload);
    });
    container.appendChild(button);
  });
}

function renderPromptVoting(room, payload = null) {
  showScreen('promptVoteScreen');
  updateTimer(room.remainingSeconds, 'promptVoteTimer');
  const lines = payload?.lines || room.promptOptions?.lines || [];
  const scenarios = payload?.scenarios || room.promptOptions?.scenarios || [];
  if (!selectedLineId && lines[0]) selectedLineId = lines[0].id;
  if (!selectedScenarioId && scenarios[0]) selectedScenarioId = scenarios[0].id;
  renderPromptOptions('lineOptionsList', lines, selectedLineId, 'line');
  renderPromptOptions('scenarioOptionsList', scenarios, selectedScenarioId, 'scenario');
  const voted = $('#promptVotedCount');
  if (voted) voted.textContent = room.votedCount || 0;
  const submit = $('#submitPromptVoteBtn');
  if (submit) submit.disabled = !!myPlayer(room)?.voted;
}

function submitPromptVote() {
  if (!selectedLineId || !selectedScenarioId) {
    showToast('Pick one line and one scenario.', true);
    return;
  }
  socket.emit('prompt:vote', { lineId: selectedLineId, scenarioId: selectedScenarioId });
}

function renderRecording(room) {
  showScreen('recordScreen');
  const recordingKey = `${room.code || 'room'}-${room.round || 0}`;
  if (lastRecordingResetKey !== recordingKey) {
    lastRecordingResetKey = recordingKey;
    resetRecorderUI();
  }
  const me = myPlayer(room);
  if (me?.submitted) lockRecorderAfterSubmit();
  updateTimer(room.remainingSeconds, 'recordTimer');
  const line = $('#roundLine');
  const style = $('#roundStyle');
  if (line) line.textContent = room.prompt?.line || '—';
  if (style) style.textContent = scenarioText(room.prompt);
  const submitted = $('#submittedCount');
  const total = $('#totalPlayers');
  if (submitted) submitted.textContent = room.submittedCount || 0;
  if (total) total.textContent = room.totalPlayers || 0;
}

function renderClipVoting(payload = currentPerformanceVotingPayload) {
  if (!payload) return;
  showScreen('votingScreen');
  const votingTitle = $('#votingScreen .modal-title');
  const votingKicker = $('#votingScreen .modal-kicker');
  if (votingTitle) votingTitle.textContent = 'VOTE FOR BEST PERFORMANCE';
  if (votingKicker) votingKicker.textContent = '';
  updateTimer(payload.remainingSeconds, 'voteTimer');
  const line = $('#voteLine');
  const style = $('#voteStyle');
  if (line) line.textContent = payload.prompt?.line || '—';
  if (style) style.textContent = scenarioText(payload.prompt);

  const list = $('#clipList');
  if (!list) return;
  list.innerHTML = '';
  payload.clips.forEach((clip) => {
    const card = document.createElement('div');
    card.className = 'clip-card';
    const isOwn = clip.clipId === payload.ownClipId;
    card.innerHTML = `
      <div class="clip-title">PERFORMANCE ${escapeHtml(clip.label)}${isOwn ? ' • YOURS' : ''}</div>
      <div class="themed-audio-slot"></div>
      ${isOwn ? '<div class="own-clip-note">YOU CANNOT VOTE FOR YOURSELF</div>' : '<button class="pixel-btn vote-btn">VOTE BEST PERFORMANCE</button>'}`;
    card.querySelector('.themed-audio-slot')?.appendChild(createThemedAudioPlayer(clip.audioData));
    if (!isOwn) card.querySelector('.vote-btn')?.addEventListener('click', () => socket.emit('vote:submit', { clipId: clip.clipId }));
    list.appendChild(card);
  });
  const voted = $('#votedCount');
  if (voted && currentRoom) voted.textContent = currentRoom.votedCount || 0;
}


function applyLocalAwardBucks(payload) {
  if (!authUser || !payload?.awards || !currentRoom) return;
  const player = myPlayer(currentRoom);
  if (!player || player.waiting) return;
  const key = `${currentRoom.code || 'room'}-${currentRoom.round || 'round'}`;
  if (localAwardAppliedKey === key) return;
  localAwardAppliedKey = key;
  let earned = 0;
  const awards = payload.awards;
  if (awards.bestPerformance?.winnerId === myId) earned += awards.bestPerformance.bucks || 100;
  if (awards.bestLine?.winnerId === myId) earned += awards.bestLine.bucks || 50;
  if (awards.bestScenario?.winnerId === myId) earned += awards.bestScenario.bucks || 50;
  authUser.wins = (authUser.wins || 0) + earned;
  authUser.gamesPlayed = (authUser.gamesPlayed || 0) + 1;
  renderAuthUI();
  const shopBucks = $('#shopBucks');
  if (shopBucks) shopBucks.textContent = `${authUser.wins || 0} B`;
}

function renderResults(payload = currentResultsPayload) {
  if (!payload) return;
  showScreen('resultsScreen');
  winSound();
  const winnerText = $('#winnerText');
  if (winnerText) winnerText.textContent = 'SAYITLIKE AWARDS CEREMONY';
  const list = $('#resultsList');
  if (!list) return;
  const awards = payload.awards || {};
  const bestPerformance = awards.bestPerformance || {};
  const bestLine = awards.bestLine || {};
  const bestScenario = awards.bestScenario || {};
  const performanceBucks = bestPerformance.bucks || 100;
  const lineBucks = bestLine.bucks || 50;
  const scenarioBucks = bestScenario.bucks || 50;

  applyLocalAwardBucks(payload);

  list.innerHTML = `
    <div class="award-card main-award"><div class="award-title">THE BIG AWARD • BEST PERFORMANCE</div><div class="award-value">${escapeHtml(bestPerformance.winnerName || 'Nobody')}</div><div class="award-winner">${bestPerformance.clipId ? `${bestPerformance.votes || 0} votes` : 'No winning clip'}</div><div class="award-bucks">+${performanceBucks} BUCKS</div></div>
    <div class="award-card"><div class="award-title">BEST LINE</div><div class="award-value">"${escapeHtml(bestLine.text || payload.prompt?.line || '—')}"</div><div class="award-winner">${escapeHtml(bestLine.winnerName || 'THE ACADEMY')}</div><div class="award-bucks">+${lineBucks} BUCKS</div></div>
    <div class="award-card"><div class="award-title">BEST SCENARIO</div><div class="award-value">${escapeHtml(scenarioText({ scenario: bestScenario.text || payload.prompt?.scenario || '—' }))}</div><div class="award-winner">${escapeHtml(bestScenario.winnerName || 'THE ACADEMY')}</div><div class="award-bucks">+${scenarioBucks} BUCKS</div></div>
    <div class="award-card"><div class="award-title">FINAL PROMPT</div><div class="award-value">${escapeHtml(promptText(payload.prompt))}</div></div>
  `;
  const playAgain = $('#playAgainBtn');
  if (playAgain) {
    playAgain.hidden = false;
    playAgain.disabled = localResultsDone;
    playAgain.textContent = localResultsDone ? 'WAITING...' : 'BACK TO ROOM';
  }
  const backToLobby = $('#backToLobbyBtn');
  if (backToLobby) {
    backToLobby.hidden = false;
    backToLobby.textContent = 'RETURN TO MAIN MENU';
  }
  if (winnerText && payload.remainingSeconds != null) winnerText.textContent = `SAYITLIKE AWARDS CEREMONY • ${payload.remainingSeconds}s`;
}

function renderRoom(room) {
  currentRoom = room;
  if ($('#roomCodeDisplay')) $('#roomCodeDisplay').textContent = room.code || '-----';
  if ($('#lobbyMode')) $('#lobbyMode').textContent = room.isQuick ? 'QUICK' : 'CUSTOM';
  if ($('#activePlayers')) $('#activePlayers').textContent = String(room.roomPlayersCount || room.totalPlayers || room.players?.length || 0).padStart(3, '0');
  if ($('#roomLink')) {
    const mode = room.isQuick ? 'quick' : 'custom';
    $('#roomLink').value = `${location.origin}${location.pathname}?room=${room.code}&mode=${mode}`;
  }
  renderPlayers(room.players || []);
  updateLobbyControls(room);

  const me = myPlayer(room);
  const waitingForNextRound = !!me?.waiting && room.status !== 'lobby';

  if (room.status === 'lobby') {
    localResultsDone = false;
    showScreen('lobbyScreen');
    return;
  }

  if (waitingForNextRound) {
    showScreen('lobbyScreen');
    return;
  }

  if (room.status === 'writing') {
    renderWriting(room);
    const writingRole = myPlayer(room)?.role === 'scenario' ? 'WRITE A SCENARIO' : 'WRITE A LINE';
    showPhaseIntro(`writing-${room.round}`, 'FIRST PHASE', writingRole, 'Half the players in the room write short lines. The other half write scenarios.', 7600);
  }
  if (room.status === 'promptVoting') {
    renderPromptVoting(room, currentPromptVotingPayload);
    showPhaseIntro(`promptVoting-${room.round}`, 'NEXT PHASE', 'VOTE FOR THE BEST LINE AND SCENARIO', 'The most voted line and scenario will be performed by everyone.', 7600);
  }
  if (room.status === 'recording') {
    renderRecording(room);
    showPhaseIntro(`recording-${room.round}`, 'NEXT PHASE', 'PERFORM', 'Record your best version of the winning prompt. Commit to it. You get one performance.', 7600);
  }
  if (room.status === 'performanceVoting') {
    renderClipVoting(currentPerformanceVotingPayload);
    showPhaseIntro(`performanceVoting-${room.round}`, 'LAST PHASE', 'VOTE BEST PERFORMANCE', 'Listen and vote for the strongest performance. You cannot vote on yourself. This award pays the most Bucks.', 7600);
  }
  if (room.status === 'results') {
    const resultsPayload = { ...(currentResultsPayload || {}), prompt: room.prompt || currentResultsPayload?.prompt, awards: room.awards || currentResultsPayload?.awards, clips: currentResultsPayload?.clips || [], remainingSeconds: room.remainingSeconds };
    currentResultsPayload = resultsPayload;
    if (localResultsDone) {
      showScreen('lobbyScreen');
      updateLobbyControls(room);
    } else {
      renderResults(resultsPayload);
      showPhaseIntro(`results-${room.round}`, 'AWARDS', 'AWARDS CEREMONY', 'The winners are about to be revealed. Best Performance pays the most.', 2600);
    }
  }
}

async function startRecording() {
  try {
    recordedBlob = null;
    renderPreviewAudio('');
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream);
    const chunks = [];
    mediaRecorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    mediaRecorder.onstop = () => {
      recordedBlob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      renderPreviewAudio(URL.createObjectURL(recordedBlob));
      if ($('#submitClipBtn')) $('#submitClipBtn').disabled = false;
      if ($('#clipStatus')) $('#clipStatus').textContent = 'Preview your clip, then submit.';
      mediaStream?.getTracks().forEach((track) => track.stop());
    };
    mediaRecorder.start();
    if ($('#recordBtn')) $('#recordBtn').disabled = true;
    if ($('#stopBtn')) $('#stopBtn').disabled = false;
    if ($('#submitClipBtn')) $('#submitClipBtn').disabled = true;
    if ($('#clipStatus')) $('#clipStatus').textContent = 'Recording... keep it under 10 seconds.';
    clearTimeout(recordStopTimer);
    recordStopTimer = setTimeout(stopRecording, 10000);
  } catch (err) {
    showToast('Microphone access failed.', true);
  }
}

function stopRecording() {
  clearTimeout(recordStopTimer);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if ($('#recordBtn')) $('#recordBtn').disabled = false;
  if ($('#stopBtn')) $('#stopBtn').disabled = true;
}

function submitClip() {
  if (!recordedBlob) {
    showToast('Record a clip first.', true);
    return;
  }
  const reader = new FileReader();
  reader.onloadend = () => {
    socket.emit('clip:submit', { audioData: reader.result, mimeType: recordedBlob.type || 'audio/webm' });
  };
  reader.readAsDataURL(recordedBlob);
}

function lockRecorderAfterSubmit() {
  if ($('#recordBtn')) $('#recordBtn').disabled = true;
  if ($('#stopBtn')) $('#stopBtn').disabled = true;
  if ($('#submitClipBtn')) $('#submitClipBtn').disabled = true;
  if ($('#clipStatus')) $('#clipStatus').textContent = 'Submitted. Waiting for the other players.';
}


function returnToMainMenuFromResults() {
  resetLocalRoundState();
  phaseIntroShown.clear();
  localResultsDone = false;
  socket.emit('room:leave');
  showScreen('homeScreen');
}

function setupEvents() {
  $$('.menu-btn[data-screen], .back-btn[data-screen]').forEach((btn) => {
    btn.addEventListener('click', () => { menuSound(); showScreen(btn.dataset.screen); });
  });

  $('#accountCard')?.addEventListener('click', () => showScreen('accountScreen'));
  $('#soundToggle')?.addEventListener('click', () => {
    const panel = $('#volumePanel');
    if (panel) panel.classList.toggle('open');
  });
  $('#volumeSlider')?.addEventListener('input', (event) => {
    uiVolume = Number(event.target.value);
    localStorage.setItem('sayitlike_volume', String(uiVolume));
    setVolumeUI();
  });

  $$('[data-quick-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('[data-quick-tab]').forEach((el) => el.classList.remove('active'));
      $$('.quick-pane').forEach((el) => el.classList.remove('active'));
      tab.classList.add('active');
      const pane = tab.dataset.quickTab === 'create' ? $('#quickCreatePane') : $('#quickRoomsPane');
      pane?.classList.add('active');
    });
  });

  $('#refreshQuickRoomsBtn')?.addEventListener('click', () => socket.emit('quick:list'));
  $('#createQuickRoomBtn')?.addEventListener('click', () => { if (requireLoginToPlay()) socket.emit('quick:create', { name: getName() }); });
  $('#joinQuickRoomBtn')?.addEventListener('click', () => { if (requireLoginToPlay()) socket.emit('quick:join', { name: getName(), code: $('#quickRoomCodeInput')?.value }); });
  $('#quickRoomsList')?.addEventListener('click', (event) => {
    const card = event.target.closest('.room-card');
    if (card && requireLoginToPlay()) socket.emit('quick:join', { name: getName(), code: card.dataset.code });
  });

  $('#createRoomBtn')?.addEventListener('click', () => { if (requireLoginToPlay()) socket.emit('custom:create', { name: getName() }); });
  $('#joinRoomBtn')?.addEventListener('click', () => { if (requireLoginToPlay()) socket.emit('custom:join', { name: getName(), code: $('#roomCodeInput')?.value }); });
  $('#copyRoomBtn')?.addEventListener('click', () => copyText($('#roomLink')?.value || ''));
  $('#startRoundBtn')?.addEventListener('click', () => socket.emit('round:start'));
  $('#leaveLobbyBtn')?.addEventListener('click', leaveRoom);
  $('#leaveLobbyBtn2')?.addEventListener('click', leaveRoom);
  $('#backToLobbyBtn')?.addEventListener('click', returnToMainMenuFromResults);
  $('#playAgainBtn')?.addEventListener('click', playAgain);
  $('#recordBtn')?.addEventListener('click', startRecording);
  $('#stopBtn')?.addEventListener('click', stopRecording);
  $('#submitClipBtn')?.addEventListener('click', submitClip);

  socket.on('app:hello', ({ playerId, user }) => {
    myId = playerId;
    if (user) {
      authUser = user;
      renderAuthUI();
    }
  });
  socket.on('app:error', (message) => showToast(message, true));
  socket.on('game:notice', (message) => showToast(message));
  socket.on('quick:list', renderQuickRooms);
  socket.on('leaderboard:update', renderLeaderboard);
  socket.on('room:joined', () => showScreen('lobbyScreen'));
  socket.on('room:left', () => { resetLocalRoundState(); phaseIntroShown.clear(); localResultsDone = false; showScreen('playScreen'); });
  socket.on('room:update', renderRoom);
  socket.on('round:writing', () => { resetLocalRoundState(); });
  socket.on('prompt:submitted', () => {
    const btn = $('#submitPromptBtn');
    if (btn) btn.disabled = true;
    showToast('Nominee submitted.');
  });
  socket.on('round:prompt-voting', (payload) => {
    currentPromptVotingPayload = payload;
    selectedLineId = payload.lines?.[0]?.id || null;
    selectedScenarioId = payload.scenarios?.[0]?.id || null;
    if (currentRoom) renderPromptVoting(currentRoom, payload);
  });
  socket.on('prompt:vote-submitted', () => showToast('Votes submitted.'));
  socket.on('round:recording', ({ prompt, remainingSeconds }) => {
    if (currentRoom) {
      currentRoom.prompt = prompt;
      currentRoom.remainingSeconds = remainingSeconds;
      renderRecording(currentRoom);
    }
  });
  socket.on('clip:submitted', lockRecorderAfterSubmit);
  socket.on('round:performance-voting', (payload) => {
    stopActiveRecorder();
    currentPerformanceVotingPayload = payload;
    renderClipVoting(payload);
  });
  socket.on('vote:submitted', () => showToast('Vote submitted.'));
  socket.on('results:done', () => { localResultsDone = true; showScreen('lobbyScreen'); updateLobbyControls(currentRoom); });
  socket.on('round:back-to-lobby', () => { localResultsDone = false; resetLocalRoundState(); showScreen('lobbyScreen'); });
  socket.on('round:results', (payload) => {
    currentResultsPayload = payload;
    renderResults(payload);
  });
}


function injectShopScreen() {
  if ($('#shopScreen')) return;
  const hallScreen = $('#hallScreen');
  const shop = document.createElement('section');
  shop.className = 'modal-wrap screen';
  shop.id = 'shopScreen';
  shop.innerHTML = `
    <div class="modal small">
      <button class="modal-close back-btn" data-screen="homeScreen">X</button>
      <div class="modal-inner">
        <h2 class="modal-title">SHOP</h2>
        <div class="modal-kicker">VOICEBUCKS <span id="shopBucks">${authUser?.wins || 0} B</span></div>
        <div class="shop-grid">
          <div class="shop-row">
            <h3>REVEAL ANIMATIONS</h3>
            <div class="shop-cards">
              <div class="shop-item"><strong>GLITCH</strong><small>COMING SOON</small><div class="shop-locked">LOCKED</div></div>
              <div class="shop-item"><strong>OSCAR</strong><small>COMING SOON</small><div class="shop-locked">LOCKED</div></div>
              <div class="shop-item"><strong>CHAOS</strong><small>COMING SOON</small><div class="shop-locked">LOCKED</div></div>
            </div>
          </div>
          <div class="shop-row">
            <h3>PROFILE THEMES</h3>
            <div class="shop-cards">
              <div class="shop-item"><strong>GHOST</strong><small>800 B</small><div class="shop-locked">NOT ENOUGH</div></div>
              <div class="shop-item"><strong>ROYAL</strong><small>1500 B</small><div class="shop-locked">NOT ENOUGH</div></div>
              <div class="shop-item"><strong>NEON</strong><small>2500 B</small><div class="shop-locked">NOT ENOUGH</div></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  (hallScreen || document.querySelector('.game-frame'))?.before(shop);
}

function initCopy() {
  injectShopScreen();
  const subtitle = $('.logo-subtitle');
  if (subtitle) subtitle.textContent = 'WRITE THE LINE • WRITE THE SCENARIO • WIN THE PERFORMANCE';
  const mainHowButton = $('#homeScreen .menu-btn[data-screen="howScreen"]');
  if (mainHowButton) {
    mainHowButton.dataset.screen = 'shopScreen';
    const strong = mainHowButton.querySelector('strong');
    const small = mainHowButton.querySelector('small');
    if (strong) strong.textContent = 'SHOP';
    if (small) small.textContent = 'PROFILE THEMES + REWARDS';
  }
  const shopBucks = $('#shopBucks');
  if (shopBucks) shopBucks.textContent = `${authUser?.wins || 0} B`;
  const how = $('#howScreen .modal-inner');
  if (how) {
    how.innerHTML = `
      <h2 class="modal-title">HOW TO PLAY</h2>
      <div class="modal-kicker">SAYITLIKE AWARDS MODE</div>
      <div class="section"><h3>1. WRITE</h3><p>Half the players write lines. Half write scenarios that complete <strong>Say it like...</strong></p></div>
      <div class="section"><h3>2. VOTE FOR THE BEST LINE AND SCENARIO</h3><p>The most voted line and scenario will be performed by everyone.</p></div>
      <div class="section"><h3>3. PERFORM</h3><p>Everyone records the same winning prompt.</p></div>
      <div class="section"><h3>4. AWARDS</h3><p>Best Performance pays 100 Bucks. Best Line and Best Scenario pay 50 Bucks each.</p></div>`;
  }

  document.querySelectorAll('.footer-links a, .footer-links button').forEach((link) => {
    if (link.textContent.trim().toUpperCase() === 'HOW TO PLAY') {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        showScreen('howScreen');
      });
    }
  });

  const roundScenarioLabel = $('#roundStyle')?.previousElementSibling;
  if (roundScenarioLabel) roundScenarioLabel.textContent = 'SCENARIO';
  const voteScenarioLabel = $('#voteStyle')?.previousElementSibling;
  if (voteScenarioLabel) voteScenarioLabel.textContent = 'SCENARIO';
  const recordKicker = $('#recordScreen .modal-kicker');
  if (recordKicker) recordKicker.textContent = '35 SECONDS TO SUBMIT • 10 SECOND MAX CLIP';
  const votingTitle = $('#votingScreen .modal-title');
  if (votingTitle) votingTitle.textContent = 'VOTE FOR BEST PERFORMANCE';
  const votingKicker = $('#votingScreen .modal-kicker');
  if (votingKicker) votingKicker.textContent = '';
  const voteTimer = $('#voteTimer');
  if (voteTimer) voteTimer.textContent = '45';
  const recordTimer = $('#recordTimer');
  if (recordTimer) recordTimer.textContent = '35';
}

document.addEventListener('DOMContentLoaded', () => {
  injectAwardsScreens();
  injectPhaseIntro();
  initCopy();
  setVolumeUI();
  setNameFromStorage();
  setupEvents();
  loadAuthUser();

  const params = new URLSearchParams(location.search);
  const roomCode = params.get('room');
  const roomMode = (params.get('mode') || '').toLowerCase();
  if (roomCode) {
    const code = roomCode.toUpperCase().slice(0, 5);
    const customInput = $('#roomCodeInput');
    const quickInput = $('#quickRoomCodeInput');
    if (customInput) customInput.value = code;
    if (quickInput) quickInput.value = code;
    showScreen(roomMode === 'quick' ? 'quickScreen' : 'customScreen');
  }
});
