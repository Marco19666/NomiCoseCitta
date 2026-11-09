// ============================================================
// NOMI COSE CITTÀ — app.js (v11, con debug e fallback)
// ============================================================

import { joinRoom } from 'https://cdn.jsdelivr.net/npm/trystero@0.21.5/torrent/+esm';

// ------------------------------------------------------------
// CONFIGURAZIONE
// ------------------------------------------------------------
const APP_ID = 'nomi-cose-citta-v1';
const ALPHABET = 'ABCDEFGILMNOPRSTUVZ'; // 19 lettere (esclusi H J K Q W X Y)
const STORAGE_NAME = 'ncc_player_name';
const FIXED_CATEGORIES = ['Cose', 'Nomi', 'Città'];
const WORKER_URL = 'https://muddy-grass-6726.chiccovision.workers.dev';

// ------------------------------------------------------------
// STATO
// ------------------------------------------------------------
const S = {
  name: '',
  isHost: false,
  roomCode: '',
  room: null,
  send: {},
  peers: new Map(),

  config: { extras: [], timer: 60, rounds: 5 },

  round: {
    num: 0,
    letter: '',
    active: false,
    prevLetter: '',
    timer: 0,
    remaining: 0,
  },
  interval: null,

  answers: {},
  ready: false,

  scores: new Map(),

  forceCloseTimeout: null,
};

// ------------------------------------------------------------
// DOM
// ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const D = {
  screenLobby: $('screenLobby'),
  screenGame: $('screenGame'),
  screenResults: $('screenResults'),

  joinCard: $('joinCard'),
  configCard: $('configCard'),
  inputName: $('inputPlayerName'),
  btnCreate: $('btnCreateRoom'),
  inputCode: $('inputRoomCode'),
  btnJoin: $('btnJoinRoom'),

  extraCats: $('extraCategories'),
  timerOpts: $('timerOptions'),
  roundsOpts: $('roundsOptions'),
  playerList: $('playerList'),
  playerCount: $('playerCount'),
  btnShare: $('btnShareWa'),
  btnStart: $('btnStartGame'),
  hostHint: $('hostHint'),

  roomBadge: $('roomBadge'),
  roomCode: $('roomCode'),
  connDot: $('connDot'),

  roundLetter: $('roundLetter'),
  roundTimer: $('roundTimer'),
  roundTimerBox: $('roundTimerBox'),
  roundNumber: $('roundNumber'),
  roundSeed: $('roundSeed'),
  categoryInputs: $('categoryInputs'),
  btnDone: $('btnDone'),
  doneHint: $('doneHint'),
  gamePlayerList: $('gamePlayerList'),

  resultsTitle: $('resultsTitle'),
  standings: $('standingsContent'),
  results: $('resultsContent'),
  btnNext: $('btnNextRound'),

  toast: $('toast'),
};

// ------------------------------------------------------------
// UTILITY
// ------------------------------------------------------------
function toast(msg, ms = 2200) {
  D.toast.textContent = msg;
  D.toast.hidden = false;
  D.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    D.toast.classList.remove('show');
    setTimeout(() => { D.toast.hidden = true; }, 250);
  }, ms);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function showScreen(which) {
  for (const el of [D.screenLobby, D.screenGame, D.screenResults]) {
    if (el) el.classList.remove('active');
  }
  if (which === 'lobby' && D.screenLobby) D.screenLobby.classList.add('active');
  if (which === 'game' && D.screenGame) D.screenGame.classList.add('active');
  if (which === 'results' && D.screenResults) D.screenResults.classList.add('active');
}

function codeRoom() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return [...buf].map(b => chars[b % chars.length]).join('');
}

function seedRandom(seed) {
  let x = seed >>> 0 || 1;
  x ^= x << 13; x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5;  x >>>= 0;
  return x / 4294967296;
}

function pickLetter(seed, prev) {
  const pool = ALPHABET.split('').filter(l => l !== prev);
  return pool[Math.floor(seedRandom(seed) * pool.length)];
}

function fmt(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : String(r);
}

function normName(n) {
  return String(n || '').trim().toLowerCase();
}

function ensureName() {
  let n = (D.inputName?.value || '').trim();
  if (!n) n = localStorage.getItem(STORAGE_NAME) || '';
  if (!n) n = 'Giocatore ' + Math.floor(100 + Math.random() * 900);
  n = n.slice(0, 20);
  localStorage.setItem(STORAGE_NAME, n);
  S.name = n;
  return n;
}

