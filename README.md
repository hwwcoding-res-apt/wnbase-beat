# Arrow Beat

A static, FNF-style 4-lane arrow rhythm game. Charts are generated
**automatically** from the audio — no manual note placement, ever.

## Run it

Browsers block `fetch()` on local files opened directly (`file://`), so serve
the folder over a tiny local server:

```bash
cd fnf-game
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser. Works with any static
host too (GitHub Pages, Netlify, a plain nginx box, etc.) — nothing here
needs a backend.

A built-in synthesized demo track is included, so the game is playable with
zero setup.

## Add your own songs

Click **"+ Upload songs"** on the song select screen and pick any audio
file(s) (mp3, wav, ogg, etc.) from your computer. The title is taken
straight from the filename — no metadata to fill in. Pick the song, hit
Play, and the game analyzes the audio and builds a beatmap on the spot,
every time.

Uploaded songs live in memory for the current browser session (nothing is
written to disk), so they'll need re-uploading if you refresh the page.

## How the auto-charting works

See `chart-generator.js` for the full implementation. Short version:

1. The track is split into a **low band** (bass/kick, <200Hz) and a
   **high band** (everything else — snares, hats, melody, vocals) using
   Web Audio `BiquadFilterNode`s rendered through an `OfflineAudioContext`.
2. Each band's energy envelope is computed in ~23ms windows.
3. Local energy peaks that clear an adaptive threshold become notes
   (classic onset/peak-picking detection).
4. The sensitivity auto-tunes so note density lands near a target
   notes-per-second for the chosen difficulty (Easy/Normal/Hard).
5. Low-band hits alternate between the left/down lanes; high-band hits
   alternate between up/right, so charts don't spam a single key.

It's a lightweight heuristic, not a professional chart — but it's fully
automatic and holds up well for anything with a clear beat (electronic,
pop, rock, hip-hop). Very ambient or arrhythmic tracks will chart more
sparsely.

## Controls

- **Arrow keys** — hit notes as they reach the ring
- **Esc** — quit to song select mid-song

## Files

```
fnf-game/
├── index.html          screens: song select, loading, gameplay, results
├── style.css            neon FNF-ish theme
├── game.js               game loop, input, scoring, rendering
├── chart-generator.js    the auto-charting algorithm + demo synth track
├── songs/
│   ├── songs.json        manifest — edit this to add/remove songs
│   └── (your mp3s go here)
└── README.md
```
