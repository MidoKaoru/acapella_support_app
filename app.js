/**
 * app.js
 * アプリ全体の初期化・タブ管理・共通コントローラー
 *
 * iOS Safari 注意点：
 *   - AudioContext はユーザー操作（タップ）後に作成 / resume する必要がある
 *   - getAudioContext() を各操作ハンドラーの先頭で呼ぶことで対応
 */

'use strict';

// ─── 共有 AudioContext ────────────────────────
let _audioContext = null;

function getAudioContext() {
  if (!_audioContext) {
    _audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_audioContext.state === 'suspended') {
    _audioContext.resume();
  }
  return _audioContext;
}

// ─── モジュールインスタンス ──────────────────
const pitchPipe = new PitchPipe();
const metronome = new Metronome();

// ─── タブ管理 ────────────────────────────────
function initTabs() {
  const tabBtns   = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;

      tabBtns.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      tabPanels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      document.getElementById(`tab-${target}`).classList.add('active');
    });
  });
}

// ─── ピッチパイプ UI ─────────────────────────
function initPitchPipe() {
  // 音名ボタンを動的生成
  const grid = document.getElementById('note-grid');
  pitchPipe.notes.forEach(note => {
    const btn = document.createElement('button');
    btn.className = `note-btn${note.isSharp ? ' sharp' : ''}`;
    btn.dataset.note = note.name;
    btn.setAttribute('aria-label', `${note.name}（${note.solfege}）`);
    btn.innerHTML = `${note.name}<span class="note-sub">${note.solfege}</span>`;

    btn.addEventListener('click', () => {
      const ctx = getAudioContext();
      pitchPipe.setAudioContext(ctx);
      const isActive = pitchPipe.toggle(note.name);
      btn.classList.toggle('active', isActive);
    });

    grid.appendChild(btn);
  });

  // 音色選択
  document.querySelectorAll('#wave-type .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#wave-type .segment-btn')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      pitchPipe.setWaveType(btn.dataset.wave);
    });
  });

  // 基準周波数スライダー
  const freqSlider  = document.getElementById('freq-slider');
  const freqDisplay = document.getElementById('freq-display');

  function applyFreq(raw) {
    const freq = Math.max(420, Math.min(460, parseFloat(raw)));
    const rounded = Math.round(freq * 10) / 10;
    pitchPipe.setBaseFreq(rounded);
    freqDisplay.textContent = `${rounded.toFixed(1)} Hz`;
    freqSlider.value = rounded;
  }

  freqSlider.addEventListener('input', () => applyFreq(freqSlider.value));

  document.getElementById('freq-down-big').addEventListener('click', () =>
    applyFreq((parseFloat(freqSlider.value) - 1).toFixed(1)));
  document.getElementById('freq-down').addEventListener('click', () =>
    applyFreq((parseFloat(freqSlider.value) - 0.1).toFixed(1)));
  document.getElementById('freq-up').addEventListener('click', () =>
    applyFreq((parseFloat(freqSlider.value) + 0.1).toFixed(1)));
  document.getElementById('freq-up-big').addEventListener('click', () =>
    applyFreq((parseFloat(freqSlider.value) + 1).toFixed(1)));

  // 全音停止
  document.getElementById('stop-notes-btn').addEventListener('click', () => {
    pitchPipe.stopAll();
    document.querySelectorAll('.note-btn').forEach(b => b.classList.remove('active'));
  });
}

