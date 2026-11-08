// ============================================================
// NOMI COSE CITTÀ — app.js (v3 con classifica, stop timer, WhatsApp)
// ============================================================

import { joinRoom } from 'https://cdn.jsdelivr.net/npm/trystero@0.21.5/torrent/+esm';

// ------------------------------------------------------------
// COSTANTI
// ------------------------------------------------------------
const APP_ID = 'nomi-cose-citta-v1';
const ALPHABET = 'ABCDEFGILMNOPRSTUVXZ';
const STORAGE_KEY_NAME = 'ncc_player_name';
const FIXED_CATEGORIES = ['Cose', 'Nomi', 'Città'];
const DEFAULT_EXTRA_CATEGORIES = ['Animali', 'Mestieri', 'Colori', 'Film', 'Cantanti', 'Sport', 'Cibo'];
const WORKER_URL = 'https://muddy-grass-6726.chiccovision.workers.dev';
const STOP_BONUS = 15;

// ------------------------------------------------------------
// STATO
// ------------------------------------------------------------
const state = {
  playerName: '',
  isHost: false,
  roomCode: '',
  room: null,
  peers: new Map(),

  config: {
    extraCategories: [...DEFAULT_EXTRA_CATEGORIES],
    selectedExtras: [],
    timerSeconds: 60,
    totalRounds: 5,
  },

  round: {
    number: 0,
    letter: '',
    seed: 0,
    timerSeconds: 0,
    active: false,
    previousLetter: '',
  },

  myAnswers: {},
  myReady: false,
  myStopped: false,
  myStopRemaining: null,

  // Classifica accumulata: peerKey -> { name, total, rounds, bonusCount }
  scores: new Map(),

  // Stato dello stop timer nel round corrente (autorità host)
  stop: {
    firstPeerKey: null,
    firstRemaining: null,
  },

  timerInterval: null,
};

// ------------------------------------------------------------
// DOM
// ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const dom = {
  screenLobby: $('screenLobby'),
  screenGame: $('screenGame'),
  screenResults: $('screenResults'),
  joinCard: $('joinCard'),
  configCard: $('configCard'),
  btnCreateRoom: $('btnCreateRoom'),
  inputRoomCode: $('inputRoomCode'),
  btnJoinRoom: $('btnJoinRoom'),
  extraCategories: $('extraCategories'),
  timerOptions: $('timerOptions'),
  roundsOptions: $('roundsOptions'),
  playerList: $('playerList'),
  playerCount: $('playerCount'),
  btnShareWa: $('btnShareWa'),
  btnStartGame: $('btnStartGame'),
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
  btnStopTimer: $('btnStopTimer'),
  doneHint: $('doneHint'),
  stopHint: $('stopHint'),
  gamePlayerList: $('gamePlayerList'),
  resultsTitle: $('resultsTitle'),
  standingsContent: $('standingsContent'),
  resultsContent: $('resultsContent'),
  btnNextRound: $('btnNextRound'),
  toast: $('toast'),
};

// ------------------------------------------------------------
// UTILITY
// ------------------------------------------------------------
function showToast(msg, duration = 2500) {
  dom.toast.textContent = msg;
  dom.toast.hidden = false;
  dom.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    dom.toast.classList.remove('show');
    setTimeout(() => { dom.toast.hidden = true; }, 300);
  }, duration);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  for (const b of arr) code += chars[b % chars.length];
  return code;
}

function seededRandom(seed) {
  let x = seed >>> 0;
  if (x === 0) x = 1;
  x ^= x << 13; x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5;  x >>>= 0;
  return x / 4294967296;
}

function pickLetter(seed, previousLetter) {
  const candidates = ALPHABET.split('').filter(l => l !== previousLetter);
  const r = seededRandom(seed);
  return candidates[Math.floor(r * candidates.length)];
}

