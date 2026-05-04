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
let lastPhaseIntroKey = null;
let lastRecordingResetKey = null;

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
    if (accountLevel) accountLevel.textContent = String(Math.max(1, Math.floor((authUser.wins || 0) / 300) + 1));
  } else {
    if (playerName) { playerName.disabled = false; playerName.value = 'Guest'; }
    if (accountName) accountName.textContent = 'GUEST';
    if (accountWins) accountWins.textContent = '0 B';
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
      <div class="phase-intro-kicker">NEXT CATEGORY</div>
      <h2 id="phaseIntroTitle">ROUND STARTING</h2>
      <p id="phaseIntroText">Get ready.</p>
    </div>`;
  document.body.appendChild(overlay);

  const style = document.createElement('style');
  style.id = 'phaseIntroStyles';
  style.textContent = `
    .phase-intro{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(6,3,18,.86);backdrop-filter:blur(2px)}
    .phase-intro[hidden]{display:none!important}
    .phase-intro-card{width:min(760px,86vw);border:3px solid var(--purple);background:#120822;box-shadow:0 0 44px rgba(124,58,237,.35);padding:34px;text-align:center;animation:phasePop .24s ease-out both}
    .phase-intro-kicker{color:var(--green);font-family:ui-monospace,monospace;font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px}
    .phase-intro h2{font-size:clamp(36px,8vw,78px);line-height:.95;margin:0 0 16px;color:#fff4e4;text-transform:uppercase}
    .phase-intro p{font-family:ui-monospace,monospace;color:var(--muted);font-size:15px;line-height:1.5;margin:0 auto;max-width:640px}
    @keyframes phasePop{from{transform:scale(.9);opacity:0}to{transform:scale(1);opacity:1}}
  `;
  document.head.appendChild(style);
}

function showPhaseIntro(key, title, text) {
  if (!key || lastPhaseIntroKey === key) return;
  lastPhaseIntroKey = key;
  const overlay = $('#phaseIntroOverlay');
  if (!overlay) return;
  const titleEl = $('#phaseIntroTitle');
  const textEl = $('#phaseIntroText');
  if (titleEl) titleEl.textContent = title;
  if (textEl) textEl.textContent = text;
  overlay.hidden = false;
  clearTimeout(showPhaseIntro.timer);
  showPhaseIntro.timer = setTimeout(() => { overlay.hidden = true; }, 7600);
}

function updateLobbyControls(room) {
  const start = $('#startRoundBtn');
  const note = document.querySelector('.players-section .tiny-note');
  const me = myPlayer(room);
  const playerCount = room?.players?.length || room?.totalPlayers || 0;
  const isHost = !!me?.isHost;

  if (note) note.textContent = 'Awards Mode needs an even number of players. Max 10 players. Host starts the round.';
  if (!start) return;

  start.hidden = !isHost;
  if (!isHost) return;

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
  lastPhaseIntroKey = null;
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
  const preview = $('#previewAudio');
  if (preview) {
    try { if (preview.src && preview.src.startsWith('blob:')) URL.revokeObjectURL(preview.src); } catch {}
    preview.removeAttribute('src');
    preview.load?.();
    preview.hidden = true;
  }
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
  lastPhaseIntroKey = null;
  lastRecordingResetKey = null;
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
  const me = myPlayer();
  if (me && !me.isHost) {
    showToast('Only the host can start the next round.', true);
    return;
  }
  const btn = $('#playAgainBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'STARTING...';
  }
  resetLocalRoundState();
  socket.emit('round:start');
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
        <h2 class="modal-title">BEST WRITING</h2>
        <div class="modal-kicker" id="writingKicker">WRITE YOUR NOMINEE</div>
        <div class="timer" id="writingTimer">45</div>
        <div class="section">
          <h3 id="writingRoleTitle">YOUR CATEGORY</h3>
          <p id="writingInstructions">Write something short.</p>
          <textarea id="promptSubmissionInput" class="prompt-input" maxlength="130" placeholder="Type here..."></textarea>
          <div class="action-row"><button class="pixel-btn" id="submitPromptBtn">SUBMIT NOMINEE</button></div>
          <p class="tiny-note" id="writingHint">Keep it short. The winning line and scenario become the final prompt.</p>
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
        <h2 class="modal-title">VOTE THE PROMPT</h2>
        <div class="modal-kicker">PICK THE LINE AND SCENARIO EVERYONE WILL PERFORM</div>
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
    .prompt-input{width:100%;min-height:110px;background:#140a24;color:#fff4e4;border:2px solid var(--purple);border-radius:12px;padding:14px;font-family:ui-monospace,monospace;font-size:14px;resize:vertical;box-sizing:border-box;text-transform:none}
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
    if (currentRoom?.status === 'writing') status = player.submitted ? 'WRITTEN' : (player.role === 'line' ? 'LINE' : 'SCENARIO');
    if (currentRoom?.status === 'promptVoting') status = player.voted ? 'VOTED' : 'VOTING';
    if (currentRoom?.status === 'recording') status = player.submitted ? 'SUBMITTED' : 'RECORDING';
    if (currentRoom?.status === 'performanceVoting') status = player.voted ? 'VOTED' : 'VOTING';
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
  const roleTitle = $('#writingRoleTitle');
  const instructions = $('#writingInstructions');
  const input = $('#promptSubmissionInput');
  const submit = $('#submitPromptBtn');
  if (role === 'scenario') {
    if (roleTitle) roleTitle.textContent = 'WRITE A SCENARIO';
    if (instructions) instructions.innerHTML = 'Complete the prompt: <strong>Say it like...</strong>';
    if (input) input.placeholder = 'you just got caught eating the wedding cake';
  } else {
    if (roleTitle) roleTitle.textContent = 'WRITE A LINE';
    if (instructions) instructions.innerHTML = 'Write a short sentence someone can perform out loud.';
    if (input) input.placeholder = 'I can explain.';
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
      <audio controls src="${clip.audioData}"></audio>
      <button class="pixel-btn vote-btn" ${isOwn ? 'disabled' : ''}>VOTE BEST PERFORMANCE</button>`;
    card.querySelector('button')?.addEventListener('click', () => socket.emit('vote:submit', { clipId: clip.clipId }));
    list.appendChild(card);
  });
  const voted = $('#votedCount');
  if (voted && currentRoom) voted.textContent = currentRoom.votedCount || 0;
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

  list.innerHTML = `
    <div class="award-card main-award"><div class="award-title">THE BIG AWARD • BEST PERFORMANCE</div><div class="award-value">${escapeHtml(bestPerformance.winnerName || 'Nobody')}</div><div class="award-winner">${bestPerformance.clipId ? `${bestPerformance.votes || 0} votes` : 'No winning clip'}</div><div class="award-bucks">+${performanceBucks} BUCKS</div></div>
    <div class="award-card"><div class="award-title">BEST LINE</div><div class="award-value">"${escapeHtml(bestLine.text || payload.prompt?.line || '—')}"</div><div class="award-winner">${escapeHtml(bestLine.winnerName || 'THE ACADEMY')}</div><div class="award-bucks">+${lineBucks} BUCKS</div></div>
    <div class="award-card"><div class="award-title">BEST SCENARIO</div><div class="award-value">${escapeHtml(scenarioText({ scenario: bestScenario.text || payload.prompt?.scenario || '—' }))}</div><div class="award-winner">${escapeHtml(bestScenario.winnerName || 'THE ACADEMY')}</div><div class="award-bucks">+${scenarioBucks} BUCKS</div></div>
    <div class="award-card"><div class="award-title">FINAL PROMPT</div><div class="award-value">${escapeHtml(promptText(payload.prompt))}</div></div>
  `;
  const playAgain = $('#playAgainBtn');
  const me = myPlayer();
  if (playAgain) {
    playAgain.hidden = !!me && !me.isHost;
    playAgain.disabled = false;
    playAgain.textContent = 'PLAY AGAIN';
  }
}