// ─── メトロノーム UI ─────────────────────────
function initMetronome() {
  const bpmInput        = document.getElementById('bpm-input');
  const bpmSlider       = document.getElementById('bpm-slider');
  const bottomBpm       = document.getElementById('bottom-bpm');
  const metroToggle     = document.getElementById('metro-toggle');
  const metroToggleLabel = document.getElementById('metro-toggle-label');
  const beatIndicator   = document.getElementById('beat-indicator');

  // BPM 表示を一括更新
  function applyBPM(value) {
    const bpm = Math.max(20, Math.min(300, Math.round(Number(value))));
    metronome.setBPM(bpm);
    bpmInput.value    = bpm;
    bpmSlider.value   = bpm;
    bottomBpm.textContent = bpm;
  }

  // 拍ドット を再描画
  function buildBeatDots(count) {
    beatIndicator.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const dot = document.createElement('div');
      dot.className = i === 0 ? 'beat-dot accent' : 'beat-dot';
      dot.dataset.beat = i;
      beatIndicator.appendChild(dot);
    }
  }

  // メトロノームからの拍コールバック → 対応ドットを点灯
  metronome.onBeat = (beatIndex) => {
    document.querySelectorAll('.beat-dot').forEach(d => d.classList.remove('lit'));
    if (beatIndex >= 0) {
      const dot = beatIndicator.querySelector(`[data-beat="${beatIndex}"]`);
      if (dot) dot.classList.add('lit');
    }
  };

  // BPM 入力
  bpmInput.addEventListener('change', () => applyBPM(bpmInput.value));
  bpmInput.addEventListener('blur',   () => applyBPM(bpmInput.value));

  // BPM スライダー
  bpmSlider.addEventListener('input', () => applyBPM(bpmSlider.value));

  // ±ボタン
  document.getElementById('bpm-down-big').addEventListener('click', () => applyBPM(metronome.bpm - 10));
  document.getElementById('bpm-down').addEventListener('click',     () => applyBPM(metronome.bpm - 1));
  document.getElementById('bpm-up').addEventListener('click',       () => applyBPM(metronome.bpm + 1));
  document.getElementById('bpm-up-big').addEventListener('click',   () => applyBPM(metronome.bpm + 10));

  // 拍子選択
  document.querySelectorAll('#time-sig .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#time-sig .segment-btn')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      metronome.setTimeSignature(btn.dataset.sig);
      buildBeatDots(metronome.beatsPerMeasure);
    });
  });

  // クリック音選択
  document.querySelectorAll('#metro-sound-type .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#metro-sound-type .segment-btn')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      metronome.setSoundType(btn.dataset.sound);
    });
  });

  // タップテンポ
  document.getElementById('tap-btn').addEventListener('click', () => {
    getAudioContext(); // iOS: 最初のタップで AudioContext を起動
    const bpm = metronome.tapTempo();
    if (bpm !== null) applyBPM(bpm);
  });

  // スタート / ストップ
  metroToggle.addEventListener('click', () => {
    if (metronome.isPlaying) {
      metronome.stop();
      metroToggleLabel.textContent = 'スタート';
      metroToggle.classList.remove('playing');
    } else {
      const ctx = getAudioContext();
      metronome.setAudioContext(ctx);
      metronome.start();
      metroToggleLabel.textContent = 'ストップ';
      metroToggle.classList.add('playing');
    }
  });

  // 初期状態
  buildBeatDots(4);
  applyBPM(120);
}

