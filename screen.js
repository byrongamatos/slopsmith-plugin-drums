// Drum Highway visualization plugin — lane-based scrolling drum
// renderer (Rock Band-style) with MIDI drum pad input, WebAudioFont
// drum kit sounds, and accuracy scoring.
//
// Wave B migration (slopsmith#36): the plugin used to wrap
// window.playSong and toggle itself on/off based on arrangement name.
// That activation model has been replaced by slopsmith core's viz
// picker + Auto mode. This file now exports a setRenderer factory at
// window.slopsmithViz_drums and declares matchesArrangement so Auto
// mode picks drums automatically on Drums / Percussion arrangements.
//
// Single-instance assumption: overlay canvas, scoring state, and
// settings panel live at module scope. The main-player viz picker
// constructs at most one instance at a time, so this is correct
// today. Splitscreen's per-panel setRenderer adoption (Wave C) will
// re-factor these into createFactory closures.

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════

// Word-boundary match so unrelated arrangement names don't trigger
// Auto-drums via a substring hit — e.g. "Drumstick" (hypothetical)
// must NOT match "drums". The \b anchors still catch standard
// Rocksmith arrangement labels cleanly: "Drums", "Drum Kit",
// "Percussion", "Electronic Drums", etc.
const DRUMS_PATTERNS = /\b(?:drums|percussion|drum\s*kit)\b/i;
const VISIBLE_SECONDS = 3.0;
const NOW_LINE_Y_FRAC = 0.85;
const LANE_PAD = 1;
const KICK_LANE_EXTRA = 20;
const HIT_TOLERANCE = 0.05;        // seconds (drums need tighter timing than piano)

// ── Persisted settings ───────────────────────────────────────────────
//
// Explicit map from in-memory property name to localStorage key so
// read and write always agree. The previous code read from
// hand-picked keys but wrote to snake-cased derivatives ('midiChannel'
// → 'drums_midi_channel' not 'drums_midi_ch'), silently losing saves
// on every reload.

const STORE_KEYS = {
    midiInputId:    'drums_midi_input',
    synthVolume:    'drums_synth_vol',
    midiChannel:    'drums_midi_ch',
    hitDetection:   'drums_hit_detect',
    showLaneLabels: 'drums_lane_labels',
    customMapping:  'drums_custom_map',
};

