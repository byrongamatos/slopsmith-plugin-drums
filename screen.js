// Drum Highway visualization plugin — lane-based scrolling drum
// renderer (Rock Band-style) with MIDI drum pad input, WebAudioFont
// drum kit sounds, and accuracy scoring.
//
// Wave C (slopsmith#36): per-instance refactor. Earlier Wave B
// landed setRenderer support with an explicit single-instance
// module-state assumption. Wave C lifts that: rendering, scoring,
// held-pad state, settings UI, and listeners are now all
// per-instance (closured inside createFactory). Main-player usage
// keeps its single-instance fast path via the
// window.slopsmithSplitscreen helper surface — its absence OR
// isActive()===false means "we're the only instance, always
// focused."
//
// Under splitscreen (N panels, N simultaneous drum instances):
//   - each panel hosts its own overlay canvas, scoring, settings
//     panel + gear docked inside the panel's bar
//   - MIDI input is a browser singleton; the currently-focused
//     panel (clicked most recently) is the sole recipient of
//     drum-pad note-on events
//   - focus-change clears held-pad / lane-flash state on the
//     outgoing panel
//   - _cfg.learnLane stays module-scope (per-user-intent — clicking
//     Learn in any panel assigns the next pad-hit-from-the-focused
//     device; the lane-row UI updates everywhere via class selector)
//
// song:ready event subscription is gone: each draw() edge-detects
// bundle.isReady false→true per-instance, which is correct for N
// panels without the cross-instance fan-out of the global bus.

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

// Numeric cfg normaliser — parseFloat/parseInt return NaN on junk
// like "foo" or "", which would propagate into AudioParam.gain.value
// (breaks playback) or MIDI channel filtering (misroutes events).
// Clamp to [min, max] when provided and fall back to the default on
// any non-finite result.
function _readNum(key, fallback, min, max) {
    const raw = _readStore(key);
    if (raw == null) return fallback;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
}

// Lane ids declared here so the customMapping validator below can
// shape-check persisted user mappings. The full DRUM_LANES table
// appears further down (with colors, symbols, MIDI-note lists); the
// ids are duplicated here once because _cfg initialises before the
// DRUM_LANES block runs.
const _VALID_LANE_IDS = new Set([
    'hihat', 'snare', 'tom1', 'tom2', 'tom3', 'crash', 'ride', 'kick',
]);

// Validate a customMapping object loaded from localStorage. Storage
// is user-controlled (manual edits, another plugin, synced profiles),
// so parsing the raw JSON is NOT enough — we need to reject
// non-object / array inputs, strip __proto__ / constructor /
// prototype keys to block prototype-pollution, and drop any
// (key, value) pair that isn't (MIDI note 0-127, known lane id).
// Returns a clean null-prototype object, or null if nothing survives.
function _validateCustomMapping(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const clean = Object.create(null);
    let hasEntries = false;
    for (const key of Object.keys(raw)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        const midi = parseInt(key, 10);
        if (!Number.isFinite(midi) || midi < 0 || midi > 127) continue;
        const val = raw[key];
        if (typeof val !== 'string' || !_VALID_LANE_IDS.has(val)) continue;
        clean[midi] = val;
        hasEntries = true;
    }
    return hasEntries ? clean : null;
}

const _cfg = {
    midiInputId:    _readStore(STORE_KEYS.midiInputId) || '',
    synthVolume:    _readNum(STORE_KEYS.synthVolume, 0.7, 0, 1),
    // -1 = all, 0..15 are the 16 MIDI channels (9 = "ch10" Drums)
    midiChannel:    Math.round(_readNum(STORE_KEYS.midiChannel, -1, -1, 15)),
    hitDetection:   _readStore(STORE_KEYS.hitDetection) === 'true',
    showLaneLabels: _readStore(STORE_KEYS.showLaneLabels) !== 'false',
    customMapping:  (function () {
        try {
            const raw = JSON.parse(_readStore(STORE_KEYS.customMapping) || 'null');
            return _validateCustomMapping(raw);
        } catch (_) { return null; }
    })(),
    // Transient: which lane is in learn mode. Module-scope across
    // panels — the Learn-mode UX is "click Learn in any panel, then
    // hit a pad on the focused MIDI device." The next focused-panel
    // drum-hit consumes the sentinel and remaps. Per-panel learnLane
    // would imply N independent in-flight remap operations, which is
    // surprising when there's only one user + one MIDI kit.
    learnLane:      null,
};

