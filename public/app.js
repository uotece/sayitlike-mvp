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
  donate: $('#donateScreen')
};

const screenIds = new Set(Object.values(screens).map((el) => el.id));

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
  if (!screenIds.has(screenId)) return;
  $$('.screen').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById(screenId);
  target.classList.add('active');
  if (screenId === 'quickScreen') socket.emit('quick:list');
  if (screenId === 'hallScreen') socket.emit('leaderboard:get');
}

function getName() {
  if (authUser?.username) {
    $('#playerName').value = authUser.username;
    $('#accountName').textContent = authUser.username.toUpperCase().replace(/\s+/g, '_') + '_';
    return authUser.username;
  }

  const nameInput = $('#playerName');
  const clean = String(nameInput.value || '').trim().slice(0, 16) || 'Guest';
  localStorage.setItem('sayitlike_name', clean);
  $('#accountName').textContent = clean.toUpperCase().replace(/\s+/g, '_') + '_';
  return clean;
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

function renderAuthUI() {
  const isSignedIn = !!authUser;
  $('#authGuestPanel').hidden = isSignedIn;
  $('#authUserPanel').hidden = !isSignedIn;

  if (isSignedIn) {
    const display = authUser.username.toUpperCase().replace(/\s+/g, '_') + '_';
    $('#accountName').textContent = display;
    $('#playerName').value = authUser.username;
    $('#playerName').disabled = true;
    $('#authSignedUsername').textContent = display;
    $('#authSignedStats').textContent = `${authUser.wins || 0} WINS • ${authUser.gamesPlayed || 0} GAMES`;
    $('#accountWins').textContent = `${authUser.wins || 0} W`;
    $('#accountLevel').textContent = String(Math.max(1, Math.floor((authUser.wins || 0) / 3) + 1));
  } else {
    $('#playerName').disabled = false;
    $('#accountWins').textContent = '0 W';
    $('#accountLevel').textContent = '1';
    setNameFromStorage();
  }
}

async function loadAuthUser() {
  initFirebaseAuth();
}

async function signup() {
  try {
    requireFirebaseClient();
    const email = $('#authEmail').value.trim();
    const username = $('#authUsername').value.trim();
    const password = $('#authPassword').value;

    const credential = await firebaseAuth.createUserWithEmailAndPassword(email, password);
    await credential.user.updateProfile({ displayName: username });
    const idToken = await credential.user.getIdToken(true);
    authUser = await saveProfile(idToken, username);
    renderAuthUI();
    socket.emit('auth:set', { idToken });
    showToast('Account created.');
    showScreen('playScreen');
  } catch (err) {
    showToast(err.message, true);
  }
}

async function login() {
  try {
    requireFirebaseClient();
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;

    const credential = await firebaseAuth.signInWithEmailAndPassword(email, password);
    const idToken = await credential.user.getIdToken(true);
    authUser = await fetchProfile(idToken);
    renderAuthUI();
    socket.emit('auth:set', { idToken });
    showToast('Logged in.');
    showScreen('playScreen');
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


function setVolumeUI() {
  $('#volumeSlider').value = uiVolume;
  $('#volumeValue').textContent = `${uiVolume}%`;
}

function copyText(value) {
  navigator.clipboard?.writeText(value)
    .then(() => showToast('Copied.'))
    .catch(() => showToast('Could not copy. Copy manually.', true));
}

function updateTimer(remainingSeconds, elementId) {
  clearInterval(tickTimer);
  const el = document.getElementById(elementId);
  if (remainingSeconds == null || !el) return;

  localTimerEnd = Date.now() + Math.max(0, Number(remainingSeconds)) * 1000;

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((localTimerEnd - Date.now()) / 1000));
    el.textContent = String(remaining).padStart(2, '0');
    if (remaining <= 0) clearInterval(tickTimer);
  };

  tick();
  tickTimer = setInterval(tick, 250);
}

function renderPlayers(players = []) {
  const playersList = $('#playersList');
  playersList.innerHTML = '';
  players.forEach((player) => {
    const div = document.createElement('div');
    div.className = 'player-chip';
    const status = currentRoom?.status === 'recording'
      ? (player.submitted ? 'SUBMITTED' : 'RECORDING')
      : currentRoom?.status === 'voting'
        ? (player.voted ? 'VOTED' : 'VOTING')
        : (player.isHost ? 'HOST' : 'READY');
    div.innerHTML = `<span>${escapeHtml(player.name)}</span><small>${status}</small>`;
    playersList.appendChild(div);
  });
}

function myPlayer(room = currentRoom) {
  return room?.players?.find((player) => player.id === myId) || null;
}

function lockRecorderAfterSubmit() {
  $('#recordBtn').disabled = true;
  $('#stopBtn').disabled = true;
  $('#submitClipBtn').disabled = true;
  $('#clipStatus').textContent = 'Submitted. Waiting for the other players.';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  }[ch]));
}

