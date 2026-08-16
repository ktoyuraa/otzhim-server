/*  ОТЖИМ — сервер подбора и дуэлей
 *  Запуск:  node server.js
 *  Порт берётся из переменной PORT, по умолчанию 8080.
 *
 *  Всё состояние держится в памяти: бои живут минуту, хранить их негде и незачем.
 *  Перезапуск сервера обрывает текущие бои — это допустимо, они короткие.
 */
'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const DUR = 60;                 // длительность боя, секунд
const CODE_TTL = 10 * 60e3;     // код друга живёт 10 минут
const ABC = 'ACEFHJKLMNPRTUVWXY3479';

/* ── состояние ─────────────────────────────────────────────── */
let waiting = null;             // игрок в очереди быстрой игры
const rooms = new Map();        // code -> {a, b, startedAt, ended}
let served = 0;                 // сколько боёв свели за всё время

/* ── статистика воронки ────────────────────────────────────── */
const stats = { days: {} };   // 'ГГГГ-ММ-ДД' -> {open, calib, set, duel, chal, reps, users:{}}

function dayKey() { return new Date().toISOString().slice(0, 10); }
function bump(ev, uid, n) {
  const k = dayKey();
  const d = stats.days[k] || (stats.days[k] = { open:0, calib:0, set:0, duel:0, chal:0, reps:0, users:{} });
  if (ev in d) d[ev] += (n || 1);
  if (uid) d.users[String(uid).slice(0, 12)] = 1;
  // храним только 30 последних дней
  const keys = Object.keys(stats.days).sort();
  while (keys.length > 30) delete stats.days[keys.shift()];
}
function statsView() {
  const out = {};
  Object.keys(stats.days).sort().forEach(k => {
    const d = stats.days[k];
    out[k] = { открыли: d.open, откалибровались: d.calib, подходов: d.set,
               боёв: d.duel, миссий: d.chal, отжиманий: d.reps,
               уникальных: Object.keys(d.users).length };
  });
  return out;
}

/* ── профили игроков ───────────────────────────────────────── */
const fs = require('fs');
const STORE = process.env.STORE || '/tmp/otzhim-data.json';
const profiles = new Map();     // id -> {id,name,total,best,xp,streak,lastDay,at}

const clean = (v, max) => String(v == null ? '' : v).slice(0, max);

function saveProfile(p) {
  if (!p || !p.id) return null;
  const id = clean(p.id, 12).toUpperCase();
  const cur = profiles.get(id) || { id, name: 'Игрок', total: 0, best: 0, xp: 0, streak: 0 };
  const merged = {
    id,
    name:    clean(p.name || cur.name, 16) || 'Игрок',
    total:   Math.max(cur.total  | 0, Math.min(p.total  | 0, 5e6)),
    best:    Math.max(cur.best   | 0, Math.min(p.best   | 0, 500)),
    xp:      Math.max(cur.xp     | 0, Math.min(p.xp     | 0, 5e6)),
    streak:  Math.max(cur.streak | 0, Math.min(p.streak | 0, 3650)),
    lastDay: clean(p.lastDay || cur.lastDay || '', 10),
    at: Date.now()
  };
  profiles.set(id, merged);
  return merged;
}

function topList() {
  const all = [...profiles.values()];
  const by = k => all.slice().sort((a, b) => b[k] - a[k]).slice(0, 20)
    .map(p => ({ name: p.name, total: p.total, best: p.best, streak: p.streak }));
  return { total: by('total'), best: by('best'), streak: by('streak') };
}

/* снимок на диск: переживает перезапуск процесса, но не пересборку */
function dump() {
  try {
    fs.writeFileSync(STORE, JSON.stringify({
      profiles: [...profiles.values()],
      stats: stats.days,
      ghosts: ghosts.slice(-300)
    }));
  } catch (e) {}
}
function restore() {
  try {
    const d = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    (d.profiles || []).forEach(p => profiles.set(p.id, p));
    (d.ghosts || []).forEach(g => ghosts.push(g));
    if (d.stats) Object.assign(stats.days, d.stats);
    console.log('восстановлено профилей: ' + profiles.size + ', записей: ' + ghosts.length);
  } catch (e) {}
}

/* ── тени: записи прошлых забегов ──────────────────────────── */
const GHOST_MAX = 800;          // больше не храним, вытесняем старые
const ghosts = [];              // {reps, times:[сек...], lvl, at}