function activeCategories() {
  return [...FIXED_CATEGORIES, ...S.config.extras];
}

// ------------------------------------------------------------
// TRYSTERO
// ------------------------------------------------------------
function initRoom(isHost, roomCode) {
  S.isHost = isHost;
  S.roomCode = roomCode;
  S.room = joinRoom({ appId: APP_ID }, roomCode);

  D.roomBadge.hidden = false;
  D.roomCode.textContent = roomCode;
  D.connDot.classList.add('online');
  D.joinCard.hidden = true;
  D.configCard.hidden = false;
  if (isHost) {
    D.btnStart.disabled = false;
    D.btnShare.hidden = false;
    D.hostHint.hidden = true;
  } else {
    D.btnStart.disabled = true;
    D.btnShare.hidden = true;
    D.hostHint.hidden = false;
  }

  const [sendPresence, onPresence] = S.room.makeAction('presence');
  const [sendAnswers, onAnswers] = S.room.makeAction('answers');
  const [sendDone, onDone] = S.room.makeAction('done');
  const [sendRoundStart, onRoundStart] = S.room.makeAction('round-start');
  const [sendResults, onResults] = S.room.makeAction('results');
  const [sendConfig, onConfig] = S.room.makeAction('config');

  S.send = { presence: sendPresence, answers: sendAnswers, done: sendDone,
             roundStart: sendRoundStart, results: sendResults, config: sendConfig };

  const announce = () => sendPresence({ name: S.name, isHost: S.isHost });

  onPresence((data, peerId) => {
    S.peers.set(peerId, {
      name: data.name, isHost: data.isHost, ready: false, answers: null,
    });
    renderPlayers();
    if (S.isHost) sendConfig({ config: S.config }, peerId);
    announce();
  });

  onConfig((data) => {
    if (S.isHost || !data?.config) return;
    S.config = {
      extras: Array.isArray(data.config.extras) ? data.config.extras : [],
      timer: data.config.timer || 60,
      rounds: data.config.rounds || 5,
    };
    syncConfigUI();
  });

  S.room.onPeerJoin(peerId => {
    console.log('peer join', peerId);
    setTimeout(announce, 250);
  });
  S.room.onPeerLeave(peerId => {
    S.peers.delete(peerId);
    renderPlayers();
  });

  onAnswers((data) => {
    if (!S.isHost) return;
    console.log('HOST onAnswers', data);
    toast('Risposte da ' + (data?.name || '?'), 1500);
    const name = data?.name;
    if (!name) return;
    const answers = data.answers || {};
    if (normName(name) === normName(S.name)) { S.answers = answers; return; }
    for (const p of S.peers.values()) {
      if (normName(p.name) === normName(name)) {
        p.answers = answers;
        p.ready = true;
        break;
      }
    }
    renderPlayers();
  });

  onDone((data) => {
    if (!S.isHost) return;
    console.log('HOST onDone', data);
    toast('Done da ' + (data?.name || '?'), 1500);
    const name = data?.name;
    if (!name) return;
    if (normName(name) === normName(S.name)) {
      S.ready = true;
    } else {
      for (const p of S.peers.values()) {
        if (normName(p.name) === normName(name)) { p.ready = true; break; }
      }
    }
    renderPlayers();
    checkAllReady();
  });

  onRoundStart((data) => {
    if (S.isHost) return;
    if (!data?.letter || !Array.isArray(data.categories)) {
      toast('Errore: dati round mancanti');
      return;
    }
    clientStartRound(data);
  });

  onResults((data) => {
    if (S.isHost) return;
    if (Array.isArray(data.scores)) S.scores = new Map(data.scores);
    renderStandings();
    renderResults(data.results);
    D.resultsTitle.textContent = data.isLast ? 'Classifica finale' : 'Risultati manche';
    D.btnNext.hidden = true;
    showScreen('results');
  });

  setTimeout(announce, 400);
}

// ------------------------------------------------------------
// LOBBY
// ------------------------------------------------------------
D.btnCreate.addEventListener('click', () => {
  ensureName();
  const code = codeRoom();
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.pushState({}, '', url);
  initRoom(true, code);
});

D.btnJoin.addEventListener('click', () => {
  ensureName();
  const code = (D.inputCode.value || '').trim().toUpperCase();
  if (!code) { toast('Inserisci un codice stanza'); return; }
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.pushState({}, '', url);
  initRoom(false, code);
});

