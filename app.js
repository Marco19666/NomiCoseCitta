// ============================================================
// NOMI COSE CITTÀ — app.js
// Logica di gioco + integrazione Trystero + verifica parole
// ============================================================

import { joinRoom } from 'https://esm.sh/trystero/torrent';

// ------------------------------------------------------------
// COSTANTI
// ------------------------------------------------------------
const APP_ID = 'nomi-cose-citta-v1';
const ALPHABET = 'ABCDEFGILMNOPRSTUVXZ'; // 20 lettere (esclusi H,J,K,Q,W,Y)
const STORAGE_KEY_NAME = 'ncc_player_name';
const FIXED_CATEGORIES = ['Cose', 'Nomi', 'Città'];
const DEFAULT_EXTRA_CATEGORIES = ['Animali', 'Mestieri', 'Colori', 'Film', 'Cantanti', 'Sport', 'Cibo'];

// URL del Worker Cloudflare (da aggiornare dopo il deploy)
const WORKER_URL = 'https://TUO-WORKER.tuonome.workers.dev';

// ------------------------------------------------------------
// STATO GLOBALE
// ------------------------------------------------------------
const state = {
  // Identità
  playerName: '',
  isHost: false,
  roomCode: '',
  room: null,          // istanza Trystero
  myPeerId: null,

  // Connessioni
  peers: new Map(),    // peerId -> { name, isReady, answers }

  // Configurazione partita (autorità: host)
  config: {
    extraCategories: [...DEFAULT_EXTRA_CATEGORIES],
    selectedExtras: [],
    timerSeconds: 60,
  },

  // Stato del round
  round: {
    number: 0,
    letter: '',
    seed: 0,
    timerSeconds: 0,
    startTime: 0,
    active: false,
    previousLetter: '',
  },

  // Risposte locali del giocatore
  myAnswers: {},       // categoria -> stringa
  myReady: false,

  // Timer locale
  timerInterval: null,
};

// ------------------------------------------------------------
// RIFERIMENTI DOM
// ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const dom = {
  // Lobby
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
  playerList: $('playerList'),
  playerCount: $('playerCount'),
  btnShareSms: $('btnShareSms'),
  btnStartGame: $('btnStartGame'),
  hostHint: $('hostHint'),

  // Badge stanza
  roomBadge: $('roomBadge'),
  roomCode: $('roomCode'),
  connDot: $('connDot'),

  // Gioco
  roundLetter: $('roundLetter'),
  roundTimer: $('roundTimer'),
  roundTimerBox: $('roundTimerBox'),
  roundNumber: $('roundNumber'),
  roundSeed: $('roundSeed'),
  categoryInputs: $('categoryInputs'),
  btnDone: $('btnDone'),
  doneHint: $('doneHint'),
  gamePlayerList: $('gamePlayerList'),

  // Risultati
  resultsContent: $('resultsContent'),
  btnNextRound: $('btnNextRound'),

  // Toast
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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let code = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  for (const b of arr) code += chars[b % chars.length];
  return code;
}

// PRNG deterministico basato su seed (xorshift32)
function seededRandom(seed) {
  let x = seed >>> 0;
  if (x === 0) x = 1;
  x ^= x << 13; x >>>= 0;
  x ^= x >> 17;
  x ^= x << 5;  x >>>= 0;
  return x / 4294967296;
}

// Sceglie una lettera dall'alfabeto usando il seed e la lettera precedente
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

// ------------------------------------------------------------
// NOME GIOCATORE (localStorage)
// ------------------------------------------------------------
function initPlayerName() {
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
}

