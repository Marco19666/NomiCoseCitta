// ============================================================
// NOMI COSE CITTÀ — app.js (v8)
// ============================================================

import { joinRoom } from 'https://cdn.jsdelivr.net/npm/trystero@0.21.5/torrent/+esm';

// ------------------------------------------------------------
// COSTANTI
// ------------------------------------------------------------
const APP_ID = 'nomi-cose-citta-v1';
const ALPHABET = 'ABCDEFGILMNOPRSTUVXZ';
const STORAGE_KEY_NAME = 'ncc_player_name';
const FIXED_CATEGORIES = ['Cose', 'Nomi', 'Città'];
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
  remainingSeconds: 0,

  scores: new Map(),

  firstDone: null,

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
  inputPlayerName: $('inputPlayerName'),
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
  doneHint: $('doneHint'),
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
    if (s) s.classList.remove('active');
  }
  if (name === 'lobby' && dom.screenLobby) dom.screenLobby.classList.add('active');
  if (name === 'game' && dom.screenGame) dom.screenGame.classList.add('active');
  if (name === 'results' && dom.screenResults) dom.screenResults.classList.add('active');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function ensurePlayerName() {
  let name = '';
  if (dom.inputPlayerName) name = dom.inputPlayerName.value.trim();
  if (!name) name = localStorage.getItem(STORAGE_KEY_NAME) || '';
  if (!name) name = 'Giocatore ' + Math.floor(Math.random() * 900 + 100);
  name = name.slice(0, 20);
  localStorage.setItem(STORAGE_KEY_NAME, name);
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
  for (const [key, data] of pointsByKey) {
    const s = getOrCreateScore(key, data.name);
    s.total += data.points + (data.bonus || 0);
    s.rounds.push({ points: data.points, bonus: data.bonus || 0 });
    if (data.bonus) s.bonusCount += 1;
  }
}

function renderStandings() {
  if (!dom.standingsContent) return;
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

  if (dom.roomBadge) dom.roomBadge.hidden = false;
  if (dom.roomCode) dom.roomCode.textContent = roomCode;
  if (dom.connDot) dom.connDot.classList.add('online');
  if (dom.joinCard) dom.joinCard.hidden = true;
  if (dom.configCard) dom.configCard.hidden = false;

  if (isHost) {
    if (dom.btnStartGame) dom.btnStartGame.disabled = false;
    if (dom.btnShareWa) dom.btnShareWa.hidden = false;
    if (dom.hostHint) dom.hostHint.hidden = true;
  } else {
    if (dom.btnStartGame) dom.btnStartGame.disabled = true;
    if (dom.btnShareWa) dom.btnShareWa.hidden = true;
    if (dom.hostHint) dom.hostHint.hidden = false;
  }

  const [sendPresence, onPresence] = room.makeAction('presence');
  const [sendAnswers, onAnswers] = room.makeAction('answers');
  const [sendRoundStart, onRoundStart] = room.makeAction('round-start');
  const [sendResults, onResults] = room.makeAction('results');
  const [sendConfig, onConfig] = room.makeAction('config');
  const [sendDone, onDone] = room.makeAction('done');

  state.send = {
    presence: sendPresence,
    answers: sendAnswers,
    roundStart: sendRoundStart,
    results: sendResults,
    config: sendConfig,
    done: sendDone,
  };

  function announcePresence() {
    sendPresence({ name: state.playerName, isHost: state.isHost });
  }

  onPresence((data, peerId) => {
    // La presenza può essere annunciata più volte: aggiorna solo i metadati
    // e conserva risposte/prontezza già ricevute per questa manche.
    const previous = state.peers.get(peerId) || {};
    state.peers.set(peerId, {
      ...previous,
      name: data.name || previous.name || 'Giocatore',
      isHost: Boolean(data.isHost),
      ready: previous.ready || false,
      answers: previous.answers || null,
    });
    renderPlayers();
    if (state.isHost) {
      sendConfig({ config: state.config }, peerId);
    }
  });

  onConfig((data) => {
    if (state.isHost) return;
    if (data && data.config) {
      state.config = {
        selectedExtras: Array.isArray(data.config.selectedExtras) ? data.config.selectedExtras : [],
        timerSeconds: data.config.timerSeconds || 60,
        totalRounds: data.config.totalRounds || 5,
      };
      applyConfigToUI();
    }
  });

  room.onPeerJoin(peerId => {
    console.log('Peer joined:', peerId);
    if (dom.connDot) dom.connDot.classList.add('online');
    setTimeout(announcePresence, 300);
  });

  room.onPeerLeave(peerId => {
    console.log('Peer left:', peerId);
    state.peers.delete(peerId);
    renderPlayers();
    if (state.peers.size === 0 && dom.connDot) {
      dom.connDot.classList.remove('online');
      dom.connDot.classList.add('offline');
    }
  });

  onAnswers((data, peerId) => {
    if (!state.isHost || !data) return;
    console.log('HOST onAnswers:', data, peerId);
    const peer = state.peers.get(peerId);
    if (!peer) {
      console.warn('Risposte ricevute da peer non ancora presente:', peerId);
      return;
    }
    peer.answers = data.answers && typeof data.answers === 'object' ? data.answers : {};
    peer.ready = true;
    renderPlayers();
    checkAllDone();
  });

  onDone((data, peerId) => {
    if (!state.isHost || !data) return;
    const peer = state.peers.get(peerId);
    if (!peer) {
      console.warn('Segnale done ricevuto da peer non ancora presente:', peerId);
      return;
    }
    if (!state.firstDone && data.allFilled) {
      state.firstDone = { peerKey: peerId, allFilled: true };
    }
    peer.ready = true;
    renderPlayers();
    checkAllDone();
  });

  onRoundStart((data) => {
    console.log('CLIENT onRoundStart:', JSON.stringify(data));
    if (state.isHost) return;
    if (!data || !data.letter || !Array.isArray(data.categories)) {
      console.error('Dati roundStart invalidi:', data);
      showToast('Errore: dati di gioco non validi.');
      return;
    }
    startRoundLocal(data);
  });

  onResults((data) => {
    if (state.isHost) return;
    if (data.scores) {
      state.scores = new Map(data.scores);
    }
    renderStandings();
    renderResults(data.results);
    showScreen('results');
    if (dom.btnNextRound) dom.btnNextRound.hidden = true;
    if (dom.resultsTitle) {
      dom.resultsTitle.textContent = data.isLastRound ? 'Classifica finale' : 'Risultati manche';
    }
  });

  setTimeout(announcePresence, 500);
}