D.btnShare.addEventListener('click', () => {
  const url = `${location.origin}${location.pathname}?room=${S.roomCode}`;
  const text = encodeURIComponent(`Gioca a Nomi Cose Città! ${url}`);
  window.open(`https://wa.me/?text=${text}`, '_blank');
});

D.extraCats.addEventListener('change', () => {
  if (!S.isHost) return;
  S.config.extras = [...D.extraCats.querySelectorAll('.chip-check:checked')].map(c => c.value);
  broadcastConfig();
});
D.timerOpts.addEventListener('change', () => {
  if (!S.isHost) return;
  const sel = D.timerOpts.querySelector('.chip-check:checked');
  if (sel) S.config.timer = parseInt(sel.value, 10);
  broadcastConfig();
});
D.roundsOpts.addEventListener('change', () => {
  if (!S.isHost) return;
  const sel = D.roundsOpts.querySelector('.chip-check:checked');
  if (sel) S.config.rounds = parseInt(sel.value, 10);
  broadcastConfig();
});

function broadcastConfig() {
  if (S.isHost && S.send.config) S.send.config({ config: S.config });
}

function syncConfigUI() {
  if (D.extraCats) {
    D.extraCats.querySelectorAll('.chip-check').forEach(cb => {
      cb.checked = S.config.extras.includes(cb.value);
    });
  }
  if (D.timerOpts) {
    D.timerOpts.querySelectorAll('.chip-check').forEach(rb => {
      rb.checked = parseInt(rb.value, 10) === S.config.timer;
    });
  }
  if (D.roundsOpts) {
    D.roundsOpts.querySelectorAll('.chip-check').forEach(rb => {
      rb.checked = parseInt(rb.value, 10) === S.config.rounds;
    });
  }
}

// ------------------------------------------------------------
// RENDER GIOCATORI
// ------------------------------------------------------------
function renderPlayers() {
  if (!D.playerList) return;
  const list = [
    { name: S.name + ' (tu)', isHost: S.isHost, ready: S.ready },
    ...[...S.peers.values()].map(p => ({ name: p.name, isHost: p.isHost, ready: p.ready })),
  ];
  D.playerCount.textContent = `(${list.length})`;
  D.playerList.innerHTML = list.map(p => `
    <li>
      <span class="player-name">${esc(p.name)}</span>
      <span class="player-tag ${p.isHost ? 'host' : ''} ${p.ready ? 'ready' : ''}">
        ${p.isHost ? 'Host' : (p.ready ? 'Pronto' : 'In attesa')}
      </span>
    </li>`).join('');
  if (D.gamePlayerList) {
    D.gamePlayerList.innerHTML = list.map(p => `
      <li>
        <span class="player-name">${esc(p.name)}</span>
        <span class="player-tag ${p.ready ? 'ready' : ''}">
          ${p.ready ? 'Pronto' : 'In gioco'}
        </span>
      </li>`).join('');
  }
}

// ------------------------------------------------------------
// AVVIO MANCHE
// ------------------------------------------------------------
D.btnStart.addEventListener('click', () => {
  if (S.isHost) hostStartRound();
});

function hostStartRound() {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const letter = pickLetter(seed, S.round.prevLetter);

  S.round.num += 1;
  S.round.letter = letter;
  S.round.prevLetter = letter;
  S.round.timer = S.config.timer;
  S.round.active = true;
  S.ready = false;
  clearTimeout(S.forceCloseTimeout);

  for (const p of S.peers.values()) { p.ready = false; p.answers = null; }

  const cats = activeCategories();

  prepareGameUI(letter, S.round.num, seed, cats);
  S.send.roundStart({ letter, num: S.round.num, seed, timer: S.round.timer, categories: cats });
  runTimer(S.round.timer);
  showScreen('game');
}

function clientStartRound(data) {
  S.round.num = data.num;
  S.round.letter = data.letter;
  S.round.timer = data.timer;
  S.round.active = true;
  S.ready = false;
  prepareGameUI(data.letter, data.num, data.seed, data.categories);
  runTimer(data.timer);
  showScreen('game');
}

