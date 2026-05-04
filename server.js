const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2e6,
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const RECORDING_SECONDS = 60;
const VOTING_SECONDS = 60;
const MAX_CLIP_BYTES = 1_400_000;
const LEADERBOARD_LIMIT = 25;


app.use(express.json({ limit: '32kb' }));

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const sessions = new Map(); // sessionId -> { userId, createdAt }

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadUserDb() {
  try {
    ensureDataDir();
    if (!fs.existsSync(USERS_FILE)) return { users: [] };
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.users)) return { users: [] };
    return parsed;
  } catch (err) {
    console.error('Could not load users.json:', err);
    return { users: [] };
  }
}

let userDb = loadUserDb();

function saveUserDb() {
  ensureDataDir();
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(userDb, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    wins: user.wins || 0,
    gamesPlayed: user.gamesPlayed || 0
  };
}

function cleanUsername(username) {
  const clean = String(username || '').trim().slice(0, 16);
  if (!/^[a-zA-Z0-9_-]{3,16}$/.test(clean)) return null;
  return clean;
}

function cleanPassword(password) {
  const clean = String(password || '');
  if (clean.length < 4 || clean.length > 72) return null;
  return clean;
}

function findUserByKey(usernameKey) {
  return userDb.users.find((user) => user.usernameKey === usernameKey) || null;
}

function findUserById(userId) {
  return userDb.users.find((user) => user.id === userId) || null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  try {
    const attempted = crypto.scryptSync(password, user.passwordSalt, 64);
    const stored = Buffer.from(user.passwordHash, 'hex');
    return stored.length === attempted.length && crypto.timingSafeEqual(stored, attempted);
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    String(cookieHeader)
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function getUserFromCookieHeader(cookieHeader = '') {
  const cookies = parseCookies(cookieHeader);
  const sessionId = cookies.sayitlike_session;
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  return findUserById(session.userId);
}

function getUserFromReq(req) {
  return getUserFromCookieHeader(req.headers.cookie || '');
}

function cookieOptions(req) {
  const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return [
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=2592000',
    isSecure ? 'Secure' : ''
  ].filter(Boolean).join('; ');
}

function setSessionCookie(req, res, user) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionId, { userId: user.id, createdAt: Date.now() });
  res.setHeader('Set-Cookie', `sayitlike_session=${encodeURIComponent(sessionId)}; ${cookieOptions(req)}`);
}