// ------------------------------------------------------------
// TRYSTERO — CONNESSIONE
// ------------------------------------------------------------
function initRoom(isHost, roomCode) {
  state.isHost = isHost;
  state.roomCode = roomCode;

  // Configurazione Trystero
  const config = { appId: APP_ID };
  const room = joinRoom(config, roomCode);
  state.room = room;

  // ID del peer locale
  // Trystero non espone direttamente selfId, ma lo ricaviamo dagli eventi
  // (in alternativa usiamo la callback onPeerJoin con il proprio id? No:
  //  memorizziamo l'id quando riceviamo il primo messaggio o usiamo room.getPeers)
  // Per semplicità, generiamo un ID locale stabile e lo includiamo nei messaggi.
  state.myPeerId = crypto.randomUUID();

  // Aggiorna UI stanza
  dom.roomBadge.hidden = false;
  dom.roomCode.textContent = roomCode;
  dom.connDot.classList.add('online');

  // Mostra configurazione (solo host) o lista giocatori
  dom.joinCard.hidden = true;
  dom.configCard.hidden = false;

  if (isHost) {
    dom.btnStartGame.disabled = false;
    dom.btnShareSms.hidden = false;
    dom.hostHint.hidden = true;
  } else {
    dom.btnStartGame.disabled = true;
    dom.btnShareSms.hidden = true;
    dom.hostHint.hidden = false;
  }

  // --- Azioni Trystero ---
  const [sendPresence, onPresence] = room.makeAction('presence');
  const [sendAnswers, onAnswers] = room.makeAction('answers');
  const [sendRoundStart, onRoundStart] = room.makeAction('round-start');
  const [sendRoundEnd, onRoundEnd] = room.makeAction('round-end');
  const [sendResults, onResults] = room.makeAction('results');
  const [sendConfig, onConfig] = room.makeAction('config');

  state.send = {
    presence: sendPresence,
    answers: sendAnswers,
    roundStart: sendRoundStart,
    roundEnd: sendRoundEnd,
    results: sendResults,
    config: sendConfig,
  };

  // --- Gestione presenze ---
  function announcePresence() {
    sendPresence({ name: state.playerName, isHost: state.isHost, peerId: state.myPeerId });
  }

  onPresence((data, peerId) => {
    state.peers.set(peerId, {
      name: data.name,
      isHost: data.isHost,
      peerId: data.peerId,
      ready: false,
      answers: null,
    });
    renderPlayers();
    // Rispondi con la propria presenza se non l'hai ancora fatto
    if (state.isHost) {
      // L'host invia anche la configurazione corrente
      sendConfig({ config: state.config }, peerId);
    }
    announcePresence();
  });

  onConfig((data, peerId) => {
    if (!state.isHost) {
      state.config = data.config;
      applyConfigToUI();
    }
  });

  room.onPeerJoin(peerId => {
    console.log('Peer joined:', peerId);
    dom.connDot.classList.add('online');
    // Invia subito la presenza al nuovo arrivato
    setTimeout(announcePresence, 300);
  });

  room.onPeerLeave(peerId => {
    console.log('Peer left:', peerId);
    state.peers.delete(peerId);
    renderPlayers();
    if (state.peers.size === 0) {
      dom.connDot.classList.remove('online');
      dom.connDot.classList.add('offline');
    }
  });

  // --- Risposte dei client (ricevute dall'host) ---
  onAnswers((data, peerId) => {
    if (!state.isHost) return;
    const peer = state.peers.get(peerId);
    if (peer) {
      peer.answers = data.answers;
      peer.ready = true;
    }
    renderPlayers();
    checkAllReady();
  });

  // --- Avvio round (ricevuto dai client) ---
  onRoundStart((data) => {
    if (state.isHost) return; // l'host ha già avviato localmente
    startRoundLocal(data);
  });

  // --- Fine round (ricevuto dai client) ---
  onRoundEnd((data) => {
    if (state.isHost) return;
    // I client ricevono i risultati tramite l'azione 'results'
  });

  // --- Risultati (ricevuti dai client) ---
  onResults((data) => {
    if (state.isHost) return;
    renderResults(data.results);
    showScreen('results');
  });

  // Invia la presenza iniziale
  setTimeout(announcePresence, 500);

  // Se client, richiedi configurazione all'host
  if (!state.isHost) {
    setTimeout(() => {
      // La richiesta avviene implicitamente con announcePresence
    }, 800);
  }
}

// ------------------------------------------------------------
// LOBBY — AZIONI
// ------------------------------------------------------------
dom.btnCreateRoom.addEventListener('click', () => {
  const code = generateRoomCode();
  // Aggiorna URL senza ricaricare
  const url = new URL(window.location);
  url.searchParams.set('room', code);
  window.history.pushState({}, '', url);
  initRoom(true, code);
});

dom.btnJoinRoom.addEventListener('click', () => {
  const code = dom.inputRoomCode.value.trim().toUpperCase();
  if (!code) { showToast('Inserisci un codice stanza'); return; }
  const url = new URL(window.location);
  url.searchParams.set('room', code);
  window.history.pushState({}, '', url);
  initRoom(false, code);
});

// Condivisione via SMS
dom.btnShareSms.addEventListener('click', () => {
  const url = `${window.location.origin}${window.location.pathname}?room=${state.roomCode}`;
  const body = encodeURIComponent(`Gioca a Nomi Cose Città! Clicca qui: ${url}`);
  window.location.href = `sms:?&body=${body}`;
});