function prepareGameUI(letter, num, seed, cats) {
  D.roundLetter.textContent = letter;
  D.roundNumber.textContent = `Manche ${num} di ${S.config.rounds}`;
  D.roundSeed.textContent = `seed: ${seed}`;
  D.roundTimerBox.classList.remove('warning', 'danger', 'hidden-timer');

  D.categoryInputs.innerHTML = cats.map(c => `
    <div class="cat-row" data-cat="${esc(c)}">
      <div class="cat-top">
        <span class="cat-name">${esc(c)}</span>
        <span class="cat-status" data-status="${esc(c)}">—</span>
      </div>
      <input class="input" type="text" data-input="${esc(c)}"
             placeholder="${esc(c)} con la ${esc(letter)}..." autocomplete="off">
    </div>`).join('');

  S.answers = {};
  S.ready = false;
  D.btnDone.disabled = false;
  D.btnDone.textContent = 'Ho finito!';
  D.doneHint.hidden = true;

  D.categoryInputs.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', (e) => {
      S.answers[e.target.dataset.input] = e.target.value.trim();
    });
  });
}

// ------------------------------------------------------------
// TIMER
// ------------------------------------------------------------
function runTimer(seconds) {
  stopTimer();
  if (seconds <= 0) {
    D.roundTimer.textContent = '∞';
    D.roundTimerBox.classList.add('hidden-timer');
    return;
  }
  S.round.remaining = seconds;
  D.roundTimer.textContent = fmt(seconds);
  S.interval = setInterval(() => {
    S.round.remaining -= 1;
    D.roundTimer.textContent = fmt(S.round.remaining);
    if (S.round.remaining <= 10 && S.round.remaining > 0) D.roundTimerBox.classList.add('warning');
    if (S.round.remaining <= 5) { D.roundTimerBox.classList.remove('warning'); D.roundTimerBox.classList.add('danger'); }
    if (S.round.remaining <= 0) { stopTimer(); onTimeUp(); }
  }, 1000);
}

function stopTimer() {
  if (S.interval) { clearInterval(S.interval); S.interval = null; }
}

// ------------------------------------------------------------
// HO FINITO!
// ------------------------------------------------------------
D.btnDone.addEventListener('click', () => {
  if (S.ready) return;
  S.ready = true;
  D.btnDone.disabled = true;
  D.btnDone.textContent = 'In attesa...';
  D.doneHint.hidden = false;
  renderPlayers();

  stopTimer();
  D.roundTimer.textContent = fmt(S.round.remaining);

  if (!S.isHost && S.send.answers) {
    S.send.answers({ name: S.name, answers: S.answers });
    S.send.done({ name: S.name });
  } else if (S.isHost) {
    checkAllReady();
    scheduleForceClose();
  }

  toast('Hai finito! Attendo gli altri...');
});

// ------------------------------------------------------------
// CONTROLLO TUTTI PRONTI (host)
// ------------------------------------------------------------
function checkAllReady() {
  if (!S.isHost || !S.round.active) return;
  if (!S.ready) return;
  for (const p of S.peers.values()) if (!p.ready) return;
  S.round.active = false;
  stopTimer();
  clearTimeout(S.forceCloseTimeout);
  toast('Tutti pronti, calcolo...');
  scoreRound();
}

function scheduleForceClose() {
  clearTimeout(S.forceCloseTimeout);
  S.forceCloseTimeout = setTimeout(() => {
    if (S.isHost && S.round.active && S.ready) {
      toast('Timeout attesa, chiudo il round...', 3000);
      S.round.active = false;
      stopTimer();
      scoreRound();
    }
  }, 6000);
}

// ------------------------------------------------------------
// FINE TEMPO
// ------------------------------------------------------------
function onTimeUp() {
  if (!S.round.active) return;
  S.round.active = false;
  stopTimer();
  clearTimeout(S.forceCloseTimeout);

  if (S.isHost) {
    scoreRound();
  } else {
    if (S.send.answers) S.send.answers({ name: S.name, answers: S.answers });
    toast('Tempo scaduto, attendo i risultati...');
  }
}