function renderQuickRooms(list = quickRooms) {
  quickRooms = list;
  const wrap = $('#quickRoomsList');
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
      <div>
        <div class="room-host">${escapeHtml(room.hostName)}</div>
        <div class="room-sub">${room.playersCount}/${room.maxPlayers} PLAYERS</div>
      </div>
      <div class="room-right">
        <span class="room-code">${room.code}</span>
        <small>QUICK</small>
      </div>
    `;
    wrap.appendChild(card);
  });
}

function renderLeaderboard(list = leaderboard) {
  leaderboard = list;
  const body = $('#leaderboardBody');
  body.innerHTML = '';
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="4" class="tiny-note">No results yet. Play a round and the leaderboard will populate.</td></tr>';
    return;
  }
  list.forEach((entry) => {
    const rankClass = entry.rank === 1 ? 'gold' : entry.rank === 2 ? 'silver' : entry.rank === 3 ? 'bronze' : '';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="rank ${rankClass}">${entry.rank}</td>
      <td class="player">${escapeHtml(entry.name)}${entry.isAccount ? ' ✓' : ''}</td>
      <td class="score">${entry.wins}</td>
      <td>${entry.winRate}%</td>
    `;
    body.appendChild(row);
  });
}

function renderRoom(room) {
  const previousStatus = currentRoom?.status;
  const previousRound = currentRoom?.round;
  currentRoom = room;

  $('#activePlayers').textContent = String(room.totalPlayers || room.players?.length || 0).padStart(3, '0');
  $('#roomCodeDisplay').textContent = room.code || '-----';
  $('#lobbyMode').textContent = room.isQuick ? 'QUICK BATTLE' : 'CUSTOM';
  $('#roomLink').value = `${window.location.origin}/?room=${room.code}`;
  renderPlayers(room.players);
  $('#submittedCount').textContent = room.submittedCount || 0;
  $('#totalPlayers').textContent = room.totalPlayers || room.players?.length || 0;
  $('#votedCount').textContent = room.votedCount || 0;

  const amHost = room.hostId === myId;
  $('#startRoundBtn').disabled = !amHost || room.status !== 'lobby';
  $('#playAgainBtn').disabled = !amHost;

  if (room.status === 'lobby') {
    activePhaseKey = null;
    clearInterval(tickTimer);
    showScreen('lobbyScreen');
  }

  if (room.status === 'recording') {
    $('#roundLine').textContent = room.prompt?.line || '—';
    $('#roundStyle').textContent = room.prompt?.style || '—';

    const phaseKey = `${room.code}:${room.round}:recording`;
    if (activePhaseKey !== phaseKey || previousStatus !== 'recording' || previousRound !== room.round) {
      activePhaseKey = phaseKey;
      recordedBlob = null;
      resetRecorderUI(true);
      updateTimer(room.remainingSeconds ?? room.phaseDuration ?? 60, 'recordTimer');
    }

    if (myPlayer(room)?.submitted) lockRecorderAfterSubmit();
    showScreen('recordScreen');
  }

  if (room.status === 'voting') {
    const phaseKey = `${room.code}:${room.round}:voting`;
    if (activePhaseKey !== phaseKey || previousStatus !== 'voting' || previousRound !== room.round) {
      activePhaseKey = phaseKey;
      updateTimer(room.remainingSeconds ?? room.phaseDuration ?? 60, 'voteTimer');
    }
  }

  if (room.status === 'results') {
    activePhaseKey = null;
    clearInterval(tickTimer);
    showScreen('resultsScreen');
  }
}

function resetRecorderUI(clearBlob = true) {
  if (clearBlob) recordedBlob = null;
  $('#recordBtn').disabled = false;
  $('#stopBtn').disabled = true;
  $('#submitClipBtn').disabled = !recordedBlob;
  $('#previewAudio').hidden = !recordedBlob;
  if (recordedBlob) {
    $('#previewAudio').src = URL.createObjectURL(recordedBlob);
    $('#clipStatus').textContent = 'Preview ready. Submit it or record again.';
  } else {
    $('#previewAudio').removeAttribute('src');
    $('#clipStatus').textContent = 'Click RECORD and perform the prompt.';
  }
}