function addGhost(g) {
  if (!g || !Array.isArray(g.times)) return;
  const reps = Math.max(0, g.reps | 0);
  if (reps < 5 || reps > 200) return;               // мусор не берём
  const times = g.times
    .map(Number).filter(t => t >= 0 && t <= 120)
    .sort((a, b) => a - b).slice(0, 200);
  if (times.length < 5) return;
  ghosts.push({ reps: times.length, times, lvl: Math.max(1, g.lvl | 0) || 1,
                name: clean(g.name || 'Игрок', 16), at: Date.now() });
  if (ghosts.length > GHOST_MAX) ghosts.shift();
}

/* подбираем тень под силу игрока: сначала близкие, иначе любую */
function pickGhost(best) {
  if (!ghosts.length) return null;
  const b = Math.max(1, best | 0) || 12;
  const near = ghosts.filter(g => g.reps >= b * 0.6 && g.reps <= b * 1.5);
  const pool = near.length ? near : ghosts;
  return pool[(Math.random() * pool.length) | 0];
}

const code5 = () => Array.from({length:5}, () => ABC[Math.random()*ABC.length|0]).join('');
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

/* ── здоровье сервера, чтобы можно было проверить браузером ── */
const http_ = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (req.url === '/stats') {
    res.writeHead(200, Object.assign({'Content-Type':'application/json; charset=utf-8'}, cors));
    return res.end(JSON.stringify(statsView(), null, 2));
  }
  if (req.url === '/health') {
    res.writeHead(200, Object.assign({'Content-Type':'application/json; charset=utf-8'}, cors));
    return res.end(JSON.stringify({
      ok: true,
      online: wss ? wss.clients.size : 0,
      queue: waiting ? 1 : 0,
      rooms: rooms.size,
      duels: served,
      ghosts: ghosts.length,
      players: profiles.size,
      uptime: Math.round(process.uptime())
    }));
  }
  res.writeHead(404); res.end('otzhim');
});

