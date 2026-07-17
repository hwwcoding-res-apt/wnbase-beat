/*
  game.js
  -------
  Handles: song list loading (built-in manifest + IndexedDB-persisted
  uploads), audio decode + auto-charting (via chart-generator.js), the
  note highway render loop, input judging, scoring/health, and screen
  transitions. Everything runs client-side — no server, no build step.
*/

// ---------- Constants ----------
const LANES = ['left', 'down', 'up', 'right'];
// Left = purple, Down = blue, Up = green, Right = red
const LANE_COLORS = ['#9B4DFF', '#2B8CFF', '#22D65E', '#FF3B3B'];
const KEY_TO_LANE = { ArrowLeft: 0, ArrowDown: 1, ArrowUp: 2, ArrowRight: 3 };
const LANE_KEYS = [[], [], [], []];
for (const k in KEY_TO_LANE) LANE_KEYS[KEY_TO_LANE[k]].push(k);
const HOLD_RELEASE_GRACE = 0.12; // seconds of slack before a release counts as "early"
const HOLD_TICK_INTERVAL = 0.1; // seconds between hold-tick score ticks

const HIGHWAY_W = 480;
const HIGHWAY_H = 560;
const LANE_W = 88;
const LANE_GAP = 10;
const HIGHWAY_MARGIN = (HIGHWAY_W - (LANE_W * 4 + LANE_GAP * 3)) / 2;
const HIT_LINE_Y = 480;
const NOTE_R = 30;
const SCROLL_SPEED = 340; // px per second

const HIT_WINDOWS = {
  sick: 0.05,
  good: 0.10,
  bad: 0.155
};
const MISS_WINDOW = 0.19;

const JUDGE_SCORE = { sick: 350, good: 200, bad: 60, miss: 0 };
const JUDGE_HEALTH = { sick: 2, good: 1, bad: -2, miss: -6 };
const JUDGE_COLOR = { sick: '#ffd23f', good: '#22D65E', bad: '#FF3B3B', miss: '#8a7aa8' };

// ---------- DOM refs ----------
const screens = {
  select: document.getElementById('screen-select'),
  loading: document.getElementById('screen-loading'),
  game: document.getElementById('screen-game'),
  results: document.getElementById('screen-results')
};
const songListEl = document.getElementById('song-list');
const diffRow = document.getElementById('diff-row');
const playBtn = document.getElementById('play-btn');
const loadingMsg = document.getElementById('loading-msg');
const canvas = document.getElementById('highway');
const ctx = canvas.getContext('2d');
const scoreValueEl = document.getElementById('score-value');
const comboValueEl = document.getElementById('combo-value');
const accuracyValueEl = document.getElementById('accuracy-value');
const timeValueEl = document.getElementById('time-value');
const uploadInput = document.getElementById('song-upload');
const uploadBtn = document.getElementById('upload-btn');
const uploadMenu = document.getElementById('upload-menu');
const optChooseFile = document.getElementById('opt-choose-file');
const optPasteLink = document.getElementById('opt-paste-link');
const linkOverlay = document.getElementById('link-overlay');
const linkInput = document.getElementById('link-input');
const linkStatus = document.getElementById('link-status');
const linkDownloadBtn = document.getElementById('link-download-btn');
const linkCancelBtn = document.getElementById('link-cancel-btn');
const healthBarEl = document.getElementById('health-bar');
const gameScreenEl = document.getElementById('screen-game');
const backBtn = document.getElementById('back-btn');
const pauseOverlayEl = document.getElementById('pause-overlay');
const resumeBtn = document.getElementById('resume-btn');
const pauseQuitBtn = document.getElementById('pause-quit-btn');