// ------------------------------------------------------------
// CHECK TUTTI PRONTI (host)
// ------------------------------------------------------------
function checkAllDone() {
  if (!state.isHost) return;
  if (!state.round.active) return;
  if (!state.myReady) return;
  for (const peer of state.peers.values()) {
    if (!peer.ready) return;
  }
  // Tutti hanno finito: chiudi il round
  state.round.active = false;
  stopTimer();
  showToast('Tutti hanno finito! Calcolo dei risultati...');
  collectAndScore();
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
  if (selected) state.config.timerSeconds = parseInt(selected.value, 10);
  broadcastConfig();
});

dom.roundsOptions.addEventListener('change', () => {
  if (!state.isHost) return;
  const selected = dom.roundsOptions.querySelector('.chip-check:checked');
  if (selected) state.config.totalRounds = parseInt(selected.value, 10);
  broadcastConfig();
});

function broadcastConfig() {
  if (state.isHost && state.send) {
    state.send.config({ config: state.config });
  }
}

function applyConfigToUI() {
  if (dom.extraCategories) {
    for (const cb of dom.extraCategories.querySelectorAll('.chip-check')) {
      cb.checked = state.config.selectedExtras.includes(cb.value);
    }
  }
  if (dom.timerOptions) {
    for (const rb of dom.timerOptions.querySelectorAll('.chip-check')) {
      rb.checked = parseInt(rb.value, 10) === state.config.timerSeconds;
    }
  }
  if (dom.roundsOptions) {
    for (const rb of dom.roundsOptions.querySelectorAll('.chip-check')) {
      rb.checked = parseInt(rb.value, 10) === state.config.totalRounds;
    }
  }
}

// ------------------------------------------------------------
// RENDER GIOCATORI
// ------------------------------------------------------------
function renderPlayers() {
  if (!dom.playerList || !dom.playerCount) return;

  const list = [{
    name: state.playerName + ' (tu)',
    isHost: state.isHost,
    ready: state.myReady,
  }];

  for (const [peerId, peer] of state.peers) {
    list.push({
      name: peer.name,
      isHost: peer.isHost,
      ready: peer.ready,
    });
  }

  dom.playerCount.textContent = `(${list.length})`;
  dom.playerList.innerHTML = list.map(p => `
    <li>
      <span class="player-name">${escapeHtml(p.name)}</span>
      <span class="player-tag ${p.isHost ? 'host' : ''} ${p.ready ? 'ready' : ''}">
        ${p.isHost ? 'Host' : (p.ready ? 'Pronto' : 'In attesa')}
      </span>
    </li>
  `).join('');

  if (dom.gamePlayerList) {
    dom.gamePlayerList.innerHTML = list.map(p => `
      <li>
        <span class="player-name">${escapeHtml(p.name)}</span>
        <span class="player-tag ${p.ready ? 'ready' : ''}">
          ${p.ready ? 'Pronto' : 'In gioco'}
        </span>
      </li>
    `).join('');
  }
}

