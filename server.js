const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2e6, // enough for short webm audio clips
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const RECORDING_SECONDS = 60;
const VOTING_SECONDS = 45;
const MAX_CLIP_BYTES = 1_400_000;

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

/** @type {Map<string, any>} */
const rooms = new Map();
/** @type {Map<string, string>} socket.id -> roomCode */
const socketRooms = new Map();
let quickRoomCode = null;

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
    status: 'lobby', // lobby | recording | voting | results
    prompt: null,
    players: new Map(), // socket.id -> {id,name,connected,submitted,voted}
    clips: new Map(), // clipId -> {clipId, playerId, audioData, mimeType, submittedAt}
    votes: new Map(), // voterId -> clipId
    timers: { recording: null, voting: null },
    endsAt: null,
    clipCounter: 0,
    round: 0
  };
  rooms.set(code, room);
  return room;
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    connected: p.connected,
    isHost: p.id === room.hostId,
    submitted: !!p.submitted,
    voted: !!p.voted
  }));
}

function emitRoom(room) {
  io.to(room.code).emit('room:update', {
    code: room.code,
    isQuick: room.isQuick,
    hostId: room.hostId,
    status: room.status,
    players: publicPlayers(room),
    prompt: room.prompt,
    round: room.round,
    maxPlayers: MAX_PLAYERS,
    endsAt: room.endsAt,
    submittedCount: [...room.players.values()].filter((p) => p.submitted).length,
    totalPlayers: room.players.size,
    votedCount: room.votes.size
  });
}

function cleanupRoom(room) {
  clearTimeout(room.timers.recording);
  clearTimeout(room.timers.voting);
  rooms.delete(room.code);
  if (quickRoomCode === room.code) quickRoomCode = null;
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

  // Remove the player's clip if still in active round.
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
}

function randomPrompt() {
  return {
    line: lines[Math.floor(Math.random() * lines.length)],
    style: styles[Math.floor(Math.random() * styles.length)]
  };
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
  room.endsAt = Date.now() + RECORDING_SECONDS * 1000;

  for (const player of room.players.values()) {
    player.submitted = false;
    player.voted = false;
  }

  room.timers.recording = setTimeout(() => endRecording(room), RECORDING_SECONDS * 1000);
  emitRoom(room);
}

function clipLetter(index) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return alphabet[index] || String(index + 1);
}

function maybeEndRecording(room) {
  if (room.status !== 'recording') return;
  const activePlayers = [...room.players.values()];
  const submitted = activePlayers.filter((p) => p.submitted).length;
  if (submitted >= activePlayers.length) endRecording(room);
}

function endRecording(room) {
  if (room.status !== 'recording') return;
  clearTimeout(room.timers.recording);

  if (room.clips.size === 0) {
    room.status = 'lobby';
    room.endsAt = null;
    io.to(room.code).emit('game:notice', 'Nobody submitted a clip. Round cancelled.');
    emitRoom(room);
    return;
  }

  room.status = 'voting';
  room.endsAt = Date.now() + VOTING_SECONDS * 1000;
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
      endsAt: room.endsAt
    });
  }
  emitRoom(room);
  maybeEndVoting(room);
}

function maybeEndVoting(room) {
  if (room.status !== 'voting') return;
  const possibleVoters = [...room.players.values()].filter((p) => room.clips.size > 1 || ![...room.clips.values()].some((c) => c.playerId === p.id));
  if (room.votes.size >= possibleVoters.length) endVoting(room);
}

function endVoting(room) {
  if (room.status !== 'voting') return;
  clearTimeout(room.timers.voting);
  room.status = 'results';
  room.endsAt = null;

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
  const winners = clips.filter((c) => c.votes === maxVotes && maxVotes >= 0);

  io.to(room.code).emit('round:results', {
    prompt: room.prompt,
    clips,
    winners,
    totalVotes: room.votes.size
  });
  emitRoom(room);
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

  const cleanName = String(name || 'Guest').trim().slice(0, 16) || 'Guest';
  room.players.set(socket.id, { id: socket.id, name: cleanName, connected: true, submitted: false, voted: false });
  if (!room.hostId) room.hostId = socket.id;

  socket.join(room.code);
  socketRooms.set(socket.id, room.code);
  socket.emit('room:joined', {
    code: room.code,
    playerId: socket.id,
    isHost: room.hostId === socket.id
  });
  emitRoom(room);
  return true;
}

io.on('connection', (socket) => {
  socket.emit('app:hello', { playerId: socket.id, maxPlayers: MAX_PLAYERS });

  socket.on('quick:join', ({ name } = {}) => {
    let room = quickRoomCode ? rooms.get(quickRoomCode) : null;
    if (!room || room.players.size >= MAX_PLAYERS || room.status !== 'lobby') {
      room = makeRoom(undefined, true);
      quickRoomCode = room.code;
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
    if (!room) {
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

    const data = String(audioData || '');
    if (!data.startsWith('data:audio/')) {
      socket.emit('app:error', 'Invalid audio clip.');
      return;
    }
    // quick approximate base64 length guard
    if (Buffer.byteLength(data, 'utf8') > MAX_CLIP_BYTES) {
      socket.emit('app:error', 'Audio clip is too large. Keep it under 10 seconds.');
      return;
    }

    // Replace previous clip if player re-submits before time ends.
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
  console.log(`SayItLike running on port ${PORT}`);
});