function _saveCfg(key, val) {
    // Apply the same shape validation the _cfg initialiser uses so
    // anything we write to localStorage is also trustworthy on next
    // load. Belt-and-suspenders — Learn-mode builds its map from
    // Object.assign({}, _getActiveDrumMap()) + a fresh midi+laneId
    // pair, so input is already well-formed, but routing through
    // the validator means any future caller can't accidentally
    // persist garbage.
    if (key === 'customMapping' && val !== null) {
        val = _validateCustomMapping(val);
    }
    _cfg[key] = val;
    const storeKey = STORE_KEYS[key];
    if (!storeKey) return;
    const serialised = typeof val === 'object' && val !== null
        ? JSON.stringify(val) : String(val);
    try { localStorage.setItem(storeKey, serialised); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════
// Module-level singletons (browser-unique resources)
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
// Wave C: routes incoming MIDI events to the currently-focused drum
// instance (null when no instance is active). Instances claim this
// on focus-change and release it on defocus / destroy.
let _activeInstance = null;
// Registry of live factory instances so module-level helpers (device-
// list refresh, shutdown-when-last-destroys) can iterate.
const _instances = new Set();
// Monotonic id for per-instance DOM tagging (useful for debugging).
let _nextInstanceId = 0;

// ── Synth ─────────────────────────────────────────────────────────────
let _audioCtx = null;
let _synthPlayer = null;
let _synthGain = null;
let _synthLoading = false;
let _playerScriptLoaded = false;
const _drumPresets = {};           // midiNote -> preset

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
// WebAudioFont drum kit synthesizer (module-level — one audio context per tab)
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
// Web MIDI input (module-level — one MIDI access per tab)
// ═══════════════════════════════════════════════════════════════════════

async function _midiInit() {
    if (_midiAccess) return;
    if (!navigator.requestMIDIAccess) return;
    try {
        _midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        _midiAccess.onstatechange = () => _midiUpdateAllDeviceLists();
        _midiAutoConnect();
        // Populate whatever settings panels are open — may be zero
        // on first init, but if any instance has its settings open
        // we want the MIDI <select> filled.
        _midiUpdateAllDeviceLists();
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
    // Iterate ALL live instances — _activeInstance can be null
    // (no panel focused yet) or stale (focus swapped between
    // device events). Iterating _instances guarantees no panel
    // shows "stuck" pressed lanes when it later becomes focused.
    for (const inst of _instances) {
        if (inst && typeof inst._releaseAllSounding === 'function') {
            inst._releaseAllSounding();
        }
    }
    // Learn-mode is a module-scope sentinel, so clear once and
    // refresh every panel's Learn UI to keep buttons in sync.
    _cfg.learnLane = null;
    _updateLearnUI();

    // Persist regardless of match. Empty id is the explicit "None"
    // option and must be saved so _midiAutoConnect respects the
    // opt-out on next init instead of auto-picking inputs[0] again.
    _saveCfg('midiInputId', id || '');

    if (!id || !_midiAccess) {
        _midiUpdateAllDeviceLists();
        return;
    }
    _midiAccess.inputs.forEach(inp => {
        if (inp.id === id) {
            _midiInput = inp;
            // Wire the handler only when at least one renderer is
            // active. A late _midiConnect from an async _midiInit
            // that resolved post-destroy would otherwise re-enable
            // scoring / synth in the background.
            if (_midiActive) _midiInput.onmidimessage = _midiOnMessage;
        }
    });
    _midiUpdateAllDeviceLists();
}

function _midiPauseHandler() {
    // Called from destroy() when the LAST instance goes away —
    // detach the message handler so the connected kit stops firing
    // hits into a plugin no longer visible. Flipping _midiActive
    // BEFORE the detach also prevents a late-resolving _midiConnect
    // (from an in-flight _midiInit started in the most recent init())
    // from re-wiring the handler on an already-destroyed renderer.
    // Keep _midiInput so a future init() can reattach without the
    // user re-picking.
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
    // Only the focused instance receives MIDI. Module-level
    // _activeInstance is the routing slot; it points at null when
    // no instance is focused (splitscreen toggled off mid-session
    // between teardowns, or no instance initialised yet).
    if (!_activeInstance) return;

    const [status, note, velocity] = e.data;
    const ch = status & 0x0F;
    if (_cfg.midiChannel >= 0 && ch !== _cfg.midiChannel) return;

    const cmd = status & 0xF0;
    if (cmd === 0x90 && velocity > 0) {
        _activeInstance._handleDrumHit(note, velocity);
    }
    // Drums don't need note-off handling (one-shot hits)
}

function _midiUpdateAllDeviceLists() {
    if (!_midiAccess) return;
    const inputs = [];
    _midiAccess.inputs.forEach(inp => inputs.push(inp));

    // Every instance's settings panel (if open) has a
    // `.drums-midi-select` node. Iterate all of them so a
    // device plug/unplug reflects everywhere simultaneously.
    const selects = document.querySelectorAll('.drums-midi-select');
    for (const sel of selects) {
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
            // inp.name can be null / empty across browsers and devices
            // (Firefox historically, some class-compliant kits); fall
            // back through manufacturer → id so the dropdown never
            // literally says "null".
            opt.textContent = inp.name || inp.manufacturer || inp.id || 'Unknown device';
            if (_midiInput && _midiInput.id === inp.id) opt.selected = true;
            sel.appendChild(opt);
        }
    }
}

// Refresh every Learn button across every open settings panel so the
// "..." pending indicator and the active-lane highlight reflect the
// shared _cfg.learnLane sentinel.
function _updateLearnUI() {
    const learnBtns = document.querySelectorAll('.drums-learn-btn');
    learnBtns.forEach(btn => {
        const idx = parseInt(btn.dataset.lane);
        btn.textContent = _cfg.learnLane === idx ? '...' : 'Learn';
        btn.style.color = _cfg.learnLane === idx ? '#ff0' : '#aaa';
    });
}

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helper wrappers
// ═══════════════════════════════════════════════════════════════════════
//
// Centralise the "am I in splitscreen?" / "which panel are my chrome
// anchors?" queries so instance code can read the runtime environment
// cheaply. Absence of window.slopsmithSplitscreen OR isActive()===false
// means "main-player, always focused" from the plugin's POV.

function _ssActive() {
    const ss = window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    // Validate the FULL surface this plugin consumes, not just
    // isActive(). If a future splitscreen build ships partial
    // helpers (or an older bundled splitscreen lacks one of the
    // newer methods), report "not active" so the wrappers fall
    // back to the main-player single-instance fast path rather
    // than reaching a half-broken splitscreen state where focus
    // never lands on any instance and MIDI routing dies.
    return typeof ss.isCanvasFocused === 'function'
        && typeof ss.panelChromeFor === 'function'
        && typeof ss.settingsAnchorFor === 'function'
        && typeof ss.onFocusChange === 'function'
        && typeof ss.offFocusChange === 'function';
}

function _ssPanelChrome(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.panelChromeFor === 'function')
        ? ss.panelChromeFor(highwayCanvas) : null;
}

function _ssSettingsAnchor(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.settingsAnchorFor === 'function')
        ? ss.settingsAnchorFor(highwayCanvas) : null;
}

