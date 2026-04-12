// Drum Highway plugin — lane-based scrolling drum renderer (Rock Band-style)
// with MIDI drum pad input, WebAudioFont drum kit sounds, and accuracy scoring.
// Activates when a "Drums" arrangement is loaded, or via toggle button.

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════

let _drumEnabled = false;
let _drumAuto = false;
let _drumCanvas = null;
let _drumCtx = null;
let _rafId = null;
let _settingsPanel = null;
let _settingsVisible = false;

// ── Persisted settings ───────────────────────────────────────────────

const _cfg = {
    midiInputId:   localStorage.getItem('drums_midi_input') || '',
    synthVolume:   parseFloat(localStorage.getItem('drums_synth_vol') || '0.7'),
    midiChannel:   parseInt(localStorage.getItem('drums_midi_ch') || '-1'),  // -1 = all, 9 = ch10
    hitDetection:  localStorage.getItem('drums_hit_detect') === 'true',
    showLaneLabels: localStorage.getItem('drums_lane_labels') !== 'false',
    customMapping: JSON.parse(localStorage.getItem('drums_custom_map') || 'null'),
    learnLane:     null,  // transient: which lane is in learn mode
};

function _saveCfg(key, val) {
    _cfg[key] = val;
    const storeKey = 'drums_' + key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
    if (typeof val === 'object' && val !== null) {
        localStorage.setItem(storeKey, JSON.stringify(val));
    } else {
        localStorage.setItem(storeKey, String(val));
    }
}

// ── MIDI input state ─────────────────────────────────────────────────

let _midiAccess = null;
let _midiInput = null;
const _heldPads = new Map();       // midi note -> {velocity, wall}

// ── Synth state ──────────────────────────────────────────────────────

let _audioCtx = null;
let _synthPlayer = null;
let _synthPreset = null;
let _synthGain = null;
let _synthLoading = false;
let _playerScriptLoaded = false;

// ── Hit detection state ──────────────────────────────────────────────

const HIT_TOLERANCE = 0.05;        // seconds (drums need tighter timing)
let _hits = 0, _misses = 0, _streak = 0, _bestStreak = 0;
const _hitNoteKeys = new Set();     // "time|midi" strings for correctly hit notes
const _wrongFlashes = [];           // [{lane, wall}] for brief flashes
const _missedNoteKeys = new Set();  // "time|midi" strings for notes that passed unplayed

// ── Lane flash state ─────────────────────────────────────────────────
const _laneFlashes = [];            // [{laneIdx, wall, color}]

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

// Map a song note (encoded as string*24+fret) to a lane index
function _songNoteToLaneIdx(midi) {
    return _midiToLane[midi] !== undefined ? _midiToLane[midi] : -1;
}

// ═══════════════════════════════════════════════════════════════════════
// Color Helpers
// ═══════════════════════════════════════════════════════════════════════