// Safe localStorage reader — getItem can throw SecurityError in
// sandboxed iframes, under Safari on file://, or when storage is
// disabled for the origin. An unguarded throw during the _cfg
// initialiser would abort the IIFE and the plugin would never
// register its setRenderer factory. Return null on failure so the
// `|| default` fallthrough below still produces a usable value.
function _readStore(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

const _cfg = {
    midiInputId:    _readStore(STORE_KEYS.midiInputId) || '',
    synthVolume:    parseFloat(_readStore(STORE_KEYS.synthVolume) || '0.7'),
    midiChannel:    parseInt(_readStore(STORE_KEYS.midiChannel) || '-1'),  // -1 = all, 9 = ch10
    hitDetection:   _readStore(STORE_KEYS.hitDetection) === 'true',
    showLaneLabels: _readStore(STORE_KEYS.showLaneLabels) !== 'false',
    customMapping:  (function () {
        try { return JSON.parse(_readStore(STORE_KEYS.customMapping) || 'null'); }
        catch (_) { return null; }
    })(),
    learnLane:      null,  // transient: which lane is in learn mode
};

function _saveCfg(key, val) {
    _cfg[key] = val;
    const storeKey = STORE_KEYS[key];
    if (!storeKey) return;
    const serialised = typeof val === 'object' && val !== null
        ? JSON.stringify(val) : String(val);
    try { localStorage.setItem(storeKey, serialised); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════
// Module-level singleton state
// ═══════════════════════════════════════════════════════════════════════

// ── MIDI input ────────────────────────────────────────────────────────
let _midiAccess = null;
let _midiInput = null;
// Gates onmidimessage wiring. init() flips true via _midiResumeHandler
// and destroy() flips false via _midiPauseHandler. Because _midiInit
// is async, a requestMIDIAccess promise begun in init() can resolve
// AFTER destroy() has already run — the resulting _midiAutoConnect
// would otherwise assign `_midiInput.onmidimessage = _midiOnMessage`
// on a no-longer-visible renderer, bringing synth + scoring back in
// the background. Every callsite that would attach the handler
// consults this flag first.
let _midiActive = false;
const _heldPads = new Map();       // midi note -> {velocity, wall}

// ── Synth ─────────────────────────────────────────────────────────────
let _audioCtx = null;
let _synthPlayer = null;
let _synthGain = null;
let _synthLoading = false;
let _playerScriptLoaded = false;
const _drumPresets = {};           // midiNote -> preset

// ── Rendering / scoring (single active instance) ──────────────────────
let _drumCanvas = null;
let _drumCtx = null;
let _settingsPanel = null;
let _settingsGear = null;
let _settingsVisible = false;
let _highwayCanvas = null;
let _prevHighwayDisplay = '';
// #player-controls inline-style snapshot. _createOverlayCanvas
// nudges position + zIndex so the controls strip stays above the
// overlay; destroy() must restore those verbatim so the inline
// override doesn't leak into whichever renderer comes next.
let _controlsStyleTouched = false;
let _prevControlsPosition = '';
let _prevControlsZIndex = '';

let _hits = 0, _misses = 0, _streak = 0, _bestStreak = 0;
const _hitNoteKeys = new Set();
const _wrongFlashes = [];          // [{lane, wall}]
const _missedNoteKeys = new Set();
const _laneFlashes = [];           // [{laneIdx, wall, color}]

// Latest filtered arrays cached by draw(bundle) so async MIDI hits
// (_checkHit) can score against the same difficulty-filtered chart
// the user sees. highway.getNotes()/.getChords() are unfiltered.
let _latestNotes = null;
let _latestChords = null;
let _latestTime = 0;

// ═══════════════════════════════════════════════════════════════════════
// MIDI / Drum Mapping
// ═══════════════════════════════════════════════════════════════════════

function noteToMidi(string, fret) { return string * 24 + fret; }

function _noteKey(time, midi) {
    return time.toFixed(3) + '|' + midi;
}

// Standard GM drum lane definitions
const DRUM_LANES = [
    { id: 'hihat',  label: 'HH', midiNotes: [42, 44, 46], color: [0.3, 0.6, 1.0],  symbol: 'x'       },
    { id: 'snare',  label: 'Sn', midiNotes: [38, 40],     color: [1.0, 0.9, 0.2],  symbol: 'circle'   },
    { id: 'tom1',   label: 'T1', midiNotes: [48, 50],     color: [0.3, 1.0, 0.3],  symbol: 'circle'   },
    { id: 'tom2',   label: 'T2', midiNotes: [45, 47],     color: [1.0, 0.6, 0.1],  symbol: 'circle'   },
    { id: 'tom3',   label: 'T3', midiNotes: [41, 43],     color: [0.7, 0.4, 1.0],  symbol: 'circle'   },
    { id: 'crash',  label: 'Cr', midiNotes: [49, 57],     color: [0.2, 0.9, 0.9],  symbol: 'diamond'  },
    { id: 'ride',   label: 'Ri', midiNotes: [51, 59],     color: [0.9, 0.9, 0.9],  symbol: 'diamond'  },
    { id: 'kick',   label: 'Ki', midiNotes: [35, 36],     color: [1.0, 0.2, 0.3],  symbol: 'bar'      },
];

// Build reverse lookup: MIDI note -> lane index
const _midiToLane = {};
DRUM_LANES.forEach((lane, idx) => {
    lane.midiNotes.forEach(n => { _midiToLane[n] = idx; });
});

// Default pad mapping (MIDI note -> lane id)
const DEFAULT_DRUM_MAP = {
    36: 'kick', 35: 'kick',
    38: 'snare', 40: 'snare',
    42: 'hihat', 44: 'hihat', 46: 'hihat',
    48: 'tom1', 50: 'tom1',
    45: 'tom2', 47: 'tom2',
    41: 'tom3', 43: 'tom3',
    49: 'crash', 57: 'crash',
    51: 'ride', 59: 'ride',
};

function _getActiveDrumMap() {
    return _cfg.customMapping || DEFAULT_DRUM_MAP;
}

function _midiToLaneIdx(midiNote) {
    const map = _getActiveDrumMap();
    const laneId = map[midiNote];
    if (!laneId) return -1;
    return DRUM_LANES.findIndex(l => l.id === laneId);
}

function _songNoteToLaneIdx(midi) {
    return _midiToLane[midi] !== undefined ? _midiToLane[midi] : -1;
}

// ═══════════════════════════════════════════════════════════════════════
// Color helper
// ═══════════════════════════════════════════════════════════════════════

function _rgbStr(r, g, b, a) {
    return a !== undefined
        ? `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`
        : `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
}

// ═══════════════════════════════════════════════════════════════════════
// Script loader
// ═══════════════════════════════════════════════════════════════════════

function _loadScript(url) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load ' + url));
        document.head.appendChild(s);
    });
}

// ═══════════════════════════════════════════════════════════════════════
// WebAudioFont drum kit synthesizer
// ═══════════════════════════════════════════════════════════════════════

const WAF_BASE = 'https://surikov.github.io/webaudiofontdata/sound/';
const WAF_PLAYER_URL = 'https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js';
const WAF_SF = 'JCLive_sf2_file';

const DRUM_MIDI_NOTES = [35, 36, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 57, 59];

function _drumWafVar(note)  { return '_drum_' + note + '_0_' + WAF_SF; }
function _drumWafUrl(note)  { return WAF_BASE + '128' + note + '_0_' + WAF_SF + '.js'; }

async function _synthInit() {
    if (_synthPlayer) return;
    try {
        if (!_playerScriptLoaded) {
            await _loadScript(WAF_PLAYER_URL);
            _playerScriptLoaded = true;
        }
        if (typeof WebAudioFontPlayer === 'undefined') return;

        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        _synthGain = _audioCtx.createGain();
        _synthGain.gain.value = _cfg.synthVolume;
        _synthGain.connect(_audioCtx.destination);
        _synthPlayer = new WebAudioFontPlayer();

        await _synthLoadDrumKit();
    } catch (e) {
        console.warn('[Drums] Synth init failed:', e);
    }
}

async function _synthLoadDrumKit() {
    if (!_synthPlayer || !_audioCtx) return;
    _synthLoading = true;

    const promises = DRUM_MIDI_NOTES.map(async (note) => {
        const varName = _drumWafVar(note);
        try {
            if (!window[varName]) {
                await _loadScript(_drumWafUrl(note));
            }
            const preset = window[varName];
            if (preset) {
                _synthPlayer.adjustPreset(_audioCtx, preset);
                _drumPresets[note] = preset;
            }
        } catch (e) {
            console.warn('[Drums] Failed to load drum note ' + note + ':', e);
        }
    });

    await Promise.all(promises);
    _synthLoading = false;
}

function _synthEnsureCtx() {
    if (_audioCtx && _audioCtx.state === 'suspended') {
        _audioCtx.resume();
    }
}

function _synthDrumHit(midiNote, velocity) {
    if (!_synthPlayer || !_audioCtx || !_synthGain) return;
    const preset = _drumPresets[midiNote];
    if (!preset) return;
    _synthEnsureCtx();

    const vol = (velocity / 127) * _cfg.synthVolume;
    _synthPlayer.queueWaveTable(
        _audioCtx, _synthGain, preset, 0, midiNote, 0.5, vol
    );
}

function _synthSetVolume(vol) {
    _saveCfg('synthVolume', vol);
    if (_synthGain) _synthGain.gain.value = vol;
}

// ═══════════════════════════════════════════════════════════════════════
// Web MIDI input
// ═══════════════════════════════════════════════════════════════════════

async function _midiInit() {
    if (_midiAccess) return;
    if (!navigator.requestMIDIAccess) return;
    try {
        _midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        _midiAccess.onstatechange = () => _midiUpdateDeviceList();
        _midiAutoConnect();
        // Populate the settings panel's MIDI <select> even when
        // _midiAutoConnect bailed early (no devices, or user's saved
        // "None" opt-out). Without this the dropdown stays stuck on
        // the initial "None" option until a device statechange fires.
        _midiUpdateDeviceList();
    } catch (e) {
        console.warn('[Drums] MIDI access denied:', e);
    }
}

function _midiAutoConnect() {
    if (!_midiAccess) return;
    const inputs = [];
    _midiAccess.inputs.forEach(inp => inputs.push(inp));
    if (!inputs.length) return;

    // Distinguish "never picked a device" from "explicitly picked
    // None". _readStore returns null for the never-set case (and
    // for storage-disabled contexts) and '' for an explicit-None
    // save via _midiConnect. Only respect the explicit-None
    // sentinel; fall through to inputs[0] on the null branch.
    const raw = _readStore(STORE_KEYS.midiInputId);
    if (raw === '') return;

    const target = inputs.find(i => i.id === raw) || inputs[0];
    _midiConnect(target.id);
}

function _midiConnect(id) {
    if (_midiInput) _midiInput.onmidimessage = null;
    _midiInput = null;

    // Release anything currently sounding / held on the OLD device
    // before we swap. Drum notes are short (queueWaveTable duration
    // 0.5s) so hung tones are less likely than for piano, but
    // _heldPads drives on-screen lane pressed state and would
    // otherwise keep the prior hit animating after a device swap.
    _releaseAllSounding();

    // Persist regardless of match. Empty id is the explicit "None"
    // option and must be saved so _midiAutoConnect respects the
    // opt-out on next init instead of auto-picking inputs[0] again.
    _saveCfg('midiInputId', id || '');

    if (!id || !_midiAccess) {
        _midiUpdateDeviceList();
        return;
    }
    _midiAccess.inputs.forEach(inp => {
        if (inp.id === id) {
            _midiInput = inp;
            // Wire the handler only when the renderer is active.
            // A late _midiConnect from an async _midiInit that
            // resolved post-destroy would otherwise re-enable
            // scoring / synth in the background.
            if (_midiActive) _midiInput.onmidimessage = _midiOnMessage;
        }
    });
    _midiUpdateDeviceList();
}

function _midiPauseHandler() {
    // Called from destroy() — detach the message handler so the
    // connected kit stops firing _onDrumHit into a plugin no longer
    // visible. Flipping _midiActive BEFORE the detach also prevents
    // a late-resolving _midiConnect (from an in-flight _midiInit
    // started in the most recent init()) from re-wiring the handler
    // on an already-destroyed renderer. Keep _midiInput so a
    // future init() can reattach without the user re-picking.
    _midiActive = false;
    if (_midiInput) _midiInput.onmidimessage = null;
}

function _midiResumeHandler() {
    // Called from init() — flip the gate first so an in-flight
    // _midiConnect that lands shortly after this returns wires the
    // handler too. If _midiInput is already populated from a prior
    // lifetime, restore the handler immediately.
    _midiActive = true;
    if (_midiInput) _midiInput.onmidimessage = _midiOnMessage;
}

function _midiOnMessage(e) {
    const [status, note, velocity] = e.data;
    const ch = status & 0x0F;

    if (_cfg.midiChannel >= 0 && ch !== _cfg.midiChannel) return;

    const cmd = status & 0xF0;

    if (cmd === 0x90 && velocity > 0) {
        _onDrumHit(note, velocity);
    }
    // Drums don't need note-off handling (one-shot hits)
}

function _onDrumHit(midiNote, velocity) {
    if (midiNote < 0 || midiNote > 127) return;

    // Learn mode: assign this MIDI note to the pending lane
    if (_cfg.learnLane !== null) {
        const map = Object.assign({}, _getActiveDrumMap());
        map[midiNote] = DRUM_LANES[_cfg.learnLane].id;
        _saveCfg('customMapping', map);
        _cfg.learnLane = null;
        _updateLearnUI();
        return;
    }

    _heldPads.set(midiNote, { velocity, wall: performance.now() });
    _synthDrumHit(midiNote, velocity);
    _synthEnsureCtx();

    const laneIdx = _midiToLaneIdx(midiNote);
    if (laneIdx >= 0) {
        const lane = DRUM_LANES[laneIdx];
        _laneFlashes.push({
            laneIdx,
            wall: performance.now(),
            color: _rgbStr(lane.color[0], lane.color[1], lane.color[2], 0.6),
        });
    }

    if (_cfg.hitDetection) {
        _checkHit(midiNote);
    }
}

function _midiUpdateDeviceList() {
    const sel = document.getElementById('drums-midi-select');
    if (!sel || !_midiAccess) return;

    const inputs = [];
    _midiAccess.inputs.forEach(inp => inputs.push(inp));

    // Build <option> elements via the DOM API rather than
    // concatenating an HTML string. MIDI device names come from
    // attached hardware and can contain characters that would
    // otherwise inject markup ("<" in a vendor string or a
    // maliciously-named device) directly into the settings panel.
    // .value / .textContent escape both fields safely.
    sel.textContent = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'None';
    sel.appendChild(noneOpt);
    for (const inp of inputs) {
        const opt = document.createElement('option');
        opt.value = inp.id;
        opt.textContent = inp.name;
        if (_midiInput && _midiInput.id === inp.id) opt.selected = true;
        sel.appendChild(opt);
    }
}

// Shared cleanup for "everything pressed / sounding on the previous
// MIDI device should stop now." Called from _teardown() on destroy
// AND from _midiConnect() on device switch, so a "None" pick or
// device-swap doesn't leave pressed-lane animations drooling out.
// Also clears transient Learn-mode state — _cfg.learnLane is a
// pending-remap sentinel; leaving it set across a destroy / device
// swap would silently swallow the next drum hit on the next init.
function _releaseAllSounding() {
    _heldPads.clear();
    _wrongFlashes.length = 0;
    _laneFlashes.length = 0;
    _cfg.learnLane = null;
}

// ═══════════════════════════════════════════════════════════════════════
// Hit detection / accuracy scoring (against cached filter-aware arrays)
// ═══════════════════════════════════════════════════════════════════════

function _checkHit(playedMidi) {
    const t = _latestTime;
    const notes = _latestNotes;
    const chords = _latestChords;

    // No chart cached yet (song-change reconnect window, or the
    // very first frame after init before draw has caught up). Skip
    // scoring entirely — counting a hit as a miss here would inflate
    // the miss counter every time the user noodles on the pad during
    // a song switch, with no matching notes to score against.
    //
    // Check both "nullish" AND "empty array" — `![] === false` in
    // JS, so `if (!notes && !chords)` would miss the reconnect case
    // where bundle.notes/chords arrive as [] before any song data.
    const notesEmpty = !notes || notes.length === 0;
    const chordsEmpty = !chords || chords.length === 0;
    if (notesEmpty && chordsEmpty) return;

    const playedLane = _midiToLaneIdx(playedMidi);
    if (playedLane < 0) return;

    let foundHit = false;

    if (notes) {
        for (const n of notes) {
            if (n.t > t + HIT_TOLERANCE + 0.5) break;
            if (n.t < t - HIT_TOLERANCE - 0.5) continue;
            const songMidi = noteToMidi(n.s, n.f);
            const songLane = _songNoteToLaneIdx(songMidi);
            const key = _noteKey(n.t, songMidi);
            if (songLane === playedLane && Math.abs(n.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                _hitNoteKeys.add(key);
                foundHit = true;
                break;
            }
        }
    }

    if (!foundHit && chords) {
        for (const c of chords) {
            if (c.t > t + HIT_TOLERANCE + 0.5) break;
            if (c.t < t - HIT_TOLERANCE - 0.5) continue;
            for (const cn of (c.notes || [])) {
                const songMidi = noteToMidi(cn.s, cn.f);
                const songLane = _songNoteToLaneIdx(songMidi);
                const key = _noteKey(c.t, songMidi);
                if (songLane === playedLane && Math.abs(c.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                    _hitNoteKeys.add(key);
                    foundHit = true;
                    break;
                }
            }
            if (foundHit) break;
        }
    }

    if (foundHit) {
        _hits++;
        _streak++;
        if (_streak > _bestStreak) _bestStreak = _streak;
    } else {
        _misses++;
        _streak = 0;
        _wrongFlashes.push({ lane: playedLane, wall: performance.now() });
    }
}

function _updateMissedNotes(t, notes, chords) {
    if (!_cfg.hitDetection) return;
    const cutoff = t - HIT_TOLERANCE - 0.05;

    if (notes) {
        for (const n of notes) {
            if (n.t > cutoff) break;
            if (n.t < cutoff - 2) continue;
            const songMidi = noteToMidi(n.s, n.f);
            const key = _noteKey(n.t, songMidi);
            if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && n.t < cutoff) {
                _missedNoteKeys.add(key);
            }
        }
    }
    if (chords) {
        for (const c of chords) {
            if (c.t > cutoff) break;
            if (c.t < cutoff - 2) continue;
            for (const cn of (c.notes || [])) {
                const songMidi = noteToMidi(cn.s, cn.f);
                const key = _noteKey(c.t, songMidi);
                if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && c.t < cutoff) {
                    _missedNoteKeys.add(key);
                }
            }
        }
    }

    const now = performance.now();
    while (_wrongFlashes.length && now - _wrongFlashes[0].wall > 400) {
        _wrongFlashes.shift();
    }
    while (_laneFlashes.length && now - _laneFlashes[0].wall > 300) {
        _laneFlashes.shift();
    }
    for (const [midi, info] of _heldPads) {
        if (now - info.wall > 200) _heldPads.delete(midi);
    }
}

function _resetScoring() {
    _hits = 0; _misses = 0; _streak = 0; _bestStreak = 0;
    _hitNoteKeys.clear();
    _missedNoteKeys.clear();
    _wrongFlashes.length = 0;
    _laneFlashes.length = 0;
}

function _primeLatestSnapshot() {
    // Fill _latest* from highway's public getters so a MIDI hit that
    // lands before the first draw() of a new chart has a snapshot
    // to score against. Getters return unfiltered arrays; once the
    // first draw runs, _latest* switches to the difficulty-filtered
    // bundle arrays. Worst case: one hit immediately after song:ready
    // scores against a note the difficulty slider has hidden.
    try {
        if (typeof highway !== 'undefined') {
            _latestNotes = typeof highway.getNotes === 'function' ? highway.getNotes() : null;
            _latestChords = typeof highway.getChords === 'function' ? highway.getChords() : null;
            _latestTime = typeof highway.getTime === 'function' ? highway.getTime() : 0;
        }
    } catch (_) {
        _latestNotes = null;
        _latestChords = null;
        _latestTime = 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Settings panel + gear button
// ═══════════════════════════════════════════════════════════════════════

function _injectSettingsGear() {
    const controls = document.getElementById('player-controls');
    if (!controls || _settingsGear) return;

    const closeBtn = controls.querySelector('button:last-child');
    const gear = document.createElement('button');
    gear.id = 'btn-drums-settings';
    gear.className = 'px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
    gear.type = 'button';
    gear.title = 'Drum settings (MIDI, sounds, scoring)';
    // Accessible name for screen readers — title alone is announced
    // inconsistently, and the glyph itself would otherwise surface
    // as "black gear" or similar ambiguous text.
    gear.setAttribute('aria-label', 'Drum settings');
    const glyph = document.createElement('span');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '⚙';
    gear.appendChild(glyph);
    gear.onclick = _toggleSettings;
    controls.insertBefore(gear, closeBtn);
    _settingsGear = gear;
}

function _removeSettingsGear() {
    if (_settingsGear) {
        _settingsGear.remove();
        _settingsGear = null;
    }
}

function _toggleSettings() {
    _settingsVisible = !_settingsVisible;
    if (!_settingsPanel && _settingsVisible) _createSettingsPanel();
    if (_settingsPanel) _settingsPanel.style.display = _settingsVisible ? '' : 'none';
    if (_settingsVisible) {
        _midiInit();
        _synthInit();
        _midiUpdateDeviceList();
    }
}

function _updateLearnUI() {
    const learnBtns = document.querySelectorAll('.drums-learn-btn');
    learnBtns.forEach(btn => {
        const idx = parseInt(btn.dataset.lane);
        btn.textContent = _cfg.learnLane === idx ? '...' : 'Learn';
        btn.style.color = _cfg.learnLane === idx ? '#ff0' : '#aaa';
    });
}

function _createSettingsPanel() {
    if (_settingsPanel) return;
    const player = document.getElementById('player');
    if (!player) return;

    const panel = document.createElement('div');
    panel.id = 'drums-settings-panel';
    panel.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:25;' +
        'background:rgba(8,8,20,0.94);border-bottom:1px solid #222;padding:6px 12px;' +
        'font-family:system-ui,sans-serif;display:none;max-height:50%;overflow-y:auto;';

    const channelOpts = '<option value="-1"' + (_cfg.midiChannel === -1 ? ' selected' : '') + '>All</option>' +
        '<option value="9"' + (_cfg.midiChannel === 9 ? ' selected' : '') + '>10 (Drums)</option>' +
        Array.from({length: 16}, (_, i) =>
            i === 9 ? '' : `<option value="${i}"${_cfg.midiChannel === i ? ' selected' : ''}>${i + 1}</option>`
        ).join('');

    const mapRows = DRUM_LANES.map((lane, idx) => {
        const map = _getActiveDrumMap();
        const assigned = Object.entries(map).filter(([_, v]) => v === lane.id).map(([k]) => k).join(', ');
        return `<tr>
            <td style="color:${_rgbStr(lane.color[0], lane.color[1], lane.color[2])};font-weight:bold;padding:2px 6px;">${lane.label}</td>
            <td style="color:#888;padding:2px 6px;font-size:10px;">${assigned || 'none'}</td>
            <td style="padding:2px 4px;"><button class="drums-learn-btn" data-lane="${idx}"
                style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:1px 6px;
                font-size:10px;color:#aaa;cursor:pointer;">Learn</button></td>
        </tr>`;
    }).join('');

    panel.innerHTML = `
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
            <div style="display:flex;align-items:center;gap:4px;">
                <span style="font-size:10px;color:#666;">MIDI</span>
                <select id="drums-midi-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                    padding:3px 6px;font-size:11px;color:#ccc;outline:none;max-width:180px;">
                    <option value="">None</option>
                </select>
            </div>
            <div style="display:flex;align-items:center;gap:4px;">
                <span style="font-size:10px;color:#666;">Vol</span>
                <input type="range" id="drums-vol-slider" min="0" max="100"
                    value="${Math.round(_cfg.synthVolume * 100)}"
                    style="width:70px;accent-color:#ef4444;height:14px;">
            </div>
            <div style="display:flex;align-items:center;gap:4px;">
                <span style="font-size:10px;color:#666;">Ch</span>
                <select id="drums-channel-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                    padding:3px 6px;font-size:11px;color:#ccc;outline:none;width:72px;">
                    ${channelOpts}
                </select>
            </div>
            <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                <input type="checkbox" id="drums-chk-labels" ${_cfg.showLaneLabels ? 'checked' : ''}
                    style="accent-color:#ef4444;"> Labels
            </label>
            <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                <input type="checkbox" id="drums-chk-hits" ${_cfg.hitDetection ? 'checked' : ''}
                    style="accent-color:#22cc66;"> Hits
            </label>
            <button id="drums-reset-map" style="background:#1a1a2e;border:1px solid #333;border-radius:4px;
                padding:2px 8px;font-size:10px;color:#aaa;cursor:pointer;">Reset Map</button>
        </div>
        <details style="margin-top:2px;">
            <summary style="font-size:10px;color:#666;cursor:pointer;">MIDI Mapping</summary>
            <table style="font-size:11px;margin-top:4px;">${mapRows}</table>
        </details>`;

    const controls = document.getElementById('player-controls');
    if (controls) {
        player.insertBefore(panel, controls);
    } else {
        player.appendChild(panel);
    }
    _settingsPanel = panel;

    panel.querySelector('#drums-midi-select').onchange = function () {
        _midiConnect(this.value);
        _synthInit();
    };
    panel.querySelector('#drums-vol-slider').oninput = function () {
        _synthSetVolume(parseInt(this.value) / 100);
    };
    panel.querySelector('#drums-channel-select').onchange = function () {
        _saveCfg('midiChannel', parseInt(this.value));
    };
    panel.querySelector('#drums-chk-labels').onchange = function () {
        _saveCfg('showLaneLabels', this.checked);
    };
    panel.querySelector('#drums-chk-hits').onchange = function () {
        _saveCfg('hitDetection', this.checked);
        if (this.checked) _resetScoring();
    };
    panel.querySelector('#drums-reset-map').onclick = function () {
        _saveCfg('customMapping', null);
        // Mapping rows are rendered once during panel construction
        // from the current _getActiveDrumMap(). Rebuild the panel so
        // the "assigned" column updates to reflect the defaults.
        // _removeSettingsPanel forces _settingsVisible=false as part
        // of tearing the node down; snapshot the prior visibility
        // state and restore it after the rebuild so the gear toggle
        // remains in sync — otherwise _settingsVisible and the
        // actual panel visibility would disagree, and the next gear
        // click would just flip the flag back to "visible" without
        // any visual change.
        const wasSettingsVisible = _settingsVisible;
        _removeSettingsPanel();
        _createSettingsPanel();
        _settingsVisible = wasSettingsVisible;
        if (wasSettingsVisible && _settingsPanel) _settingsPanel.style.display = '';
        _midiUpdateDeviceList();
    };

    panel.querySelectorAll('.drums-learn-btn').forEach(btn => {
        btn.onclick = function () {
            const idx = parseInt(this.dataset.lane);
            _cfg.learnLane = _cfg.learnLane === idx ? null : idx;
            _updateLearnUI();
        };
    });
}

function _removeSettingsPanel() {
    if (_settingsPanel) {
        _settingsPanel.remove();
        _settingsPanel = null;
    }
    _settingsVisible = false;
}

// ═══════════════════════════════════════════════════════════════════════
// Round rect helper
// ═══════════════════════════════════════════════════════════════════════

function _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ═══════════════════════════════════════════════════════════════════════
// Lane geometry (vertical — lanes are columns, notes scroll top → bottom)
// ═══════════════════════════════════════════════════════════════════════

function _computeLaneLayout(W /* , H */) {
    const numLanes = DRUM_LANES.length;
    const padL = 10;
    const padR = 10;
    const availW = W - padL - padR;

    const kickIdx = DRUM_LANES.findIndex(l => l.id === 'kick');
    const regularW = (availW - KICK_LANE_EXTRA) / numLanes;
    const kickW = regularW + KICK_LANE_EXTRA;

    const lanes = [];
    let x = padL;
    for (let i = 0; i < numLanes; i++) {
        const w = i === kickIdx ? kickW : regularW;
        lanes.push({
            idx: i,
            lane: DRUM_LANES[i],
            x: x,
            w: w,
            centerX: x + w / 2,
        });
        x += w + LANE_PAD;
    }
    return lanes;
}

// ═══════════════════════════════════════════════════════════════════════
// Drawing
// ═══════════════════════════════════════════════════════════════════════

function _timeToY(dt, nowLineY, topY) {
    if (dt <= 0) return nowLineY + (-dt / 0.3) * 20;
    const frac = dt / VISIBLE_SECONDS;
    return nowLineY - frac * (nowLineY - topY);
}

function _draw(notes, chords, t, beats) {
    if (!_drumCanvas || !_drumCtx) return;

    // Update the MIDI-scoring snapshots FIRST — before the
    // no-chart-yet early return below. During a song change where
    // bundle.currentTime advances but notes/chords are still empty
    // (WS reconnect window), a drum hit between frames would
    // otherwise score against the PREVIOUS song's cached chart and
    // its stale t.
    _latestNotes = notes;
    _latestChords = chords;
    _latestTime = t;

    const W = _drumCanvas.width / (window.devicePixelRatio || 1);
    const H = _drumCanvas.height / (window.devicePixelRatio || 1);
    const ctx = _drumCtx;

    // No chart yet — paint the plugin's base background and return,
    // rather than leaving the previous frame's notes + HUD frozen
    // on screen through a reconnect. Treat both nullish AND empty
    // arrays as "no chart": bundle.notes / bundle.chords can arrive
    // as [] before song_info populates them, and `![]` is false in
    // JS so the plain `!notes && !chords` guard misses that case.
    const notesEmpty = !notes || notes.length === 0;
    const chordsEmpty = !chords || chords.length === 0;
    if (notesEmpty && chordsEmpty) {
        ctx.fillStyle = '#040408';
        ctx.fillRect(0, 0, W, H);
        return;
    }

    _updateMissedNotes(t, notes, chords);

    const nowLineY = H * NOW_LINE_Y_FRAC;
    const topY = 0;
    const laneLayout = _computeLaneLayout(W, H);
    const kickIdx = DRUM_LANES.findIndex(l => l.id === 'kick');

    // ── Background ──────────────────────────────────────────────────
    ctx.fillStyle = '#040408';
    ctx.fillRect(0, 0, W, H);

    // ── Lane backgrounds (vertical columns) ─────────────────────────
    for (let i = 0; i < laneLayout.length; i++) {
        const ll = laneLayout[i];
        const [r, g, b] = ll.lane.color;

        ctx.fillStyle = _rgbStr(r * 0.06, g * 0.06, b * 0.06, 0.5);
        ctx.fillRect(ll.x, topY, ll.w, nowLineY + 20);

        ctx.strokeStyle = _rgbStr(r * 0.15, g * 0.15, b * 0.15, 0.3);
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(ll.x + ll.w, topY);
        ctx.lineTo(ll.x + ll.w, nowLineY + 20);
        ctx.stroke();

        for (const flash of _laneFlashes) {
            if (flash.laneIdx === i) {
                const age = (performance.now() - flash.wall) / 300;
                if (age < 1) {
                    ctx.fillStyle = _rgbStr(r, g, b, 0.25 * (1 - age));
                    ctx.fillRect(ll.x, topY, ll.w, nowLineY + 20);
                }
            }
        }
    }

    // ── Kick lane separator ─────────────────────────────────────────
    if (kickIdx >= 0) {
        const kickLL = laneLayout[kickIdx];
        ctx.strokeStyle = 'rgba(255,80,80,0.3)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(kickLL.x - 2, topY);
        ctx.lineTo(kickLL.x - 2, nowLineY + 20);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // ── Beat / measure lines ────────────────────────────────────────
    if (beats) {
        for (const b of beats) {
            const dt = b.time - t;
            if (dt < -0.1 || dt > VISIBLE_SECONDS) continue;
            const y = _timeToY(dt, nowLineY, topY);
            ctx.strokeStyle = b.measure > 0 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)';
            ctx.lineWidth = b.measure > 0 ? 1 : 0.5;
            ctx.beginPath();
            ctx.moveTo(laneLayout[0].x, y);
            ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w, y);
            ctx.stroke();
        }
    }

    // ── Now line ────────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(laneLayout[0].x, nowLineY);
    ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w, nowLineY);
    ctx.stroke();

    _drawScrollingNotes(ctx, notes, chords, t, laneLayout, nowLineY, topY, W, H);

    if (_cfg.showLaneLabels) {
        _drawLaneLabels(ctx, laneLayout, nowLineY, H);
    }

    if (_cfg.hitDetection && (_hits + _misses) > 0) {
        _drawAccuracyHUD(ctx, W, H);
    }

    if (_midiInput) {
        ctx.fillStyle = '#22cc66';
        ctx.beginPath();
        ctx.arc(W - 20, 16, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#22cc6688';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('MIDI', W - 28, 16);
    }
}

function _drawScrollingNotes(ctx, notes, chords, t, laneLayout, nowLineY, topY /* , W, H */) {
    const allNotes = [];

    if (notes) {
        for (const n of notes) {
            const dt = n.t - t;
            if (dt > VISIBLE_SECONDS + 1) break;
            if (dt < -1) continue;
            allNotes.push({ midi: noteToMidi(n.s, n.f), t: n.t, ac: n.ac });
        }
    }
    if (chords) {
        for (const c of chords) {
            const dt = c.t - t;
            if (dt > VISIBLE_SECONDS + 1) break;
            if (dt < -1) continue;
            for (const cn of (c.notes || [])) {
                allNotes.push({ midi: noteToMidi(cn.s, cn.f), t: c.t, ac: cn.ac });
            }
        }
    }

    for (const n of allNotes) {
        const laneIdx = _songNoteToLaneIdx(n.midi);
        if (laneIdx < 0 || laneIdx >= laneLayout.length) continue;

        const ll = laneLayout[laneIdx];
        const lane = ll.lane;
        const dt = n.t - t;
        const y = _timeToY(dt, nowLineY, topY);

        if (y < -20 || y > nowLineY + 30) continue;

        const isActive = Math.abs(dt) < 0.03;

        const nk = _noteKey(n.t, n.midi);
        let useHitColor = false, useMissColor = false;
        if (_cfg.hitDetection) {
            if (_hitNoteKeys.has(nk)) useHitColor = true;
            else if (_missedNoteKeys.has(nk)) useMissColor = true;
        }

        let [cr, cg, cb] = lane.color;
        if (useHitColor) { cr = 0; cg = 1; cb = 0.27; }
        else if (useMissColor) { cr = 0.33; cg = 0.33; cb = 0.4; }

        const velFactor = n.ac ? 1.3 : 1.0;
        const cx = ll.centerX;

        if (lane.id === 'kick') {
            const barH = Math.max(4, 8 * velFactor);
            const firstLane = laneLayout[0];
            const lastLane = laneLayout[laneLayout.length - 1];
            const fullLeft = firstLane.x;
            const fullRight = lastLane.x + lastLane.w;

            if (!useMissColor) {
                const glowAlpha = isActive ? 0.4 : 0.15;
                for (let i = 1; i >= 0; i--) {
                    const spread = (i + 1) * 2;
                    ctx.fillStyle = _rgbStr(cr, cg, cb, glowAlpha * (0.3 + (1 - i) * 0.2));
                    ctx.fillRect(fullLeft, y - barH / 2 - spread, fullRight - fullLeft, barH + spread * 2);
                }
            }

            ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.2 : 0.5);
            ctx.fillRect(fullLeft, y - barH / 2, fullRight - fullLeft, barH);

            ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 0.9);
            ctx.fillRect(ll.x + 2, y - barH / 2, ll.w - 4, barH);

            if (isActive && !useMissColor) {
                ctx.fillStyle = _rgbStr(cr, cg, cb, 0.12);
                ctx.fillRect(fullLeft, nowLineY - 5, fullRight - fullLeft, 10);
            }
        } else if (lane.symbol === 'diamond') {
            const size = (ll.w * 0.25) * velFactor;

            if (!useMissColor) {
                const glowAlpha = isActive ? 0.5 : 0.2;
                for (let i = 1; i >= 0; i--) {
                    const spread = (i + 1) * 2;
                    const a = glowAlpha * (0.15 + (1 - i) * 0.15);
                    ctx.strokeStyle = _rgbStr(cr, cg, cb, a);
                    ctx.lineWidth = spread;
                    ctx.beginPath();
                    ctx.moveTo(cx, y - size - spread);
                    ctx.lineTo(cx + size + spread, y);
                    ctx.lineTo(cx, y + size + spread);
                    ctx.lineTo(cx - size - spread, y);
                    ctx.closePath();
                    ctx.stroke();
                }
            }

            ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
            ctx.beginPath();
            ctx.moveTo(cx, y - size);
            ctx.lineTo(cx + size, y);
            ctx.lineTo(cx, y + size);
            ctx.lineTo(cx - size, y);
            ctx.closePath();
            ctx.fill();
        } else if (lane.id === 'hihat') {
            const size = (ll.w * 0.22) * velFactor;
            const isOpen = n.midi === 46;
            const isPedal = n.midi === 44;
            const s = isPedal ? size * 0.6 : size;

            if (!useMissColor) {
                const glowAlpha = isActive ? 0.5 : 0.2;
                ctx.strokeStyle = _rgbStr(cr, cg, cb, glowAlpha * 0.3);
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.moveTo(cx - s, y - s);
                ctx.lineTo(cx + s, y + s);
                ctx.moveTo(cx + s, y - s);
                ctx.lineTo(cx - s, y + s);
                ctx.stroke();
            }

            if (isOpen) {
                ctx.strokeStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.arc(cx, y, s, 0, Math.PI * 2);
                ctx.stroke();
                ctx.font = `bold ${Math.max(8, s * 0.7)}px sans-serif`;
                ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 0.8);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('o', cx, y);
            } else {
                ctx.strokeStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
                ctx.lineWidth = isPedal ? 1.5 : 2.5;
                ctx.beginPath();
                ctx.moveTo(cx - s, y - s);
                ctx.lineTo(cx + s, y + s);
                ctx.moveTo(cx + s, y - s);
                ctx.lineTo(cx - s, y + s);
                ctx.stroke();
            }
        } else {
            const radius = (ll.w * 0.25) * velFactor;

            if (!useMissColor) {
                const glowAlpha = isActive ? 0.5 : 0.2;
                for (let i = 1; i >= 0; i--) {
                    const spread = (i + 1) * 2;
                    const a = glowAlpha * (0.15 + (1 - i) * 0.15);
                    ctx.strokeStyle = _rgbStr(cr, cg, cb, a);
                    ctx.lineWidth = spread;
                    ctx.beginPath();
                    ctx.arc(cx, y, radius + spread, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }

            ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 1);
            ctx.beginPath();
            ctx.arc(cx, y, radius, 0, Math.PI * 2);
            ctx.fill();

            if (!useMissColor && radius > 4) {
                const grad = ctx.createRadialGradient(cx - radius * 0.3, y - radius * 0.3, 0, cx, y, radius);
                grad.addColorStop(0, _rgbStr(Math.min(cr + 0.3, 1), Math.min(cg + 0.3, 1), Math.min(cb + 0.3, 1), 0.4));
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(cx, y, radius, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}

function _drawLaneLabels(ctx, laneLayout, nowLineY, H) {
    const labelY = nowLineY + 8;
    const labelH = H - labelY;

    ctx.fillStyle = 'rgba(8,8,20,0.85)';
    ctx.fillRect(0, labelY, laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w + 10, labelH);

    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, labelY);
    ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w + 10, labelY);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const ll of laneLayout) {
        const [r, g, b] = ll.lane.color;
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = _rgbStr(r, g, b, 0.9);
        ctx.fillText(ll.lane.label, ll.centerX, labelY + labelH / 2);
    }
}

function _drawAccuracyHUD(ctx, W /* , H */) {
    const total = _hits + _misses;
    if (total === 0) return;

    const pct = Math.round((_hits / total) * 100);
    const text = `Accuracy: ${pct}%   Streak: ${_streak}   Best: ${_bestStreak}   ${_hits}/${total}`;

    ctx.font = 'bold 12px sans-serif';
    const tw = ctx.measureText(text).width;
    const hudW = tw + 24;
    const hudH = 24;
    const hudX = (W - hudW) / 2;
    const hudY = 6;

    ctx.fillStyle = 'rgba(8,8,20,0.75)';
    _roundRect(ctx, hudX, hudY, hudW, hudH, 6);
    ctx.fill();

    ctx.fillStyle = pct >= 80 ? '#22cc66' : pct >= 50 ? '#ffcc33' : '#ff6644';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, hudY + hudH / 2);
}

// ═══════════════════════════════════════════════════════════════════════
// Lifecycle helpers
// ═══════════════════════════════════════════════════════════════════════

function _createOverlayCanvas() {
    const player = document.getElementById('player');
    if (!player) return null;

    const canvas = document.createElement('canvas');
    canvas.id = 'drum-highway-canvas';
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:5;pointer-events:none;';

    const controls = document.getElementById('player-controls');
    if (controls) {
        player.insertBefore(canvas, controls);
        // Snapshot prior inline values so destroy() can restore them.
        // An empty string here means the rule lives in a stylesheet
        // rather than inline; assigning '' back on restore removes
        // our override without touching the stylesheet rule.
        _prevControlsPosition = controls.style.position;
        _prevControlsZIndex = controls.style.zIndex;
        _controlsStyleTouched = true;
        controls.style.position = 'relative';
        controls.style.zIndex = '20';
    } else {
        player.appendChild(canvas);
    }
    return canvas;
}

function _restoreControlsStyle() {
    if (!_controlsStyleTouched) return;
    const controls = document.getElementById('player-controls');
    if (controls) {
        controls.style.position = _prevControlsPosition;
        controls.style.zIndex = _prevControlsZIndex;
    }
    _controlsStyleTouched = false;
    _prevControlsPosition = '';
    _prevControlsZIndex = '';
}

function _applyCanvasDims(canvas) {
    // Measure #player in CSS px; see the piano plugin's equivalent
    // comment for why we ignore the w/h passed to resize() in favour
    // of re-measuring the element rect.
    if (!canvas) return;
    const player = document.getElementById('player');
    if (!player) return;
    const w = player.clientWidth;
    const h = player.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    if (_drumCtx) _drumCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract
// ═══════════════════════════════════════════════════════════════════════

// Wipes scoring + flash buffers + _heldPads so the next chart
// doesn't inherit stale state. Critical for Auto-mode
// Drums-to-Drums transitions (drum renderer stays selected across
// the arrangement switch). Module-scope so the song:ready listener
// wired in init() is a stable function reference across factory
// instances.
function _resetForNewChart() {
    _resetScoring();
    _heldPads.clear();
    _primeLatestSnapshot();
}

// Module-scope handlers. Previously these were per-factory closures,
// which meant a defensive-teardown running inside a NEW factory's
// init() was calling removeEventListener / slopsmith.off with its
// OWN refs, which never matched the OLD factory's registered refs —
// so listeners leaked and every event fired the handler stack twice.
// Module-scope refs keep attach/detach symmetric. The single-instance
// assumption at the top of the file covers multi-factory correctness;
// Wave C splitscreen adoption will re-factor state into closures and
// at that point we'll need per-panel handlers too.
function _onWinResize() {
    _applyCanvasDims(_drumCanvas);
}
function _onSongReady() {
    _resetForNewChart();
}

function createFactory() {
    let _isReady = false;

    return {
        init(canvas /* , bundle */) {
            // Defensive teardown in case a prior init wasn't paired
            // with destroy. Mirror destroy()'s cleanup exactly —
            // including restoreCanvas=true. If we skipped the
            // restore, the prior lifetime's highway canvas would
            // stay `display:none` going into the fresh capture
            // below, poisoning `_prevHighwayDisplay` with "none" so
            // a later destroy() would re-hide the canvas permanently.
            if (_drumCanvas || _isReady) {
                window.removeEventListener('resize', _onWinResize);
                if (window.slopsmith) window.slopsmith.off?.('song:ready', _onSongReady);
                _midiPauseHandler();
                _teardown(/* restoreCanvas */ true);
                _isReady = false;
            }

            _highwayCanvas = canvas;
            _prevHighwayDisplay = canvas ? canvas.style.display : '';

            _drumCanvas = _createOverlayCanvas();
            if (!_drumCanvas) {
                console.warn('[Drums] init: #player container missing; aborting');
                return;
            }
            _drumCtx = _drumCanvas.getContext('2d');
            if (!_drumCtx) {
                // 2D context unavailable — tear down our freshly
                // built overlay, restore any controls-style override,
                // and leave the highway canvas visible as a fallback.
                // Without this abort we'd hide the highway below and
                // every draw() would silently no-op against a null
                // ctx, leaving a blank player.
                console.warn('[Drums] init: getContext("2d") returned null; aborting');
                _drumCanvas.remove();
                _drumCanvas = null;
                _highwayCanvas = null;
                _prevHighwayDisplay = '';
                _restoreControlsStyle();
                return;
            }

            if (_highwayCanvas) _highwayCanvas.style.display = 'none';

            _injectSettingsGear();
            _applyCanvasDims(_drumCanvas);
            window.addEventListener('resize', _onWinResize);
            // Optional-chain .on as well as the receiver: older
            // slopsmith cores (pre-Wave A) expose window.slopsmith
            // as a plain object without the on/off bus, and a bare
            // .on(...) call there would throw.
            window.slopsmith?.on?.('song:ready', _onSongReady);

            _resetForNewChart();

            _midiInit();
            _synthInit();
            _midiResumeHandler();

            _isReady = true;
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;
            _draw(bundle.notes, bundle.chords, bundle.currentTime, bundle.beats);
        },
        resize(/* w, h */) {
            if (!_isReady) return;
            _applyCanvasDims(_drumCanvas);
        },
        destroy() {
            _isReady = false;
            window.removeEventListener('resize', _onWinResize);
            if (window.slopsmith) window.slopsmith.off?.('song:ready', _onSongReady);
            _midiPauseHandler();
            _teardown(/* restoreCanvas */ true);
        },
    };

    function _teardown(restoreCanvas) {
        if (_drumCanvas) {
            _drumCanvas.remove();
            _drumCanvas = null;
            _drumCtx = null;
        }
        _removeSettingsPanel();
        _removeSettingsGear();
        _restoreControlsStyle();

        _releaseAllSounding();

        if (restoreCanvas && _highwayCanvas) {
            _highwayCanvas.style.display = _prevHighwayDisplay;
            _highwayCanvas = null;
            _prevHighwayDisplay = '';
        }

        _latestNotes = null;
        _latestChords = null;
        _latestTime = 0;
    }
}

createFactory.matchesArrangement = function (songInfo) {
    if (!songInfo) return false;
    if (songInfo.arrangement && DRUMS_PATTERNS.test(songInfo.arrangement)) return true;
    if (Array.isArray(songInfo.arrangements)) {
        const idx = songInfo.arrangement_index;
        const arr = songInfo.arrangements.find(a => a.index === idx);
        if (arr && DRUMS_PATTERNS.test(arr.name)) return true;
    }
    return false;
};

window.slopsmithViz_drums = createFactory;

})();