// Configurazione extra categories (checkboxes)
dom.extraCategories.addEventListener('change', () => {
  if (!state.isHost) return;
  const checked = [...dom.extraCategories.querySelectorAll('.chip-check:checked')]
    .map(cb => cb.value);
  state.config.selectedExtras = checked;
  broadcastConfig();
});

// Configurazione timer (radio)
dom.timerOptions.addEventListener('change', () => {
  if (!state.isHost) return;
  const selected = dom.timerOptions.querySelector('.chip-check:checked');
  state.config.timerSeconds = parseInt(selected.value, 10);
  broadcastConfig();
});

function broadcastConfig() {
  if (state.isHost && state.send) {
    state.send.config({ config: state.config });
  }
}

function applyConfigToUI() {
  // Aggiorna checkboxes
  for (const cb of dom.extraCategories.querySelectorAll('.chip-check')) {
    cb.checked = state.config.selectedExtras.includes(cb.value);
  }
  // Aggiorna radio timer
  for (const rb of dom.timerOptions.querySelectorAll('.chip-check')) {
    rb.checked = parseInt(rb.value, 10) === state.config.timerSeconds;
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
    id: 'self',
  }];

  for (const [peerId, peer] of state.peers) {
    list.push({
      name: peer.name,
      isHost: peer.isHost,
      ready: peer.ready,
      id: peerId,
    });
  }

  // Lobby
  dom.playerCount.textContent = `(${list.length})`;
  dom.playerList.innerHTML = list.map(p => `
    <li>
      <span class="player-name">${escapeHtml(p.name)}</span>
      <span class="player-tag ${p.isHost ? 'host' : ''} ${p.ready ? 'ready' : ''}">
        ${p.isHost ? 'Host' : (p.ready ? 'Pronto' : 'In attesa')}
      </span>
    </li>
  `).join('');

  // Schermata gioco
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ------------------------------------------------------------
// AVVIO PARTITA (host)
// ------------------------------------------------------------
dom.btnStartGame.addEventListener('click', () => {
  if (!state.isHost) return;

  // Genera seed e lettera
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const letter = pickLetter(seed, state.round.previousLetter);

  state.round.number += 1;
  state.round.seed = seed;
  state.round.letter = letter;
  state.round.timerSeconds = state.config.timerSeconds;
  state.round.startTime = Date.now();
  state.round.active = true;
  state.round.previousLetter = letter;

  // Categorie attive: fisse + extra selezionate
  const activeCategories = [...FIXED_CATEGORIES, ...state.config.selectedExtras];

  // Prepara UI locale
  prepareGameUI(letter, state.round.number, seed, activeCategories);

  // Notifica i client
  if (state.send) {
    state.send.roundStart({
      letter,
      roundNumber: state.round.number,
      seed,
      timerSeconds: state.round.timerSeconds,
      categories: activeCategories,
    });
  }

  // Avvia timer
  startTimer(state.round.timerSeconds);
  showScreen('game');
});