function _ssIsCanvasFocused(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return true;  // main-player fast path
    return !!(ss && typeof ss.isCanvasFocused === 'function' &&
              ss.isCanvasFocused(highwayCanvas));
}

// ═══════════════════════════════════════════════════════════════════════
// Round rect helper (stateless)
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

function _timeToY(dt, nowLineY, topY) {
    if (dt <= 0) return nowLineY + (-dt / 0.3) * 20;
    const frac = dt / VISIBLE_SECONDS;
    return nowLineY - frac * (nowLineY - topY);
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract (multi-instance)
// ═══════════════════════════════════════════════════════════════════════

function createFactory() {
    const _instanceId = ++_nextInstanceId;

    // Lifecycle
    let _isReady = false;

    // Rendering state
    let _drumCanvas = null;
    let _drumCtx = null;
    let _highwayCanvas = null;
    let _prevHighwayDisplay = '';

    // Controls-style snapshot — only populated when we actually nudged
    // `#player-controls`, which is main-player-only. Splitscreen panels
    // already have their control bar layered above the canvas.
    let _controlsStyleTouched = false;
    let _prevControlsPosition = '';
    let _prevControlsZIndex = '';
    let _controlsAnchor = null;

    // Settings UI
    let _settingsPanel = null;
    let _settingsGear = null;
    let _settingsVisible = false;

    // Held / flash state — per-instance so each panel only shows the
    // pads ITS focused user is hitting.
    const _heldPads = new Map();          // midi note -> {velocity, wall}
    const _wrongFlashes = [];             // [{lane, wall}]
    const _laneFlashes = [];              // [{laneIdx, wall, color}]

    // Scoring
    let _hits = 0, _misses = 0, _streak = 0, _bestStreak = 0;
    const _hitNoteKeys = new Set();
    const _missedNoteKeys = new Set();

    // Latest bundle snapshot — cached each frame so MIDI handler
    // (async wrt draw) can score against the filter-aware chart
    // the user sees.
    let _latestNotes = null, _latestChords = null, _latestTime = 0;

    // Wave C: replace the module-level `song:ready` subscription
    // with a bundle.isReady edge-detect per-instance. The global
    // event fires N times under splitscreen (once per panel's
    // highway); edge-detecting locally scopes the reset correctly.
    let _lastBundleIsReady = false;

    // Wave C focus state
    let _isFocused = false;

    // ── Listener refs (per-instance so destroy() detach matches) ──
    const _onWinResize = () => _applyCanvasDims();
    const _onFocusChange = () => _updateFocusState();

    // ── Focus management ──
    //
    // _instanceDestroyed is a belt-and-suspenders gate: even if the
    // splitscreen helper ever ships without an unsubscribe (or a
    // future version renames offFocusChange), the focus-change
    // handler will no-op against a destroyed instance rather than
    // mutating torn-down state. Defensive because the helper's
    // unsubscribe pathway is the only thing standing between a
    // lingering listener and a stale closure.
    let _instanceDestroyed = false;

    function _updateFocusState() {
        if (_instanceDestroyed) return;
        // _highwayCanvas is nulled by _teardown; a focus-change
        // callback fired between destroy() and the handler
        // detaching would otherwise call isCanvasFocused(null).
        if (!_highwayCanvas) return;
        const shouldFocus = _ssIsCanvasFocused(_highwayCanvas);
        if (shouldFocus && !_isFocused) {
            _isFocused = true;
            _activeInstance = instance;
        } else if (!shouldFocus && _isFocused) {
            _isFocused = false;
            // Outgoing panel: stop showing pressed lanes / flashes
            // that originated from MIDI hits the panel was the
            // recipient of while focused.
            _releaseAllSounding();
            if (_activeInstance === instance) _activeInstance = null;
        }
    }

    // Per-instance cleanup: clear visual hit state. Module-level
    // `_cfg.learnLane` is NOT touched here — it's a shared sentinel,
    // and it gets cleared by _midiConnect on device swap (which
    // already iterates every live instance to call this).
    function _releaseAllSounding() {
        _heldPads.clear();
        _wrongFlashes.length = 0;
        _laneFlashes.length = 0;
    }

    // ── MIDI event handler (called by _midiOnMessage via _activeInstance) ──

    function _handleDrumHit(midiNote, velocity) {
        if (midiNote < 0 || midiNote > 127) return;

        // Learn mode: assign this MIDI note to the pending lane.
        // _cfg.learnLane is module-scope so the assignment + UI
        // refresh apply uniformly across every open settings panel.
        if (_cfg.learnLane !== null) {
            const map = Object.assign({}, _getActiveDrumMap());
            map[midiNote] = DRUM_LANES[_cfg.learnLane].id;
            _saveCfg('customMapping', map);
            _cfg.learnLane = null;
            _updateLearnUI();
            _refreshSettingsMapping();
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

    // ── Hit detection / accuracy scoring (against cached filter-aware arrays) ──

    function _checkHit(playedMidi) {
        const t = _latestTime;
        const notes = _latestNotes;
        const chords = _latestChords;

        // No chart cached yet (song-change reconnect window, or the
        // very first frame after init before draw has caught up). Skip
        // scoring entirely — counting a hit as a miss here would inflate
        // the miss counter every time the user noodles on the pad during
        // a song switch, with no matching notes to score against.
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

    function _resetForNewChart() {
        _resetScoring();
        _heldPads.clear();
        // Wave C: no _primeLatestSnapshot — we don't consult the
        // bare `window.highway` global anymore (it's the main-
        // player's highway, not ours under splitscreen). First
        // MIDI hits before the first draw() just don't score.
    }

    // ── Settings panel + gear button (per-instance) ──

    function _injectSettingsGear() {
        if (_settingsGear) return;
        const anchor = _ssSettingsAnchor(_highwayCanvas) ||
                       document.getElementById('player-controls');
        if (!anchor) return;

        const gear = document.createElement('button');
        gear.className = 'btn-drums-settings px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        gear.dataset.drumsInstance = String(_instanceId);
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

        if (_ssActive()) {
            // Splitscreen: append to the panel bar.
            anchor.appendChild(gear);
        } else {
            // Main-player: insert before the close button.
            const closeBtn = anchor.querySelector('button:last-child');
            if (closeBtn) anchor.insertBefore(gear, closeBtn);
            else anchor.appendChild(gear);
        }
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
            _midiUpdateAllDeviceLists();
        }
    }

    // Rebuild the settings panel's MIDI mapping table after a Learn
    // assignment. Done in-place rather than rebuilding the whole
    // panel so the `<details>` open/closed state and the focused
    // form-control aren't disturbed.
    function _refreshSettingsMapping() {
        if (!_settingsPanel) return;
        const tbl = _settingsPanel.querySelector('.drums-map-table');
        if (!tbl) return;
        tbl.innerHTML = _buildMappingRows();
        _wireLearnButtons(_settingsPanel);
    }

    function _buildMappingRows() {
        return DRUM_LANES.map((lane, idx) => {
            const map = _getActiveDrumMap();
            const assigned = Object.entries(map).filter(([_, v]) => v === lane.id).map(([k]) => k).join(', ');
            return `<tr>
                <td style="color:${_rgbStr(lane.color[0], lane.color[1], lane.color[2])};font-weight:bold;padding:2px 6px;">${lane.label}</td>
                <td style="color:#888;padding:2px 6px;font-size:10px;">${assigned || 'none'}</td>
                <td style="padding:2px 4px;"><button class="drums-learn-btn" data-lane="${idx}"
                    style="background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:1px 6px;
                    font-size:10px;color:${_cfg.learnLane === idx ? '#ff0' : '#aaa'};cursor:pointer;">${_cfg.learnLane === idx ? '...' : 'Learn'}</button></td>
            </tr>`;
        }).join('');
    }

    function _wireLearnButtons(panel) {
        panel.querySelectorAll('.drums-learn-btn').forEach(btn => {
            btn.onclick = function () {
                const idx = parseInt(this.dataset.lane);
                _cfg.learnLane = _cfg.learnLane === idx ? null : idx;
                _updateLearnUI();
            };
        });
    }

    function _createSettingsPanel() {
        if (_settingsPanel) return;
        const panelChrome = _ssPanelChrome(_highwayCanvas);
        const mount = panelChrome || document.getElementById('player');
        if (!mount) return;

        const panel = document.createElement('div');
        panel.className = 'drums-settings-panel';
        panel.dataset.drumsInstance = String(_instanceId);
        panel.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:25;' +
            'background:rgba(8,8,20,0.94);border-bottom:1px solid #222;padding:6px 12px;' +
            'font-family:system-ui,sans-serif;display:none;max-height:50%;overflow-y:auto;';

        const channelOpts = '<option value="-1"' + (_cfg.midiChannel === -1 ? ' selected' : '') + '>All</option>' +
            '<option value="9"' + (_cfg.midiChannel === 9 ? ' selected' : '') + '>10 (Drums)</option>' +
            Array.from({length: 16}, (_, i) =>
                i === 9 ? '' : `<option value="${i}"${_cfg.midiChannel === i ? ' selected' : ''}>${i + 1}</option>`
            ).join('');

        // All form controls use classes (not ids) so N panels don't
        // collide on getElementById lookups. Handlers bind via
        // panel.querySelector scoped to this specific panel.
        panel.innerHTML = `
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">MIDI</span>
                    <select class="drums-midi-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;max-width:180px;">
                        <option value="">None</option>
                    </select>
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Vol</span>
                    <input type="range" class="drums-vol-slider" min="0" max="100"
                        value="${Math.round(_cfg.synthVolume * 100)}"
                        style="width:70px;accent-color:#ef4444;height:14px;">
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Ch</span>
                    <select class="drums-channel-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;width:72px;">
                        ${channelOpts}
                    </select>
                </div>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                    <input type="checkbox" class="drums-chk-labels" ${_cfg.showLaneLabels ? 'checked' : ''}
                        style="accent-color:#ef4444;"> Labels
                </label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                    <input type="checkbox" class="drums-chk-hits" ${_cfg.hitDetection ? 'checked' : ''}
                        style="accent-color:#22cc66;"> Hits
                </label>
                <button class="drums-reset-map" style="background:#1a1a2e;border:1px solid #333;border-radius:4px;
                    padding:2px 8px;font-size:10px;color:#aaa;cursor:pointer;">Reset Map</button>
            </div>
            <details style="margin-top:2px;">
                <summary style="font-size:10px;color:#666;cursor:pointer;">MIDI Mapping</summary>
                <table class="drums-map-table" style="font-size:11px;margin-top:4px;">${_buildMappingRows()}</table>
            </details>`;

        if (panelChrome) {
            panelChrome.appendChild(panel);
        } else {
            const controls = document.getElementById('player-controls');
            if (controls) mount.insertBefore(panel, controls);
            else mount.appendChild(panel);
        }
        _settingsPanel = panel;

        panel.querySelector('.drums-midi-select').onchange = function () {
            _midiConnect(this.value);
            _synthInit();
        };
        panel.querySelector('.drums-vol-slider').oninput = function () {
            _synthSetVolume(parseInt(this.value) / 100);
        };
        panel.querySelector('.drums-channel-select').onchange = function () {
            _saveCfg('midiChannel', parseInt(this.value));
        };
        panel.querySelector('.drums-chk-labels').onchange = function () {
            _saveCfg('showLaneLabels', this.checked);
        };
        panel.querySelector('.drums-chk-hits').onchange = function () {
            _saveCfg('hitDetection', this.checked);
            if (this.checked) _resetScoring();
        };
        panel.querySelector('.drums-reset-map').onclick = function () {
            _saveCfg('customMapping', null);
            // Rebuild the mapping table inline so the `<details>`
            // open state and panel scroll position survive the
            // reset. _refreshSettingsMapping rewires the Learn
            // button onclicks against the new <button> nodes.
            _refreshSettingsMapping();
            _midiUpdateAllDeviceLists();
        };

        _wireLearnButtons(panel);
    }

    function _removeSettingsPanel() {
        if (_settingsPanel) {
            _settingsPanel.remove();
            _settingsPanel = null;
        }
        _settingsVisible = false;
    }

    // ── Canvas / overlay management ──

    function _applyCanvasDims() {
        if (!_drumCanvas || !_drumCtx) return;
        // Prefer the splitscreen panel chrome as the source-of-truth
        // rect when we're in splitscreen; otherwise measure #player.
        const panelChrome = _ssPanelChrome(_highwayCanvas);
        const srcRect = panelChrome || document.getElementById('player');
        if (!srcRect) return;
        const w = srcRect.clientWidth;
        const h = srcRect.clientHeight;
        if (!w || !h) return;
        const dpr = window.devicePixelRatio || 1;
        _drumCanvas.width = w * dpr;
        _drumCanvas.height = h * dpr;
        _drumCanvas.style.width = w + 'px';
        _drumCanvas.style.height = h + 'px';
        _drumCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function _createOverlayCanvas() {
        const panelChrome = _ssPanelChrome(_highwayCanvas);
        const mount = panelChrome || document.getElementById('player');
        if (!mount) return null;

        const canvas = document.createElement('canvas');
        canvas.className = 'drum-highway-canvas';
        canvas.dataset.drumsInstance = String(_instanceId);
        canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:5;pointer-events:none;';

        if (panelChrome) {
            // Splitscreen panel chrome already has a bar at the
            // bottom; appending is fine — the bar has z-index above
            // our overlay's z-index:5.
            panelChrome.appendChild(canvas);
        } else {
            // Main-player path: insert before controls so controls
            // stay clickable above the overlay. Snapshot their
            // style and nudge them above z-index 5.
            const controls = document.getElementById('player-controls');
            if (controls) {
                mount.insertBefore(canvas, controls);
                _prevControlsPosition = controls.style.position;
                _prevControlsZIndex = controls.style.zIndex;
                _controlsStyleTouched = true;
                _controlsAnchor = controls;
                controls.style.position = 'relative';
                controls.style.zIndex = '20';
            } else {
                mount.appendChild(canvas);
            }
        }
        return canvas;
    }

    function _restoreControlsStyle() {
        if (!_controlsStyleTouched || !_controlsAnchor) return;
        _controlsAnchor.style.position = _prevControlsPosition;
        _controlsAnchor.style.zIndex = _prevControlsZIndex;
        _controlsStyleTouched = false;
        _prevControlsPosition = '';
        _prevControlsZIndex = '';
        _controlsAnchor = null;
    }

    // ── Drawing ──

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

        // Empty-but-loaded chart (e.g. arrangement filtered to nothing
        // by the difficulty slider, or a long rest). bundle.isReady is
        // already verified upstream in draw(); blank the overlay so
        // a previous chart's notes don't sit frozen on screen, but
        // the Wave B "treat empty as no chart and bail" early-return
        // is GONE — empty arrays during ready playback are still a
        // valid render path (paint backgrounds + lane labels even
        // without scrolling notes) so the kit lanes stay visible.
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

        // MIDI indicator — show on the focused panel only; non-focused
        // panels don't receive input so the dot would be misleading.
        if (_midiInput && _isFocused) {
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

    // ── Teardown ──

    function _teardown() {
        if (_drumCanvas) {
            _drumCanvas.remove();
            _drumCanvas = null;
            _drumCtx = null;
        }
        _removeSettingsPanel();
        _removeSettingsGear();
        _restoreControlsStyle();

        _releaseAllSounding();

        if (_highwayCanvas) {
            _highwayCanvas.style.display = _prevHighwayDisplay;
            _highwayCanvas = null;
            _prevHighwayDisplay = '';
        }

        _latestNotes = null;
        _latestChords = null;
        _latestTime = 0;
    }

    // ── Factory return: setRenderer contract ──

    const instance = {
        init(canvas /* , bundle */) {
            // Defensive teardown if a prior init wasn't paired with
            // destroy. Remove listeners, restore canvas, release
            // held state — mirrors destroy() exactly, INCLUDING
            // removing from _instances and pausing MIDI if we're
            // the last live instance. Without the _instances
            // cleanup, a re-init that subsequently fails early
            // (no mount / null ctx) would leave the instance
            // orphaned in the set, making _instances.size checks
            // inaccurate and preventing _midiPauseHandler from
            // ever running.
            if (_drumCanvas || _isReady) {
                window.removeEventListener('resize', _onWinResize);
                const ss = window.slopsmithSplitscreen;
                if (ss && typeof ss.offFocusChange === 'function') {
                    ss.offFocusChange(_onFocusChange);
                }
                _instances.delete(instance);
                if (_activeInstance === instance) _activeInstance = null;
                _teardown();
                _isReady = false;
                _isFocused = false;
                if (_instances.size === 0) _midiPauseHandler();
            }

            // Clear the destroyed sentinel so an init() following a
            // destroy() on the same factory object (e.g. highway
            // re-using a renderer across songs) re-enables focus
            // updates. Set to true in destroy() above — without this
            // reset, _updateFocusState would permanently no-op.
            _instanceDestroyed = false;

            _highwayCanvas = canvas;
            _prevHighwayDisplay = canvas ? canvas.style.display : '';

            _drumCanvas = _createOverlayCanvas();
            if (!_drumCanvas) {
                console.warn('[Drums] init: no mount container available; aborting');
                return;
            }
            _drumCtx = _drumCanvas.getContext('2d');
            if (!_drumCtx) {
                // 2D context unavailable — tear down our freshly
                // built overlay, restore any controls-style override,
                // and leave the highway canvas visible as a fallback.
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
            _applyCanvasDims();
            window.addEventListener('resize', _onWinResize);

            const ss = window.slopsmithSplitscreen;
            // Subscribe only when BOTH on/offFocusChange exist on
            // the helper. A subscribe-without-unsubscribe path
            // would leak the listener every init/destroy cycle and
            // — combined with _ssActive's strict surface check
            // returning false — also produce inconsistent focus
            // routing where the listener fires but the wrappers
            // treat splitscreen as inactive.
            if (ss && typeof ss.onFocusChange === 'function'
                   && typeof ss.offFocusChange === 'function') {
                ss.onFocusChange(_onFocusChange);
            }

            _resetForNewChart();

            _instances.add(instance);

            // Kick off MIDI + synth. One-time init — subsequent
            // instances no-op out because the module singletons are
            // already populated.
            _midiInit();
            _synthInit();

            _isReady = true;

            // Determine focus BEFORE resuming the MIDI handler so
            // _activeInstance is populated when onmidimessage gets
            // wired. Otherwise a MIDI message arriving in the
            // window between _midiResumeHandler and the first
            // focus-change event would route through _midiOnMessage
            // → null _activeInstance → silently dropped. Main-player
            // fast path takes effect synchronously here too.
            _updateFocusState();
            _midiResumeHandler();
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;

            // Wave C: bundle.isReady edge detect in place of the
            // global song:ready subscription. Each panel's highway
            // emits song:ready independently; subscribing at module
            // scope would fire N×. Edge-detecting per-instance
            // correctly scopes the reset.
            const isReady = !!bundle.isReady;
            if (isReady && !_lastBundleIsReady) {
                _resetForNewChart();
            }
            _lastBundleIsReady = isReady;

            // Loading / reconnect window — chart isn't confirmed
            // yet. Paint the plugin's base background so the
            // previous chart's notes + HUD don't sit frozen on
            // screen. Once bundle.isReady flips true we hand off to
            // _draw which paints lanes + scrolling notes.
            if (!isReady) {
                if (_drumCanvas && _drumCtx) {
                    const W = _drumCanvas.width / (window.devicePixelRatio || 1);
                    const H = _drumCanvas.height / (window.devicePixelRatio || 1);
                    _drumCtx.fillStyle = '#040408';
                    _drumCtx.fillRect(0, 0, W, H);
                }
                return;
            }

            _draw(bundle.notes, bundle.chords, bundle.currentTime, bundle.beats);
        },
        resize(/* w, h */) {
            if (!_isReady) return;
            _applyCanvasDims();
        },
        destroy() {
            _isReady = false;
            // Set BEFORE attempting the (best-effort) unsubscribe so
            // the focus-change handler's _instanceDestroyed guard
            // catches any event that sneaks through a failed /
            // missing offFocusChange call.
            _instanceDestroyed = true;
            window.removeEventListener('resize', _onWinResize);
            const ss = window.slopsmithSplitscreen;
            if (ss && typeof ss.offFocusChange === 'function') {
                ss.offFocusChange(_onFocusChange);
            }
            _instances.delete(instance);
            if (_activeInstance === instance) _activeInstance = null;
            _isFocused = false;
            // Pause the MIDI handler only if we're the last instance
            // standing. Otherwise other instances still need MIDI
            // events flowing into _midiOnMessage (which routes to the
            // currently-focused instance).
            if (_instances.size === 0) {
                _midiPauseHandler();
            }
            _teardown();
        },
        // Internal hooks used by module-level MIDI router + device-swap.
        _handleDrumHit,
        _releaseAllSounding,
    };

    return instance;
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
