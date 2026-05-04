const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2e6,
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;
const WRITING_SECONDS = 45;
const PROMPT_VOTING_SECONDS = 25;
const RECORDING_SECONDS = 35;
const PERFORMANCE_VOTING_SECONDS = 45;
const MAX_CLIP_BYTES = 1_400_000;
const LEADERBOARD_LIMIT = 25;

app.use(express.json({ limit: '64kb' }));

let firebaseReady = false;
let db = null;

function initFirebaseAdmin() {
  try {
    if (admin.apps.length) {
      firebaseReady = true;
      db = admin.firestore();
      return;
    }

    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    } else {
      console.warn('Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT_BASE64 on Render.');
      return;
    }

    firebaseReady = true;
    db = admin.firestore();
    console.log('Firebase Admin initialized.');
  } catch (err) {
    firebaseReady = false;
    db = null;
    console.error('Firebase Admin initialization failed:', err);
  }
}

initFirebaseAdmin();

function requireFirebase() {
  if (!firebaseReady || !db) {
    const error = new Error('Firebase Admin is not configured on the server.');
    error.statusCode = 503;
    throw error;
  }
}

function publicUserFromDoc(uid, data = {}) {
  if (!uid) return null;
  return {
    id: uid,
    uid,
    email: data.email || '',
    username: data.username || 'Guest',
    wins: data.wins || 0,
    gamesPlayed: data.gamesPlayed || 0
  };
}

function cleanUsername(username) {
  const clean = String(username || '').trim().slice(0, 16);
  if (!/^[a-zA-Z0-9_-]{3,16}$/.test(clean)) return null;
  return clean;
}