function renderRoom(room) {
  currentRoom = room;
  if ($('#roomCodeDisplay')) $('#roomCodeDisplay').textContent = room.code || '-----';
  if ($('#lobbyMode')) $('#lobbyMode').textContent = room.isQuick ? 'QUICK' : 'CUSTOM';
  if ($('#activePlayers')) $('#activePlayers').textContent = String(room.totalPlayers || room.players?.length || 0).padStart(3, '0');
  if ($('#roomLink')) {
    const mode = room.isQuick ? 'quick' : 'custom';
    $('#roomLink').value = `${location.origin}${location.pathname}?room=${room.code}&mode=${mode}`;
  }
  renderPlayers(room.players || []);
  updateLobbyControls(room);

  if (room.status === 'lobby') showScreen('lobbyScreen');
  if (room.status === 'writing') {
    renderWriting(room);
    showPhaseIntro(`writing-${room.round}`, 'WRITE THE NOMINEES', 'Half the players write short lines. The other half write scenarios that complete Say it like...');
  }
  if (room.status === 'promptVoting') {
    renderPromptVoting(room, currentPromptVotingPayload);
    showPhaseIntro(`promptVoting-${room.round}`, 'VOTE THE PROMPT', 'Vote for Best Line and Best Scenario. The winners combine into the final performance prompt.');
  }
  if (room.status === 'recording') {
    renderRecording(room);
    showPhaseIntro(`recording-${room.round}`, 'PERFORM', 'Record your best version of the winning prompt. Commit to it. You get one performance.');
  }
  if (room.status === 'performanceVoting') {
    renderClipVoting(currentPerformanceVotingPayload);
    showPhaseIntro(`performanceVoting-${room.round}`, 'VOTE PERFORMANCE', 'Listen anonymously and vote for the strongest performance. This award pays the most Bucks.');
  }
  if (room.status === 'results') {
    renderResults(currentResultsPayload || { prompt: room.prompt, awards: room.awards, clips: [] });
    showPhaseIntro(`results-${room.round}`, 'AWARDS CEREMONY', 'Best Performance pays 100 Bucks. Best Line and Best Scenario pay 50 Bucks each.');
  }
}

