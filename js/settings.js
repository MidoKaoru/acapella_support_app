/**
 * settings.js
 * 設定画面のロジック。
 * - ピッチパイプのデフォルト値（基準周波数・音色）の読み書き
 * - Gemini APIキーの保存・接続確認
 * - 設定変更はストレージへの保存と同時にピッチパイプへライブ反映する
 */

'use strict';

// ─── 公開 API ────────────────────────────────

function openSettings() {
  _refreshUI();
  const screen = document.getElementById('screen-settings');
  screen.classList.add('open');
  screen.setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  const screen = document.getElementById('screen-settings');
  screen.classList.remove('open');
  screen.setAttribute('aria-hidden', 'true');
  // APIキーが保存されていれば解析タブの表示を更新する
  if (typeof onApiKeySaved === 'function') onApiKeySaved();
}

// ─── UI をストレージの値で初期化 ─────────────

function _refreshUI() {
  const s = getSettings();

  // 基準周波数
  document.getElementById('settings-freq-slider').value = s.baseFreq;
  document.getElementById('settings-freq-display').textContent =
    `${parseFloat(s.baseFreq).toFixed(1)} Hz`;

  // ピッチパイプ音色
  document.querySelectorAll('#settings-wave-type .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.wave === s.waveType);
  });

  // メトロノームクリック音
  document.querySelectorAll('#settings-sound-type .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sound === s.soundType);
  });

  // APIキー（ステータス表示をリセット）
  document.getElementById('settings-api-key').value = s.apiKey || '';
  document.getElementById('settings-api-key').type  = 'password';
  document.getElementById('settings-api-toggle').textContent = '表示';
  const statusEl = document.getElementById('settings-api-status');
  statusEl.textContent = '';
  statusEl.className   = 'settings-api-status';
}

// ─── 基準周波数の変更・保存・ライブ反映 ──────

function _applyFreq(raw) {
  const clamped = Math.max(420, Math.min(460, Math.round(parseFloat(raw) * 10) / 10));

  // ストレージ保存
  const s = getSettings();
  s.baseFreq = clamped;
  saveSettings(s);

  // 設定画面 UI 更新
  document.getElementById('settings-freq-slider').value = clamped;
  document.getElementById('settings-freq-display').textContent = `${clamped.toFixed(1)} Hz`;

  // ピッチパイプへ反映
  pitchPipe.setBaseFreq(clamped);

  // ピッチパイプタブの UI も同期
  const tabSlider  = document.getElementById('freq-slider');
  const tabDisplay = document.getElementById('freq-display');
  if (tabSlider)  tabSlider.value = clamped;
  if (tabDisplay) tabDisplay.textContent = `${clamped.toFixed(1)} Hz`;
}

// ─── 音色の変更・保存・ライブ反映 ────────────

function _applyWaveType(waveType) {
  // ストレージ保存
  const s = getSettings();
  s.waveType = waveType;
  saveSettings(s);

  // 設定画面 UI 更新
  document.querySelectorAll('#settings-wave-type .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.wave === waveType);
  });

  // ピッチパイプへ反映
  pitchPipe.setWaveType(waveType);

  // ピッチパイプタブの UI も同期
  document.querySelectorAll('#wave-type .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.wave === waveType);
  });
}

// ─── メトロノームクリック音の変更・保存・ライブ反映 ──

function _applySoundType(soundType) {
  const s = getSettings();
  s.soundType = soundType;
  saveSettings(s);

  // 設定画面 UI 更新
  document.querySelectorAll('#settings-sound-type .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sound === soundType);
  });

  // メトロノームへ反映
  metronome.setSoundType(soundType);

  // メトロノームタブの UI も同期
  document.querySelectorAll('#metro-sound-type .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sound === soundType);
  });
}

// ─── APIキーの保存・接続確認 ─────────────────