// ------------------------------------------------------------
// AVVIO MANCHE
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

  state.firstDone = null;
  state.myReady = false;
  state.myAnswers = {};
  for (const peer of state.peers.values()) {
    peer.ready = false;
    peer.answers = null;
  }

  const activeCategories = [...FIXED_CATEGORIES, ...(state.config.selectedExtras || [])];

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
  console.log('startRoundLocal chiamato con:', data);
  state.round.number = data.roundNumber;
  state.round.letter = data.letter;
  state.round.seed = data.seed;
  state.round.timerSeconds = data.timerSeconds;
  state.round.active = true;
  state.round.previousLetter = data.letter;

  state.myReady = false;

  prepareGameUI(data.letter, data.roundNumber, data.seed, data.categories);
  startTimer(data.timerSeconds);
  showScreen('game');
}

function prepareGameUI(letter, roundNumber, seed, categories) {
  if (!Array.isArray(categories)) {
    console.error('prepareGameUI: categories non è un array', categories);
    categories = [...FIXED_CATEGORIES];
  }

  dom.roundLetter.textContent = letter;
  dom.roundNumber.textContent = `Manche ${roundNumber} di ${state.config.totalRounds}`;
  dom.roundSeed.textContent = `seed: ${seed}`;
  dom.roundTimerBox.classList.remove('warning', 'danger', 'hidden-timer');

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
  dom.btnDone.disabled = false;
  dom.btnDone.textContent = 'Ho finito!';
  dom.doneHint.hidden = true;

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
    dom.roundTimer.textContent = formatTime(Math.max(0, state.remainingSeconds));

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
  dom.btnDone.textContent = 'In attesa...';
  renderPlayers();

  const categories = [...FIXED_CATEGORIES, ...(state.config.selectedExtras || [])];
  const allFilled = categories.every(cat => (state.myAnswers[cat] || '').length > 0);

  stopTimer();
  dom.roundTimer.textContent = formatTime(state.remainingSeconds);

  if (!state.isHost && state.send) {
    state.send.answers({ answers: state.myAnswers, name: state.playerName });
    state.send.done({ name: state.playerName, allFilled });
  } else if (state.isHost) {
    if (!state.firstDone && allFilled) {
      state.firstDone = { peerKey: '__host__', allFilled: true };
    }
    checkAllDone();
  }

  if (!allFilled) {
    showToast('Hai finito, ma non hai compilato tutti i campi: nessun bonus.');
  } else {
    showToast('Hai finito! Bonus valido solo se tutte le parole sono corrette.');
  }
});

// ------------------------------------------------------------
// FINE MANCHE
// ------------------------------------------------------------
function onRoundTimeUp() {
  if (!state.round.active) return;
  state.round.active = false;
  stopTimer();

  if (state.isHost) {
    collectAndScore();
  } else {
    if (state.send) {
      state.send.answers({ answers: state.myAnswers, name: state.playerName });
    }
    showToast('Tempo scaduto! In attesa dei risultati...');
  }
}

// ------------------------------------------------------------
// SCORING (host)
// ------------------------------------------------------------
async function collectAndScore() {
  await new Promise(r => setTimeout(r, 2500));

  const allAnswers = new Map();
  allAnswers.set('__host__', { name: state.playerName, answers: state.myAnswers });
  for (const [peerId, peer] of state.peers.entries()) {
    allAnswers.set(peerId, { name: peer.name, answers: peer.answers || {} });
  }

  const categories = [...FIXED_CATEGORIES, ...(state.config.selectedExtras || [])];
  const results = {};
  const pointsByKey = new Map();

  for (const cat of categories) {
    results[cat] = [];
    for (const [peerKey, data] of allAnswers) {
      const word = (data.answers[cat] || '').trim();
      let valid = false;
      if (word) valid = await verifyWord(word, state.round.letter, cat);
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

  for (const cat of categories) {
    for (const e of results[cat]) {
      if (!pointsByKey.has(e.peerKey)) {
        pointsByKey.set(e.peerKey, { name: e.playerName, points: 0, bonus: 0 });
      }
      pointsByKey.get(e.peerKey).points += e.points;
    }
  }

  if (state.firstDone && state.firstDone.allFilled) {
    const firstKey = state.firstDone.peerKey;
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
        for (const cat of categories) {
          const e = results[cat].find(x => x.peerKey === firstKey);
          if (e && e.word) e.bonusFlag = true;
        }
      }
    }
  }

  addRoundScores(pointsByKey);

  const isLastRound = state.round.number >= state.config.totalRounds;

  if (state.send) {
    state.send.results({
      results,
      scores: [...state.scores.entries()],
      isLastRound,
    });
  }

  renderStandings();
  renderResults(results);
  showScreen('results');
  dom.resultsTitle.textContent = isLastRound ? 'Classifica finale' : 'Risultati manche';
  dom.btnNextRound.hidden = !state.isHost || isLastRound;

  if (isLastRound) {
    showToast('Partita terminata!');
  }
}