async function verifyIdToken(idToken) {
  requireFirebase();
  if (!idToken) {
    const error = new Error('Missing Firebase ID token.');
    error.statusCode = 401;
    throw error;
  }
  return admin.auth().verifyIdToken(String(idToken));
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

async function getUserProfile(uid) {
  requireFirebase();
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return null;
  return publicUserFromDoc(uid, snap.data());
}

async function upsertUserProfile({ uid, email, username }) {
  requireFirebase();

  const clean = cleanUsername(username);
  if (!clean) {
    const error = new Error('Username must be 3-16 characters and use only letters, numbers, _ or -.');
    error.statusCode = 400;
    throw error;
  }

  const usernameKey = clean.toLowerCase();
  const userRef = db.collection('users').doc(uid);
  const usernameRef = db.collection('usernames').doc(usernameKey);

  await db.runTransaction(async (tx) => {
    const usernameSnap = await tx.get(usernameRef);
    if (usernameSnap.exists && usernameSnap.data().uid !== uid) {
      const error = new Error('Username already taken.');
      error.statusCode = 409;
      throw error;
    }

    const userSnap = await tx.get(userRef);
    const previousUsernameKey = userSnap.exists ? userSnap.data().usernameKey : null;

    if (previousUsernameKey && previousUsernameKey !== usernameKey) {
      tx.delete(db.collection('usernames').doc(previousUsernameKey));
    }

    tx.set(usernameRef, { uid, username: clean, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    tx.set(userRef, {
      uid,
      email: email || '',
      username: clean,
      usernameKey,
      wins: userSnap.exists ? (userSnap.data().wins || 0) : 0,
      gamesPlayed: userSnap.exists ? (userSnap.data().gamesPlayed || 0) : 0,
      createdAt: userSnap.exists ? (userSnap.data().createdAt || admin.firestore.FieldValue.serverTimestamp()) : admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  return getUserProfile(uid);
}

async function userFromToken(idToken) {
  const decoded = await verifyIdToken(idToken);
  let profile = await getUserProfile(decoded.uid);

  if (!profile) {
    const fallbackUsername = cleanUsername(decoded.name) || cleanUsername((decoded.email || '').split('@')[0]) || `user_${decoded.uid.slice(0, 6)}`;
    profile = await upsertUserProfile({ uid: decoded.uid, email: decoded.email || '', username: fallbackUsername });
  }

  return profile;
}

app.post('/api/users/profile', async (req, res) => {
  try {
    const decoded = await verifyIdToken(req.body?.idToken);
    const profile = await upsertUserProfile({ uid: decoded.uid, email: decoded.email || '', username: req.body?.username });
    res.json({ user: profile });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || 'Could not save profile.' });
  }
});

app.get('/api/users/me', async (req, res) => {
  try {
    const idToken = getBearerToken(req);
    const profile = await userFromToken(idToken);
    res.json({ user: profile });
  } catch (err) {
    res.status(err.statusCode || 401).json({ error: err.message || 'Not signed in.' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const socketRooms = new Map();
const playerStats = new Map();

const FALLBACK_LINES = [
  'I can explain.',
  'Nobody needs to know.',
  'That was not supposed to happen.',
  'Put the chicken down.',
  'This changes everything.'
];
const FALLBACK_SCENARIOS = [
  'you are the worst liar alive',
  'you just got caught eating the wedding cake',
  'you are trying to sound calm while everything is clearly on fire',
  'you rehearsed this moment and still forgot every word',
  'your plan worked but way too early'
];

function normalizeName(name) {
  return String(name || 'Guest').trim().slice(0, 16).toLowerCase();
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeRoom(code = makeRoomCode(), isQuick = false) {
  const room = {
    code,
    isQuick,
    hostId: null,
    status: 'lobby',
    players: new Map(),
    assignments: new Map(),
    submissions: new Map(),
    promptVotes: new Map(),
    clips: new Map(),
    performanceVotes: new Map(),
    prompt: null,
    promptOptions: { lines: [], scenarios: [] },
    awards: null,
    timers: { phase: null },
    endsAt: null,
    phaseStartedAt: null,
    phaseDuration: null,
    clipCounter: 0,
    round: 0
  };
  rooms.set(code, room);
  return room;
}

function clearPhaseTimer(room) {
  clearTimeout(room.timers.phase);
  room.timers.phase = null;
}

function phasePayload(room) {
  return {
    endsAt: room.endsAt,
    phaseStartedAt: room.phaseStartedAt,
    phaseDuration: room.phaseDuration,
    remainingSeconds: room.endsAt ? Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000)) : null
  };
}

function beginTimedPhase(room, status, seconds, callback) {
  clearPhaseTimer(room);
  room.status = status;
  room.phaseStartedAt = Date.now();
  room.phaseDuration = seconds;
  room.endsAt = room.phaseStartedAt + seconds * 1000;
  room.timers.phase = setTimeout(() => callback(room), seconds * 1000);
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => {
    let submitted = false;
    let voted = false;
    if (room.status === 'writing') submitted = room.submissions.has(p.id);
    if (room.status === 'promptVoting') voted = room.promptVotes.has(p.id);
    if (room.status === 'recording') submitted = !!p.submitted;
    if (room.status === 'performanceVoting') voted = room.performanceVotes.has(p.id);
    return {
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.id === room.hostId,
      submitted,
      voted,
      role: room.assignments.get(p.id) || null,
      hasAccount: !!p.userId
    };
  });
}

function roomPayload(room) {
  const players = [...room.players.values()];
  return {
    code: room.code,
    isQuick: room.isQuick,
    hostId: room.hostId,
    status: room.status,
    players: publicPlayers(room),
    prompt: room.prompt,
    promptOptions: room.promptOptions,
    awards: room.awards,
    round: room.round,
    maxPlayers: MAX_PLAYERS,
    ...phasePayload(room),
    submittedCount: room.status === 'writing'
      ? room.submissions.size
      : room.status === 'recording'
        ? players.filter((p) => p.submitted).length
        : 0,
    votedCount: room.status === 'promptVoting'
      ? room.promptVotes.size
      : room.status === 'performanceVoting'
        ? room.performanceVotes.size
        : 0,
    totalPlayers: room.players.size
  };
}

function emitRoom(room) {
  io.to(room.code).emit('room:update', roomPayload(room));
}

function quickRoomsPayload() {
  return [...rooms.values()]
    .filter((room) => room.isQuick && room.status === 'lobby')
    .sort((a, b) => b.players.size - a.players.size || a.code.localeCompare(b.code))
    .map((room) => ({
      code: room.code,
      hostName: room.players.get(room.hostId)?.name || 'Guest',
      playersCount: room.players.size,
      maxPlayers: MAX_PLAYERS,
      status: room.status,
      round: room.round
    }));
}

function emitQuickRooms(target = io) {
  target.emit('quick:list', quickRoomsPayload());
}

async function leaderboardPayload() {
  if (firebaseReady && db) {
    const snap = await db.collection('users').orderBy('wins', 'desc').limit(LEADERBOARD_LIMIT).get();
    return snap.docs
      .map((doc, index) => {
        const data = doc.data();
        return {
          rank: index + 1,
          name: data.username || 'Guest',
          wins: data.wins || 0,
          gamesPlayed: data.gamesPlayed || 0,
          winRate: data.gamesPlayed ? Math.round(((data.wins || 0) / data.gamesPlayed) * 100) : 0,
          isAccount: true
        };
      })
      .filter((entry) => entry.wins > 0 || entry.gamesPlayed > 0);
  }

  return [...playerStats.values()]
    .filter((entry) => entry.wins > 0 || entry.gamesPlayed > 0)
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name))
    .slice(0, LEADERBOARD_LIMIT)
    .map((entry, index) => ({
      rank: index + 1,
      name: entry.name,
      wins: entry.wins,
      gamesPlayed: entry.gamesPlayed,
      winRate: entry.gamesPlayed ? Math.round((entry.wins / entry.gamesPlayed) * 100) : 0,
      isAccount: false
    }));
}

async function emitLeaderboard(target = io) {
  try {
    target.emit('leaderboard:update', await leaderboardPayload());
  } catch (err) {
    console.error('Could not load leaderboard:', err);
    target.emit('leaderboard:update', []);
  }
}

function cleanupRoom(room) {
  clearPhaseTimer(room);
  rooms.delete(room.code);
  emitQuickRooms();
}

function clipLetter(index) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return alphabet[index] || String(index + 1);
}

function sanitizeLine(text) {
  const value = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 90);
  if (value.length < 2) return null;
  return value;
}

function sanitizeScenario(text) {
  let value = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 130);
  value = value.replace(/^like\s+/i, '').trim();
  if (value.length < 4) return null;
  return value;
}

function shuffledPlayers(room) {
  return [...room.players.values()].sort(() => Math.random() - 0.5);
}

function startRound(room) {
  if (room.players.size < MIN_PLAYERS) {
    io.to(room.code).emit('app:error', `Need at least ${MIN_PLAYERS} players for Awards Mode.`);
    return;
  }

  clearPhaseTimer(room);
  room.round += 1;
  room.prompt = null;
  room.awards = null;
  room.promptOptions = { lines: [], scenarios: [] };
  room.assignments.clear();
  room.submissions.clear();
  room.promptVotes.clear();
  room.clips.clear();
  room.performanceVotes.clear();
  room.clipCounter = 0;

  const players = shuffledPlayers(room);
  const lineSlots = Math.ceil(players.length / 2);
  players.forEach((player, index) => {
    room.assignments.set(player.id, index < lineSlots ? 'line' : 'scenario');
    player.submitted = false;
    player.voted = false;
  });

  beginTimedPhase(room, 'writing', WRITING_SECONDS, endWriting);
  emitRoom(room);
  emitQuickRooms();

  for (const player of room.players.values()) {
    io.to(player.id).emit('round:writing', { role: room.assignments.get(player.id), ...phasePayload(room) });
  }
}

function submissionPayload(room) {
  return {
    lines: [...room.submissions.values()].filter((s) => s.type === 'line'),
    scenarios: [...room.submissions.values()].filter((s) => s.type === 'scenario')
  };
}

function maybeEndWriting(room) {
  if (room.status !== 'writing') return;
  if (room.submissions.size >= room.players.size) endWriting(room);
}

function makeFallbackOption(type, index) {
  const text = type === 'line' ? FALLBACK_LINES[index % FALLBACK_LINES.length] : FALLBACK_SCENARIOS[index % FALLBACK_SCENARIOS.length];
  return { id: `${type}:fallback:${index}`, type, text, authorId: null, authorName: 'THE ACADEMY', votes: 0, fallback: true };
}

function endWriting(room) {
  if (room.status !== 'writing') return;
  clearPhaseTimer(room);

  const submitted = submissionPayload(room);
  const lines = submitted.lines.length ? submitted.lines : [makeFallbackOption('line', room.round)];
  const scenarios = submitted.scenarios.length ? submitted.scenarios : [makeFallbackOption('scenario', room.round)];

  room.promptOptions = { lines, scenarios };
  room.promptVotes.clear();
  for (const player of room.players.values()) player.voted = false;

  beginTimedPhase(room, 'promptVoting', PROMPT_VOTING_SECONDS, endPromptVoting);
  emitRoom(room);
  io.to(room.code).emit('round:prompt-voting', { lines, scenarios, ...phasePayload(room) });
}

function maybeEndPromptVoting(room) {
  if (room.status !== 'promptVoting') return;
  if (room.promptVotes.size >= room.players.size) endPromptVoting(room);
}

function pickWinner(options, votes, voteKey) {
  const tally = new Map(options.map((option) => [option.id, 0]));
  for (const vote of votes.values()) {
    const id = vote?.[voteKey];
    if (tally.has(id)) tally.set(id, tally.get(id) + 1);
  }
  const scored = options.map((option) => ({ ...option, votes: tally.get(option.id) || 0 }));
  const maxVotes = scored.reduce((max, option) => Math.max(max, option.votes), -1);
  const tied = scored.filter((option) => option.votes === maxVotes);
  return tied[Math.floor(Math.random() * tied.length)] || scored[0];
}

function endPromptVoting(room) {
  if (room.status !== 'promptVoting') return;
  clearPhaseTimer(room);

  const bestLine = pickWinner(room.promptOptions.lines, room.promptVotes, 'lineId');
  const bestScenario = pickWinner(room.promptOptions.scenarios, room.promptVotes, 'scenarioId');
  room.promptOptions = {
    lines: room.promptOptions.lines.map((option) => ({ ...option, votes: [...room.promptVotes.values()].filter((v) => v.lineId === option.id).length })),
    scenarios: room.promptOptions.scenarios.map((option) => ({ ...option, votes: [...room.promptVotes.values()].filter((v) => v.scenarioId === option.id).length }))
  };
  room.prompt = {
    line: bestLine.text,
    scenario: bestScenario.text,
    style: `like ${bestScenario.text}`,
    lineAuthorId: bestLine.authorId,
    lineAuthorName: bestLine.authorName,
    scenarioAuthorId: bestScenario.authorId,
    scenarioAuthorName: bestScenario.authorName
  };

  room.clips.clear();
  room.performanceVotes.clear();
  for (const player of room.players.values()) {
    player.submitted = false;
    player.voted = false;
  }

  beginTimedPhase(room, 'recording', RECORDING_SECONDS, endRecording);
  emitRoom(room);
  io.to(room.code).emit('round:recording', { prompt: room.prompt, ...phasePayload(room) });
}

function maybeEndRecording(room) {
  if (room.status !== 'recording') return;
  const activePlayers = [...room.players.values()];
  const submitted = activePlayers.filter((p) => p.submitted).length;
  if (submitted >= activePlayers.length) endRecording(room);
}

function endRecording(room) {
  if (room.status !== 'recording') return;
  clearPhaseTimer(room);

  if (room.clips.size === 0) {
    room.status = 'lobby';
    room.endsAt = null;
    room.phaseStartedAt = null;
    room.phaseDuration = null;
    io.to(room.code).emit('game:notice', 'Nobody submitted a performance. Round cancelled.');
    emitRoom(room);
    emitQuickRooms();
    return;
  }

  for (const player of room.players.values()) player.voted = false;
  beginTimedPhase(room, 'performanceVoting', PERFORMANCE_VOTING_SECONDS, endPerformanceVoting);

  const clips = [...room.clips.values()].map((clip, index) => ({
    clipId: clip.clipId,
    label: clipLetter(index),
    audioData: clip.audioData,
    mimeType: clip.mimeType
  }));

  for (const player of room.players.values()) {
    const ownClip = [...room.clips.values()].find((clip) => clip.playerId === player.id);
    io.to(player.id).emit('round:performance-voting', {
      clips,
      ownClipId: ownClip ? ownClip.clipId : null,
      prompt: room.prompt,
      ...phasePayload(room)
    });
  }

  emitRoom(room);
  maybeEndPerformanceVoting(room);
}

function maybeEndPerformanceVoting(room) {
  if (room.status !== 'performanceVoting') return;
  const possibleVoters = [...room.players.values()].filter((p) => room.clips.size > 1 || ![...room.clips.values()].some((c) => c.playerId === p.id));
  if (room.performanceVotes.size >= possibleVoters.length) endPerformanceVoting(room);
}

function endPerformanceVoting(room) {
  if (room.status !== 'performanceVoting') return;
  clearPhaseTimer(room);
  room.status = 'results';
  room.endsAt = null;
  room.phaseStartedAt = null;
  room.phaseDuration = null;

  const tally = new Map();
  for (const clip of room.clips.values()) tally.set(clip.clipId, 0);
  for (const clipId of room.performanceVotes.values()) tally.set(clipId, (tally.get(clipId) || 0) + 1);

  const clips = [...room.clips.values()].map((clip, index) => {
    const player = room.players.get(clip.playerId);
    return {
      clipId: clip.clipId,
      label: clipLetter(index),
      playerId: clip.playerId,
      playerName: player ? player.name : 'Disconnected',
      votes: tally.get(clip.clipId) || 0,
      audioData: clip.audioData,
      mimeType: clip.mimeType
    };
  });

  const maxVotes = clips.reduce((max, c) => Math.max(max, c.votes), -1);
  const winners = clips.filter((c) => c.votes === maxVotes);
  const bestPerformance = winners[Math.floor(Math.random() * winners.length)] || null;

  room.awards = {
    bestLine: { text: room.prompt?.line || '', winnerName: room.prompt?.lineAuthorName || 'THE ACADEMY', winnerId: room.prompt?.lineAuthorId || null, bucks: 50 },
    bestScenario: { text: room.prompt?.scenario || '', winnerName: room.prompt?.scenarioAuthorName || 'THE ACADEMY', winnerId: room.prompt?.scenarioAuthorId || null, bucks: 50 },
    bestPerformance: bestPerformance ? {
      text: bestPerformance.label,
      winnerName: bestPerformance.playerName,
      winnerId: bestPerformance.playerId,
      votes: bestPerformance.votes,
      clipId: bestPerformance.clipId,
      bucks: 100
    } : null
  };

  const awardPoints = new Map();
  const addAwardPoints = (playerId, points) => {
    if (!playerId || !points) return;
    awardPoints.set(playerId, (awardPoints.get(playerId) || 0) + points);
  };
  addAwardPoints(room.awards.bestPerformance?.winnerId, 100);
  addAwardPoints(room.awards.bestLine?.winnerId, 50);
  addAwardPoints(room.awards.bestScenario?.winnerId, 50);

  const accountUpdates = [];
  for (const player of room.players.values()) {
    const bucksEarned = awardPoints.get(player.id) || 0;
    if (player.userId && firebaseReady && db) {
      accountUpdates.push(db.collection('users').doc(player.userId).set({
        gamesPlayed: admin.firestore.FieldValue.increment(1),
        wins: admin.firestore.FieldValue.increment(bucksEarned),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }));
    } else {
      const norm = normalizeName(player.name);
      const current = playerStats.get(norm) || { name: player.name, wins: 0, gamesPlayed: 0 };
      current.name = player.name;
      current.gamesPlayed += 1;
      current.wins += bucksEarned;
      playerStats.set(norm, current);
    }
  }

  Promise.allSettled(accountUpdates).then(() => emitLeaderboard()).catch((err) => {
    console.error('Could not update account stats:', err);
    emitLeaderboard();
  });

  io.to(room.code).emit('round:results', {
    prompt: room.prompt,
    promptOptions: room.promptOptions,
    clips,
    winners,
    awards: room.awards,
    totalVotes: room.performanceVotes.size
  });
  emitRoom(room);
  emitQuickRooms();
}

function leaveCurrentRoom(socket) {
  const code = socketRooms.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketRooms.delete(socket.id);
  socket.leave(code);
  if (!room) return;

  room.players.delete(socket.id);
  room.assignments.delete(socket.id);
  room.submissions.delete(socket.id);
  room.promptVotes.delete(socket.id);
  room.performanceVotes.delete(socket.id);

  for (const [clipId, clip] of room.clips.entries()) {
    if (clip.playerId === socket.id) {
      room.clips.delete(clipId);
      for (const [voterId, votedClipId] of room.performanceVotes.entries()) {
        if (votedClipId === clipId) room.performanceVotes.delete(voterId);
      }
    }
  }

  if (room.players.size === 0) {
    cleanupRoom(room);
    return;
  }

  if (room.hostId === socket.id) room.hostId = [...room.players.keys()][0];
  if (room.status === 'writing') maybeEndWriting(room);
  if (room.status === 'promptVoting') maybeEndPromptVoting(room);
  if (room.status === 'recording') maybeEndRecording(room);
  if (room.status === 'performanceVoting') maybeEndPerformanceVoting(room);
  emitRoom(room);
  emitQuickRooms();
}

function joinRoom(socket, room, name) {
  leaveCurrentRoom(socket);
  if (room.players.size >= MAX_PLAYERS) {
    socket.emit('app:error', 'This room is full.');
    return false;
  }
  if (room.status !== 'lobby') {
    socket.emit('app:error', 'This room already started. Create or join another room.');
    return false;
  }

  const authUser = socket.data.user || null;
  const cleanName = authUser ? authUser.username : (String(name || 'Guest').trim().slice(0, 16) || 'Guest');
  room.players.set(socket.id, { id: socket.id, userId: authUser ? authUser.id : null, name: cleanName, connected: true, submitted: false, voted: false });

  if (!room.hostId) room.hostId = socket.id;

  socket.join(room.code);
  socketRooms.set(socket.id, room.code);
  socket.emit('room:joined', { code: room.code, playerId: socket.id, isHost: room.hostId === socket.id, isQuick: room.isQuick });
  emitRoom(room);
  emitQuickRooms();
  return true;
}

io.on('connection', (socket) => {
  socket.data.user = null;
  socket.emit('app:hello', { playerId: socket.id, maxPlayers: MAX_PLAYERS, user: null });
  emitQuickRooms(socket);
  emitLeaderboard(socket);

  socket.on('quick:list', () => emitQuickRooms(socket));
  socket.on('leaderboard:get', () => emitLeaderboard(socket));

  socket.on('auth:set', async ({ idToken } = {}) => {
    try {
      socket.data.user = await userFromToken(idToken);
      socket.emit('app:hello', { playerId: socket.id, maxPlayers: MAX_PLAYERS, user: socket.data.user });
      emitLeaderboard(socket);
    } catch (err) {
      socket.data.user = null;
      socket.emit('app:error', err.message || 'Could not verify Firebase account.');
      socket.emit('app:hello', { playerId: socket.id, maxPlayers: MAX_PLAYERS, user: null });
    }
  });

  socket.on('auth:clear', () => {
    socket.data.user = null;
    socket.emit('app:hello', { playerId: socket.id, maxPlayers: MAX_PLAYERS, user: null });
  });

  socket.on('quick:create', ({ name } = {}) => joinRoom(socket, makeRoom(undefined, true), name));

  socket.on('quick:join', ({ name, code } = {}) => {
    const normalizedCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(normalizedCode);
    if (!room || !room.isQuick) {
      socket.emit('app:error', 'Quick room not found.');
      return;
    }
    joinRoom(socket, room, name);
  });

  socket.on('custom:create', ({ name } = {}) => joinRoom(socket, makeRoom(undefined, false), name));

  socket.on('custom:join', ({ name, code } = {}) => {
    const normalizedCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(normalizedCode);
    if (!room || room.isQuick) {
      socket.emit('app:error', 'Room not found.');
      return;
    }
    joinRoom(socket, room, name);
  });

  socket.on('room:leave', () => leaveCurrentRoom(socket));

  socket.on('round:start', () => {
    const code = socketRooms.get(socket.id);
    const room = rooms.get(code);
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit('app:error', 'Only the host can start the round.');
      return;
    }
    startRound(room);
  });

  socket.on('prompt:submit', ({ text } = {}) => {
    const code = socketRooms.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'writing') return;
    const player = room.players.get(socket.id);
    const role = room.assignments.get(socket.id);
    if (!player || !role) return;

    const cleanText = role === 'line' ? sanitizeLine(text) : sanitizeScenario(text);
    if (!cleanText) {
      socket.emit('app:error', role === 'line' ? 'Write a short line first.' : 'Write a scenario first.');
      return;
    }

    room.submissions.set(socket.id, { id: `${role}:${socket.id}:${room.round}`, type: role, text: cleanText, authorId: socket.id, authorName: player.name, votes: 0, fallback: false });
    socket.emit('prompt:submitted');
    emitRoom(room);
    maybeEndWriting(room);
  });

  socket.on('prompt:vote', ({ lineId, scenarioId } = {}) => {
    const code = socketRooms.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'promptVoting') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const lineOk = room.promptOptions.lines.some((option) => option.id === lineId);
    const scenarioOk = room.promptOptions.scenarios.some((option) => option.id === scenarioId);
    if (!lineOk || !scenarioOk) {
      socket.emit('app:error', 'Pick one line and one scenario.');
      return;
    }
    room.promptVotes.set(socket.id, { lineId, scenarioId });
    socket.emit('prompt:vote-submitted');
    emitRoom(room);
    maybeEndPromptVoting(room);
  });

  socket.on('clip:submit', ({ audioData, mimeType } = {}) => {
    const code = socketRooms.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'recording') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.submitted) {
      socket.emit('app:error', 'You already submitted your performance.');
      return;
    }

    const data = String(audioData || '');
    if (!data.startsWith('data:audio/')) {
      socket.emit('app:error', 'Invalid audio clip.');
      return;
    }
    if (Buffer.byteLength(data, 'utf8') > MAX_CLIP_BYTES) {
      socket.emit('app:error', 'Audio clip is too large. Keep it under 10 seconds.');
      return;
    }

    for (const [clipId, clip] of room.clips.entries()) {
      if (clip.playerId === socket.id) room.clips.delete(clipId);
    }

    const clipId = `${socket.id}:${Date.now()}:${++room.clipCounter}`;
    room.clips.set(clipId, { clipId, playerId: socket.id, audioData: data, mimeType: String(mimeType || 'audio/webm'), submittedAt: Date.now() });
    player.submitted = true;
    socket.emit('clip:submitted');
    emitRoom(room);
    maybeEndRecording(room);
  });

  socket.on('vote:submit', ({ clipId } = {}) => {
    const code = socketRooms.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'performanceVoting') return;
    const player = room.players.get(socket.id);
    const clip = room.clips.get(String(clipId || ''));
    if (!player || !clip) return;
    if (clip.playerId === socket.id) {
      socket.emit('app:error', "You can't vote for yourself.");
      return;
    }
    if (room.performanceVotes.has(socket.id)) {
      socket.emit('app:error', 'You already voted.');
      return;
    }
    room.performanceVotes.set(socket.id, clip.clipId);
    socket.emit('vote:submitted');
    emitRoom(room);
    maybeEndPerformanceVoting(room);
  });

  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

server.listen(PORT, () => {
  console.log(`SayItLike MVP running on http://localhost:${PORT}`);
});