async function startRecording() {
  try {
    recordedBlob = null;
    const preview = $('#previewAudio');
    if (preview) preview.hidden = true;
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream);
    const chunks = [];
    mediaRecorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    mediaRecorder.onstop = () => {
      recordedBlob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (preview) {
        preview.src = URL.createObjectURL(recordedBlob);
        preview.hidden = false;
      }
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
  $('#backToLobbyBtn')?.addEventListener('click', () => showScreen('lobbyScreen'));
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
  socket.on('room:left', () => { resetLocalRoundState(); showScreen('playScreen'); });
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
  socket.on('round:results', (payload) => {
    currentResultsPayload = payload;
    renderResults(payload);
  });
}

function initCopy() {
  const subtitle = $('.logo-subtitle');
  if (subtitle) subtitle.textContent = 'WRITE THE LINE • WRITE THE SCENARIO • WIN THE PERFORMANCE';
  const how = $('#howScreen .modal-inner');
  if (how) {
    how.innerHTML = `
      <h2 class="modal-title">HOW TO PLAY</h2>
      <div class="modal-kicker">SAYITLIKE AWARDS MODE</div>
      <div class="section"><h3>1. WRITE</h3><p>Half the players write lines. Half write scenarios that complete <strong>Say it like...</strong></p></div>
      <div class="section"><h3>2. VOTE THE PROMPT</h3><p>Everyone votes for Best Line and Best Scenario. The winners combine into the final prompt.</p></div>
      <div class="section"><h3>3. PERFORM</h3><p>Everyone records the same winning prompt.</p></div>
      <div class="section"><h3>4. AWARDS</h3><p>Best Performance pays 100 Bucks. Best Line and Best Scenario pay 50 Bucks each.</p></div>`;
  }
  const roundScenarioLabel = $('#roundStyle')?.previousElementSibling;
  if (roundScenarioLabel) roundScenarioLabel.textContent = 'SCENARIO';
  const voteScenarioLabel = $('#voteStyle')?.previousElementSibling;
  if (voteScenarioLabel) voteScenarioLabel.textContent = 'SCENARIO';
  const recordKicker = $('#recordScreen .modal-kicker');
  if (recordKicker) recordKicker.textContent = '35 SECONDS TO SUBMIT • 10 SECOND MAX CLIP';
  const votingKicker = $('#votingScreen .modal-kicker');
  if (votingKicker) votingKicker.textContent = 'LISTEN ANONYMOUSLY • VOTE FOR BEST PERFORMANCE';
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