function _rgbStr(r, g, b, a) {
    return a !== undefined
        ? `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`
        : `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
}

// Feedback colors
const COL_HIT    = '#00ff44';
const COL_WRONG  = '#ff4444';
const COL_MISSED = '#555566';

// ═══════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════

const VISIBLE_SECONDS = 3.0;
const NOW_LINE_Y_FRAC = 0.85;     // Now line at 85% from top (like guitar/piano)
const LABEL_H = 24;               // Lane label height at bottom
const LANE_PAD = 1;               // Padding between lanes
const KICK_LANE_EXTRA = 20;       // Extra width for kick lane

// ═══════════════════════════════════════════════════════════════════════
// Script Loader
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
// WebAudioFont Drum Kit Synthesizer
// ═══════════════════════════════════════════════════════════════════════

const WAF_BASE = 'https://surikov.github.io/webaudiofontdata/sound/';
const WAF_PLAYER_URL = 'https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js';
const WAF_SF = 'JCLive_sf2_file';

// WebAudioFont has one file per drum MIDI note:
//   URL:  128NN_0_JCLive_sf2_file.js   (NN = MIDI note)
//   Var:  _drum_NN_0_JCLive_sf2_file
const DRUM_MIDI_NOTES = [35, 36, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 57, 59];

function _drumWafVar(note)  { return '_drum_' + note + '_0_' + WAF_SF; }
function _drumWafUrl(note)  { return WAF_BASE + '128' + note + '_0_' + WAF_SF + '.js'; }

// Per-note presets
const _drumPresets = {};  // midiNote -> preset

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

    // Load all drum note presets in parallel
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
    console.log('[Drums] Loaded ' + Object.keys(_drumPresets).length + ' drum presets');
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
// Web MIDI Input
// ═══════════════════════════════════════════════════════════════════════

async function _midiInit() {
    if (_midiAccess) return;
    if (!navigator.requestMIDIAccess) return;
    try {
        _midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        _midiAccess.onstatechange = () => _midiUpdateDeviceList();
        _midiAutoConnect();
    } catch (e) {
        console.warn('[Drums] MIDI access denied:', e);
    }
}

function _midiAutoConnect() {
    if (!_midiAccess) return;
    const inputs = [];
    _midiAccess.inputs.forEach(inp => inputs.push(inp));
    if (!inputs.length) return;

    const saved = _cfg.midiInputId;
    const target = inputs.find(i => i.id === saved) || inputs[0];
    _midiConnect(target.id);
}

function _midiConnect(id) {
    if (_midiInput) _midiInput.onmidimessage = null;
    _midiInput = null;

    if (!_midiAccess) return;
    _midiAccess.inputs.forEach(inp => {
        if (inp.id === id) {
            _midiInput = inp;
            _midiInput.onmidimessage = _midiOnMessage;
            _saveCfg('midiInputId', id);
        }
    });
    _midiUpdateDeviceList();
}

function _midiOnMessage(e) {
    const [status, note, velocity] = e.data;
    const ch = status & 0x0F;

    // Channel filter (-1 = all)
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

    // Visual feedback: flash the corresponding lane
    const laneIdx = _midiToLaneIdx(midiNote);
    if (laneIdx >= 0) {
        const lane = DRUM_LANES[laneIdx];
        _laneFlashes.push({
            laneIdx,
            wall: performance.now(),
            color: _rgbStr(lane.color[0], lane.color[1], lane.color[2], 0.6),
        });
    }

    // Hit detection
    if (_cfg.hitDetection) {
        _checkHit(midiNote);
    }
}

function _midiUpdateDeviceList() {
    const sel = document.getElementById('drums-midi-select');
    if (!sel || !_midiAccess) return;

    const inputs = [];
    _midiAccess.inputs.forEach(inp => inputs.push(inp));

    sel.innerHTML = '<option value="">None</option>' +
        inputs.map(inp => {
            const selected = _midiInput && _midiInput.id === inp.id ? 'selected' : '';
            return `<option value="${inp.id}" ${selected}>${inp.name}</option>`;
        }).join('');
}

// ═══════════════════════════════════════════════════════════════════════
// Hit Detection / Accuracy Scoring
// ═══════════════════════════════════════════════════════════════════════

function _checkHit(playedMidi) {
    const t = highway.getTime();
    const notes = highway.getNotes();
    const chords = highway.getChords();

    // Map the played MIDI note to a lane
    const playedLane = _midiToLaneIdx(playedMidi);
    if (playedLane < 0) return;

    let foundHit = false;

    // Check standalone notes
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

    // Check chord notes
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

function _updateMissedNotes(t) {
    if (!_cfg.hitDetection) return;
    const notes = highway.getNotes();
    const chords = highway.getChords();
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

    // Prune old flashes (>400ms)
    const now = performance.now();
    while (_wrongFlashes.length && now - _wrongFlashes[0].wall > 400) {
        _wrongFlashes.shift();
    }
    while (_laneFlashes.length && now - _laneFlashes[0].wall > 300) {
        _laneFlashes.shift();
    }
    // Clear old held pads (>200ms for visual feedback)
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

// ═══════════════════════════════════════════════════════════════════════
// Auto-detection
// ═══════════════════════════════════════════════════════════════════════

const DRUMS_PATTERNS = /drums|percussion|drum\s*kit/i;

function isDrumsArrangement() {
    const info = highway.getSongInfo();
    if (!info) return false;
    if (info.arrangement && DRUMS_PATTERNS.test(info.arrangement)) return true;
    if (info.arrangements) {
        const idx = info.arrangement_index;
        const arr = info.arrangements.find(a => a.index === idx);
        if (arr && DRUMS_PATTERNS.test(arr.name)) return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════════════
// Toggle Buttons
// ═══════════════════════════════════════════════════════════════════════

function _drumInjectButton() {
    const controls = document.getElementById('player-controls');
    if (!controls || document.getElementById('btn-drums')) return;

    const closeBtn = controls.querySelector('button:last-child');

    const btn = document.createElement('button');
    btn.id = 'btn-drums';
    btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
    btn.textContent = 'Drums';
    btn.title = 'Toggle drum highway view';
    btn.onclick = () => _drumToggle(false);
    controls.insertBefore(btn, closeBtn);

    const gear = document.createElement('button');
    gear.id = 'btn-drums-settings';
    gear.className = 'px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
    gear.innerHTML = '&#9881;';
    gear.title = 'Drum settings (MIDI, sounds, scoring)';
    gear.onclick = _toggleSettings;
    controls.insertBefore(gear, closeBtn);
}

function _drumUpdateButton() {
    const btn = document.getElementById('btn-drums');
    const gear = document.getElementById('btn-drums-settings');
    if (btn) {
        if (_drumEnabled) {
            btn.className = 'px-3 py-1.5 bg-red-900/50 rounded-lg text-xs text-red-300 transition';
            btn.textContent = 'Drums \u2713';
        } else {
            btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
            btn.textContent = 'Drums';
        }
    }
    if (gear) gear.classList.toggle('hidden', !_drumEnabled);
}

function _drumToggle(auto) {
    if (auto && _drumEnabled && !_drumAuto) return;
    _drumEnabled = !_drumEnabled || auto;
    _drumAuto = auto && _drumEnabled;
    _drumUpdateButton();

    if (_drumEnabled) {
        _drumShow();
    } else {
        _drumHide();
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Settings Panel
// ═══════════════════════════════════════════════════════════════════════

function _toggleSettings() {
    _settingsVisible = !_settingsVisible;
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

    // Build mapping table rows
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

    // Wire up events
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
    };

    // Learn buttons
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
// Canvas Management
// ═══════════════════════════════════════════════════════════════════════

function _drumShow() {
    const hwCanvas = document.getElementById('highway-canvas') || document.getElementById('highway');
    if (hwCanvas) hwCanvas.style.display = 'none';

    if (!_drumCanvas) {
        const player = document.getElementById('player');
        if (!player) return;

        _drumCanvas = document.createElement('canvas');
        _drumCanvas.id = 'drum-highway-canvas';
        _drumCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:5;pointer-events:none;';

        const controls = document.getElementById('player-controls');
        if (controls) {
            player.insertBefore(_drumCanvas, controls);
            controls.style.position = 'relative';
            controls.style.zIndex = '20';
        } else {
            player.appendChild(_drumCanvas);
        }
        _drumCtx = _drumCanvas.getContext('2d');
    }

    _createSettingsPanel();
    _drumResize();
    window.addEventListener('resize', _drumResize);
    if (!_rafId) _rafId = requestAnimationFrame(_drumDraw);

    _midiInit();
    _synthInit();
}

function _drumHide() {
    const hwCanvas = document.getElementById('highway-canvas') || document.getElementById('highway');
    if (hwCanvas) hwCanvas.style.display = '';

    if (_drumCanvas) {
        window.removeEventListener('resize', _drumResize);
        _drumCanvas.remove();
        _drumCanvas = null;
        _drumCtx = null;
    }
    if (_rafId) {
        cancelAnimationFrame(_rafId);
        _rafId = null;
    }
    _removeSettingsPanel();
}

function _drumResize() {
    if (!_drumCanvas) return;
    const player = document.getElementById('player');
    if (!player) return;
    const dpr = window.devicePixelRatio || 1;
    _drumCanvas.width = player.clientWidth * dpr;
    _drumCanvas.height = player.clientHeight * dpr;
    _drumCanvas.style.width = player.clientWidth + 'px';
    _drumCanvas.style.height = player.clientHeight + 'px';
    if (_drumCtx) _drumCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ═══════════════════════════════════════════════════════════════════════
// Round Rect Helper
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
// Lane Geometry (vertical — lanes are columns, notes scroll top to bottom)
// ═══════════════════════════════════════════════════════════════════════

function _computeLaneLayout(W, H) {
    const numLanes = DRUM_LANES.length;
    const padL = 10;
    const padR = 10;
    const availW = W - padL - padR;

    // Kick lane gets extra width
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
    // dt > 0 means note is in the future (above now line)
    // dt <= 0 means note has passed (below now line)
    if (dt <= 0) return nowLineY + (-dt / 0.3) * 20;
    const frac = dt / VISIBLE_SECONDS;
    return nowLineY - frac * (nowLineY - topY);
}

let _debugLogged = false;
function _drumDraw() {
    _rafId = requestAnimationFrame(_drumDraw);
    if (!_drumCanvas || !_drumCtx) return;

    const notes = highway.getNotes();
    const chords = highway.getChords();
    const t = highway.getTime();

    if (!_debugLogged && (notes || chords)) {
        _debugLogged = true;
        const noteCount = notes ? notes.length : 0;
        const chordCount = chords ? chords.length : 0;
        console.log('[Drums] Highway data:', noteCount, 'notes,', chordCount, 'chords');
        if (notes && notes.length > 0) {
            const sample = notes.slice(0, 5).map(n => {
                const midi = noteToMidi(n.s, n.f);
                const lane = _songNoteToLaneIdx(midi);
                return `s=${n.s} f=${n.f} midi=${midi} lane=${lane}`;
            });
            console.log('[Drums] First notes:', sample);
        }
        console.log('[Drums] Song info:', highway.getSongInfo());
    }

    if (!notes && !chords) return;

    const W = _drumCanvas.width / (window.devicePixelRatio || 1);
    const H = _drumCanvas.height / (window.devicePixelRatio || 1);
    const ctx = _drumCtx;

    _updateMissedNotes(t);

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

        // Subtle lane background stripe
        ctx.fillStyle = _rgbStr(r * 0.06, g * 0.06, b * 0.06, 0.5);
        ctx.fillRect(ll.x, topY, ll.w, nowLineY + 20);

        // Lane border (right edge)
        ctx.strokeStyle = _rgbStr(r * 0.15, g * 0.15, b * 0.15, 0.3);
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(ll.x + ll.w, topY);
        ctx.lineTo(ll.x + ll.w, nowLineY + 20);
        ctx.stroke();

        // Lane flash (from MIDI hit)
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

    // ── Kick lane separator (left edge of kick column) ──────────────
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

    // ── Beat / measure lines (horizontal) ───────────────────────────
    const beats = highway.getBeats();
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

    // ── Now line (horizontal) ───────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(laneLayout[0].x, nowLineY);
    ctx.lineTo(laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w, nowLineY);
    ctx.stroke();

    // ── Scrolling notes ─────────────────────────────────────────────
    _drawScrollingNotes(ctx, notes, chords, t, laneLayout, nowLineY, topY, W, H);

    // ── Lane labels (at the bottom, below now line) ─────────────────
    if (_cfg.showLaneLabels) {
        _drawLaneLabels(ctx, laneLayout, nowLineY, H);
    }

    // ── Accuracy HUD ────────────────────────────────────────────────
    if (_cfg.hitDetection && (_hits + _misses) > 0) {
        _drawAccuracyHUD(ctx, W, H);
    }

    // ── MIDI status indicator ───────────────────────────────────────
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

// ── Draw Scrolling Notes (vertical — notes fall top to bottom) ──────

function _drawScrollingNotes(ctx, notes, chords, t, laneLayout, nowLineY, topY, W, H) {
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

        // Skip if off-screen
        if (y < -20 || y > nowLineY + 30) continue;

        const isActive = Math.abs(dt) < 0.03;

        // Determine color
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
            // ── Kick: full-height bar spanning all lanes ────────────
            const barW = ll.w * 0.6 * velFactor;
            const barH = Math.max(4, 8 * velFactor);
            const firstLane = laneLayout[0];
            const lastLane = laneLayout[laneLayout.length - 1];
            const fullLeft = firstLane.x;
            const fullRight = lastLane.x + lastLane.w;

            // Full-width bar across all lanes
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

            // Brighter bar in the kick column
            ctx.fillStyle = _rgbStr(cr, cg, cb, useMissColor ? 0.3 : 0.9);
            ctx.fillRect(ll.x + 2, y - barH / 2, ll.w - 4, barH);

            // Active flash
            if (isActive && !useMissColor) {
                ctx.fillStyle = _rgbStr(cr, cg, cb, 0.12);
                ctx.fillRect(fullLeft, nowLineY - 5, fullRight - fullLeft, 10);
            }
        } else if (lane.symbol === 'diamond') {
            // ── Cymbal: diamond shape ───────────────────────────────
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
            // ── Hi-hat: X shapes with variation ─────────────────────
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
            // ── Toms / Snare: circles ───────────────────────────────
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

// ── Lane Labels (at the bottom of each column) ─────────────────────

function _drawLaneLabels(ctx, laneLayout, nowLineY, H) {
    const labelY = nowLineY + 8;
    const labelH = H - labelY;

    // Label background strip
    ctx.fillStyle = 'rgba(8,8,20,0.85)';
    ctx.fillRect(0, labelY, laneLayout[laneLayout.length - 1].x + laneLayout[laneLayout.length - 1].w + 10, labelH);

    // Top border
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

// ── Accuracy HUD ────────────────────────────────────────────────────

function _drawAccuracyHUD(ctx, W, H) {
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
// Hook into playSong
// ═══════════════════════════════════════════════════════════════════════

function _drumOnSongLoad() {
    _drumInjectButton();
    _resetScoring();

    setTimeout(() => {
        if (isDrumsArrangement()) {
            _drumToggle(true);
        } else if (_drumAuto) {
            _drumEnabled = false;
            _drumAuto = false;
            _drumHide();
            _drumUpdateButton();
        }
    }, 500);
}

const _origPlaySong = window.playSong;
window.playSong = async function (filename, arrangement) {
    if (_drumAuto) {
        _drumEnabled = false;
        _drumAuto = false;
        _drumHide();
    }
    await _origPlaySong(filename, arrangement);
    _drumOnSongLoad();
};

const _origReconnect = highway.reconnect.bind(highway);
highway.reconnect = function (filename, arrangement) {
    _resetScoring();
    _origReconnect(filename, arrangement);
    setTimeout(() => {
        if (isDrumsArrangement()) {
            if (!_drumEnabled) _drumToggle(true);
        } else if (_drumAuto) {
            _drumEnabled = false;
            _drumAuto = false;
            _drumHide();
            _drumUpdateButton();
        }
    }, 500);
};

})();