function showScreen(name) {
  for (const s of [dom.screenLobby, dom.screenGame, dom.screenResults]) {
    s.classList.remove('active');
  }
  if (name === 'lobby') dom.screenLobby.classList.add('active');
  if (name === 'game') dom.screenGame.classList.add('active');
  if (name === 'results') dom.screenResults.classList.add('active');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function ensurePlayerName() {
  let name = localStorage.getItem(STORAGE_KEY_NAME);
  if (!name) {
    name = prompt('Come ti chiami?');
    if (!name || !name.trim()) {
      name = 'Giocatore ' + Math.floor(Math.random() * 900 + 100);
    }
    name = name.trim().slice(0, 20);
    localStorage.setItem(STORAGE_KEY_NAME, name);
  }
  state.playerName = name;
  return name;
}

// ------------------------------------------------------------
// CLASSIFICA
// ------------------------------------------------------------
function getOrCreateScore(peerKey, name) {
  if (!state.scores.has(peerKey)) {
    state.scores.set(peerKey, { name, total: 0, rounds: [], bonusCount: 0 });
  } else if (name) {
    state.scores.get(peerKey).name = name;
  }
  return state.scores.get(peerKey);
}

function addRoundScores(pointsByKey) {
  // pointsByKey: Map<peerKey, { name, points, bonus }>
  for (const [key, data] of pointsByKey) {
    const s = getOrCreateScore(key, data.name);
    s.total += data.points + (data.bonus || 0);
    s.rounds.push({ points: data.points, bonus: data.bonus || 0 });
    if (data.bonus) s.bonusCount += 1;
  }
}

function renderStandings() {
  const arr = [...state.scores.entries()]
    .map(([key, data]) => ({ key, ...data }))
    .sort((a, b) => b.total - a.total);

  if (arr.length === 0) {
    dom.standingsContent.innerHTML = '<p class="muted">Nessun punteggio ancora.</p>';
    return;
  }

  dom.standingsContent.innerHTML = `<div class="standings">${arr.map((s, i) => `
    <div class="standing-row ${i === 0 ? 'first' : ''}">
      <span class="standing-pos">${i + 1}°</span>
      <span class="standing-name">${escapeHtml(s.name)}</span>
      <span class="standing-points">${s.total} pt</span>
      ${s.bonusCount > 0 ? `<span class="standing-bonus">+${s.bonusCount * STOP_BONUS} bonus</span>` : ''}
    </div>
  `).join('')}</div>`;
}

// ------------------------------------------------------------
// TRYSTERO
// ------------------------------------------------------------
function initRoom(isHost, roomCode) {
  state.isHost = isHost;
  state.roomCode = roomCode;

  const room = joinRoom({ appId: APP_ID }, roomCode);
  state.room = room;

  dom.roomBadge.hidden = false;
  dom.roomCode.textContent = roomCode;
  dom.connDot.classList.add('online');
  dom.joinCard.hidden = true;
  dom.configCard.hidden = false;

  if (isHost) {
    dom.btnStartGame.disabled = false;
    dom.btnShareWa.hidden = false;
    dom.hostHint.hidden = true;
  } else {
    dom.btnStartGame.disabled = true;
    dom.btnShareWa.hidden = true;
    dom.hostHint.hidden = false;
  }

  const [sendPresence, onPresence] = room.makeAction('presence');
  const [sendAnswers, onAnswers] = room.makeAction('answers');
  const [sendRoundStart, onRoundStart] = room.makeAction('round-start');
  const [sendResults, onResults] = room.makeAction('results');
  const [sendConfig, onConfig] = room.makeAction('config');
  const [sendStop, onStop] = room.makeAction('stop');

  state.send = {
    presence: sendPresence,
    answers: sendAnswers,
    roundStart: sendRoundStart,
    results: sendResults,
    config: sendConfig,
    stop: sendStop,
  };

  function announcePresence() {
    sendPresence({ name: state.playerName, isHost: state.isHost });
  }

  onPresence((data, peerId) => {
    state.peers.set(peerId, {
      name: data.name,
      isHost: data.isHost,
      ready: false,
      stopped: false,
      answers: null,
    });
    renderPlayers();
    if (state.isHost) {
      sendConfig({ config: state.config }, peerId);
    }
    announcePresence();
  });

  onConfig((data) => {
    if (!state.isHost) {
      state.config = data.config;
      applyConfigToUI();
    }
  });

  room.onPeerJoin(peerId => {
    dom.connDot.classList.add('online');
    setTimeout(announcePresence, 300);
  });

  room.onPeerLeave(peerId => {
    state.peers.delete(peerId);
    renderPlayers();
    if (state.peers.size === 0) {
      dom.connDot.classList.remove('online');
      dom.connDot.classList.add('offline');
    }
  });

  onAnswers((data, peerId) => {
    if (!state.isHost) return;
    const peer = state.peers.get(peerId);
    if (peer) {
      peer.answers = data.answers;
      peer.ready = true;
    }
    renderPlayers();
  });

  onRoundStart((data) => {
    if (state.isHost) return;
    startRoundLocal(data);
  });

  onResults((data) => {
    if (state.isHost) return;
    // Salva i punteggi ricevuti e aggiorna classifica
    if (data.scores) {
      state.scores = new Map(data.scores);
    }
    renderStandings();
    renderResults(data.results);
    showScreen('results');
    dom.btnNextRound.hidden = true;
    dom.resultsTitle.textContent = data.isLastRound ? 'Classifica finale' : 'Risultati manche';
  });

  onStop((data, peerId) => {
    if (!state.isHost) return;
    const peer = state.peers.get(peerId);
    if (peer) {
      peer.stopped = true;
      peer.stopRemaining = data.remaining;
      // Primo stopper con tutti i campi compilati
      if (!state.stop.firstPeerKey && data.allFilled) {
        state.stop.firstPeerKey = peerId;
        state.stop.firstRemaining = data.remaining;
      }
    }
    renderPlayers();
  });

  setTimeout(announcePresence, 500);
}

// ------------------------------------------------------------
// LOBBY
// ------------------------------------------------------------
dom.btnCreateRoom.addEventListener('click', () => {
  ensurePlayerName();
  const code = generateRoomCode();
  const url = new URL(window.location);
  url.searchParams.set('room', code);
  window.history.pushState({}, '', url);
  initRoom(true, code);
});

dom.btnJoinRoom.addEventListener('click', () => {
  ensurePlayerName();
  const code = dom.inputRoomCode.value.trim().toUpperCase();
  if (!code) { showToast('Inserisci un codice stanza'); return; }
  const url = new URL(window.location);
  url.searchParams.set('room', code);
  window.history.pushState({}, '', url);
  initRoom(false, code);
});

dom.btnShareWa.addEventListener('click', () => {
  const url = `${window.location.origin}${window.location.pathname}?room=${state.roomCode}`;
  const text = encodeURIComponent(`Gioca a Nomi Cose Città! Clicca qui: ${url}`);
  window.open(`https://wa.me/?text=${text}`, '_blank');
});

dom.extraCategories.addEventListener('change', () => {
  if (!state.isHost) return;
  const checked = [...dom.extraCategories.querySelectorAll('.chip-check:checked')]
    .map(cb => cb.value);
  state.config.selectedExtras = checked;
  broadcastConfig();
});

dom.timerOptions.addEventListener('change', () => {
  if (!state.isHost) return;
  const selected = dom.timerOptions.querySelector('.chip-check:checked');
  state.config.timerSeconds = parseInt(selected.value, 10);
  broadcastConfig();
});

dom.roundsOptions.addEventListener('change', () => {
  if (!state.isHost) return;
  const selected = dom.roundsOptions.querySelector('.chip-check:checked');
  state.config.totalRounds = parseInt(selected.value, 10);
  broadcastConfig();
});

function broadcastConfig() {
  if (state.isHost && state.send) {
    state.send.config({ config: state.config });
  }
}

function applyConfigToUI() {
  for (const cb of dom.extraCategories.querySelectorAll('.chip-check')) {
    cb.checked = state.config.selectedExtras.includes(cb.value);
  }
  for (const rb of dom.timerOptions.querySelectorAll('.chip-check')) {
    rb.checked = parseInt(rb.value, 10) === state.config.timerSeconds;
  }
  for (const rb of dom.roundsOptions.querySelectorAll('.chip-check')) {
    rb.checked = parseInt(rb.value, 10) === state.config.totalRounds;
  }
}

// ------------------------------------------------------------
// RENDER GIOCATORI
// ------------------------------------------------------------
function renderPlayers() {
  const list = [{
    name: state.playerName + ' (tu)',
    isHost: state.isHost,
    ready: state.myReady,
    stopped: state.myStopped,
  }];

  for (const [peerId, peer] of state.peers) {
    list.push({
      name: peer.name,
      isHost: peer.isHost,
      ready: peer.ready,
      stopped: peer.stopped || false,
    });
  }

  dom.playerCount.textContent = `(${list.length})`;
  dom.playerList.innerHTML = list.map(p => `
    <li>
      <span class="player-name">${escapeHtml(p.name)}</span>
      <span class="player-tag ${p.isHost ? 'host' : ''} ${p.ready ? 'ready' : ''} ${p.stopped ? 'stopped' : ''}">
        ${p.isHost ? 'Host' : (p.stopped ? 'Stop' : (p.ready ? 'Pronto' : 'In attesa'))}
      </span>
    </li>
  `).join('');

  if (dom.gamePlayerList) {
    dom.gamePlayerList.innerHTML = list.map(p => `
      <li>
        <span class="player-name">${escapeHtml(p.name)}</span>
        <span class="player-tag ${p.stopped ? 'stopped' : ''} ${p.ready ? 'ready' : ''}">
          ${p.stopped ? 'Stop' : (p.ready ? 'Pronto' : 'In gioco')}
        </span>
      </li>
    `).join('');
  }
}

// ------------------------------------------------------------
// AVVIO MANCHE (host)
// ------------------------------------------------------------
dom.btnStartGame.addEventListener('click', () => {
  if (!state.isHost) return;
  startNewRound();
});

function startNewRound() {
  if (!state.isHost) return;

  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const letter = pickLetter(seed, state.round.previousLetter);

  state.round.number += 1;
  state.round.seed = seed;
  state.round.letter = letter;
  state.round.timerSeconds = state.config.timerSeconds;
  state.round.active = true;
  state.round.previousLetter = letter;

  // Reset stop
  state.stop = { firstPeerKey: null, firstRemaining: null };
  state.myStopped = false;
  state.myStopRemaining = null;
  for (const peer of state.peers.values()) {
    peer.stopped = false;
    peer.ready = false;
    peer.answers = null;
  }

  const activeCategories = [...FIXED_CATEGORIES, ...state.config.selectedExtras];

  prepareGameUI(letter, state.round.number, seed, activeCategories);

  if (state.send) {
    state.send.roundStart({
      letter,
      roundNumber: state.round.number,
      seed,
      timerSeconds: state.round.timerSeconds,
      categories: activeCategories,
    });
  }

  startTimer(state.round.timerSeconds);
  showScreen('game');
}

function startRoundLocal(data) {
  state.round.number = data.roundNumber;
  state.round.letter = data.letter;
  state.round.seed = data.seed;
  state.round.timerSeconds = data.timerSeconds;
  state.round.active = true;
  state.round.previousLetter = data.letter;

  state.myStopped = false;
  state.myStopRemaining = null;

  prepareGameUI(data.letter, data.roundNumber, data.seed, data.categories);
  startTimer(data.timerSeconds);
  showScreen('game');
}

function prepareGameUI(letter, roundNumber, seed, categories) {
  dom.roundLetter.textContent = letter;
  dom.roundNumber.textContent = `Manche ${roundNumber} di ${state.config.totalRounds}`;
  dom.roundSeed.textContent = `seed: ${seed}`;
  dom.roundTimerBox.classList.remove('warning', 'danger', 'hidden-timer', 'stopped');

  dom.categoryInputs.innerHTML = categories.map(cat => `
    <div class="cat-row" data-cat="${escapeHtml(cat)}">
      <div class="cat-top">
        <span class="cat-name">${escapeHtml(cat)}</span>
        <span class="cat-status" data-status="${escapeHtml(cat)}">—</span>
      </div>
      <input class="input" type="text" data-input="${escapeHtml(cat)}"
             placeholder="${escapeHtml(cat)} con la ${letter}..." autocomplete="off">
    </div>
  `).join('');

  state.myAnswers = {};
  state.myReady = false;
  state.myStopped = false;
  dom.btnDone.disabled = false;
  dom.btnStopTimer.disabled = false;
  dom.doneHint.hidden = true;
  dom.stopHint.hidden = true;

  for (const input of dom.categoryInputs.querySelectorAll('input')) {
    input.addEventListener('input', (e) => {
      state.myAnswers[e.target.dataset.input] = e.target.value.trim();
    });
  }
}

// ------------------------------------------------------------
// TIMER
// ------------------------------------------------------------
function startTimer(seconds) {
  stopTimer();
  if (seconds <= 0) {
    dom.roundTimer.textContent = '∞';
    dom.roundTimerBox.classList.add('hidden-timer');
    return;
  }

  let remaining = seconds;
  state.remainingSeconds = remaining;
  dom.roundTimer.textContent = formatTime(remaining);

  state.timerInterval = setInterval(() => {
    state.remainingSeconds -= 1;
    if (!state.myStopped) {
      dom.roundTimer.textContent = formatTime(Math.max(0, state.remainingSeconds));
    }

    const rem = state.remainingSeconds;
    if (rem <= 10 && rem > 0) dom.roundTimerBox.classList.add('warning');
    if (rem <= 5) {
      dom.roundTimerBox.classList.remove('warning');
      dom.roundTimerBox.classList.add('danger');
    }

    if (rem <= 0) {
      stopTimer();
      onRoundTimeUp();
    }
  }, 1000);
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}`;
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

// ------------------------------------------------------------
// HO FINITO!
// ------------------------------------------------------------
dom.btnDone.addEventListener('click', () => {
  if (state.myReady) return;
  state.myReady = true;
  dom.btnDone.disabled = true;
  dom.doneHint.hidden = false;
  renderPlayers();

  if (!state.isHost && state.send) {
    state.send.answers({ answers: state.myAnswers });
  }
});

// ------------------------------------------------------------
// STOP TIMER
// ------------------------------------------------------------
dom.btnStopTimer.addEventListener('click', () => {
  if (state.myStopped) return;

  // Controlla che tutti i campi siano compilati
  const categories = [...FIXED_CATEGORIES, ...state.config.selectedExtras];
  const allFilled = categories.every(cat => (state.myAnswers[cat] || '').length > 0);

  state.myStopped = true;
  state.myStopRemaining = state.remainingSeconds;
  dom.btnStopTimer.disabled = true;
  dom.stopHint.hidden = false;
  dom.roundTimerBox.classList.add('stopped');
  dom.roundTimer.textContent = formatTime(state.remainingSeconds);

  renderPlayers();

  if (!state.isHost && state.send) {
    state.send.stop({ remaining: state.remainingSeconds, allFilled });
  } else if (state.isHost) {
    // L'host registra il proprio stop localmente
    if (allFilled && !state.stop.firstPeerKey) {
      state.stop.firstPeerKey = 'self';
      state.stop.firstRemaining = state.remainingSeconds;
    }
  }

  if (!allFilled) {
    showToast('Stop registrato, ma non hai compilato tutti i campi: nessun bonus.');
  } else {
    showToast('Stop registrato! Bonus valido solo se tutte le parole sono corrette.');
  }
});

// ------------------------------------------------------------
// FINE MANCHE
// ------------------------------------------------------------
function onRoundTimeUp() {
  state.round.active = false;
  stopTimer();

  if (state.isHost) {
    collectAndScore();
  } else {
    if (state.send) {
      state.send.answers({ answers: state.myAnswers });
    }
    showToast('Tempo scaduto! In attesa dei risultati...');
  }
}

// ------------------------------------------------------------
// SCORING (host)
// ------------------------------------------------------------
async function collectAndScore() {
  const allAnswers = new Map();
  allAnswers.set('self', { name: state.playerName, answers: state.myAnswers });
  for (const [peerId, peer] of state.peers) {
    allAnswers.set(peerId, { name: peer.name, answers: peer.answers || {} });
  }

  const categories = [...FIXED_CATEGORIES, ...state.config.selectedExtras];
  const results = {};
  const pointsByKey = new Map();

  // Verifica parole per categoria
  for (const cat of categories) {
    results[cat] = [];
    for (const [peerKey, data] of allAnswers) {
      const word = (data.answers[cat] || '').trim();
      let valid = false;
      if (word) valid = await verifyWord(word, state.round.letter);
      results[cat].push({
        peerKey,
        playerName: data.name,
        word,
        valid,
        points: 0,
        bonus: 0,
        bonusFlag: false,
      });
    }
  }

  // Calcola punti base: 10 se valida e unica, 5 se valida ma duplicata
  for (const cat of categories) {
    const entries = results[cat];
    const wordCounts = {};
    for (const e of entries) {
      if (e.valid && e.word) {
        const key = e.word.toLowerCase();
        wordCounts[key] = (wordCounts[key] || 0) + 1;
      }
    }
    for (const e of entries) {
      if (!e.valid || !e.word) { e.points = 0; continue; }
      const key = e.word.toLowerCase();
      e.points = wordCounts[key] > 1 ? 5 : 10;
    }
  }

  // Accumula punti base per giocatore
  for (const cat of categories) {
    for (const e of results[cat]) {
      if (!pointsByKey.has(e.peerKey)) {
        pointsByKey.set(e.peerKey, { name: e.playerName, points: 0, bonus: 0 });
      }
      pointsByKey.get(e.peerKey).points += e.points;
    }
  }

  // Bonus Stop timer: assegnato al primo stopper con tutti i campi compilati E tutte le parole valide
  if (state.stop.firstPeerKey) {
    const firstKey = state.stop.firstPeerKey;
    // Controlla che tutte le parole di quel giocatore siano valide
    let allValid = true;
    let hasAnyWord = false;
    for (const cat of categories) {
      const entry = results[cat].find(e => e.peerKey === firstKey);
      if (!entry) continue;
      if (entry.word) hasAnyWord = true;
      if (entry.word && !entry.valid) { allValid = false; break; }
    }
    if (allValid && hasAnyWord) {
      const entry = pointsByKey.get(firstKey);
      if (entry) {
        entry.bonus = STOP_BONUS;
        // Marca nel dettaglio
        for (const cat of categories) {
          const e = results[cat].find(x => x.peerKey === firstKey);
          if (e && e.word) e.bonusFlag = true;
        }
      }
    }
  }

  // Aggiorna classifica
  addRoundScores(pointsByKey);

  const isLastRound = state.round.number >= state.config.totalRounds;

  // Invia ai client
  if (state.send) {
    state.send.results({
      results,
      scores: [...state.scores.entries()],
      isLastRound,
    });
  }

  // Mostra localmente
  renderStandings();
  renderResults(results, pointsByKey);
  showScreen('results');
  dom.resultsTitle.textContent = isLastRound ? 'Classifica finale' : 'Risultati manche';
  dom.btnNextRound.hidden = !state.isHost || isLastRound;

  if (isLastRound) {
    showToast('Partita terminata!');
  }
}

// ------------------------------------------------------------
// VERIFICA PAROLE
// ------------------------------------------------------------
async function verifyWord(word, letter) {
  if (word[0].toUpperCase() !== letter) return false;

  try {
    const url = `https://it.wikipedia.org/w/api.php?origin=*&action=opensearch&search=${encodeURIComponent(word)}&limit=5`;
    const res = await fetch(url);
    const data = await res.json();
    if (data[1] && data[1].length > 0) {
      const lower = word.toLowerCase();
      const match = data[1].some(t => t.toLowerCase().includes(lower));
      if (match) return true;
    }
  } catch (e) {
    console.warn('Wikipedia error:', e);
  }

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word, letter }),
    });
    const data = await res.json();
    return data.valid === true;
  } catch (e) {
    console.warn('Worker error:', e);
    return false;
  }
}