const ALLOWED = [
  'https://otzhim.space',
  'https://www.otzhim.space',
  'https://ktoyuraa.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];
function originOK(o) {
  if (!o) return true;                       // без источника — свои же тесты
  return ALLOWED.includes(o);
}

const wss = new WebSocketServer({
  server: http_,
  verifyClient: (info, done) => {
    const o = info.origin || (info.req && info.req.headers.origin);
    if (originOK(o)) return done(true);
    console.log('отказ источнику: ' + o);
    done(false, 403, 'origin not allowed');
  }
});

/* ── свести двоих и начать бой ─────────────────────────────── */
function pair(p1, p2, roomCode) {
  const room = { a: p1, b: p2, startedAt: 0, ended: false, code: roomCode || null };
  p1.room = room; p1.side = 'a'; p1.reps = 0; p1.ready = false;
  p2.room = room; p2.side = 'b'; p2.reps = 0; p2.ready = false;
  if (roomCode) rooms.set(roomCode, room);
  served++;
  send(p1.ws, { t: 'found', side: 'a' });
  send(p2.ws, { t: 'found', side: 'b' });
}

/* оба прошли калибровку — стартуем одновременно */
function maybeStart(room) {
  if (!room || room.startedAt) return;
  if (!room.a.ready || !room.b.ready) return;
  room.startedAt = Date.now();
  const go = { t: 'go', dur: DUR };
  send(room.a.ws, go); send(room.b.ws, go);
  // страховка: если клиенты промолчат, закроем бой сами
  room.timer = setTimeout(() => finish(room), (DUR + 8) * 1000);
}

function foeOf(p) {
  const r = p.room; if (!r) return null;
  return r.a === p ? r.b : r.a;
}

function finish(room) {
  if (!room || room.ended) return;
  room.ended = true;
  clearTimeout(room.timer);
  const res = { t: 'over', a: room.a.reps, b: room.b.reps };
  send(room.a.ws, res); send(room.b.ws, res);
  if (room.code) rooms.delete(room.code);
  room.a.room = null; room.b.room = null;
}

/* соперник ушёл посреди боя */
function abandon(p) {
  const foe = foeOf(p), room = p.room;
  if (!room) return;
  clearTimeout(room.timer);
  room.ended = true;
  if (room.code) rooms.delete(room.code);
  send(foe && foe.ws, { t: 'foegone', reps: p.reps });
  if (foe) foe.room = null;
  p.room = null;
}

/* ── подключение ───────────────────────────────────────────── */
wss.on('connection', ws => {
  const p = { ws, room: null, side: null, reps: 0, ready: false, code: null, alive: true };
  ws.on('pong', () => { p.alive = true; });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || !m.t) return;

    switch (m.t) {

      /* быстрая игра: либо забираем ждущего, либо встаём сами */
      case 'find': {
        if (p.room) return;
        if (waiting && waiting !== p && waiting.ws.readyState === 1) {
          const other = waiting; waiting = null;
          pair(other, p);
        } else {
          waiting = p;
          send(ws, { t: 'waiting' });
        }
        break;
      }

      /* отмена поиска */
      case 'cancel': {
        if (waiting === p) waiting = null;
        if (p.code) { rooms.delete(p.code); p.code = null; }
        break;
      }

      /* игра с другом: выдать разовый код */
      case 'host': {
        if (p.code) rooms.delete(p.code);
        let c; do { c = code5(); } while (rooms.has(c));
        p.code = c;
        rooms.set(c, { host: p, createdAt: Date.now(), pending: true });
        send(ws, { t: 'code', code: c });
        break;
      }

      /* игра с другом: войти по коду */
      case 'join': {
        const c = String(m.code || '').toUpperCase();
        const slot = rooms.get(c);
        if (!slot || !slot.pending || !slot.host || slot.host.ws.readyState !== 1) {
          return send(ws, { t: 'nocode' });
        }
        rooms.delete(c);
        slot.host.code = null;
        pair(slot.host, p, null);
        break;
      }

      /* калибровка пройдена */
      case 'ready': {
        p.ready = true;
        maybeStart(p.room);
        break;
      }

      /* засчитано повторение */
      case 'rep': {
        p.reps = Math.max(0, m.n | 0);
        const foe = foeOf(p);
        if (foe) send(foe.ws, { t: 'foe', n: p.reps });
        break;
      }

      /* бой окончен на стороне клиента */
      case 'end': {
        p.reps = Math.max(p.reps, m.n | 0);
        const room = p.room;
        if (room) { p.done = true;
          const foe = foeOf(p);
          if (!foe || foe.done) finish(room);
        }
        break;
      }

      /* прислали запись своего забега */
      case 'ghost': {
        addGhost(m);
        break;
      }

      /* живого нет — просим чужую запись */
      case 'ghostreq': {
        const g = pickGhost(m.best);
        if (g) send(ws, { t: 'ghost', reps: g.reps, times: g.times, lvl: g.lvl, name: g.name || 'Игрок' });
        else   send(ws, { t: 'noghost' });
        break;
      }

      /* сохранить профиль */
      case 'save': {
        const saved = saveProfile(m);
        if (saved) send(ws, { t: 'saved' });
        break;
      }

      /* забрать профиль по коду восстановления */
      case 'load': {
        const id = clean(m.id, 12).toUpperCase();
        const p = profiles.get(id);
        send(ws, p ? { t: 'profile', p } : { t: 'noprofile' });
        break;
      }

      /* таблица лидеров */
      case 'top': {
        send(ws, { t: 'top', ...topList() });
        break;
      }

      /* событие воронки */
      case 'ev': {
        const name = String(m.ev || '').slice(0, 10);
        if (['open','calib','set','duel','chal','reps'].includes(name)) {
          bump(name, m.id, name === 'reps' ? Math.min(500, m.n | 0) : 1);
        }
        break;
      }

      case 'leave': {
        if (waiting === p) waiting = null;
        abandon(p);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (waiting === p) waiting = null;
    if (p.code) rooms.delete(p.code);
    abandon(p);
  });
});

/* ── уборка: мёртвые соединения и протухшие коды ───────────── */
setInterval(() => {
  wss.clients.forEach(ws => {
    const p = [...wss.clients].includes(ws) ? ws : null;
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
  const now = Date.now();
  for (const [c, r] of rooms) {
    if (r.pending && now - r.createdAt > CODE_TTL) rooms.delete(c);
  }
}, 30e3);

wss.on('connection', ws => { ws.isAlive = true; });

restore();
setInterval(dump, 30e3);
process.on('SIGTERM', () => { dump(); process.exit(0); });

http_.listen(PORT, () => {
  console.log('ОТЖИМ: сервер слушает порт ' + PORT);
});
