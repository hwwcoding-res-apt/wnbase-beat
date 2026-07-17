/*
  chart-generator.js
  ------------------
  Turns any decoded AudioBuffer into a playable 4-lane note chart, entirely
  client-side. No server, no manual charting — drop an mp3 in songs/, add
  one line to songs.json, and this runs automatically.

  How it works:
  1. Isolate the "vocal / lead melody" range of the mix with a bandpass
     filter (~220Hz–4kHz) — this is where sung vocals and lead
     instruments live.
  2. Separately isolate the classic drum-heavy ranges — sub/kick
     (<150Hz) and hats/cymbals (>6kHz) — via OfflineAudioContext biquad
     filters, purely to know when they're firing.
  3. Compute short-window RMS energy envelopes for both, then build a
     "vocal score" envelope that subtracts out drum energy. Moments
     dominated by kick/snare/hats score low even if they're loud;
     moments where the vocal/melody band carries the energy score high.
  4. Peak-pick onsets from that vocal score (adaptive threshold, tuned
     to hit a target notes/sec for the chosen difficulty) — these
     become notes. Pure drum hits with little melodic content mostly
     get filtered out.
  5. Assign lanes using each note's spectral brightness (via zero-
     crossing rate) as a loose guide, plus anti-repeat jitter, so
     patterns track the melody without falling into a mechanical
     left-right-left-right loop.
*/

const DIFFICULTY_TARGET_NPS = {
  easy: 1.4,
  normal: 2.3,
  hard: 3.4
};

// ---------- Deterministic charting ----------
// Charts must always come out identical for the same song + difficulty,
// regardless of where the song sits in the list, upload order, or how
// many times it's played. We derive a seed purely from the decoded
// audio content (plus difficulty), then use a seeded PRNG instead of
// Math.random() anywhere a charting decision is made.