// ─── リズムタブ ──────────────────────────────
function initRhythm() {
  const DIVISIONS = 12;
  const SVG_NS    = 'http://www.w3.org/2000/svg';
  const CX = 110, CY = 110, R_OUTER = 90, R_DOT = 11, R_INNER_DOT = 7;

  // プリセット定義（0=12時=表拍は含まない）
  const PRESETS = {
    none:            [],
    straight8:       [6],
    sixteenth:       [3, 6, 9],
    shuffle:         [8],
    halftimeShuffle: [2, 3, 5, 6, 8, 9, 11],
  };

  // 現在のステップ状態（0は常にtrue）
  const steps = new Array(DIVISIONS).fill(false);
  steps[0] = true;

  const svg = document.getElementById('rhythm-clock');

  // ── SVGを構築 ──────────────────────────────
  function buildClock() {
    svg.innerHTML = '';

    // 外周リング
    const ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('cx', CX); ring.setAttribute('cy', CY);
    ring.setAttribute('r', R_OUTER);
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'var(--border)');
    ring.setAttribute('stroke-width', '2');
    svg.appendChild(ring);

    for (let i = 0; i < DIVISIONS; i++) {
      const angle = (i / DIVISIONS) * 2 * Math.PI - Math.PI / 2; // 12時スタート
      const x = CX + R_OUTER * Math.cos(angle);
      const y = CY + R_OUTER * Math.sin(angle);

      // ドット本体
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', y);
      circle.dataset.step = i;
      circle.classList.add('rhythm-dot');
      updateDotStyle(circle, i);
      svg.appendChild(circle);

      // タップ領域（ドットより広い透明な円）
      const hit = document.createElementNS(SVG_NS, 'circle');
      hit.setAttribute('cx', x);
      hit.setAttribute('cy', y);
      hit.setAttribute('r', '18');
      hit.setAttribute('fill', 'transparent');
      hit.dataset.step = i;
      hit.addEventListener('click', onDotClick);
      svg.appendChild(hit);
    }

    // 中心ラベル
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', CX); label.setAttribute('y', CY + 5);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '12');
    label.setAttribute('fill', 'var(--text-secondary)');
    label.setAttribute('font-family', '-apple-system, sans-serif');
    label.textContent = '1拍';
    svg.appendChild(label);
  }

  function updateDotStyle(circle, i) {
    const isOn = steps[i];
    const isRoot = i === 0;
    const r = isOn ? R_DOT : R_INNER_DOT;
    circle.setAttribute('r', r);
    if (isRoot) {
      circle.setAttribute('fill', 'var(--primary)');
      circle.setAttribute('stroke', 'var(--primary)');
      circle.setAttribute('stroke-width', '2');
    } else if (isOn) {
      circle.setAttribute('fill', 'var(--primary)');
      circle.setAttribute('stroke', 'var(--primary)');
      circle.setAttribute('stroke-width', '2');
    } else {
      circle.setAttribute('fill', 'var(--surface)');
      circle.setAttribute('stroke', 'var(--border)');
      circle.setAttribute('stroke-width', '2');
    }
  }

  function refreshDots() {
    svg.querySelectorAll('.rhythm-dot').forEach(c => {
      updateDotStyle(c, parseInt(c.dataset.step));
    });
  }

  function onDotClick(e) {
    const i = parseInt(e.currentTarget.dataset.step);
    if (i === 0) return; // 表拍は変更不可
    steps[i] = !steps[i];
    refreshDots();
    applyToMetronome();
    syncPresetButtons();
  }

  function applyToMetronome() {
    const active = [];
    for (let i = 1; i < DIVISIONS; i++) {
      if (steps[i]) active.push(i);
    }
    metronome.setSubdivisionSteps(active);
  }

  function syncPresetButtons() {
    const activeSteps = JSON.stringify(
      Array.from({length: DIVISIONS}, (_, i) => i).filter(i => i > 0 && steps[i]).sort((a,b)=>a-b)
    );
    document.querySelectorAll('.preset-btn').forEach(btn => {
      const presetSteps = JSON.stringify([...(PRESETS[btn.dataset.preset] || [])].sort((a,b)=>a-b));
      btn.classList.toggle('active', presetSteps === activeSteps);
    });
  }

  function applyPreset(name) {
    const preset = PRESETS[name] ?? [];
    for (let i = 1; i < DIVISIONS; i++) steps[i] = preset.includes(i);
    refreshDots();
    applyToMetronome();
  }

  // ── プリセットボタン ──────────────────────
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyPreset(btn.dataset.preset);
    });
  });

  buildClock();
}

// ─── 全停止ボタン ────────────────────────────
function initGlobalStop() {
  document.getElementById('global-stop').addEventListener('click', () => {
    // メトロノーム停止
    if (metronome.isPlaying) {
      metronome.stop();
      metroToggleLabel.textContent = 'スタート';
      metroToggle.classList.remove('playing');
    }

    // ピッチパイプ全音停止
    pitchPipe.stopAll();
    document.querySelectorAll('.note-btn').forEach(b => b.classList.remove('active'));
  });
}

// ─── Service Worker 登録（PWA） ──────────────
function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.warn('Service Worker 登録失敗:', err);
      });
    });
  }
}

// ─── 初期化 ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initPitchPipe();
  initMetronome();
  initRhythm();
  initGlobalStop();
  registerSW();
});
