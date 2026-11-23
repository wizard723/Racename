const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 25000,
  pingInterval: 10000
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const trackRecords = {
  oval: [],
  circuit: [],
  hairpin: []
};

const VALID_TRACKS = ['oval', 'circuit', 'hairpin'];
const VALID_WEATHER = ['clear', 'rain', 'fog'];
const VALID_TIME = ['day', 'night'];
const VALID_DIFFICULTY = ['easy', 'medium', 'hard'];
const VALID_CARS = ['sport', 'muscle', 'drift', 'hyper'];

const START_POSITIONS = [
  { x: 520, y: 310, angle: 0 },
  { x: 520, y: 375, angle: 0 },
  { x: 520, y: 440, angle: 0 },
  { x: 440, y: 310, angle: 0 },
  { x: 440, y: 375, angle: 0 },
  { x: 440, y: 440, angle: 0 }
];

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms[code] ? genCode() : code;
}

function sanitize(s) {
  return String(s || 'Гонщик').replace(/[<>]/g, '').trim().slice(0, 16) || 'Гонщик';
}

function sanitizeColor(c) {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#ff3366';
}

function sanitizeEnum(val, list, def) {
  return list.includes(val) ? val : def;
}

function getPlayers(code) {
  const room = rooms[code];
  if (!room) return [];
  return Object.values(room.players).map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
    carType: p.carType,
    x: p.x,
    y: p.y,
    vx: p.vx || 0,
    vy: p.vy || 0,
    angle: p.angle,
    velAngle: p.velAngle,
    speed: p.speed,
    steerInput: p.steerInput || 0,
    lap: p.lap || 1,
    bestLap: p.bestLap || null,
    cp: p.cp || 0,
    drift: p.drift || 0,
    braking: !!p.braking,
    gear: p.gear || 1,
    rpm: p.rpm || 1000,
    penalty: p.penalty || 0,
    finished: !!p.finished,
    finishTime: p.finishTime || null,
    disconnected: !!p.disconnected,
    isHost: p.id === room.hostId
  }));
}

function getRoomState(code) {
  const r = rooms[code];
  if (!r) return null;
  return {
    code,
    hostId: r.hostId,
    started: r.started,
    countdown: r.countdown,
    startTime: r.startTime,
    serverTime: Date.now(),
    settings: r.settings,
    players: getPlayers(code),
    records: trackRecords[r.settings.track] || []
  };
}

function cleanupRoom(code) {
  const r = rooms[code];
  if (!r) return;
  if (r.countdownTimer) {
    clearInterval(r.countdownTimer);
    r.countdownTimer = null;
  }
  if (r.cleanupTimer) {
    clearTimeout(r.cleanupTimer);
    r.cleanupTimer = null;
  }
  delete rooms[code];
}

function createPlayerObj(id, name, color, carType, pos) {
  return {
    id,
    name: sanitize(name),
    color: sanitizeColor(color),
    carType: sanitizeEnum(carType, VALID_CARS, 'sport'),
    x: pos.x,
    y: pos.y,
    vx: 0,
    vy: 0,
    angle: pos.angle,
    velAngle: pos.angle,
    speed: 0,
    steerInput: 0,
    lap: 1,
    bestLap: null,
    cp: 0,
    drift: 0,
    braking: false,
    gear: 1,
    rpm: 1000,
    penalty: 0,
    finished: false,
    finishTime: null,
    disconnected: false,
    disconnectTimer: null,
    lastPacket: Date.now()
  };
}