function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// FNV-1a style hash over sampled points of the decoded audio, so the
// seed is a fingerprint of the actual sound rather than anything about
// how/where the song was loaded.
function seedFromBuffer(buffer) {
  const data = buffer.getChannelData(0);
  let hash = 0x811c9dc5;
  const step = Math.max(1, Math.floor(data.length / 8000));
  for (let i = 0; i < data.length; i += step) {
    const v = Math.floor((data[i] + 1) * 4096) & 0xffff;
    hash ^= v;
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= Math.floor(buffer.duration * 1000) >>> 0;
  hash = Math.imul(hash, 0x01000193);
  hash ^= (buffer.numberOfChannels * 2654435761) >>> 0;
  return hash >>> 0;
}

// mulberry32 — small, fast, deterministic PRNG seeded with a 32-bit int.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function filterBand(buffer, stages) {
  // stages: array of {type, freq, Q}, chained in series
  const offlineCtx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
  const src = offlineCtx.createBufferSource();
  src.buffer = buffer;
  let node = src;
  for (const stage of stages) {
    const filter = offlineCtx.createBiquadFilter();
    filter.type = stage.type;
    filter.frequency.value = stage.freq;
    filter.Q.value = stage.Q != null ? stage.Q : 0.7;
    node.connect(filter);
    node = filter;
  }
  node.connect(offlineCtx.destination);
  src.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

function computeEnvelope(data, windowSize) {
  const envelope = new Float32Array(Math.ceil(data.length / windowSize));
  for (let i = 0, w = 0; i < data.length; i += windowSize, w++) {
    let sum = 0;
    const end = Math.min(i + windowSize, data.length);
    for (let j = i; j < end; j++) sum += data[j] * data[j];
    envelope[w] = Math.sqrt(sum / (end - i));
  }
  return envelope;
}

// Normalize an envelope to a comparable 0..1-ish scale using its own
// running average, so bands with different natural loudness (bass vs.
// hats vs. vocals) can be combined/compared fairly.
function normalizeEnvelope(envelope, avgWindowFrames) {
  const out = new Float32Array(envelope.length);
  let runningSum = 0;
  const q = [];
  for (let i = 0; i < envelope.length; i++) {
    q.push(envelope[i]);
    runningSum += envelope[i];
    if (q.length > avgWindowFrames) runningSum -= q.shift();
    const avg = runningSum / q.length || 1e-6;
    out[i] = envelope[i] / avg;
  }
  return out;
}

function pickPeaks(envelope, sampleRate, windowSize, factor, minGapFrames, avgWindowFrames) {
  const peaks = [];
  let lastPeakFrame = -minGapFrames * 2;
  let runningSum = 0;
  const q = [];
  for (let i = 1; i < envelope.length - 1; i++) {
    q.push(envelope[i - 1]);
    runningSum += envelope[i - 1];
    if (q.length > avgWindowFrames) runningSum -= q.shift();
    const avg = runningSum / q.length;
    const threshold = avg * factor + 0.0008;
    const v = envelope[i];
    if (
      v > threshold &&
      v >= envelope[i - 1] &&
      v >= envelope[i + 1] &&
      i - lastPeakFrame >= minGapFrames
    ) {
      peaks.push(i);
      lastPeakFrame = i;
    }
  }
  return peaks.map(i => (i * windowSize) / sampleRate);
}

// Zero-crossing rate around a point in time — a cheap proxy for pitch /
// brightness (higher ZCR ~ brighter / higher-pitched content) used only
// to spread notes across lanes in a way that loosely tracks the melody.
function zcrAt(data, sampleRate, centerTime, windowSec) {
  const center = Math.floor(centerTime * sampleRate);
  const half = Math.floor((windowSec * sampleRate) / 2);
  const start = Math.max(0, center - half);
  const end = Math.min(data.length - 2, center + half);
  if (end <= start) return 0;
  let crossings = 0;
  for (let i = start; i < end; i++) {
    if ((data[i] >= 0) !== (data[i + 1] >= 0)) crossings++;
  }
  return crossings / (end - start);
}

// Turn a list of {time, brightness, hold} onsets into lane-assigned
// notes. Brightness loosely steers which lane a note lands in, but a
// small amount of controlled (seeded, so still deterministic) jitter
// plus anti-repeat rules stop the pattern from turning into a
// mechanical alternation or long streaks.
function assignLanes(onsets, rng) {
  if (onsets.length === 0) return [];
  const bMin = Math.min(...onsets.map(o => o.brightness));
  const bMax = Math.max(...onsets.map(o => o.brightness));
  const range = Math.max(bMax - bMin, 1e-6);

  const history = [];
  const notes = [];
  for (const o of onsets) {
    const norm = (o.brightness - bMin) / range; // 0..1
    // base bucket from brightness, with a little jitter so identical
    // pitches don't always land on the same lane
    let lane = Math.min(3, Math.floor((norm + (rng() - 0.5) * 0.35) * 4));
    lane = Math.max(0, Math.min(3, lane));

    const last = history[history.length - 1];
    const secondLast = history[history.length - 2];
    if (last === lane && secondLast === lane) {
      // never allow a third repeat in a row
      lane = (lane + 1 + Math.floor(rng() * 3)) % 4;
    } else if (last === lane && rng() < 0.65) {
      // usually break up even a single repeat for more movement
      lane = (lane + 1 + Math.floor(rng() * 3)) % 4;
    }

    notes.push({ time: o.time, lane, hold: o.hold || 0 });
    history.push(lane);
    if (history.length > 2) history.shift();
  }
  return notes;
}

// Measures how long the vocal score stays "loud" after a peak — used
// to decide whether an onset should become a held sustain note instead
// of a quick tap. Stops early if the next onset is coming up soon.
function computeSustainSeconds(vocalScore, peakFrame, windowSize, sampleRate, nextPeakFrame) {
  const peakVal = vocalScore[peakFrame] || 0;
  if (peakVal <= 0) return 0;
  const dropThreshold = peakVal * 0.4;
  const maxFrame = nextPeakFrame != null
    ? Math.max(peakFrame, nextPeakFrame - 2)
    : vocalScore.length - 1;
  let frame = peakFrame;
  while (frame < maxFrame && vocalScore[frame] >= dropThreshold) frame++;
  return ((frame - peakFrame) * windowSize) / sampleRate;
}

/**
 * Generate a chart from an AudioBuffer, charting vocals / lead melody
 * only (drums are actively suppressed).
 * Deterministic: the same audio content + difficulty always yields the
 * exact same chart (lane picks, hold notes and all), because charting
 * decisions are driven by a PRNG seeded from the decoded audio itself
 * rather than Math.random(). Where a song sits in the song list, when
 * it's played, or how many times it's charted has no effect.
 * @param {AudioBuffer} buffer
 * @param {'easy'|'normal'|'hard'} difficulty
 * @param {(msg:string)=>void} onProgress optional progress callback
 * @returns {Promise<{notes: {time:number, lane:number, hold:number}[], duration:number}>}
 *   `hold` is the sustain length in seconds (0 for an ordinary tap note).
 */
async function generateChart(buffer, difficulty = 'normal', onProgress = () => {}) {
  const windowSize = 1024; // ~23ms at 44.1kHz
  const minGapFrames = 7; // ~160ms minimum spacing between notes
  const avgWindowFrames = 45; // ~1s adaptive baseline

  // Seed is a fingerprint of the audio content itself (+ difficulty),
  // so the same song always produces the same chart no matter when,
  // where, or how many times it's charted.
  const rng = mulberry32(seedFromBuffer(buffer) ^ hashString(difficulty));

  onProgress('Isolating vocals / lead melody…');
  const [vocalData, kickData, hatData] = await Promise.all([
    filterBand(buffer, [{ type: 'highpass', freq: 220, Q: 0.7 }, { type: 'lowpass', freq: 4000, Q: 0.7 }]),
    filterBand(buffer, [{ type: 'lowpass', freq: 150, Q: 0.7 }]),
    filterBand(buffer, [{ type: 'highpass', freq: 6000, Q: 0.7 }])
  ]);

  onProgress('Filtering out drums…');
  const vocalEnvRaw = computeEnvelope(vocalData, windowSize);
  const kickEnvRaw = computeEnvelope(kickData, windowSize);
  const hatEnvRaw = computeEnvelope(hatData, windowSize);

  const vocalEnv = normalizeEnvelope(vocalEnvRaw, avgWindowFrames);
  const kickEnv = normalizeEnvelope(kickEnvRaw, avgWindowFrames);
  const hatEnv = normalizeEnvelope(hatEnvRaw, avgWindowFrames);

  // Vocal score: reward mid-band energy, penalize frames where the
  // kick or hat bands are spiking (i.e. it's a drum hit, not a vocal).
  const len = vocalEnv.length;
  const vocalScore = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const drumPressure = Math.max(kickEnv[i] - 1, 0) + Math.max(hatEnv[i] - 1, 0);
    vocalScore[i] = Math.max(0, vocalEnv[i] - drumPressure * 0.85);
  }

  onProgress('Detecting melody onsets…');
  const targetNPS = DIFFICULTY_TARGET_NPS[difficulty] || DIFFICULTY_TARGET_NPS.normal;

  let factor = 1.5;
  let peakTimes = [];
  for (let iter = 0; iter < 8; iter++) {
    peakTimes = pickPeaks(vocalScore, buffer.sampleRate, windowSize, factor, minGapFrames, avgWindowFrames);
    const nps = peakTimes.length / buffer.duration;
    if (nps > targetNPS * 1.15) factor *= 1.2;
    else if (nps < targetNPS * 0.85) factor *= 0.8;
    else break;
  }

  onProgress('Charting lanes…');
  // Minimum sustained duration (seconds) before an onset becomes a hold
  // note instead of a tap, and the max length we'll ever let a hold run.
  const MIN_HOLD_SEC = 0.32;
  const MAX_HOLD_SEC = 3.0;
  const peakFrames = peakTimes.map(t => Math.round((t * buffer.sampleRate) / windowSize));
  const onsets = peakTimes.map((t, idx) => {
    const nextTime = idx < peakTimes.length - 1 ? peakTimes[idx + 1] : buffer.duration;
    const nextFrame = idx < peakFrames.length - 1 ? peakFrames[idx + 1] : undefined;
    const sustainSec = computeSustainSeconds(vocalScore, peakFrames[idx], windowSize, buffer.sampleRate, nextFrame);
    // Leave breathing room before the next note so a hold never eats
    // into the note that follows it.
    const roomBeforeNext = nextTime - t - 0.15;
    const hold = (sustainSec >= MIN_HOLD_SEC && roomBeforeNext >= MIN_HOLD_SEC)
      ? Math.min(sustainSec, roomBeforeNext, MAX_HOLD_SEC)
      : 0;
    return {
      time: t,
      brightness: zcrAt(vocalData, buffer.sampleRate, t, 0.08),
      hold
    };
  });

  let notes = assignLanes(onsets, rng);

  // Drop anything in the first 0.6s to give the player a breath before playing.
  notes = notes.filter(n => n.time > 0.6);

  return { notes, duration: buffer.duration };
}