async function _saveAndTestApiKey() {
  const key      = document.getElementById('settings-api-key').value.trim();
  const statusEl = document.getElementById('settings-api-status');
  const saveBtn  = document.getElementById('settings-api-save');

  saveApiKey(key);

  if (!key) {
    statusEl.textContent = 'APIキーを入力してください';
    statusEl.className   = 'settings-api-status error';
    return;
  }

  saveBtn.disabled     = true;
  statusEl.textContent = '確認中...';
  statusEl.className   = 'settings-api-status';

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
    );
    if (res.ok) {
      statusEl.textContent = '🎉 設定完了！「ふりかえり」が使えるようになりました';
      statusEl.className   = 'settings-api-status success';
    } else {
      statusEl.textContent = `キーが無効です（${res.status}）`;
      statusEl.className   = 'settings-api-status error';
    }
  } catch {
    statusEl.textContent = 'ネットワークエラー。接続を確認してください';
    statusEl.className   = 'settings-api-status error';
  } finally {
    saveBtn.disabled = false;
  }
}

// ─── 初期化 ──────────────────────────────────

function initSettings() {
  document.getElementById('settings-back-btn').addEventListener('click', closeSettings);

  // 基準周波数スライダー・ボタン
  const slider = document.getElementById('settings-freq-slider');
  slider.addEventListener('input', () => _applyFreq(slider.value));

  document.getElementById('settings-freq-down-big').addEventListener('click', () =>
    _applyFreq(parseFloat(slider.value) - 1));
  document.getElementById('settings-freq-down').addEventListener('click', () =>
    _applyFreq(parseFloat(slider.value) - 0.1));
  document.getElementById('settings-freq-up').addEventListener('click', () =>
    _applyFreq(parseFloat(slider.value) + 0.1));
  document.getElementById('settings-freq-up-big').addEventListener('click', () =>
    _applyFreq(parseFloat(slider.value) + 1));

  // ピッチパイプ音色ボタン
  document.querySelectorAll('#settings-wave-type .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => _applyWaveType(btn.dataset.wave));
  });

  // メトロノームクリック音ボタン
  document.querySelectorAll('#settings-sound-type .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => _applySoundType(btn.dataset.sound));
  });

  // APIキー 表示/非表示トグル
  document.getElementById('settings-api-toggle').addEventListener('click', () => {
    const input = document.getElementById('settings-api-key');
    const btn   = document.getElementById('settings-api-toggle');
    if (input.type === 'password') {
      input.type   = 'text';
      btn.textContent = '隠す';
    } else {
      input.type   = 'password';
      btn.textContent = '表示';
    }
  });

  // APIキー リアルタイムバリデーション
  document.getElementById('settings-api-key').addEventListener('input', (e) => {
    const val      = e.target.value.trim();
    const statusEl = document.getElementById('settings-api-status');
    if (val.length > 0 && val.length < 30) {
      statusEl.textContent = '⚠️ キーが短すぎます（通常39文字）';
      statusEl.className   = 'settings-api-status error';
    } else {
      statusEl.textContent = '';
      statusEl.className   = 'settings-api-status';
    }
  });

  // 貼り付けボタン（失敗時は入力欄にフォーカスしてCtrl+Vを促す）
  document.getElementById('settings-api-paste')?.addEventListener('click', async () => {
    const input    = document.getElementById('settings-api-key');
    const statusEl = document.getElementById('settings-api-status');
    try {
      const text = await navigator.clipboard.readText();
      input.value = text.trim();
      input.dispatchEvent(new Event('input'));
    } catch {
      input.focus();
      statusEl.textContent = 'Ctrl+V（Mac：⌘V）で貼り付けてください';
      statusEl.className   = 'settings-api-status';
    }
  });

  // APIキー 保存・接続確認
  document.getElementById('settings-api-save').addEventListener('click', _saveAndTestApiKey);

  // 右スワイプでメイン画面へ戻る
  const _screen = document.getElementById('screen-settings');
  let _sx = 0, _sy = 0;
  _screen.addEventListener('touchstart', e => {
    if (e.target.closest('input[type="range"]')) return;
    _sx = e.touches[0].clientX;
    _sy = e.touches[0].clientY;
  }, { passive: true });
  _screen.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - _sx;
    const dy = e.changedTouches[0].clientY - _sy;
    if (dx > 50 && Math.abs(dx) > Math.abs(dy)) closeSettings();
  }, { passive: true });
}