function prepareGameUI(letter, roundNumber, seed, categories) {
  dom.roundLetter.textContent = letter;
  dom.roundNumber.textContent = `Round ${roundNumber}`;
  dom.roundSeed.textContent = `seed: ${seed}`;
  dom.roundTimerBox.classList.remove('warning', 'danger', 'hidden-timer');

  // Genera input per categoria
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

  // Reset risposte locali
  state.myAnswers = {};
  state.myReady = false;
  dom.btnDone.disabled = false;
  dom.doneHint.hidden = true;

  // Ascolta input
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
  dom.roundTimer.textContent = formatTime(remaining);

  state.timerInterval = setInterval(() => {
    remaining -= 1;
    dom.roundTimer.textContent = formatTime(remaining);

    if (remaining <= 10 && remaining > 0) {
      dom.roundTimerBox.classList.add('warning');
    }
    if (remaining <= 5) {
      dom.roundTimerBox.classList.remove('warning');
      dom.roundTimerBox.classList.add('danger');
    }

    if (remaining <= 0) {
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
// FINE ROUND
// ------------------------------------------------------------
function onRoundTimeUp() {
  state.round.active = false;
  stopTimer();

  if (state.isHost) {
    // L'host raccoglie tutte le risposte e calcola i risultati
    collectAndScore();
  } else {
    // I client inviano le proprie risposte all'host
    if (state.send) {
      state.send.answers({ answers: state.myAnswers });
    }
    showToast('Tempo scaduto! In attesa dei risultati...');
  }
}

// "Ho finito!" — segna solo il proprio stato
dom.btnDone.addEventListener('click', () => {
  if (state.myReady) return;
  state.myReady = true;
  dom.btnDone.disabled = true;
  dom.doneHint.hidden = false;
  renderPlayers();

  if (!state.isHost && state.send) {
    state.send.answers({ answers: state.myAnswers });
  } else if (state.isHost) {
    // L'host ha già le sue risposte in state.myAnswers
  }
});

// ------------------------------------------------------------
// SCORING (host)
// ------------------------------------------------------------
async function collectAndScore() {
  // Raccogli risposte: proprie + quelle ricevute dai client
  const allAnswers = new Map();
  allAnswers.set(state.myPeerId, {
    name: state.playerName,
    answers: state.myAnswers,
  });

  for (const [peerId, peer] of state.peers) {
    allAnswers.set(peerId, {
      name: peer.name,
      answers: peer.answers || {},
    });
  }

  // Categorie attive
  const categories = [...FIXED_CATEGORIES, ...state.config.selectedExtras];

  // Per ogni categoria, verifica le parole
  const results = {}; // categoria -> [{ playerName, word, valid, points }]
  for (const cat of categories) {
    results[cat] = [];
    for (const [peerId, data] of allAnswers) {
      const word = (data.answers[cat] || '').trim();
      let valid = false;
      if (word) {
        valid = await verifyWord(word, state.round.letter);
      }
      results[cat].push({
        playerName: data.name,
        word: word,
        valid: valid,
        points: 0, // calcolato dopo
      });
    }
  }

  // Calcola punti: 10 se valida e unica, 5 se valida ma duplicata, 0 se non valida
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

  // Invia risultati a tutti
  if (state.send) {
    state.send.results({ results });
  }

  // Mostra risultati localmente
  renderResults(results);
  showScreen('results');
}

// ------------------------------------------------------------
// VERIFICA PAROLE
// ------------------------------------------------------------
async function verifyWord(word, letter) {
  // Controllo base: inizia con la lettera giusta?
  if (word[0].toUpperCase() !== letter) return false;

  // 1. Prova Wikipedia (italiana)
  try {
    const url = `https://it.wikipedia.org/w/api.php?origin=*&action=opensearch&search=${encodeURIComponent(word)}&limit=5`;
    const res = await fetch(url);
    const data = await res.json();
    // data[1] = array di titoli suggeriti
    if (data[1] && data[1].length > 0) {
      // Verifica che ci sia una corrispondenza ragionevole
      const lower = word.toLowerCase();
      const match = data[1].some(t => t.toLowerCase().includes(lower));
      if (match) return true;
    }
  } catch (e) {
    console.warn('Wikipedia error:', e);
  }

  // 2. Fallback: Worker Gemini
  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        word: word,
        letter: letter,
        prompt: `La parola italiana "${word}" è una parola valida che inizia con la lettera "${letter}"? Rispondi solo "sì" o "no".`,
      }),
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
function renderResults(results) {
  const html = Object.entries(results).map(([cat, entries]) => {
    const rows = entries.map(e => {
      const cls = e.word && !e.valid ? 'word-dup' : '';
      const status = e.word ? (e.valid ? '' : '(non valida)') : '(vuoto)';
      return `
        <div class="result-row">
          <span>${escapeHtml(e.playerName)}: <span class="${cls}">${escapeHtml(e.word || '—')}</span> ${status}</span>
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

  // Pulsante prossimo round (solo host)
  dom.btnNextRound.hidden = !state.isHost;
  dom.btnNextRound.onclick = () => {
    if (!state.isHost) return;
    // Torna alla lobby di configurazione e riavvia
    state.myReady = false;
    state.myAnswers = {};
    renderPlayers();
    showScreen('lobby');
    // Il prossimo "Inizia partita" avvierà il round successivo
  };
}

// ------------------------------------------------------------
// BOOT
// ------------------------------------------------------------
function boot() {
  initPlayerName();

  // Controlla se c'è ?room= nell'URL
  const params = new URLSearchParams(window.location.search);
  const roomCode = params.get('room');

  if (roomCode) {
    // Client: entra direttamente nella stanza
    initRoom(false, roomCode.toUpperCase());
  } else {
    // Host: mostra lobby per creare stanza
    showScreen('lobby');
  }
}

boot();