/**
 * Procedurally synthesize a short demo track so the game is playable
 * with zero uploaded files. A continuous lead melody over a light
 * drum/bass bed, so the vocal-focused charter has a clear melody to
 * follow throughout (not just every other bar).
 */
async function synthDemoTrack(audioCtx, bpm = 128, bars = 32) {
  const beatDur = 60 / bpm;
  const barDur = beatDur * 4;
  const totalDur = barDur * bars + 2;
  const sampleRate = audioCtx.sampleRate;
  const offlineCtx = new OfflineAudioContext(2, Math.ceil(totalDur * sampleRate), sampleRate);

  function kickAt(t) {
    const osc = offlineCtx.createOscillator();
    const gain = offlineCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    gain.gain.setValueAtTime(1, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    osc.connect(gain);
    gain.connect(offlineCtx.destination);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  function hatAt(t, vol = 0.35) {
    const bufferSize = sampleRate * 0.05;
    const noiseBuf = offlineCtx.createBuffer(1, bufferSize, sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const src = offlineCtx.createBufferSource();
    src.buffer = noiseBuf;
    const filter = offlineCtx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 6000;
    const gain = offlineCtx.createGain();
    gain.gain.value = vol;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(offlineCtx.destination);
    src.start(t);
  }

  function bassAt(t, freq, dur) {
    const osc = offlineCtx.createOscillator();
    const gain = offlineCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(offlineCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function leadAt(t, freq, dur = 0.22, vol = 0.16) {
    const osc = offlineCtx.createOscillator();
    const gain = offlineCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(offlineCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  const bassNotes = [55, 55, 82.4, 65.4];
  // A simple evolving "melody" pattern so there's always something in
  // the vocal-range band for the auto-charter to follow, even on bars
  // that would otherwise be drum-only.
  const phraseA = [329.6, 392, 440, 392, 329.6, 293.7, 261.6, 293.7];
  const phraseB = [261.6, 329.6, 392, 440, 493.9, 440, 392, 329.6];

  for (let bar = 0; bar < bars; bar++) {
    const barStart = 1 + bar * barDur;
    for (let beat = 0; beat < 4; beat++) {
      const t = barStart + beat * beatDur;
      kickAt(t);
      bassAt(t, bassNotes[bar % bassNotes.length], beatDur * 0.9);
      hatAt(t + beatDur * 0.5, 0.22);
    }
    const phrase = bar % 4 < 2 ? phraseA : phraseB;
    for (let e = 0; e < 8; e++) {
      leadAt(barStart + e * (barDur / 8), phrase[(bar + e) % phrase.length]);
    }
  }

  return offlineCtx.startRendering();
}