// ------------------------------------------------------------
// RENDER RISULTATI
// ------------------------------------------------------------
function renderResults(results, pointsByKey) {
  const html = Object.entries(results).map(([cat, entries]) => {
    const rows = entries.map(e => {
      const cls = e.word && !e.valid ? 'word-dup' : '';
      const status = e.word ? (e.valid ? '' : '(non valida)') : '(vuoto)';
      const bonusTag = e.bonusFlag ? `<span class="bonus-tag">+${STOP_BONUS}</span>` : '';
      return `
        <div class="result-row">
          <span>${escapeHtml(e.playerName)}: <span class="${cls}">${escapeHtml(e.word || '—')}</span> ${status}${bonusTag}</span>
          <span class="points">${e.points} pt</span>
        </div>
      `;
    }).join('');
    return `
      <div class="result-cat">
        <div class="result-cat-title">${escapeHtml(cat)}</div>
        ${rows}
      </div>
    `;
  }).join('');

  dom.resultsContent.innerHTML = html;
}

// ------------------------------------------------------------
// PROSSIMA MANCHE
// ------------------------------------------------------------
dom.btnNextRound.addEventListener('click', () => {
  if (!state.isHost) return;
  if (state.round.number >= state.config.totalRounds) {
    showToast('Partita già terminata.');
    return;
  }
  state.myReady = false;
  state.myAnswers = {};
  state.myStopped = false;
  renderPlayers();
  startNewRound();
});

// ------------------------------------------------------------
// BOOT
// ------------------------------------------------------------
function boot() {
  const params = new URLSearchParams(window.location.search);
  const roomCode = params.get('room');

  if (roomCode) {
    ensurePlayerName();
    initRoom(false, roomCode.toUpperCase());
  } else {
    showScreen('lobby');
  }
}

boot();