function clearSessionCookie(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies.sayitlike_session) sessions.delete(cookies.sayitlike_session);
  res.setHeader('Set-Cookie', `sayitlike_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

app.post('/api/auth/signup', (req, res) => {
  const username = cleanUsername(req.body?.username);
  const password = cleanPassword(req.body?.password);

  if (!username) {
    return res.status(400).json({ error: 'Username must be 3-16 characters and use only letters, numbers, _ or -.' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Password must be 4-72 characters.' });
  }

  const usernameKey = username.toLowerCase();
  if (findUserByKey(usernameKey)) {
    return res.status(409).json({ error: 'Username already taken.' });
  }

  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    username,
    usernameKey,
    passwordSalt: salt,
    passwordHash: hash,
    wins: 0,
    gamesPlayed: 0,
    createdAt: new Date().toISOString()
  };

  userDb.users.push(user);
  saveUserDb();
  setSessionCookie(req, res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const username = cleanUsername(req.body?.username);
  const password = cleanPassword(req.body?.password);
  if (!username || !password) {
    return res.status(400).json({ error: 'Invalid username or password.' });
  }

  const user = findUserByKey(username.toLowerCase());
  if (!user || !verifyPassword(password, user)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  setSessionCookie(req, res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: publicUser(getUserFromReq(req)) });
});


app.use(express.static(path.join(__dirname, 'public')));

const lines = [
  "I can explain.",
  "That wasn't supposed to happen.",
  "Nobody needs to know.",
  "I knew you would come back.",
  "This is completely normal.",
  "Put the chicken down.",
  "We are not alone.",
  "I trusted you.",
  "You forgot one thing.",
  "Don't open that door.",
  "It was like this when I found it.",
  "I swear I'm not lying.",
  "This changes everything.",
  "Why is it moving?",
  "I have a bad feeling about this."
];

const styles = [
  "like a supervillain",
  "like a nervous liar",
  "like a disappointed dad",
  "like a robot learning emotions",
  "like a soap opera actor",
  "like a horror movie victim",
  "like a motivational speaker",
  "like a fake-nice customer service agent",
  "like you're hiding a crime",
  "like an anime protagonist",
  "like a medieval king",
  "like a terrible lawyer",
  "like a reality show contestant",
  "like you just got caught",
  "like someone trying not to cry"
];

const rooms = new Map();
const socketRooms = new Map();
const playerStats = new Map(); // normalizedName -> {name,wins,gamesPlayed}

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
    prompt: null,
    players: new Map(),
    clips: new Map(),
    votes: new Map(),
    timers: { recording: null, voting: null },
    endsAt: null,
    phaseStartedAt: null,
    phaseDuration: null,
    clipCounter: 0,
    round: 0
  };
  rooms.set(code, room);
  return room;
}

function randomPrompt() {
  return {
    line: lines[Math.floor(Math.random() * lines.length)],
    style: styles[Math.floor(Math.random() * styles.length)]
  };
}

function clipLetter(index) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return alphabet[index] || String(index + 1);
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    connected: p.connected,
    isHost: p.id === room.hostId,
    submitted: !!p.submitted,
    voted: !!p.voted,
    hasAccount: !!p.userId
  }));
}

function roomPayload(room) {
  return {
    code: room.code,
    isQuick: room.isQuick,
    hostId: room.hostId,
    status: room.status,
    players: publicPlayers(room),
    prompt: room.prompt,
    round: room.round,
    maxPlayers: MAX_PLAYERS,
    endsAt: room.endsAt,
    phaseStartedAt: room.phaseStartedAt,
    phaseDuration: room.phaseDuration,
    remainingSeconds: room.endsAt ? Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000)) : null,
    submittedCount: [...room.players.values()].filter((p) => p.submitted).length,
    totalPlayers: room.players.size,
    votedCount: room.votes.size
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

function leaderboardPayload() {
  const accountRows = userDb.users.map((user) => ({
    name: user.username,
    wins: user.wins || 0,
    gamesPlayed: user.gamesPlayed || 0,
    isAccount: true
  }));

  const guestRows = [...playerStats.values()].map((entry) => ({
    ...entry,
    isAccount: false
  }));

  return [...accountRows, ...guestRows]
    .filter((entry) => entry.wins > 0 || entry.gamesPlayed > 0)
    .sort((a, b) =>
      b.wins - a.wins ||
      (b.gamesPlayed ? b.wins / b.gamesPlayed : 0) - (a.gamesPlayed ? a.wins / a.gamesPlayed : 0) ||
      a.name.localeCompare(b.name)
    )
    .slice(0, LEADERBOARD_LIMIT)
    .map((entry, index) => ({
      rank: index + 1,
      name: entry.name,
      wins: entry.wins,
      gamesPlayed: entry.gamesPlayed,
      winRate: entry.gamesPlayed ? Math.round((entry.wins / entry.gamesPlayed) * 100) : 0,
      isAccount: !!entry.isAccount
    }));
}

function emitLeaderboard(target = io) {
  target.emit('leaderboard:update', leaderboardPayload());
}

function cleanupRoom(room) {
  clearTimeout(room.timers.recording);
  clearTimeout(room.timers.voting);
  rooms.delete(room.code);
  emitQuickRooms();
}

function maybeEndRecording(room) {
  if (room.status !== 'recording') return;
  const activePlayers = [...room.players.values()];
  const submitted = activePlayers.filter((p) => p.submitted).length;
  if (submitted >= activePlayers.length) endRecording(room);
}

function maybeEndVoting(room) {
  if (room.status !== 'voting') return;
  const possibleVoters = [...room.players.values()].filter((p) => room.clips.size > 1 || ![...room.clips.values()].some((c) => c.playerId === p.id));
  if (room.votes.size >= possibleVoters.length) endVoting(room);
}

function leaveCurrentRoom(socket) {
  const code = socketRooms.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketRooms.delete(socket.id);
  socket.leave(code);
  if (!room) return;

  room.players.delete(socket.id);
  room.votes.delete(socket.id);

  for (const [clipId, clip] of room.clips.entries()) {
    if (clip.playerId === socket.id) {
      room.clips.delete(clipId);
      for (const [voterId, votedClipId] of room.votes.entries()) {
        if (votedClipId === clipId) room.votes.delete(voterId);
      }
    }
  }

  if (room.players.size === 0) {
    cleanupRoom(room);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = [...room.players.keys()][0];
  }

  if (room.status === 'recording') maybeEndRecording(room);
  if (room.status === 'voting') maybeEndVoting(room);
  emitRoom(room);
  emitQuickRooms();
}

function startRound(room) {
  clearTimeout(room.timers.recording);
  clearTimeout(room.timers.voting);
  room.status = 'recording';
  room.prompt = randomPrompt();
  room.clips.clear();
  room.votes.clear();
  room.clipCounter = 0;
  room.round += 1;
  room.phaseStartedAt = Date.now();
  room.phaseDuration = RECORDING_SECONDS;
  room.endsAt = room.phaseStartedAt + RECORDING_SECONDS * 1000;

  for (const player of room.players.values()) {
    player.submitted = false;
    player.voted = false;
  }

  room.timers.recording = setTimeout(() => endRecording(room), RECORDING_SECONDS * 1000);
  emitRoom(room);
  emitQuickRooms();
}

function endRecording(room) {
  if (room.status !== 'recording') return;
  clearTimeout(room.timers.recording);

  if (room.clips.size === 0) {
    room.status = 'lobby';
    room.endsAt = null;
    room.phaseStartedAt = null;
    room.phaseDuration = null;
    io.to(room.code).emit('game:notice', 'Nobody submitted a clip. Round cancelled.');
    emitRoom(room);
    emitQuickRooms();
    return;
  }

  room.status = 'voting';
  room.phaseStartedAt = Date.now();
  room.phaseDuration = VOTING_SECONDS;
  room.endsAt = room.phaseStartedAt + VOTING_SECONDS * 1000;
  room.timers.voting = setTimeout(() => endVoting(room), VOTING_SECONDS * 1000);

  const clips = [...room.clips.values()].map((clip, index) => ({
    clipId: clip.clipId,
    label: clipLetter(index),
    audioData: clip.audioData,
    mimeType: clip.mimeType
  }));

  for (const player of room.players.values()) {
    const ownClip = [...room.clips.values()].find((clip) => clip.playerId === player.id);
    io.to(player.id).emit('round:voting', {
      clips,
      ownClipId: ownClip ? ownClip.clipId : null,
      prompt: room.prompt,
      endsAt: room.endsAt,
      phaseStartedAt: room.phaseStartedAt,
      phaseDuration: room.phaseDuration,
      remainingSeconds: room.endsAt ? Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000)) : null
    });
  }
  emitRoom(room);
  maybeEndVoting(room);
}

function endVoting(room) {
  if (room.status !== 'voting') return;
  clearTimeout(room.timers.voting);
  room.status = 'results';
  room.endsAt = null;
  room.phaseStartedAt = null;
  room.phaseDuration = null;

  const tally = new Map();
  for (const clip of room.clips.values()) tally.set(clip.clipId, 0);
  for (const clipId of room.votes.values()) tally.set(clipId, (tally.get(clipId) || 0) + 1);

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

  const maxVotes = clips.reduce((max, c) => Math.max(max, c.votes), 0);
  const winners = clips.filter((c) => c.votes === maxVotes && clips.length && maxVotes >= 0);

  // update leaderboard stats. Accounts are persisted; guest stats stay in memory.
  let changedUserDb = false;
  const participantPlayers = new Map();
  for (const clip of room.clips.values()) {
    const player = room.players.get(clip.playerId);
    if (player) participantPlayers.set(player.id, player);
  }

  for (const player of participantPlayers.values()) {
    if (player.userId) {
      const user = findUserById(player.userId);
      if (user) {
        user.gamesPlayed = (user.gamesPlayed || 0) + 1;
        changedUserDb = true;
      }
    } else {
      const norm = normalizeName(player.name);
      const current = playerStats.get(norm) || { name: player.name, wins: 0, gamesPlayed: 0 };
      current.name = player.name;
      current.gamesPlayed += 1;
      playerStats.set(norm, current);
    }
  }

  for (const winner of winners) {
    const player = room.players.get(winner.playerId);
    if (player?.userId) {
      const user = findUserById(player.userId);
      if (user) {
        user.wins = (user.wins || 0) + 1;
        changedUserDb = true;
      }
    } else {
      const norm = normalizeName(winner.playerName);
      const current = playerStats.get(norm) || { name: winner.playerName, wins: 0, gamesPlayed: 0 };
      current.name = winner.playerName;
      current.wins += 1;
      playerStats.set(norm, current);
    }
  }

  if (changedUserDb) saveUserDb();

  io.to(room.code).emit('round:results', {
    prompt: room.prompt,
    clips,
    winners,
    totalVotes: room.votes.size
  });
  emitRoom(room);
  emitLeaderboard();
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

  const authUser = socket.data.user || getUserFromCookieHeader(socket.handshake.headers.cookie || '');
  if (authUser) socket.data.user = authUser;

  const cleanName = authUser
    ? authUser.username
    : (String(name || 'Guest').trim().slice(0, 16) || 'Guest');

  room.players.set(socket.id, {
    id: socket.id,
    userId: authUser ? authUser.id : null,
    name: cleanName,
    connected: true,
    submitted: false,
    voted: false
  });

  if (!room.hostId) room.hostId = socket.id;

  socket.join(room.code);
  socketRooms.set(socket.id, room.code);
  socket.emit('room:joined', {
    code: room.code,
    playerId: socket.id,
    isHost: room.hostId === socket.id,
    isQuick: room.isQuick
  });
  emitRoom(room);
  emitQuickRooms();
  return true;
}

io.on('connection', (socket) => {
  socket.data.user = getUserFromCookieHeader(socket.handshake.headers.cookie || '');
  socket.emit('app:hello', { playerId: socket.id, maxPlayers: MAX_PLAYERS, user: publicUser(socket.data.user) });
  emitQuickRooms(socket);
  emitLeaderboard(socket);

  socket.on('quick:list', () => emitQuickRooms(socket));
  socket.on('leaderboard:get', () => emitLeaderboard(socket));
  socket.on('auth:refresh', () => {
    socket.data.user = getUserFromCookieHeader(socket.handshake.headers.cookie || '');
    socket.emit('app:hello', { playerId: socket.id, maxPlayers: MAX_PLAYERS, user: publicUser(socket.data.user) });
    emitLeaderboard(socket);
  });

  socket.on('quick:create', ({ name } = {}) => {
    const room = makeRoom(undefined, true);
    joinRoom(socket, room, name);
  });

  socket.on('quick:join', ({ name, code } = {}) => {
    const normalizedCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(normalizedCode);
    if (!room || !room.isQuick) {
      socket.emit('app:error', 'Quick room not found.');
      return;
    }
    joinRoom(socket, room, name);
  });

  socket.on('custom:create', ({ name } = {}) => {
    const room = makeRoom(undefined, false);
    joinRoom(socket, room, name);
  });

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
    if (room.players.size < 1) {
      socket.emit('app:error', 'Need at least 1 player to start.');
      return;
    }
    startRound(room);
  });

  socket.on('clip:submit', ({ audioData, mimeType } = {}) => {
    const code = socketRooms.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'recording') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.submitted) {
      socket.emit('app:error', 'You already submitted your clip.');
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
    room.clips.set(clipId, {
      clipId,
      playerId: socket.id,
      audioData: data,
      mimeType: String(mimeType || 'audio/webm'),
      submittedAt: Date.now()
    });
    player.submitted = true;
    socket.emit('clip:submitted');
    emitRoom(room);
    maybeEndRecording(room);
  });

  socket.on('vote:submit', ({ clipId } = {}) => {
    const code = socketRooms.get(socket.id);
    const room = rooms.get(code);
    if (!room || room.status !== 'voting') return;
    const player = room.players.get(socket.id);
    const clip = room.clips.get(String(clipId || ''));
    if (!player || !clip) return;
    if (clip.playerId === socket.id) {
      socket.emit('app:error', "You can't vote for yourself.");
      return;
    }
    if (room.votes.has(socket.id)) {
      socket.emit('app:error', 'You already voted.');
      return;
    }
    room.votes.set(socket.id, clip.clipId);
    player.voted = true;
    socket.emit('vote:submitted');
    emitRoom(room);
    maybeEndVoting(room);
  });

  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

server.listen(PORT, () => {
  console.log(`SayItLike MVP running on http://localhost:${PORT}`);
});
