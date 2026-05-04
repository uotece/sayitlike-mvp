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

const screens = {
  home: $('#homeScreen'),
  play: $('#playScreen'),
  custom: $('#customScreen'),
  lobby: $('#lobbyScreen'),
  record: $('#recordScreen'),
  voting: $('#votingScreen'),
  results: $('#resultsScreen'),
  how: $('#howScreen'),
  hall: $('#hallScreen'),
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
}

function getName() {
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

function setVolumeUI() {
  $('#volumeSlider').value = uiVolume;
  $('#volumeValue').textContent = `${uiVolume}%`;
}

function copyText(value) {
  navigator.clipboard?.writeText(value)
    .then(() => showToast('Copied.'))
    .catch(() => showToast('Could not copy. Copy manually.', true));
}

function updateTimer(endTime, elementId) {
  clearInterval(tickTimer);
  const el = document.getElementById(elementId);
  if (!endTime || !el) return;
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    el.textContent = String(remaining).padStart(2, '0');
  };
  tick();
  tickTimer = setInterval(tick, 250);
}

function renderPlayers(players = [], hostId = null) {
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

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  }[ch]));
}

function renderRoom(room) {
  currentRoom = room;
  $('#activePlayers').textContent = String(room.totalPlayers || room.players?.length || 0).padStart(3, '0');
  $('#roomCodeDisplay').textContent = room.code || '-----';
  $('#lobbyMode').textContent = room.isQuick ? 'QUICK BATTLE' : 'CUSTOM';
  $('#roomLink').value = `${window.location.origin}/?room=${room.code}`;
  renderPlayers(room.players, room.hostId);
  $('#submittedCount').textContent = room.submittedCount || 0;
  $('#totalPlayers').textContent = room.totalPlayers || room.players?.length || 0;
  $('#votedCount').textContent = room.votedCount || 0;

  const amHost = room.hostId === myId;
  $('#startRoundBtn').disabled = !amHost || room.status !== 'lobby';
  $('#playAgainBtn').disabled = !amHost;

  if (room.status === 'lobby') showScreen('lobbyScreen');
  if (room.status === 'recording') {
    $('#roundLine').textContent = room.prompt?.line || '—';
    $('#roundStyle').textContent = room.prompt?.style || '—';
    updateTimer(room.endsAt, 'recordTimer');
    resetRecorderUI(false);
    showScreen('recordScreen');
  }
  if (room.status === 'results') showScreen('resultsScreen');
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
    showToast('Microphone permission failed. Allow microphone access and try again.', true);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
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
  updateTimer(payload.endsAt, 'voteTimer');

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

  payload.clips
    .slice()
    .sort((a, b) => b.votes - a.votes)
    .forEach((clip) => {
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
  winSound();
  showScreen('resultsScreen');
}

function leaveRoom() {
  softSound();
  socket.emit('room:leave');
  currentRoom = null;
  showScreen('playScreen');
}

function initEvents() {
  setNameFromStorage();
  setVolumeUI();

  $('#playerName').addEventListener('input', getName);

  document.addEventListener('pointerdown', (event) => {
    const clicky = event.target.closest('button, a');
    if (!clicky) return;
    if (clicky.classList.contains('back-btn') || clicky.classList.contains('modal-close')) softSound();
    else if (clicky.classList.contains('menu-btn')) menuSound();
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

  $('#quickBattleBtn').addEventListener('click', () => {
    socket.emit('quick:join', { name: getName() });
  });
  $('#createRoomBtn').addEventListener('click', () => {
    socket.emit('custom:create', { name: getName() });
  });
  $('#joinRoomBtn').addEventListener('click', () => {
    socket.emit('custom:join', { name: getName(), code: $('#roomCodeInput').value });
  });
  $('#roomCodeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
  $('#roomCodeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#joinRoomBtn').click();
  });

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

socket.on('app:hello', (payload) => { myId = payload.playerId; });
socket.on('app:error', (message) => showToast(message, true));
socket.on('game:notice', (message) => showToast(message));
socket.on('room:joined', (payload) => {
  currentRoom = { ...(currentRoom || {}), code: payload.code };
  showToast(`Joined room ${payload.code}.`);
});
socket.on('room:update', renderRoom);
socket.on('clip:submitted', () => {
  $('#clipStatus').textContent = 'Submitted. Waiting for the other players.';
  $('#recordBtn').disabled = true;
  $('#stopBtn').disabled = true;
  $('#submitClipBtn').disabled = true;
  showToast('Clip submitted.');
});
socket.on('round:voting', renderVoting);
socket.on('vote:submitted', () => showToast('Vote submitted.'));
socket.on('round:results', renderResults);

initEvents();
