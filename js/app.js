/**
 * app.js
 * アプリ全体の初期化・タブ管理・共通コントローラー
 *
 * iOS Safari 注意点：
 *   - AudioContext はユーザー操作（タップ）後に作成 / resume する必要がある
 *   - getAudioContext() を各操作ハンドラーの先頭で呼ぶことで対応
 */

'use strict';

// ─── ボタンアイコン SVG 文字列（library.js からも参照） ──
/* eslint-disable */
var BTN_PLAY  = '<svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" style="flex-shrink:0"><polygon points="2,1 11,6 2,11"/></svg>';
var BTN_PAUSE = '<svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" style="flex-shrink:0"><rect x="2" y="1" width="3" height="10" rx="0.5"/><rect x="7" y="1" width="3" height="10" rx="0.5"/></svg>';
var BTN_STOP  = '<svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" style="flex-shrink:0"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/></svg>';
// ピッチパイプアイコン（線画ギア、ボタン用）
var BTN_ICON_PITCH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><path d="M10.75,4.10 L10.90,1.56 L13.10,1.56 L13.25,4.10 L14.87,4.53 L16.27,2.41 L18.17,3.51 L17.03,5.78 L18.22,6.97 L20.50,5.83 L21.59,7.73 L19.47,9.13 L19.90,10.75 L22.44,10.90 L22.44,13.10 L19.90,13.25 L19.47,14.87 L21.59,16.27 L20.50,18.17 L18.22,17.03 L17.03,18.22 L18.17,20.50 L16.27,21.59 L14.87,19.47 L13.25,19.90 L13.10,22.44 L10.90,22.44 L10.75,19.90 L9.13,19.47 L7.73,21.59 L5.83,20.50 L6.97,18.22 L5.78,17.03 L3.51,18.17 L2.41,16.27 L4.53,14.87 L4.10,13.25 L1.56,13.10 L1.56,10.90 L4.10,10.75 L4.53,9.13 L2.41,7.73 L3.51,5.83 L5.78,6.97 L6.97,5.78 L5.83,3.51 L7.73,2.41 L9.13,4.53 Z"/><circle cx="12" cy="12" r="2" stroke-width="1.5"/></svg>';
// メトロノームアイコン（ボタン用）
var BTN_ICON_METRO = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><polygon points="6,22 18,22 14,3 10,3"/><line x1="12" y1="20" x2="16.5" y2="9"/><circle cx="16" cy="9.5" r="1.5" fill="currentColor" stroke="none"/></svg>';
/* eslint-enable */

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

  // 起動時にストレージの設定を適用
  const stored = getSettings();
  applyFreq(stored.baseFreq);
  pitchPipe.setWaveType(stored.waveType);
  document.querySelectorAll('#wave-type .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.wave === stored.waveType);
  });
}

// ─── BPM ⇔ スライダー値 変換（グローバル） ────────────────
// スライダー内部値 = BPM（40〜240 線形）
function sliderToBpm(v) {
  return Math.max(40, Math.min(240, Math.round(Number(v))));
}

function bpmToSlider(bpm) {
  return Math.max(40, Math.min(240, Math.round(Number(bpm))));
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
    const bpm = Math.max(40, Math.min(240, Math.round(Number(value))));
    metronome.setBPM(bpm);
    bpmInput.value        = bpm;
    bpmSlider.value       = bpmToSlider(bpm);
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

  // BPM スライダー（非線形スケール）
  bpmSlider.addEventListener('input', () => applyBPM(sliderToBpm(bpmSlider.value)));

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
  let tapCount = 0;
  let tapResetTimer = null;
  const tapDotsEl   = document.getElementById('tap-dots');
  const tapDotNodes = tapDotsEl ? tapDotsEl.querySelectorAll('.tap-progress-dot') : [];

  function resetTapState() {
    tapCount = 0;
    tapDotNodes.forEach(d => d.classList.remove('active'));
  }

  function playTapClick() {
    const ctx = getAudioContext();
    metronome.playBeatSound(ctx);
  }

  const tapBtn = document.getElementById('tap-btn');

  function handleTap(e) {
    playTapClick();

    // リップルエフェクト
    const btn    = tapBtn;
    const rect   = btn.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const ripple = document.createElement('span');
    ripple.className = 'tap-ripple';
    ripple.style.left = (clientX - rect.left) + 'px';
    ripple.style.top  = (clientY - rect.top)  + 'px';
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());

    // ドット更新
    tapCount = Math.min(tapCount + 1, 4);
    tapDotNodes.forEach((d, i) => d.classList.toggle('active', i < tapCount));

    // 2.5秒無操作でリセット
    clearTimeout(tapResetTimer);
    tapResetTimer = setTimeout(resetTapState, 2500);

    // 4回以上でBPM算出・反映
    const bpm = metronome.tapTempo();
    if (bpm !== null && tapCount >= 4) applyBPM(bpm);
  }

  tapBtn.addEventListener('touchstart', (e) => {
    e.preventDefault(); // click の遅延発火を抑止
    handleTap(e);
  }, { passive: false });

  // タッチ非対応環境（PC）用フォールバック
  tapBtn.addEventListener('mousedown', handleTap);

  // スタート / ストップ
  metroToggle.addEventListener('click', () => {
    if (metronome.isPlaying) {
      metronome.stop();
      metroToggleLabel.innerHTML = BTN_PLAY;
      metroToggle.classList.remove('playing');
    } else {
      const ctx = getAudioContext();
      metronome.setAudioContext(ctx);
      metronome.start();
      metroToggleLabel.innerHTML = BTN_PAUSE;
      metroToggle.classList.add('playing');
    }
  });

  // 初期状態
  buildBeatDots(4);
  applyBPM(120);  // 120 は 40〜240 範囲内

  // 起動時にストレージの設定を適用
  const storedSound = getSettings().soundType;
  metronome.setSoundType(storedSound);
  document.querySelectorAll('#metro-sound-type .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sound === storedSound);
  });
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
    halftimeShuffle: [4, 6, 10],
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