io.on('connection', (socket) => {
  socket.on('createRoom', (payload, cb) => {
    if (typeof cb !== 'function') return;
    const { name, color, carType, settings } = payload || {};
    const code = genCode();
    const roomSettings = {
      track: sanitizeEnum(settings?.track, VALID_TRACKS, 'oval'),
      weather: sanitizeEnum(settings?.weather, VALID_WEATHER, 'clear'),
      timeOfDay: sanitizeEnum(settings?.timeOfDay, VALID_TIME, 'day'),
      laps: Math.max(1, Math.min(10, parseInt(settings?.laps, 10) || 3)),
      aiCount: Math.max(0, Math.min(5, parseInt(settings?.aiCount, 10) || 2)),
      difficulty: sanitizeEnum(settings?.difficulty, VALID_DIFFICULTY, 'medium')
    };

    rooms[code] = {
      hostId: socket.id,
      players: {},
      started: false,
      countdown: 0,
      countdownTimer: null,
      cleanupTimer: null,
      startTime: 0,
      settings: roomSettings
    };

    const pos = START_POSITIONS[0];
    rooms[code].players[socket.id] = createPlayerObj(socket.id, name, color, carType, pos);

    socket.join(code);
    socket.roomCode = code;
    cb({ ok: true, state: getRoomState(code) });
  });

  socket.on('joinRoom', (payload, cb) => {
    if (typeof cb !== 'function') return;
    let { code, name, color, carType } = payload || {};
    code = String(code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Комната не найдена' });
    if (room.started) return cb({ ok: false, error: 'Гонка уже началась' });
    const activePlayers = Object.values(room.players).filter(p => !p.disconnected);
    if (activePlayers.length >= 6) return cb({ ok: false, error: 'Комната заполнена (макс. 6)' });

    const pos = START_POSITIONS[activePlayers.length] || START_POSITIONS[0];
    room.players[socket.id] = createPlayerObj(socket.id, name, color, carType, pos);

    socket.join(code);
    socket.roomCode = code;
    io.to(code).emit('roomUpdated', getRoomState(code));
    cb({ ok: true, state: getRoomState(code) });
  });

  // Автоматическое восстановление сессии при обрыве связи
  socket.on('rejoinRoom', (payload, cb) => {
    if (typeof cb !== 'function') return;
    const code = String(payload?.code || '').toUpperCase().trim();
    const oldId = String(payload?.oldId || '');
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Комната закрыта' });

    const oldPlayer = room.players[oldId];
    if (oldPlayer) {
      if (oldPlayer.disconnectTimer) {
        clearTimeout(oldPlayer.disconnectTimer);
        oldPlayer.disconnectTimer = null;
      }
      delete room.players[oldId];
      oldPlayer.id = socket.id;
      oldPlayer.disconnected = false;
      oldPlayer.lastPacket = Date.now();
      room.players[socket.id] = oldPlayer;
      if (room.hostId === oldId) {
        room.hostId = socket.id;
      }
      socket.join(code);
      socket.roomCode = code;
      io.to(code).emit('playerRejoined', { oldId, player: getPlayers(code).find(p => p.id === socket.id), hostId: room.hostId });
      return cb({ ok: true, state: getRoomState(code) });
    }

    if (!room.started && Object.keys(room.players).length < 6) {
      const pos = START_POSITIONS[Object.keys(room.players).length] || START_POSITIONS[0];
      room.players[socket.id] = createPlayerObj(socket.id, payload?.name, payload?.color, payload?.carType, pos);
      socket.join(code);
      socket.roomCode = code;
      io.to(code).emit('roomUpdated', getRoomState(code));
      return cb({ ok: true, state: getRoomState(code) });
    }

    return cb({ ok: false, error: 'Не удалось восстановить подключение' });
  });

  socket.on('updateRoomSettings', (settings) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.started) return;

    room.settings = {
      track: sanitizeEnum(settings?.track, VALID_TRACKS, room.settings.track),
      weather: sanitizeEnum(settings?.weather, VALID_WEATHER, room.settings.weather),
      timeOfDay: sanitizeEnum(settings?.timeOfDay, VALID_TIME, room.settings.timeOfDay),
      laps: Math.max(1, Math.min(10, parseInt(settings?.laps, 10) || room.settings.laps)),
      aiCount: Math.max(0, Math.min(5, parseInt(settings?.aiCount, 10) || 0)),
      difficulty: sanitizeEnum(settings?.difficulty, VALID_DIFFICULTY, room.settings.difficulty)
    };
    io.to(code).emit('roomUpdated', getRoomState(code));
  });

  socket.on('updatePlayerProfile', ({ name, color, carType }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || !room.players[socket.id] || room.started) return;
    const p = room.players[socket.id];
    p.name = sanitize(name);
    p.color = sanitizeColor(color);
    p.carType = sanitizeEnum(carType, VALID_CARS, p.carType);
    io.to(code).emit('roomUpdated', getRoomState(code));
  });

  socket.on('startGame', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.started) return;

    room.started = true;
    room.countdown = 3;
    const ids = Object.keys(room.players);
    ids.forEach((id, idx) => {
      const pos = START_POSITIONS[idx] || START_POSITIONS[0];
      const p = room.players[id];
      p.x = pos.x;
      p.y = pos.y;
      p.vx = 0;
      p.vy = 0;
      p.angle = pos.angle;
      p.velAngle = pos.angle;
      p.speed = 0;
      p.steerInput = 0;
      p.lap = 1;
      p.bestLap = null;
      p.cp = 0;
      p.drift = 0;
      p.braking = false;
      p.penalty = 0;
      p.finished = false;
      p.finishTime = null;
      p.lastPacket = Date.now();
    });

    io.to(code).emit('gameStarted', getRoomState(code));

    room.countdownTimer = setInterval(() => {
      if (!rooms[code]) return;
      room.countdown -= 1;
      if (room.countdown > 0) {
        io.to(code).emit('countdown', room.countdown);
      } else {
        clearInterval(room.countdownTimer);
        room.countdownTimer = null;
        room.startTime = Date.now();
        io.to(code).emit('raceGo', { startTime: room.startTime, serverTime: Date.now() });
      }
    }, 1000);
  });

  socket.on('restartRoom', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.countdownTimer) {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
    }
    room.started = false;
    room.countdown = 0;
    Object.values(room.players).forEach((p, idx) => {
      const pos = START_POSITIONS[idx] || START_POSITIONS[0];
      p.x = pos.x;
      p.y = pos.y;
      p.vx = 0;
      p.vy = 0;
      p.angle = pos.angle;
      p.velAngle = pos.angle;
      p.speed = 0;
      p.lap = 1;
      p.bestLap = null;
      p.cp = 0;
      p.finished = false;
      p.finishTime = null;
      p.penalty = 0;
    });
    io.to(code).emit('backToLobby', getRoomState(code));
  });

  socket.on('update', (d) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || !room.started) return;
    const p = room.players[socket.id];
    if (!p || !d || typeof d !== 'object') return;

    const now = Date.now();
    const dt = Math.max(0.015, Math.min(1.5, (now - p.lastPacket) / 1000));
    p.lastPacket = now;

    const nx = Number(d.x);
    const ny = Number(d.y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;

    // Мягкая проверка от читов с запасом на пинг и старт-позиции трассы
    const dist = Math.hypot(nx - p.x, ny - p.y);
    if (dist > 1800 * dt + 450 && p.lastPacket - room.startTime > 1500) return;

    p.x = nx;
    p.y = ny;
    p.vx = Number.isFinite(d.vx) ? Math.max(-1200, Math.min(1200, d.vx)) : 0;
    p.vy = Number.isFinite(d.vy) ? Math.max(-1200, Math.min(1200, d.vy)) : 0;
    p.angle = Number.isFinite(d.angle) ? d.angle : p.angle;
    p.velAngle = Number.isFinite(d.velAngle) ? d.velAngle : p.angle;
    p.speed = Number.isFinite(d.speed) ? Math.max(-400, Math.min(1100, d.speed)) : 0;
    p.steerInput = Number.isFinite(d.steerInput) ? Math.max(-1, Math.min(1, d.steerInput)) : 0;
    p.lap = Math.max(1, Math.min(20, parseInt(d.lap, 10) || p.lap));
    p.bestLap = Number.isFinite(d.bestLap) && d.bestLap > 0 ? d.bestLap : p.bestLap;
    p.cp = Math.max(0, Math.min(50, parseInt(d.cp, 10) || 0));
    p.drift = Number.isFinite(d.drift) ? d.drift : 0;
    p.braking = !!d.braking;
    p.gear = Math.max(-1, Math.min(6, parseInt(d.gear, 10) || 1));
    p.rpm = Math.max(800, Math.min(9500, parseInt(d.rpm, 10) || 1000));
    p.penalty = Number.isFinite(d.penalty) ? Math.max(0, d.penalty) : 0;

    if (d.finished && !p.finished) {
      p.finished = true;
      p.finishTime = Number.isFinite(d.finishTime) ? d.finishTime : (now - room.startTime);
      const track = room.settings.track;
      trackRecords[track].push({
        name: p.name,
        carType: p.carType,
        time: p.finishTime,
        laps: room.settings.laps,
        date: new Date().toISOString().slice(0, 10)
      });
      trackRecords[track].sort((a, b) => a.time - b.time);
      trackRecords[track] = trackRecords[track].slice(0, 10);
      io.to(code).emit('playerFinished', {
        id: p.id,
        name: p.name,
        finishTime: p.finishTime,
        records: trackRecords[track]
      });
    }

    socket.to(code).volatile.emit('playerUpdate', {
      id: socket.id,
      t: now,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      angle: p.angle,
      speed: p.speed,
      steerInput: p.steerInput,
      lap: p.lap,
      bestLap: p.bestLap,
      drift: p.drift,
      braking: p.braking,
      gear: p.gear,
      rpm: p.rpm,
      penalty: p.penalty,
      finished: p.finished,
      finishTime: p.finishTime
    });
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    player.disconnected = true;
    const disconnectedId = socket.id;

    // Даём 12 секунд на автоматическое переподключение игрока
    player.disconnectTimer = setTimeout(() => {
      const r = rooms[code];
      if (!r || !r.players[disconnectedId] || !r.players[disconnectedId].disconnected) return;
      delete r.players[disconnectedId];
      const remainingIds = Object.keys(r.players);
      if (remainingIds.length === 0) {
        cleanupRoom(code);
      } else {
        if (r.hostId === disconnectedId) {
          r.hostId = remainingIds[0];
        }
        io.to(code).emit('playerLeft', {
          id: disconnectedId,
          newHostId: r.hostId
        });
      }
    }, 12000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Turbo Racing Server running on port ' + PORT));
