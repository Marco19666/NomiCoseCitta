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
  isCpuGame: false,
  cpuAnswers: {},
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
    scoring: false,
  },
  interval: null,

  answers: {},
  ready: false,

  scores: new Map(),
  personalGameSaved: false,
  usedLetters: [],

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
  btnCpu: $('btnCpuChallenge'),

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
  btnNewGame: $('btnNewGame'),

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

function pickLetter(seed, usedLetters = []) {
  const used = new Set(usedLetters);
  const pool = ALPHABET.split('').filter(letter => !used.has(letter));
  if (!pool.length) return '';
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
  const [sendNewGame, onNewGame] = S.room.makeAction('new-game');

  S.send = { presence: sendPresence, answers: sendAnswers, done: sendDone,
             roundStart: sendRoundStart, results: sendResults, config: sendConfig, newGame: sendNewGame };

  const announce = () => sendPresence({ name: S.name, isHost: S.isHost });

  onPresence((data, peerId) => {
    // I messaggi presence possono arrivare più volte: non azzerare
    // risposte e stato "pronto" già ricevuti durante la manche.
    const previous = S.peers.get(peerId) || {};
    S.peers.set(peerId, {
      ...previous,
      name: data.name || previous.name,
      isHost: !!data.isHost,
      ready: previous.ready || false,
      answers: previous.answers || null,
    });
    renderPlayers();
    if (S.isHost) sendConfig({ config: S.config }, peerId);
    // Non rispondere a ogni presence con un'altra presence:
    // peerJoin e l'annuncio iniziale gestiscono già la scoperta dei giocatori.
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
      if (data.answers && typeof data.answers === 'object') S.answers = data.answers;
    } else {
      for (const p of S.peers.values()) {
        if (normName(p.name) === normName(name)) {
          p.ready = true;
          // Il pacchetto "done" contiene anche le risposte: non dipendiamo
          // dall'ordine di consegna tra due azioni Trystero distinte.
          if (data.answers && typeof data.answers === 'object') p.answers = data.answers;
          break;
        }
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

  onNewGame(() => {
    if (S.isHost) return;
    resetForNewGame();
  });

  onResults((data) => {
    if (S.isHost) return;
    if (Array.isArray(data.scores)) S.scores = new Map(data.scores);
    if (data.isLast) recordPersonalGameStats();
    renderStandings();
    renderResults(data.results, data.bonuses || {});
    D.resultsTitle.textContent = data.isLast ? 'Classifica finale' : 'Risultati manche';
    D.btnNext.hidden = true;
    if (D.btnNewGame) D.btnNewGame.hidden = !data.isLast;
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

D.btnCpu?.addEventListener('click', () => {
  ensureName();
  S.isCpuGame = true;
  S.isHost = true;
  S.room = null;
  S.roomCode = '';
  S.peers.clear();
  S.scores.clear();
  D.roomBadge.hidden = true;
  D.joinCard.hidden = true;
  D.configCard.hidden = false;
  D.btnStart.disabled = false;
  D.btnShare.hidden = true;
  D.hostHint.hidden = true;
  renderPlayers();
  toast('Sfida contro il computer: scegli le impostazioni e inizia!');
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
    ...(S.isCpuGame ? [{ name: 'Computer', isHost: false, ready: false }] : []),
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

// Dizionario locale usato dall'avversario virtuale.
const CPU_DICTIONARY = {
  Cose: 'abaco;abat-jour;accendino;agenda;ago;album;anello;antenna;armadio;asciugamano;aspirapolvere;auto;balcone;borsa;bottiglia;bracciale;calendario;camera;campana;candela;carota;cartella;casco;chiave;chitarra;ciotola;computer;coperta;corda;cucchiaio;diamante;dizionario;doccia;domino;elastico;elmo;enciclopedia;erba;faro;ferro;finestra;forchetta;forno;fotografia;frigorifero;gabbia;gancio;gelato;gomma;guanto;lampada;lavagna;libro;martello;matita;medaglia;microfono;moneta;motore;nastro;occhiali;ombrello;orologio;padella;palazzo;palla;panino;paracadute;passaporto;penna;pettine;piatto;porta;quaderno;radio;rete;righello;robot;ruota;sedia;semaforo;scarpa;scatola;specchio;telefono;tenda;termometro;tavolo;tovaglia;treno;valigia;vaso;ventaglio;zaino;zerbino',
  Nomi: 'Ada;Alberto;Alessandro;Alice;Andrea;Anna;Antonio;Beatrice;Bruno;Carla;Carlo;Chiara;Claudia;Davide;Diego;Domenico;Elena;Enrico;Erica;Fabio;Federica;Filippo;Francesca;Franco;Gabriele;Giada;Giorgio;Giulia;Giuseppe;Ilaria;Irene;Luca;Lucia;Luigi;Marco;Maria;Martina;Matteo;Michele;Nicola;Paola;Paolo;Pietro;Roberto;Sara;Sofia;Stefano;Tommaso;Valentina;Vittoria;Walter;Zeno;Zoe',
  Città: 'Aosta;Alessandria;Ancona;Arezzo;Asti;Bari;Bergamo;Bologna;Bolzano;Brescia;Cagliari;Catania;Como;Cosenza;Cremona;Cuneo;Ferrara;Firenze;Foggia;Forlì;Genova;Gorizia;Grosseto;Imperia;Isernia;La Spezia;Latina;Lecce;Lecco;Livorno;Lodi;Lucca;Mantova;Massa;Matera;Messina;Milano;Modena;Napoli;Novara;Nuoro;Oristano;Padova;Palermo;Parma;Pavia;Perugia;Pescara;Pisa;Pistoia;Potenza;Prato;Ravenna;Reggio Calabria;Rieti;Rimini;Roma;Rovigo;Salerno;Sassari;Savona;Siena;Siracusa;Sondrio;Taranto;Teramo;Terni;Torino;Trapani;Trento;Treviso;Trieste;Udine;Varese;Venezia;Verona;Vercelli;Vicenza;Viterbo;Zagabria;Zurigo',
  Animali: 'aquila;asino;allocco;anaconda;ape;balena;barboncino;bruco;cane;capra;castoro;cavallo;cervo;chiocciola;cicogna;cigno;coccodrillo;coniglio;daino;delfino;dromedario;elefante;ermellino;falco;farfalla;fenicottero;formica;gabbiano;gatto;ghepardo;giraffa;gorilla;gufo;iguana;istrice;koala;lama;leone;leopardo;lumaca;lupo;medusa;merlo;mosca;mucca;oca;opossum;orca;ornitorinco;orso;ostrica;pantera;pappagallo;pecora;pipistrello;quaglia;ragno;rana;riccio;rinoceronte;rospo;scoiattolo;serpente;squalo;tartaruga;tasso;tigre;topo;toro;tucano;upupa;vacca;volpe;yak;zanzara;zebra',
  Mestieri: 'agricoltore;albergatore;architetto;artigiano;attore;barbiere;barista;benzinaio;calciatore;cantante;carabiniere;carpentiere;casaro;chef;chirurgo;commesso;cuoco;dentista;docente;elettricista;fabbro;farmacista;falegname;fotografo;geometra;giornalista;idraulico;impiegato;infermiere;insegnante;ingegnere;interprete;lavapiatti;macellaio;magazziniere;marinaio;meccanico;medico;musicista;notaio;operaio;ostetrica;panettiere;parrucchiere;pilota;pizzaiolo;poliziotto;portiere;professore;psicologo;questore;regista;ristoratore;sarto;sceneggiatore;segretario;sommelier;tecnico;traduttore;ufficiale;veterinario;vigile;zoologo',
  Colori: 'amaranto;arancione;azzurro;beige;bianco;blu;celeste;crema;corallo;fucsia;giallo;grigio;indaco;lilla;marrone;magenta;nero;ocra;oro;ottanio;porpora;rosa;rosso;rame;salmonato;senape;turchese;verde;viola',
  Film: 'Alien;Amadeus;Avatar;Bambi;Casablanca;Cenerentola;Dune;Dumbo;E.T.;Fantasia;Frozen;Gladiatore;Grease;Inception;Joker;King Kong;La vita è bella;Matrix;Mulan;Nosferatu;Oppenheimer;Psycho;Quo vadis;Rocky;Shrek;Titanic;Up;Vertigo;WALL-E;X-Men;Yesterday;Zootropolis',
  Cantanti: 'Achille Lauro;Adele;Al Bano;Annalisa;Beyoncé;Bocelli;Claudio Baglioni;Cesare Cremonini;Dua Lipa;Elisa;Elodie;Eros Ramazzotti;Franco Battiato;Giorgia;Gianna Nannini;Jovanotti;Laura Pausini;Ligabue;Madonna;Måneskin;Mina;Nek;Olly;Pino Daniele;Queen;Renato Zero;Shakira;Tiziano Ferro;Ultimo;Vasco Rossi;Zucchero',
  Sport: 'arrampicata;atletica;badminton;basket;beach volley;boxe;calcio;canottaggio;ciclismo;curling;danza;equitazione;formula 1;ginnastica;golf;hockey;judo;karate;lotta;nuoto;orienteering;pallanuoto;pallavolo;pugilato;rugby;scherma;sci;snowboard;tennis;triathlon;vela;volley;wrestling',
  Cibo: 'arancia;ananas;aragosta;banana;barbabietola;biscotto;broccoli;burrata;cannelloni;carciofo;carota;castagna;ciambella;cicoria;cioccolato;focaccia;formaggio;fragola;gnocchi;insalata;lasagna;limone;mandarino;mela;melanzana;minestrone;mozzarella;noce;oliva;omelette;panettone;pasta;pera;pesca;pizza;polenta;quinoa;radicchio;ravioli;risotto;salame;spaghetti;tiramisù;uva;zuppa;zucchina'
};

function makeComputerAnswers(categories, letter) {
  const answers = {};
  for (const category of categories) {
    const entries = (CPU_DICTIONARY[category] || '')
      .split(';')
      .map(word => word.trim())
      .filter(word => word && word[0].toLocaleUpperCase('it-IT') === letter);
    answers[category] = entries.length
      ? entries[Math.floor(Math.random() * entries.length)]
      : '';
  }
  return answers;
}

// ------------------------------------------------------------
// AVVIO MANCHE
// ------------------------------------------------------------
D.btnStart.addEventListener('click', () => {
  if (!S.isHost) {
    toast('Solo chi ha creato la stanza può avviare la partita.');
    return;
  }
  try {
    hostStartRound();
  } catch (error) {
    console.error('Errore avvio partita:', error);
    toast('Impossibile avviare: ' + (error?.message || error), 6000);
  }
});

function hostStartRound() {
  if (S.round.num >= S.config.rounds) {
    toast('La partita è terminata: avvia una nuova partita.');
    return;
  }
  if (S.usedLetters.length >= ALPHABET.length) {
    toast('Sono state utilizzate tutte le lettere disponibili. Avvia una nuova partita.');
    return;
  }
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const letter = pickLetter(seed, S.usedLetters);
  if (!letter) return;
  S.usedLetters.push(letter);

  S.round.num += 1;
  S.round.letter = letter;
  S.round.prevLetter = letter;
  S.round.timer = S.config.timer;
  S.round.active = true;
  S.round.scoring = false;
  S.ready = false;
  clearTimeout(S.forceCloseTimeout);

  for (const p of S.peers.values()) { p.ready = false; p.answers = null; }

  const cats = activeCategories();
  S.cpuAnswers = S.isCpuGame ? makeComputerAnswers(cats, letter) : {};

  // Avvia prima la schermata locale: la partita dell'host non deve
  // dipendere dalla disponibilità momentanea del canale multiplayer.
  prepareGameUI(letter, S.round.num, seed, cats);
  runTimer(S.round.timer);
  showScreen('game');

  // Poi comunica l'avvio agli altri giocatori. Se l'invio fallisce,
  // l'host resta comunque nella partita e vede un messaggio esplicito.
  try {
    if (typeof S.send.roundStart === 'function') {
      S.send.roundStart({ letter, num: S.round.num, seed, timer: S.round.timer, categories: cats });
    } else {
      toast('Partita avviata sul dispositivo host, ma invio agli altri non disponibile.', 5000);
    }
  } catch (error) {
    console.error('Errore invio round-start:', error);
    toast('Partita avviata qui; problema nel collegamento agli altri giocatori.', 5000);
  }
}

function clientStartRound(data) {
  S.round.num = data.num;
  S.round.letter = data.letter;
  if (!S.usedLetters.includes(data.letter)) S.usedLetters.push(data.letter);
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
// STATO DI ATTESA RISULTATI
// ------------------------------------------------------------
function showWaitingForResults() {
  if (D.btnDone) {
    D.btnDone.disabled = true;
    D.btnDone.textContent = 'In attesa dei risultati...';
  }
  if (D.doneHint) {
    D.doneHint.textContent = 'Manche terminata. In attesa dei risultati...';
    D.doneHint.hidden = false;
  }
  D.categoryInputs?.querySelectorAll('input').forEach(input => {
    input.disabled = true;
  });
}

// ------------------------------------------------------------
// HO FINITO!
// ------------------------------------------------------------
D.btnDone.addEventListener('click', () => {
  if (S.ready) return;
  S.ready = true;
  showWaitingForResults();
  renderPlayers();

  // Il timer continua a scorrere anche dopo "Ho finito":
  // il controllo delle parole parte solo allo zero dell'host.
  if (!S.isHost && S.send.answers) {
    S.send.answers({ name: S.name, answers: S.answers });
    S.send.done({ name: S.name, answers: S.answers });
  } else if (S.isHost) {
    checkAllReady();
  }

  toast('Hai finito! Attendo gli altri...');
});

// ------------------------------------------------------------
// CONTROLLO TUTTI PRONTI (host)
// ------------------------------------------------------------
function checkAllReady() {
  // Non avviare mai il controllo prima che il timer dell'host sia arrivato a zero.
  if (!S.isHost || S.round.active || S.round.remaining > 0 || S.round.scoring) return;
  if (!S.ready) return;
  for (const p of S.peers.values()) if (!p.ready) return;
  S.round.scoring = true;
  stopTimer();
  clearTimeout(S.forceCloseTimeout);
  toast('Tempo terminato: controllo delle risposte...');
  scoreRound();
}

function scheduleForceClose() {
  clearTimeout(S.forceCloseTimeout);
  S.forceCloseTimeout = setTimeout(() => {
    if (S.isHost && !S.round.active && S.round.remaining <= 0 && S.ready && !S.round.scoring) {
      S.round.scoring = true;
      toast('Tempo di attesa terminato: controllo delle risposte...', 3000);
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
  S.round.remaining = 0;
  stopTimer();
  clearTimeout(S.forceCloseTimeout);

  showWaitingForResults();
  if (S.isHost) {
    S.ready = true;
    checkAllReady();
    scheduleForceClose();
  } else {
    S.round.remaining = 0;
    S.ready = true;
    showWaitingForResults();
    if (S.send.answers) S.send.answers({ name: S.name, answers: S.answers });
    if (S.send.done) S.send.done({ name: S.name, answers: S.answers });
    toast('Tempo scaduto: in attesa dei risultati...');
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
    ...(S.isCpuGame ? [{ name: 'Computer', answers: S.cpuAnswers }] : []),
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

  // Bonus en plein : +15 si tutte le categorie hanno una risposta valida.
  const bonuses = {};
  for (const pl of players) {
    const perfectRound = cats.length > 0 && cats.every(cat =>
      results[cat].some(e => e.playerName === pl.name && e.valid && e.word)
    );
    if (perfectRound) bonuses[pl.name] = 15;
  }

  for (const cat of cats) {
    for (const e of results[cat]) {
      if (!totals.has(e.playerName)) totals.set(e.playerName, { name: e.playerName, points: 0 });
      totals.get(e.playerName).points += e.points;
    }
  }
  for (const [name, bonus] of Object.entries(bonuses)) {
    if (!totals.has(name)) totals.set(name, { name, points: 0 });
    totals.get(name).points += bonus;
  }

  for (const t of totals.values()) {
    if (!S.scores.has(t.name)) S.scores.set(t.name, { name: t.name, total: 0 });
    S.scores.get(t.name).total += t.points;
  }

  const isLast = S.round.num >= S.config.rounds;
  if (isLast) recordPersonalGameStats();

  if (S.send.results) {
    S.send.results({ results, bonuses, scores: [...S.scores.entries()], isLast });
  }

  renderStandings();
  renderResults(results, bonuses);
  D.resultsTitle.textContent = isLast ? 'Classifica finale' : 'Risultati manche';
  D.btnNext.hidden = !S.isHost || isLast;
  if (D.btnNewGame) D.btnNewGame.hidden = !isLast;
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
const PERSONAL_STATS_KEY = 'ncc_personal_stats_v1';

function renderPersonalStats() {
  const el = $('personalStats');
  if (!el) return;
  let stats = {};
  try { stats = JSON.parse(localStorage.getItem(PERSONAL_STATS_KEY) || '{}'); } catch (_) {}
  const games = Number(stats.games) || 0;
  if (!games) {
    el.innerHTML = '<p class="muted">Le tue statistiche personali appariranno qui dopo la prima partita.</p>';
    return;
  }
  el.innerHTML = `<div class="stats-grid">
    <div><strong>${games}</strong><span>Partite</span></div>
    <div><strong>${Number(stats.wins) || 0}</strong><span>Vittorie</span></div>
    <div><strong>${Number(stats.draws) || 0}</strong><span>Pareggi</span></div>
    <div><strong>${Number(stats.points) || 0}</strong><span>Punti totali</span></div>
  </div>`;
}

function recordPersonalGameStats() {
  if (S.personalGameSaved || !S.scores.size) return;
  const mine = [...S.scores.values()].find(p => normName(p.name) === normName(S.name));
  if (!mine) return;
  const values = [...S.scores.values()];
  const best = Math.max(...values.map(p => Number(p.total) || 0));
  const tied = values.filter(p => (Number(p.total) || 0) === best);
  let stats = {};
  try { stats = JSON.parse(localStorage.getItem(PERSONAL_STATS_KEY) || '{}'); } catch (_) {}
  stats.games = (Number(stats.games) || 0) + 1;
  stats.points = (Number(stats.points) || 0) + (Number(mine.total) || 0);
  // Una parità in testa conta come vittoria condivisa e viene indicata anche tra i pareggi.
  if ((Number(mine.total) || 0) === best) {
    stats.wins = (Number(stats.wins) || 0) + 1;
    if (tied.length > 1) stats.draws = (Number(stats.draws) || 0) + 1;
  }
  try {
    localStorage.setItem(PERSONAL_STATS_KEY, JSON.stringify(stats));
    S.personalGameSaved = true;
    renderPersonalStats();
  } catch (e) {
    console.warn('Impossibile salvare le statistiche personali', e);
  }
}

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

function renderResults(results, bonuses = {}) {
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
  const bonusRows = Object.entries(bonuses).map(([name, points]) =>
    `<div class="result-row bonus-row"><span>${esc(name)}: en plein!</span><strong>+${points} pt bonus</strong></div>`
  ).join('');
  if (bonusRows) D.results.innerHTML += `<div class="result-cat bonus-summary"><div class="result-cat-title">🏆 Bonus en plein</div>${bonusRows}</div>`;
}

// ------------------------------------------------------------
// PROSSIMA MANCHE
// ------------------------------------------------------------
function resetForNewGame() {
  stopTimer();
  clearTimeout(S.forceCloseTimeout);
  S.round = { num: 0, letter: '', active: false, prevLetter: '', timer: 0, remaining: 0, scoring: false };
  S.answers = {};
  S.cpuAnswers = {};
  S.ready = false;
  S.scores.clear();
  S.personalGameSaved = false;
  S.usedLetters = [];
  for (const p of S.peers.values()) { p.ready = false; p.answers = null; }
  D.btnNext.hidden = true;
  if (D.btnNewGame) D.btnNewGame.hidden = true;
  D.btnStart.disabled = !S.isHost;
  D.configCard.hidden = false;
  D.joinCard.hidden = true;
  renderPlayers();
  showScreen('lobby');
}

D.btnNewGame?.addEventListener('click', () => {
  if (!S.isHost) return;
  resetForNewGame();
  if (S.send.newGame) S.send.newGame({});
});

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
  renderPersonalStats();
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


// La schermata iniziale è solo una breve introduzione: non blocca l'accesso al gioco.
(function dismissSplash() {
  const splash = document.getElementById('splashScreen');
  if (!splash) return;
  const hide = () => {
    splash.classList.add('splash-hidden');
    setTimeout(() => splash.remove(), 500);
  };
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) hide();
  else setTimeout(hide, 1250);
})();
