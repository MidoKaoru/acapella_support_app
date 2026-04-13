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
  const bpmInput      = document.getElementById('bpm-input');
  const bpmSlider     = document.getElementById('bpm-slider');
  const bottomBpm     = document.getElementById('bottom-bpm');
  const metroToggle   = document.getElementById('metro-toggle');
  const beatIndicator = document.getElementById('beat-indicator');

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
      metroToggle.textContent = '▶ スタート';
      metroToggle.classList.remove('playing');
    } else {
      const ctx = getAudioContext();
      metronome.setAudioContext(ctx);
      metronome.start();
      metroToggle.textContent = '■ ストップ';
      metroToggle.classList.add('playing');
    }
  });

  // 初期状態
  buildBeatDots(4);
  applyBPM(120);
}

// ─── 全停止ボタン ────────────────────────────
function initGlobalStop() {
  document.getElementById('global-stop').addEventListener('click', () => {
    // メトロノーム停止
    if (metronome.isPlaying) {
      metronome.stop();
      const toggle = document.getElementById('metro-toggle');
      toggle.textContent = '▶ スタート';
      toggle.classList.remove('playing');
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
  initGlobalStop();
  registerSW();
});