async function startRecording() {
  try {
    if (myPlayer()?.submitted) {
      showToast('You already submitted your clip.', true);
      lockRecorderAfterSubmit();
      return;
    }
    actionSound();
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast('Your browser does not support microphone recording.', true);
      return;
    }

    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? { mimeType: 'audio/webm;codecs=opus' }
      : {};

    const chunks = [];
    mediaRecorder = new MediaRecorder(mediaStream, options);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    mediaRecorder.onstop = () => {
      clearTimeout(recordStopTimer);
      recordedBlob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
      $('#previewAudio').src = URL.createObjectURL(recordedBlob);
      $('#previewAudio').hidden = false;
      $('#recordBtn').disabled = false;
      $('#stopBtn').disabled = true;
      $('#submitClipBtn').disabled = false;
      $('#clipStatus').textContent = 'Clip ready. You can submit it or record again.';
      softSound();
    };

    mediaRecorder.start();
    $('#recordBtn').disabled = true;
    $('#stopBtn').disabled = false;
    $('#submitClipBtn').disabled = true;
    $('#clipStatus').textContent = 'Recording... max 10 seconds.';
    recordStopTimer = setTimeout(stopRecording, 10000);
  } catch (err) {
    console.error('Recording failed:', err);
    showToast('Recording failed. Check the browser console for details.', true);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function submitClip() {
  if (myPlayer()?.submitted) {
    lockRecorderAfterSubmit();
    showToast('You already submitted your clip.', true);
    return;
  }
  if (!recordedBlob) {
    showToast('Record a clip first.', true);
    return;
  }
  $('#submitClipBtn').disabled = true;
  $('#clipStatus').textContent = 'Submitting...';
  const audioData = await blobToDataURL(recordedBlob);
  socket.emit('clip:submit', { audioData, mimeType: recordedBlob.type || 'audio/webm' });
}

function renderVoting(payload) {
  currentVotingPayload = payload;
  $('#voteLine').textContent = payload.prompt?.line || '—';
  $('#voteStyle').textContent = payload.prompt?.style || '—';
  activePhaseKey = `${currentRoom?.code || 'room'}:${currentRoom?.round || 'round'}:voting`;
  updateTimer(payload.remainingSeconds ?? payload.phaseDuration ?? 60, 'voteTimer');

  const clipList = $('#clipList');
  clipList.innerHTML = '';
  payload.clips.forEach((clip) => {
    const row = document.createElement('div');
    row.className = 'clip-row';
    const isMine = clip.clipId === payload.ownClipId;
    row.innerHTML = `
      <div class="clip-id">CLIP ${clip.label}${isMine ? ' (YOU)' : ''}</div>
      <audio controls src="${clip.audioData}"></audio>
      <button class="vote-btn" ${isMine ? 'disabled' : ''} data-clip-id="${clip.clipId}">${isMine ? 'YOUR CLIP' : 'VOTE'}</button>
    `;
    clipList.appendChild(row);
  });
  showScreen('votingScreen');
}

function submitVote(clipId) {
  actionSound();
  $$('.vote-btn').forEach((button) => { button.disabled = true; });
  socket.emit('vote:submit', { clipId });
}

function renderResults(payload) {
  currentResultsPayload = payload;
  const winnerNames = payload.winners.map((w) => w.playerName).join(' + ');
  $('#winnerText').textContent = winnerNames ? `WINNER: ${winnerNames.toUpperCase()}` : 'NO WINNER';
  const winnerIds = new Set(payload.winners.map((w) => w.clipId));
  const list = $('#resultsList');
  list.innerHTML = '';

  payload.clips.slice().sort((a, b) => b.votes - a.votes).forEach((clip) => {
    const row = document.createElement('div');
    row.className = `result-row ${winnerIds.has(clip.clipId) ? 'winner' : ''}`;
    row.innerHTML = `
      <div class="clip-id">CLIP ${clip.label}</div>
      <div>
        <div class="player">${escapeHtml(clip.playerName)}</div>
        <audio controls src="${clip.audioData}"></audio>
      </div>
      <div class="score">${clip.votes} VOTE${clip.votes === 1 ? '' : 'S'}</div>
    `;
    list.appendChild(row);
  });
  loadAuthUser();
  winSound();
  showScreen('resultsScreen');
}

function leaveRoom() {
  softSound();
  socket.emit('room:leave');
  currentRoom = null;
  clearInterval(tickTimer);
  showScreen('playScreen');
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

  $('#playerName').addEventListener('input', getName);
  $('#accountCard').addEventListener('click', () => showScreen('accountScreen'));
  $('#accountCard').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') showScreen('accountScreen');
  });
  $('#signupBtn').addEventListener('click', signup);
  $('#loginBtn').addEventListener('click', login);
  $('#logoutBtn').addEventListener('click', logout);
  $('#authPassword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') login();
  });
  $('#authEmail').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') login();
  });

  document.addEventListener('pointerdown', (event) => {
    const clicky = event.target.closest('button, a');
    if (!clicky) return;
    if (clicky.classList.contains('back-btn') || clicky.classList.contains('modal-close')) softSound();
    else if (clicky.classList.contains('menu-btn') || clicky.classList.contains('browser-tab') || clicky.classList.contains('room-card')) menuSound();
    else if (clicky.classList.contains('pixel-btn') || clicky.classList.contains('vote-btn')) actionSound();
  });

  $$('[data-screen]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      showScreen(el.dataset.screen);
    });
  });

  $('#soundToggle').addEventListener('click', (event) => {
    event.stopPropagation();
    $('#volumePanel').classList.toggle('open');
    softSound();
  });
  document.addEventListener('click', (event) => {
    const panel = $('#volumePanel');
    const toggle = $('#soundToggle');
    if (!panel.contains(event.target) && !toggle.contains(event.target)) panel.classList.remove('open');
  });
  $('#volumeSlider').addEventListener('input', () => {
    uiVolume = Number($('#volumeSlider').value);
    $('#volumeValue').textContent = `${uiVolume}%`;
    localStorage.setItem('sayitlike_volume', String(uiVolume));
  });
  $('#volumeSlider').addEventListener('change', () => beep(740, 0.055, 0.7));

  $('#quickBattleMenuBtn').addEventListener('click', () => {
    setQuickTab('rooms');
    socket.emit('quick:list');
  });
  $$('.browser-tab').forEach((btn) => btn.addEventListener('click', () => setQuickTab(btn.dataset.quickTab)));
  $('#refreshQuickRoomsBtn').addEventListener('click', () => socket.emit('quick:list'));
  $('#createQuickRoomBtn').addEventListener('click', () => socket.emit('quick:create', { name: getName() }));
  $('#joinQuickRoomBtn').addEventListener('click', () => {
    socket.emit('quick:join', { name: getName(), code: $('#quickRoomCodeInput').value });
  });
  $('#quickRoomCodeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
  $('#quickRoomCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinQuickRoomBtn').click(); });
  $('#quickRoomsList').addEventListener('click', (e) => {
    const card = e.target.closest('.room-card');
    if (!card) return;
    socket.emit('quick:join', { name: getName(), code: card.dataset.code });
  });

  $('#createRoomBtn').addEventListener('click', () => socket.emit('custom:create', { name: getName() }));
  $('#joinRoomBtn').addEventListener('click', () => socket.emit('custom:join', { name: getName(), code: $('#roomCodeInput').value }));
  $('#roomCodeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
  $('#roomCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinRoomBtn').click(); });

  $('#startRoundBtn').addEventListener('click', () => socket.emit('round:start'));
  $('#playAgainBtn').addEventListener('click', () => socket.emit('round:start'));
  $('#backToLobbyBtn').addEventListener('click', () => showScreen('lobbyScreen'));
  $('#leaveLobbyBtn').addEventListener('click', leaveRoom);
  $('#leaveLobbyBtn2').addEventListener('click', leaveRoom);
  $('#copyRoomBtn').addEventListener('click', () => copyText($('#roomLink').value));

  $('#recordBtn').addEventListener('click', startRecording);
  $('#stopBtn').addEventListener('click', stopRecording);
  $('#submitClipBtn').addEventListener('click', submitClip);

  $('#clipList').addEventListener('click', (event) => {
    const button = event.target.closest('.vote-btn');
    if (!button || button.disabled) return;
    submitVote(button.dataset.clipId);
  });

  const roomFromUrl = new URLSearchParams(location.search).get('room');
  if (roomFromUrl) {
    showScreen('customScreen');
    $('#roomCodeInput').value = roomFromUrl.toUpperCase();
    showToast('Room code loaded. Enter your name and click JOIN.');
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