// ------------------------------------------------------------
// VERIFICA PAROLE (con categoria)
// ------------------------------------------------------------
async function verifyCityWithWikidata(word) {
  const normalize = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

  try {
    const searchUrl = new URL('https://www.wikidata.org/w/api.php');
    searchUrl.search = new URLSearchParams({
      action: 'wbsearchentities', search: word, language: 'it', uselang: 'it',
      type: 'item', limit: '10', format: 'json', origin: '*',
    });
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) throw new Error('Wikidata search HTTP ' + searchRes.status);
    const searchData = await searchRes.json();
    const exact = (searchData.search || []).filter(item =>
      normalize(item.label) === normalize(word) ||
      (item.aliases || []).some(alias => normalize(alias) === normalize(word))
    );
    if (!exact.length) return false;

    const ids = exact.map(item => item.id).filter(Boolean);
    if (!ids.length) return false;
    const entityUrl = new URL('https://www.wikidata.org/w/api.php');
    entityUrl.search = new URLSearchParams({
      action: 'wbgetentities', ids: ids.join('|'), props: 'claims',
      format: 'json', origin: '*',
    });
    const entityRes = await fetch(entityUrl);
    if (!entityRes.ok) throw new Error('Wikidata entities HTTP ' + entityRes.status);
    const entityData = await entityRes.json();
    // Classi di città, comuni, insediamenti e capitali presenti in Wikidata.
    const cityTypes = new Set([
      'Q515', 'Q3957', 'Q532', 'Q15284', 'Q1637706', 'Q486972',
      'Q200250', 'Q7930989', 'Q1549591', 'Q174844', 'Q5119'
    ]);
    return Object.values(entityData.entities || {}).some(entity =>
      (entity.claims?.P31 || []).some(claim =>
        cityTypes.has(claim.mainsnak?.datavalue?.value?.id)
      )
    );
  } catch (error) {
    console.warn('Wikidata error (fallback Gemini):', error);
    return false;
  }
}

async function verifyWord(word, letter, category) {
  if (word.length < 2) return false;
  if (word[0].toLocaleUpperCase('it') !== letter) return false;

  if (category === 'Città' && await verifyCityWithWikidata(word)) return true;

  if (category === 'Cose' || category === 'Nomi') {
    try {
      const url = 'https://it.wikipedia.org/w/api.php?origin=*&action=opensearch&search=' + encodeURIComponent(word) + '&limit=10';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const wanted = word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('it');
        const match = (data[1] || []).some(title =>
          title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('it') === wanted
        );
        if (match) return true;
      }
    } catch (error) {
      console.warn('Wikipedia error:', error);
    }
  }

  // Gemini resta il fallback per città non trovate in Wikidata e per le altre categorie.
  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word, letter, category }),
    });
    if (!res.ok) {
      console.warn('Worker verification HTTP error:', res.status);
      return false;
    }
    const data = await res.json();
    return data.valid === true;
  } catch (error) {
    console.warn('Worker error:', error);
    return false;
  }
}
// ------------------------------------------------------------
// RENDER RISULTATI
// ------------------------------------------------------------
function renderResults(results) {
  if (!dom.resultsContent) return;
  if (!results) {
    dom.resultsContent.innerHTML = '<p class="muted">Nessun risultato.</p>';
    return;
  }
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
  renderPlayers();
  startNewRound();
});

// ------------------------------------------------------------
// BOOT
// ------------------------------------------------------------
function boot() {
  if (dom.inputPlayerName) {
    const saved = localStorage.getItem(STORAGE_KEY_NAME);
    if (saved) dom.inputPlayerName.value = saved;
  }

  const search = window.location.search;
  const params = new URLSearchParams(search);
  let roomCode = params.get('room');

  if (!roomCode && search.includes('room=')) {
    const match = search.match(/[?&]room=([^&]+)/);
    if (match) roomCode = decodeURIComponent(match[1]);
  }

  console.log('BOOT - search:', search, 'roomCode:', roomCode);

  if (roomCode) {
    ensurePlayerName();
    initRoom(false, roomCode.toUpperCase());
  } else {
    showScreen('lobby');
  }
}

boot();