// ─── 「今の状態を保存」ボタン ─────────────────
function initSaveState() {
  document.getElementById('save-state-btn').addEventListener('click', () => {
    // 現在のピッチパイプのキー音を収集
    const activeKeys = Array.from(document.querySelectorAll('.note-btn.active'))
      .map(btn => btn.dataset.note);

    // 現在のBPM・基準周波数を取得
    const bpm     = metronome.bpm;
    const baseFreq = pitchPipe.baseFreq;

    // メトロノーム停止
    if (metronome.isPlaying) {
      metronome.stop();
      document.getElementById('metro-toggle-label').innerHTML = BTN_PLAY;
      document.getElementById('metro-toggle').classList.remove('playing');
    }

    // ピッチパイプ全音停止
    pitchPipe.stopAll();
    document.querySelectorAll('.note-btn').forEach(b => b.classList.remove('active'));

    // ライブラリの編集画面を新規追加モードで開く（初期値をキャプチャした状態で）
    openLibraryNewSong({ keys: activeKeys, bpm, baseFreq });
  });
}

// ─── 全停止ボタン ────────────────────────────
function initGlobalStop() {
  document.getElementById('global-stop').addEventListener('click', () => {
    // メトロノーム停止
    if (metronome.isPlaying) {
      metronome.stop();
      document.getElementById('metro-toggle-label').innerHTML = BTN_PLAY;
      document.getElementById('metro-toggle').classList.remove('playing');
    }

    // ピッチパイプ全音停止
    pitchPipe.stopAll();
    document.querySelectorAll('.note-btn').forEach(b => b.classList.remove('active'));
  });
}

// ─── タブ スワイプ操作 ───────────────────────
function initSwipe() {
  const TABS   = ['analysis', 'pitch', 'metronome', 'rhythm'];
  const content = document.querySelector('.tab-content');
  let startX = 0, startY = 0, tracking = false;

  content.addEventListener('touchstart', (e) => {
    // range スライダー上はスワイプ無視（スライダー操作と競合するため）
    if (e.target.closest('input[type="range"]')) return;
    startX   = e.touches[0].clientX;
    startY   = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  content.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    // 水平移動が 50px 未満、または縦移動の方が大きい場合はスクロールとみなす
    if (Math.abs(dx) < 50 || Math.abs(dx) <= Math.abs(dy)) return;

    const tabBtns = document.querySelectorAll('.tab-btn');
    let current = 0;
    tabBtns.forEach((btn, i) => { if (btn.classList.contains('active')) current = i; });

    const next = dx < 0 ? current + 1 : current - 1;
    if (next < 0 || next >= TABS.length) return;
    tabBtns[next].click();
  }, { passive: true });
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

// ─── ハンバーガーメニュー ─────────────────────
function initHamburgerMenu() {
  const btn     = document.getElementById('hamburger-btn');
  const overlay = document.getElementById('menu-overlay');
  const sheet   = document.getElementById('menu-sheet');

  function openMenu() {
    overlay.classList.add('open');
    sheet.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    overlay.setAttribute('aria-hidden', 'false');
    sheet.setAttribute('aria-hidden', 'false');
  }

  function closeMenu() {
    overlay.classList.remove('open');
    sheet.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    overlay.setAttribute('aria-hidden', 'true');
    sheet.setAttribute('aria-hidden', 'true');
  }

  btn.addEventListener('click', openMenu);
  overlay.addEventListener('click', closeMenu);

  // 各メニュー項目
  document.getElementById('menu-library').addEventListener('click', () => {
    closeMenu();
    openLibrary();
  });
  document.getElementById('menu-settings').addEventListener('click', () => {
    closeMenu();
    openSettings();
  });
}

// ─── 初期化 ──────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSwipe();
  initPitchPipe();
  initMetronome();
  initRhythm();
  initGlobalStop();
  initSaveState();
  initHamburgerMenu();
  initLibrary();
  initSettings();
  registerSW();
});