// ---------- Local high scores (per song + difficulty, saved in localStorage) ----------
const HS_PREFIX = 'arrowbeat-hs::';
function songKey(song) {
  return song.id || song.file || song.title || 'unknown-song';
}
function getHighScore(song, diff) {
  try {
    const raw = localStorage.getItem(HS_PREFIX + songKey(song) + '::' + diff);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function setHighScore(song, diff, data) {
  try { localStorage.setItem(HS_PREFIX + songKey(song) + '::' + diff, JSON.stringify(data)); } catch (e) {}
}
function getBestScoreAnyDifficulty(song) {
  let best = null;
  for (const d of ['easy', 'normal', 'hard']) {
    const hs = getHighScore(song, d);
    if (hs && (!best || hs.score > best.score)) best = hs;
  }
  return best;
}

// ---------- State ----------
let manifest = [];
let selectedSong = null;
let difficulty = 'normal';

let audioCtx = null;
let currentBuffer = null;
let currentSource = null;
let songStartCtxTime = 0; // audioCtx.currentTime when playback began
let chart = null;

let notes = []; // { time, lane, judged, hitTime }
let score = 0;
let combo = 0;
let maxCombo = 0;
let health = 50;
const judgeCounts = { sick: 0, good: 0, bad: 0, miss: 0 };
let judgedTotal = 0;
let rafId = null;
let popups = []; // floating judgement text {lane, text, color, life}
let gameOver = false;
let songDuration = 0;
let comboPulse = 0; // brief visual pulse on the combo HUD value
let scorePulse = 0; // brief visual pulse on the score HUD value

const activeHolds = [null, null, null, null]; // note currently being held per lane
let fxParticles = []; // {x,y,vx,vy,life,maxLife,color,size}
let fxRings = []; // {x,y,r,maxR,life,maxLife,color}
let shake = 0; // screen-shake magnitude, decays each frame
let paused = false;

// Full-screen ambient VFX driven by gameplay events (see initBackgroundFx
// below) — pulses expanding from center of the whole viewport, plus a
// combo "heat" value that tints and speeds up the ambient particles.
let bgPulses = []; // {r, maxR, life, maxLife, color}
let comboHeat = 0; // 0..1, rises with combo, cools off over time
function spawnBgPulse(color, strength = 1) {
  bgPulses.push({ r: 40, maxR: 0, life: 1, maxLife: 1, color, strength });
}

// ---------- Screen switching ----------
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ---------- Load manifest (built-in songs + persisted uploads) ----------
async function loadManifest() {
  let builtIn = [];
  try {
    const res = await fetch('songs/songs.json', { cache: 'no-store' });
    builtIn = await res.json();
  } catch (e) {
    builtIn = [{ title: 'Neon Circuit', builtin: 'demo' }];
  }
  builtIn.forEach(song => {
    if (!song.title) song.title = song.file ? titleFromFilename(song.file) : 'Untitled';
  });

  let persisted = [];
  try {
    const rows = await idbGetAllSongs();
    persisted = rows
      .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
      .map(row => ({
        title: row.title,
        blobFile: row.blob,
        persisted: true,
        id: row.id
      }));
  } catch (e) {
    console.warn('IndexedDB unavailable — uploaded songs will not be saved.', e);
  }

  manifest = [...builtIn, ...persisted];
  renderSongList();
}

function renderSongList() {
  songListEl.innerHTML = '';

  if (manifest.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'song-list-empty';
    empty.textContent = 'No songs yet — upload a track to get started.';
    songListEl.appendChild(empty);
    return;
  }

  manifest.forEach((song) => {
    const card = document.createElement('div');
    card.className = 'song-card';
    if (song === selectedSong) card.classList.add('selected');

    const tag = song.builtin
      ? '<span class="song-tag tag-demo">Demo</span>'
      : song.persisted
        ? '<span class="song-tag tag-saved">Saved</span>'
        : '<span class="song-tag tag-auto">Auto</span>';

    const best = getBestScoreAnyDifficulty(song);
    const bestLine = best ? `<div class="song-best">Best: ${best.score}</div>` : '';

    card.innerHTML = `
      <div class="song-card-icon"><svg viewBox="0 0 24 24"><path d="M9 18V6l11-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zm11-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="song-card-body">
        <div class="song-title">${escapeHtml(song.title)}</div>
        ${bestLine}
      </div>
      ${tag}
      ${song.persisted ? '<button class="song-delete" type="button" title="Remove song" aria-label="Remove song">&times;</button>' : ''}
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.song-delete')) return;
      document.querySelectorAll('.song-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedSong = song;
      playBtn.disabled = false;
    });

    const delBtn = card.querySelector('.song-delete');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await idbDeleteSong(song.id); } catch (err) { console.warn(err); }
        manifest = manifest.filter(s => s !== song);
        if (selectedSong === song) {
          selectedSong = null;
          playBtn.disabled = true;
        }
        renderSongList();
      });
    }

    songListEl.appendChild(card);
  });
}

function titleFromFilename(name) {
  return name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim() || name;
}

async function addSongFromFile(file) {
  const id = makeSongId();
  const title = titleFromFilename(file.name);
  const song = { title, blobFile: file, persisted: true, id };
  manifest.push(song);
  renderSongList();
  try {
    await idbPutSong({ id, title, blob: file, addedAt: Date.now() });
  } catch (e) {
    console.warn('Could not save song to IndexedDB — it will be lost on reload.', e);
  }
}

uploadInput.addEventListener('change', async () => {
  const files = Array.from(uploadInput.files || []);
  uploadInput.value = '';
  if (files.length === 0) return;
  for (const file of files) await addSongFromFile(file);
});

// ---------- Upload menu (choose from computer / paste link) ----------
function closeUploadMenu() {
  uploadMenu.classList.add('hidden');
}

uploadBtn.addEventListener('click', e => {
  e.stopPropagation();
  uploadMenu.classList.toggle('hidden');
});

document.addEventListener('click', e => {
  if (!uploadMenu.classList.contains('hidden') && !uploadMenu.contains(e.target) && e.target !== uploadBtn) {
    closeUploadMenu();
  }
});

optChooseFile.addEventListener('click', () => {
  closeUploadMenu();
  uploadInput.click();
});

optPasteLink.addEventListener('click', () => {
  closeUploadMenu();
  linkInput.value = '';
  setLinkStatus('', '');
  linkOverlay.classList.remove('hidden');
  linkInput.focus();
});

// ---------- Paste link: fetch a direct audio URL and add it as a song ----------
function setLinkStatus(msg, kind) {
  linkStatus.textContent = msg;
  linkStatus.classList.remove('is-error', 'is-ok');
  if (kind) linkStatus.classList.add(kind === 'error' ? 'is-error' : 'is-ok');
}

function closeLinkOverlay() {
  linkOverlay.classList.add('hidden');
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last || 'track';
  } catch {
    return 'track';
  }
}

async function downloadFromLink() {
  const url = linkInput.value.trim();
  if (!url) {
    setLinkStatus('Paste a link first.', 'error');
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad protocol');
  } catch {
    setLinkStatus('That doesn\'t look like a valid URL.', 'error');
    return;
  }

  linkDownloadBtn.disabled = true;
  setLinkStatus('Downloading…', '');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Server responded with ' + res.status);
    const blob = await res.blob();
    if (blob.size === 0) throw new Error('Downloaded file is empty');
    const name = filenameFromUrl(url);
    const file = new File([blob], /\.[a-z0-9]+$/i.test(name) ? name : name + '.mp3', {
      type: blob.type || 'audio/mpeg'
    });
    await addSongFromFile(file);
    setLinkStatus('Added "' + titleFromFilename(file.name) + '" to your library!', 'ok');
    setTimeout(closeLinkOverlay, 900);
  } catch (e) {
    console.warn('Link download failed:', e);
    setLinkStatus('Could not download that link. The site may block direct downloads (CORS), or the URL isn\'t a direct audio file.', 'error');
  } finally {
    linkDownloadBtn.disabled = false;
  }
}

linkDownloadBtn.addEventListener('click', downloadFromLink);
linkCancelBtn.addEventListener('click', closeLinkOverlay);
linkInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') downloadFromLink();
  if (e.key === 'Escape') closeLinkOverlay();
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}

diffRow.addEventListener('click', e => {
  const btn = e.target.closest('.diff-btn');
  if (!btn) return;
  difficulty = btn.dataset.diff;
  document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
});

playBtn.addEventListener('click', () => {
  if (selectedSong) startSong(selectedSong);
});

backBtn.addEventListener('click', () => {
  showScreen('select');
  renderSongList();
});

// ---------- Loading + charting ----------
async function startSong(song) {
  showScreen('loading');
  loadingMsg.textContent = 'Loading track…';

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  let buffer;
  try {
    if (song.builtin === 'demo') {
      loadingMsg.textContent = 'Synthesizing demo track…';
      buffer = await synthDemoTrack(audioCtx);
    } else if (song.blobFile) {
      const arrayBuf = await song.blobFile.arrayBuffer();
      buffer = await audioCtx.decodeAudioData(arrayBuf);
    } else {
      const res = await fetch('songs/' + song.file);
      const arrayBuf = await res.arrayBuffer();
      buffer = await audioCtx.decodeAudioData(arrayBuf);
    }
  } catch (err) {
    loadingMsg.textContent = 'Could not load that song. Try a different audio file.';
    console.error(err);
    return;
  }

  currentBuffer = buffer;
  songDuration = buffer.duration;

  chart = await generateChart(buffer, difficulty, msg => { loadingMsg.textContent = msg; });

  beginPlay(song);
}

// ---------- Gameplay setup ----------
function beginPlay(song) {
  notes = chart.notes.map(n => ({
    ...n,
    judged: null,
    hold: n.hold || 0,
    holdEnd: n.time + (n.hold || 0),
    holdComplete: false,
    holdBroken: false,
    lastTickTime: null
  }));
  score = 0; combo = 0; maxCombo = 0; health = 50; gameOver = false;
  comboPulse = 0; scorePulse = 0;
  judgeCounts.sick = 0; judgeCounts.good = 0; judgeCounts.bad = 0; judgeCounts.miss = 0;
  judgedTotal = 0;
  popups = [];
  fxParticles = [];
  fxRings = [];
  shake = 0;
  paused = false;
  bgPulses = [];
  comboHeat = 0;
  pauseOverlayEl.classList.add('hidden');
  activeHolds[0] = activeHolds[1] = activeHolds[2] = activeHolds[3] = null;

  scoreValueEl.textContent = '0';
  comboValueEl.textContent = '0';
  accuracyValueEl.textContent = '100%';
  timeValueEl.textContent = formatTime(chart.duration);
  healthBarEl.style.width = '50%';
  healthBarEl.classList.remove('health-critical');

  showScreen('game');

  currentSource = audioCtx.createBufferSource();
  currentSource.buffer = currentBuffer;
  currentSource.connect(audioCtx.destination);
  const lead = 0.6;
  songStartCtxTime = audioCtx.currentTime + lead;
  currentSource.start(songStartCtxTime);
  currentSource.onended = () => {
    if (!gameOver) endSong(song);
  };

  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

function currentSongTime() {
  return audioCtx.currentTime - songStartCtxTime;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

// ---------- Input ----------
const heldKeys = new Set();
window.addEventListener('keydown', e => {
  if (e.code === 'Escape' && !screens.game.classList.contains('hidden')) {
    e.preventDefault();
    if (paused) {
      quitToSelect();
    } else if (!gameOver) {
      openPause();
    }
    return;
  }
  if (paused) return; // gameplay input is ignored while paused
  if (!(e.key in KEY_TO_LANE)) return;
  if (heldKeys.has(e.key)) return; // ignore key-repeat
  heldKeys.add(e.key);
  if (screens.game.classList.contains('hidden')) return;
  e.preventDefault();
  handleHit(KEY_TO_LANE[e.key]);
});
window.addEventListener('keyup', e => {
  heldKeys.delete(e.key);
  const lane = KEY_TO_LANE[e.key];
  if (lane === undefined || gameOver || paused) return;
  const note = activeHolds[lane];
  if (note && currentSongTime() < note.holdEnd - HOLD_RELEASE_GRACE) {
    breakHold(note, lane);
  }
});

// ---------- Pause menu ----------
function openPause() {
  if (paused || gameOver) return;
  paused = true;
  if (audioCtx && audioCtx.state === 'running') audioCtx.suspend();
  pauseOverlayEl.classList.remove('hidden');
}

function closePause() {
  if (!paused) return;
  paused = false;
  pauseOverlayEl.classList.add('hidden');
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

resumeBtn.addEventListener('click', closePause);
pauseQuitBtn.addEventListener('click', quitToSelect);

function quitToSelect() {
  gameOver = true;
  paused = false;
  shake = 0;
  if (appEl) appEl.style.transform = '';
  pauseOverlayEl.classList.add('hidden');
  cancelAnimationFrame(rafId);
  try { currentSource && currentSource.stop(); } catch (e) {}
  showScreen('select');
  renderSongList(); // refresh in case a new high score was just set
}

function handleHit(lane) {
  const t = currentSongTime();
  // find nearest unjudged note in this lane within the miss window
  let best = null;
  let bestDiff = Infinity;
  for (const n of notes) {
    if (n.judged || n.lane !== lane) continue;
    const diff = Math.abs(n.time - t);
    if (diff < bestDiff) { bestDiff = diff; best = n; }
  }
  if (best && bestDiff <= HIT_WINDOWS.bad) {
    let judgement;
    if (bestDiff <= HIT_WINDOWS.sick) judgement = 'sick';
    else if (bestDiff <= HIT_WINDOWS.good) judgement = 'good';
    else judgement = 'bad';
    applyJudgement(best, judgement, lane);
    if (best.hold > 0) {
      activeHolds[lane] = best;
      best.lastTickTime = t;
    }
  } else {
    // pressed a key with no note there to hit — a "ghost tap" miss
    ghostMiss(lane);
  }
  // small tap flash even on a whiff, purely cosmetic
  flashLane(lane, best && bestDiff <= HIT_WINDOWS.bad);
}

// A key press with no note in range: breaks combo but doesn't count
// against health/accuracy — it's a slip, not a missed note.
function ghostMiss(lane) {
  combo = 0;
  comboHeat = 0;
  comboValueEl.textContent = combo;
  addPopup(lane, 'miss', 'MISS');
  burstParticles(lane, JUDGE_COLOR.miss, 6);
  shake = Math.min(1, shake + 0.2);
}

function applyJudgement(note, judgement, lane) {
  note.judged = judgement;
  judgedTotal++;
  judgeCounts[judgement]++;
  const scoreBefore = score;
  score += JUDGE_SCORE[judgement] * (judgement === 'miss' ? 1 : Math.min(1 + combo * 0.002, 1.5));
  score = Math.round(score);
  const gained = score - scoreBefore;
  if (judgement === 'miss' || judgement === 'bad') combo = judgement === 'miss' ? 0 : combo;
  if (judgement === 'sick' || judgement === 'good') combo++;
  if (judgement === 'miss') combo = 0;
  maxCombo = Math.max(maxCombo, combo);
  health = Math.max(0, Math.min(100, health + JUDGE_HEALTH[judgement]));

  scoreValueEl.textContent = score;
  scorePulse = 1;
  comboValueEl.textContent = combo;
  comboPulse = 1;
  healthBarEl.style.width = health + '%';
  healthBarEl.classList.toggle('health-critical', health <= 20);
  const liveAcc = judgedTotal > 0
    ? ((judgeCounts.sick + judgeCounts.good * 0.7 + judgeCounts.bad * 0.3) / judgedTotal) * 100
    : 100;
  accuracyValueEl.textContent = liveAcc.toFixed(1) + '%';

  addPopup(lane, judgement, null, null, judgement === 'miss' ? null : gained);
  burstParticles(lane, JUDGE_COLOR[judgement], judgement === 'sick' ? 22 : judgement === 'good' ? 13 : judgement === 'bad' ? 7 : 5);
  spawnRing(lane, JUDGE_COLOR[judgement], judgement === 'sick' ? 1.4 : 1.0);
  if (judgement === 'sick') { shake = Math.min(1, shake + 0.35); spawnBgPulse(JUDGE_COLOR.sick, 1); comboHeat = Math.min(1, comboHeat + 0.06); }
  if (judgement === 'good') comboHeat = Math.min(1, comboHeat + 0.03);
  if (judgement === 'bad') comboHeat = Math.max(0, comboHeat - 0.08);
  if (judgement === 'miss') { shake = Math.min(1, shake + 0.5); spawnBgPulse(JUDGE_COLOR.miss, 1.3); comboHeat = 0; }

  if (combo > 0 && combo % 10 === 0 && (judgement === 'sick' || judgement === 'good')) {
    addPopup(lane, judgement, `${combo}x COMBO!`, '#ffffff');
    for (let l = 0; l < 4; l++) spawnRing(l, LANE_COLORS[l], 1.6);
    spawnBgPulse('#ffffff', 1.6);
  }

  if (health <= 0 && !gameOver) {
    failSong();
  }
}

function tickHold(note, lane) {
  score += 12 * Math.min(1 + combo * 0.002, 1.5);
  score = Math.round(score);
  health = Math.min(100, health + 0.35);
  scoreValueEl.textContent = score;
  scorePulse = Math.max(scorePulse, 0.4);
  healthBarEl.style.width = health + '%';
  spawnHoldSparkle(lane);
}

function completeHold(note, lane) {
  activeHolds[lane] = null;
  note.holdComplete = true;
  score += 80;
  combo++;
  maxCombo = Math.max(maxCombo, combo);
  scoreValueEl.textContent = score;
  scorePulse = 1;
  comboValueEl.textContent = combo;
  comboPulse = 1;
  addPopup(lane, 'sick', 'HELD!');
  burstParticles(lane, JUDGE_COLOR.sick, 18);
  spawnRing(lane, JUDGE_COLOR.sick, 1.3);
  spawnBgPulse(JUDGE_COLOR.sick, 1.1);
  comboHeat = Math.min(1, comboHeat + 0.05);
}

function breakHold(note, lane) {
  if (activeHolds[lane] !== note) return;
  activeHolds[lane] = null;
  note.holdBroken = true;
  combo = 0;
  health = Math.max(0, health - 4);
  comboValueEl.textContent = combo;
  healthBarEl.style.width = health + '%';
  healthBarEl.classList.toggle('health-critical', health <= 20);
  addPopup(lane, 'bad', 'RELEASED');
  comboHeat = 0;
  if (health <= 0 && !gameOver) failSong();
}

function addPopup(lane, judgement, textOverride, colorOverride, scoreDelta) {
  popups.push({
    lane,
    text: textOverride || judgement.toUpperCase(),
    color: colorOverride || JUDGE_COLOR[judgement],
    scoreText: (scoreDelta != null) ? (scoreDelta >= 0 ? '+' : '') + scoreDelta : null,
    life: 30,
    maxLife: 30
  });
}

// ---------- Particle / ring VFX ----------
function burstParticles(lane, color, count) {
  const x = laneX(lane);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 70 + Math.random() * 170;
    fxParticles.push({
      x, y: HIT_LINE_Y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 60,
      life: 1, maxLife: 1,
      color,
      size: 2 + Math.random() * 3
    });
  }
}

function spawnHoldSparkle(lane) {
  const x = laneX(lane) + (Math.random() - 0.5) * 24;
  fxParticles.push({
    x, y: HIT_LINE_Y - Math.random() * 8,
    vx: (Math.random() - 0.5) * 50,
    vy: -70 - Math.random() * 50,
    life: 0.55, maxLife: 0.55,
    color: LANE_COLORS[lane],
    size: 1.5 + Math.random() * 2
  });
}

function spawnNoteTrail(lane, y) {
  const x = laneX(lane) + (Math.random() - 0.5) * 14;
  fxParticles.push({
    x, y,
    vx: (Math.random() - 0.5) * 12,
    vy: 20 + Math.random() * 20,
    life: 0.35, maxLife: 0.35,
    color: LANE_COLORS[lane],
    size: 1 + Math.random() * 1.4
  });
}

function spawnRing(lane, color, scale = 1) {
  fxRings.push({
    x: laneX(lane), y: HIT_LINE_Y,
    r: NOTE_R * 0.6,
    maxR: NOTE_R * (2.2 * scale),
    life: 1, maxLife: 1,
    color
  });
}

const laneFlashes = [0, 0, 0, 0];
function flashLane(lane, hit) {
  laneFlashes[lane] = hit ? 1 : 0.5;
}

const appEl = document.getElementById('app');
function applyScreenShake() {
  if (!appEl) return;
  if (shake > 0.02) {
    const mag = shake * 6;
    appEl.style.transform = `translate(${(Math.random() - 0.5) * mag}px, ${(Math.random() - 0.5) * mag}px)`;
  } else {
    appEl.style.transform = '';
  }
}

// ---------- Main loop ----------
function loop() {
  if (gameOver) return;
  if (paused) { rafId = requestAnimationFrame(loop); return; }
  const t = currentSongTime();

  // auto-miss notes that passed the window unjudged
  for (const n of notes) {
    if (!n.judged && t - n.time > MISS_WINDOW) {
      applyJudgement(n, 'miss', n.lane);
    }
  }

  // advance any in-progress hold notes: tick score/health while held,
  // complete on reaching the end, or break if the key isn't down.
  for (let lane = 0; lane < 4; lane++) {
    const note = activeHolds[lane];
    if (!note) continue;
    if (t >= note.holdEnd) {
      completeHold(note, lane);
      continue;
    }
    const stillHeld = LANE_KEYS[lane].some(k => heldKeys.has(k));
    if (!stillHeld) {
      breakHold(note, lane);
      continue;
    }
    if (note.lastTickTime == null || t - note.lastTickTime >= HOLD_TICK_INTERVAL) {
      note.lastTickTime = t;
      tickHold(note, lane);
    }
  }

  // faint trailing sparkles behind notes as they approach the hit line
  const approachWindow = HIT_LINE_Y / SCROLL_SPEED;
  for (const n of notes) {
    if (n.judged) continue;
    const dt = n.time - t;
    if (dt > 0 && dt < approachWindow * 0.85 && Math.random() < 0.18) {
      spawnNoteTrail(n.lane, HIT_LINE_Y - dt * SCROLL_SPEED);
    }
  }

  draw(t);
  timeValueEl.textContent = formatTime(songDuration - t);

  for (let i = 0; i < laneFlashes.length; i++) {
    laneFlashes[i] = Math.max(0, laneFlashes[i] - 0.06);
  }
  popups.forEach(p => p.life--);
  popups = popups.filter(p => p.life > 0);
  comboPulse = Math.max(0, comboPulse - 0.08);
  comboValueEl.style.transform = `scale(${1 + comboPulse * 0.25})`;
  scorePulse = Math.max(0, scorePulse - 0.08);
  scoreValueEl.style.transform = `scale(${1 + scorePulse * 0.18})`;
  scoreValueEl.style.textShadow = scorePulse > 0.05 ? `0 0 ${scorePulse * 14}px #ffd23f` : '';

  for (const p of fxParticles) {
    p.life -= 0.028;
    p.x += p.vx * 0.016;
    p.y += p.vy * 0.016;
    p.vy += 200 * 0.016; // gravity
  }
  fxParticles = fxParticles.filter(p => p.life > 0);

  for (const r of fxRings) {
    r.life -= 0.06;
    r.r += (r.maxR - r.r) * 0.25;
  }
  fxRings = fxRings.filter(r => r.life > 0);

  shake = Math.max(0, shake - 0.06);
  comboHeat = Math.max(0, comboHeat - 0.004);
  applyScreenShake();

  if (t > songDuration + 1.2 && !gameOver) {
    endSong(selectedSong);
    return;
  }

  rafId = requestAnimationFrame(loop);
}

function laneX(lane) {
  return HIGHWAY_MARGIN + lane * (LANE_W + LANE_GAP) + LANE_W / 2;
}

function draw(t) {
  ctx.clearRect(0, 0, HIGHWAY_W, HIGHWAY_H);

  ctx.save();
  if (shake > 0.001) {
    const mag = shake * 8;
    ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
  }

  // lane backgrounds, alternating tint + subtle color wash per lane
  for (let lane = 0; lane < 4; lane++) {
    const x = HIGHWAY_MARGIN + lane * (LANE_W + LANE_GAP);
    ctx.fillStyle = lane % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.012)';
    ctx.fillRect(x, 0, LANE_W, HIGHWAY_H);
    const grad = ctx.createLinearGradient(0, 0, 0, HIGHWAY_H);
    grad.addColorStop(0, hexToRgba(LANE_COLORS[lane], 0));
    grad.addColorStop(1, hexToRgba(LANE_COLORS[lane], 0.05));
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, LANE_W, HIGHWAY_H);

    // full-column flash that lights up on every hit, brightest near the
    // receptor and fading toward the top of the highway
    const glow = laneFlashes[lane];
    if (glow > 0.01) {
      const flashGrad = ctx.createLinearGradient(0, HIGHWAY_H, 0, 0);
      flashGrad.addColorStop(0, hexToRgba(LANE_COLORS[lane], glow * 0.32));
      flashGrad.addColorStop(1, hexToRgba(LANE_COLORS[lane], 0));
      ctx.fillStyle = flashGrad;
      ctx.fillRect(x, 0, LANE_W, HIGHWAY_H);
    }
  }

  // receptor ring at hit line
  for (let lane = 0; lane < 4; lane++) {
    const x = laneX(lane);
    const glow = laneFlashes[lane];
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, HIT_LINE_Y, NOTE_R + 4, 0, Math.PI * 2);
    ctx.strokeStyle = LANE_COLORS[lane];
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.55 + glow * 0.45;
    ctx.stroke();
    if (glow > 0) {
      ctx.beginPath();
      ctx.arc(x, HIT_LINE_Y, NOTE_R + 4 + glow * 10, 0, Math.PI * 2);
      ctx.globalAlpha = glow * 0.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(x, HIT_LINE_Y, NOTE_R - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.95;
    drawChevron(x, HIT_LINE_Y, lane, NOTE_R * 0.62, LANE_COLORS[lane], 'rgba(255,255,255,0.9)');
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // falling notes, with a soft trailing glow
  const leadTime = HIT_LINE_Y / SCROLL_SPEED;
  for (const n of notes) {
    const dt = n.time - t;
    const beingHeld = activeHolds[n.lane] === n;
    const x = laneX(n.lane);

    // hold-note tail: a glowing bar from the head out to the hold's end,
    // consumed into the receptor as the player holds through it.
    if (n.hold > 0 && !n.holdBroken) {
      const dtTail = n.holdEnd - t;
      if (dtTail > -0.2 && (dt < leadTime + 0.2 || beingHeld)) {
        const yHead = HIT_LINE_Y - dt * SCROLL_SPEED;
        const yTail = HIT_LINE_Y - dtTail * SCROLL_SPEED;
        const bottom = (n.judged && !n.holdComplete) ? HIT_LINE_Y : yHead;
        const top = Math.min(yTail, bottom);
        const height = Math.max(2, Math.abs(bottom - yTail));
        if (top < HIGHWAY_H + NOTE_R && top + height > -NOTE_R) {
          ctx.save();
          const barW = NOTE_R * 0.62;
          const grad2 = ctx.createLinearGradient(0, top, 0, top + height);
          const a1 = beingHeld ? 0.9 : n.judged ? 0.12 : 0.55;
          const a2 = beingHeld ? 0.45 : n.judged ? 0.05 : 0.22;
          grad2.addColorStop(0, hexToRgba(LANE_COLORS[n.lane], a1));
          grad2.addColorStop(1, hexToRgba(LANE_COLORS[n.lane], a2));
          ctx.fillStyle = grad2;
          roundRect(ctx, x - barW / 2, top, barW, height, barW / 2);
          ctx.fill();
          if (beingHeld) {
            ctx.globalAlpha = 0.5 + Math.sin(t * 18) * 0.25;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            roundRect(ctx, x - barW / 2, top, barW, height, barW / 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          ctx.restore();
        }
      }
    }

    if (dt < -0.3 || dt > leadTime + 0.2) continue;
    if (n.judged && n.judged !== null && dt < 0 && !beingHeld) continue; // already hit, don't draw past line
    const y = beingHeld ? HIT_LINE_Y : HIT_LINE_Y - dt * SCROLL_SPEED;
    if (y < -NOTE_R || y > HIGHWAY_H + NOTE_R) continue;

    if (!n.judged || beingHeld) {
      ctx.save();
      ctx.globalAlpha = beingHeld ? 0.55 : 0.35;
      ctx.fillStyle = LANE_COLORS[n.lane];
      ctx.beginPath();
      ctx.arc(x, y, NOTE_R * (beingHeld ? 1.55 : 1.35), 0, Math.PI * 2);
      ctx.filter = 'blur(6px)';
      ctx.fill();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(x, y, NOTE_R, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(x - 6, y - 6, 2, x, y, NOTE_R);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.25, LANE_COLORS[n.lane]);
    grad.addColorStop(1, shade(LANE_COLORS[n.lane], -30));
    ctx.fillStyle = (n.judged && !beingHeld) ? 'rgba(255,255,255,0.08)' : grad;
    ctx.fill();
    if (!n.judged || beingHeld) {
      ctx.lineWidth = beingHeld ? 3 : 2.5;
      ctx.strokeStyle = beingHeld ? '#ffffff' : 'rgba(255,255,255,0.65)';
      ctx.stroke();
      drawChevron(x, y, n.lane, NOTE_R * 0.5, 'rgba(0,0,0,0.55)', null);
    }
  }

  // particle FX (hit bursts, hold sparkles)
  for (const p of fxParticles) {
    const a = Math.max(0, p.life / p.maxLife);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6) + 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // expanding ring bursts on hit
  for (const r of fxRings) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, r.life / r.maxLife) * 0.8;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // judgement popups
  popups.forEach(p => {
    const x = laneX(p.lane);
    const alpha = p.life / p.maxLife;
    const riseY = HIT_LINE_Y - 60 - (p.maxLife - p.life);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.font = '900 19px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 6;
    ctx.fillText(p.text, x, riseY);
    if (p.scoreText) {
      ctx.font = '700 13px "Segoe UI", sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(p.scoreText, x, riseY + 16);
    }
    ctx.restore();
  });

  ctx.restore(); // matches the shake save() at the top of draw()
}

// Rounded rectangle helper (used for hold-note tails) — implemented
// manually rather than relying on ctx.roundRect for broader support.
function roundRect(c, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, Math.max(h / 2, 0.01));
  c.beginPath();
  c.moveTo(x + rad, y);
  c.arcTo(x + w, y, x + w, y + h, rad);
  c.arcTo(x + w, y + h, x, y + h, rad);
  c.arcTo(x, y + h, x, y, rad);
  c.arcTo(x, y, x + w, y, rad);
  c.closePath();
}

// Draws a bold chevron ("arrowhead") pointing left/down/up/right, centered
// at (x, y) with the given half-size. Much clearer at small sizes and
// across fonts/browsers than a text glyph.
const LANE_ANGLE = [Math.PI, Math.PI / 2, -Math.PI / 2, 0]; // left, down, up, right
function drawChevron(x, y, lane, size, fillColor, strokeColor) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(LANE_ANGLE[lane]);
  // simple bold arrow: a triangle tip plus a stubby tail, pointing "right"
  // before rotation (rotation above aims it the correct direction per lane)
  ctx.beginPath();
  ctx.moveTo(size * 1.05, 0);
  ctx.lineTo(size * 0.15, size * 0.85);
  ctx.lineTo(size * 0.15, size * 0.35);
  ctx.lineTo(-size * 0.9, size * 0.35);
  ctx.lineTo(-size * 0.9, -size * 0.35);
  ctx.lineTo(size * 0.15, -size * 0.35);
  ctx.lineTo(size * 0.15, -size * 0.85);
  ctx.closePath();
  if (fillColor) { ctx.fillStyle = fillColor; ctx.fill(); }
  if (strokeColor) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = strokeColor;
    ctx.stroke();
  }
  ctx.restore();
}

function shade(hex, percent) {
  const num = parseInt(hex.slice(1), 16);
  let r = (num >> 16) + percent;
  let g = ((num >> 8) & 0x00ff) + percent;
  let b = (num & 0x0000ff) + percent;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `rgb(${r},${g},${b})`;
}

function hexToRgba(hex, alpha) {
  const num = parseInt(hex.slice(1), 16);
  const r = (num >> 16) & 0xff, g = (num >> 8) & 0xff, b = num & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------- End states ----------
function failSong() {
  gameOver = true;
  shake = 0;
  if (appEl) appEl.style.transform = '';
  cancelAnimationFrame(rafId);
  try { currentSource && currentSource.stop(); } catch (e) {}
  showResults(selectedSong, true);
}

function endSong(song) {
  gameOver = true;
  shake = 0;
  if (appEl) appEl.style.transform = '';
  cancelAnimationFrame(rafId);
  showResults(song, false);
}

function showResults(song, failed) {
  const acc = judgedTotal > 0
    ? ((judgeCounts.sick + judgeCounts.good * 0.7 + judgeCounts.bad * 0.3) / judgedTotal) * 100
    : 0;
  document.getElementById('results-song-title').textContent = failed
    ? `${song.title} — Failed`
    : `${song.title} — Complete`;
  document.getElementById('res-score').textContent = score;
  document.getElementById('res-combo').textContent = maxCombo;
  document.getElementById('res-acc').textContent = acc.toFixed(1) + '%';
  document.getElementById('res-judge').textContent =
    `${judgeCounts.sick} / ${judgeCounts.good} / ${judgeCounts.bad} / ${judgeCounts.miss}`;

  let grade = 'D';
  if (failed) grade = 'F';
  else if (acc >= 97) grade = 'S';
  else if (acc >= 90) grade = 'A';
  else if (acc >= 80) grade = 'B';
  else if (acc >= 65) grade = 'C';
  const gradeEl = document.getElementById('results-grade');
  gradeEl.textContent = grade;
  gradeEl.className = 'grade grade-' + grade.toLowerCase();

  // Local high score for this song + difficulty — only a completed
  // (non-failed) run can set a new best.
  const bestRowEl = document.getElementById('res-best-row');
  const bestValEl = document.getElementById('res-best');
  const prevBest = getHighScore(song, difficulty);
  let isNewBest = false;
  if (!failed && (!prevBest || score > prevBest.score)) {
    isNewBest = true;
    setHighScore(song, difficulty, { score, combo: maxCombo, acc: acc, grade, date: Date.now() });
  }
  const bestNow = getHighScore(song, difficulty) || prevBest;
  bestRowEl.classList.toggle('new-best', isNewBest);
  bestValEl.textContent = (bestNow ? bestNow.score : score) + (isNewBest ? ' — NEW BEST!' : '');

  showScreen('results');
  if (!failed && (grade === 'S' || grade === 'A')) spawnConfetti(grade === 'S' ? 70 : 40);
}

function spawnConfetti(count) {
  const colors = LANE_COLORS.concat(['#ffd23f', '#ffffff']);
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + 'vw';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = (2 + Math.random() * 1.5) + 's';
    piece.style.animationDelay = (Math.random() * 0.4) + 's';
    document.body.appendChild(piece);
    piece.addEventListener('animationend', () => piece.remove());
  }
}

// ---------- Ambient background fx (song-select / loading / results only) ----------
(function initBackgroundFx() {
  const bgCanvas = document.getElementById('bg-fx');
  if (!bgCanvas) return;
  const bgCtx = bgCanvas.getContext('2d');
  let w, h, particles, diag;

  function resize() {
    w = bgCanvas.width = window.innerWidth;
    h = bgCanvas.height = window.innerHeight;
    diag = Math.hypot(w, h);
  }
  function makeParticles() {
    const count = Math.min(70, Math.floor((w * h) / 20000));
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 1 + Math.random() * 2.2,
      vy: 0.15 + Math.random() * 0.35,
      vx: (Math.random() - 0.5) * 0.15,
      color: LANE_COLORS[Math.floor(Math.random() * LANE_COLORS.length)],
      a: 0.15 + Math.random() * 0.35
    }));
  }
  window.addEventListener('resize', () => { resize(); makeParticles(); });
  resize();
  makeParticles();

  function frame() {
    bgCtx.clearRect(0, 0, w, h);
    const inGameplay = !screens.game.classList.contains('hidden');

    // Ambient drifting particles everywhere, all the time — dimmer and
    // tinted warmer as combo heat rises, calmer when idle on a menu.
    const speedMul = inGameplay ? 1 + comboHeat * 1.8 : 1;
    for (const p of particles) {
      p.y -= p.vy * speedMul;
      p.x += p.vx * speedMul;
      if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
      bgCtx.beginPath();
      bgCtx.arc(p.x, p.y, p.r * (inGameplay ? 1 + comboHeat * 0.5 : 1), 0, Math.PI * 2);
      bgCtx.fillStyle = inGameplay && comboHeat > 0.3 ? '#ffd23f' : p.color;
      bgCtx.globalAlpha = inGameplay ? p.a * (0.4 + comboHeat * 0.6) : p.a;
      bgCtx.fill();
    }
    bgCtx.globalAlpha = 1;

    // Full-screen pulse rings triggered by big hits / combo milestones /
    // misses — expands from the center of the viewport and fades out.
    const cx = w / 2, cy = h / 2;
    bgPulses.forEach(p => {
      const maxR = diag * 0.55 * (p.strength || 1);
      p.r += (maxR - p.r) * 0.16;
      p.life -= 0.045;
    });
    bgPulses = bgPulses.filter(p => p.life > 0);
    for (const p of bgPulses) {
      bgCtx.save();
      bgCtx.globalAlpha = Math.max(0, p.life) * 0.35;
      bgCtx.strokeStyle = p.color;
      bgCtx.lineWidth = 10 * Math.max(0, p.life);
      bgCtx.beginPath();
      bgCtx.arc(cx, cy, p.r, 0, Math.PI * 2);
      bgCtx.stroke();
      bgCtx.restore();
    }

    // Low-health warning vignette, pulsing red around the screen edges.
    if (inGameplay && health <= 30) {
      const pulse = 0.35 + Math.sin(performance.now() / 220) * 0.2;
      const vign = bgCtx.createRadialGradient(cx, cy, diag * 0.25, cx, cy, diag * 0.55);
      vign.addColorStop(0, 'rgba(249,57,63,0)');
      vign.addColorStop(1, `rgba(249,57,63,${pulse * (1 - health / 30)})`);
      bgCtx.fillStyle = vign;
      bgCtx.fillRect(0, 0, w, h);
    }

    requestAnimationFrame(frame);
  }
  frame();
})();

// ---------- Init ----------
loadManifest();
showScreen('select');