// ------------------------------------------------------------
// PUNTEGGI (host)
// ------------------------------------------------------------
async function scoreRound() {
  await new Promise(r => setTimeout(r, 4000));

  const players = [
    { name: S.name, answers: S.answers },
    ...[...S.peers.values()].map(p => ({ name: p.name, answers: p.answers || {} })),
  ];

  const cats = activeCategories();
  const results = {};
  const totals = new Map();

  for (const cat of cats) {
    results[cat] = [];
    for (const pl of players) {
      const word = (pl.answers[cat] || '').trim();
      const valid = word ? await askGemini(word, S.round.letter, cat) : false;
      results[cat].push({ playerName: pl.name, word, valid, points: 0 });
    }
  }

  for (const cat of cats) {
    const entries = results[cat];
    const counts = {};
    for (const e of entries) {
      if (e.valid && e.word) {
        const k = e.word.toLowerCase();
        counts[k] = (counts[k] || 0) + 1;
      }
    }
    for (const e of entries) {
      if (!e.valid || !e.word) { e.points = 0; continue; }
      const k = e.word.toLowerCase();
      e.points = counts[k] > 1 ? 5 : 10;
    }
  }

  for (const cat of cats) {
    for (const e of results[cat]) {
      if (!totals.has(e.playerName)) totals.set(e.playerName, { name: e.playerName, points: 0 });
      totals.get(e.playerName).points += e.points;
    }
  }

  for (const t of totals.values()) {
    if (!S.scores.has(t.name)) S.scores.set(t.name, { name: t.name, total: 0 });
    S.scores.get(t.name).total += t.points;
  }

  const isLast = S.round.num >= S.config.rounds;

  if (S.send.results) {
    S.send.results({ results, scores: [...S.scores.entries()], isLast });
  }

  renderStandings();
  renderResults(results);
  D.resultsTitle.textContent = isLast ? 'Classifica finale' : 'Risultati manche';
  D.btnNext.hidden = !S.isHost || isLast;
  showScreen('results');
}

// ------------------------------------------------------------
// GEMINI
// ------------------------------------------------------------
async function askGemini(word, letter, category) {
  if (word.length < 2) return false;
  if (word[0].toUpperCase() !== letter) return false;

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word, letter, category }),
    });
    if (!res.ok) {
      const errText = await res.text();
      toast('Worker errore ' + res.status, 4000);
      console.warn('Worker error:', res.status, errText);
      return false;
    }
    const data = await res.json();
    if (data.error) {
      toast('Worker: ' + data.error, 4000);
      return false;
    }
    return data.valid === true;
  } catch (e) {
    toast('Rete: ' + e.message, 4000);
    console.warn('Worker fetch failed', e);
    return false;
  }
}

// ------------------------------------------------------------
// RENDER RISULTATI E CLASSIFICA
// ------------------------------------------------------------
function renderStandings() {
  if (!D.standings) return;
  const arr = [...S.scores.values()].sort((a, b) => b.total - a.total);
  if (!arr.length) {
    D.standings.innerHTML = '<p class="muted">Nessun punteggio.</p>';
    return;
  }
  D.standings.innerHTML = `<div class="standings">${arr.map((s, i) => `
    <div class="standing-row ${i === 0 ? 'first' : ''}">
      <span class="standing-pos">${i + 1}°</span>
      <span class="standing-name">${esc(s.name)}</span>
      <span class="standing-points">${s.total} pt</span>
    </div>`).join('')}</div>`;
}

function renderResults(results) {
  if (!D.results) return;
  if (!results) { D.results.innerHTML = '<p class="muted">Nessun risultato.</p>'; return; }
  D.results.innerHTML = Object.entries(results).map(([cat, entries]) => {
    const rows = entries.map(e => {
      const status = e.word ? (e.valid ? '' : '(non valida)') : '(vuoto)';
      return `<div class="result-row">
        <span>${esc(e.playerName)}: <span class="${e.word && !e.valid ? 'word-dup' : ''}">${esc(e.word || '—')}</span> ${status}</span>
        <span class="points">${e.points} pt</span>
      </div>`;
    }).join('');
    return `<div class="result-cat"><div class="result-cat-title">${esc(cat)}</div>${rows}</div>`;
  }).join('');
}

// ------------------------------------------------------------
// PROSSIMA MANCHE
// ------------------------------------------------------------
D.btnNext.addEventListener('click', () => {
  if (!S.isHost) return;
  if (S.round.num >= S.config.rounds) return;
  S.ready = false;
  S.answers = {};
  renderPlayers();
  hostStartRound();
});

// ------------------------------------------------------------
// BOOT
// ------------------------------------------------------------
(function boot() {
  if (D.inputName) {
    const saved = localStorage.getItem(STORAGE_NAME);
    if (saved) D.inputName.value = saved;
  }

  const params = new URLSearchParams(location.search);
  let code = params.get('room');
  if (!code && location.search.includes('room=')) {
    const m = location.search.match(/[?&]room=([^&]+)/);
    if (m) code = decodeURIComponent(m[1]);
  }

  if (code) {
    ensureName();
    initRoom(false, code.toUpperCase());
  } else {
    showScreen('lobby');
  }
})();
