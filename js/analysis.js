'use strict';

/**
 * analysis.js
 * 録音解析タブのUI・解析フロー・カード描画を管理する。
 * 依存: storage.js, dict.js, gemini.js
 */

// ─── GAS エンドポイント（誤変換報告先） ──────────
const GAS_URL = 'https://script.google.com/macros/s/AKfycby7cEkycJf522dtH6BIFvpEbzQ1wcBMoijRCi1lOn5GgS7tnTzTfdSlJliSP29QkXy0pw/exec';

// ─── 内部状態 ────────────────────────────────────
let _state         = 'idle'; // 'idle'|'uploading'|'waiting'|'transcribing'|'analyzing'|'done'|'error'
let _currentResult = null;   // 現在表示中の解析結果
let _audioFile     = null;   // 選択中の音声ファイル
let _audioHasFile  = false;  // 音源がプレーヤーにセット済みか
let _activeFilters = { parts: [], categories: [] };

// ─── 初期化 ──────────────────────────────────────

function initAnalysis() {
  loadDict(); // 辞書をlocalStorageに初期化

  _checkApiKey();
  _renderSessionsList();

  const fileInput = document.getElementById('analysis-file');
  const startBtn  = document.getElementById('analysis-start-btn');
  const fileLabel = document.getElementById('analysis-file-name');

  fileInput.addEventListener('change', () => {
    _audioFile = fileInput.files[0] || null;
    fileLabel.textContent = _audioFile ? _audioFile.name : 'ファイルを選択';
    startBtn.disabled = !_audioFile;
  });

  startBtn.addEventListener('click', _startAnalysis);

  document.getElementById('analysis-open-settings').addEventListener('click', () => {
    openSettings();
  });

  document.getElementById('analysis-export-btn').addEventListener('click', _exportJson);
  document.getElementById('analysis-clear-filter').addEventListener('click', _clearFilters);
}

// APIキーの有無でフォーム表示を切り替える
function _checkApiKey() {
  const hasKey = !!getApiKey();
  document.getElementById('analysis-no-key').style.display = hasKey ? 'none'  : 'block';
  document.getElementById('analysis-form').style.display   = hasKey ? 'block' : 'none';
}

// 設定画面でAPIキーが保存されたとき呼び出す（settings.js から呼ぶ）
function onApiKeySaved() {
  _checkApiKey();
}

// ─── 解析フロー ──────────────────────────────────

async function _startAnalysis() {
  if (!_audioFile) return;
  if (!getApiKey()) { _checkApiKey(); return; }

  // 前回のエラー・結果をリセット
  _hideError();
  document.getElementById('analysis-results').style.display = 'none';
  document.getElementById('analysis-transcript-wrap').style.display = 'none';
  _activeFilters = { parts: [], categories: [] };

  _setState('uploading');

  let uploadedFileName = null;
  let analyzer;
  try {
    analyzer = new GeminiAudioAnalyzer();
  } catch (e) {
    _setState('error');
    _showError(e.message);
    return;
  }

  try {
    // ① アップロード
    _setStepStatus('uploading', 'running');
    const { fileUri, mimeType, fileName } = await analyzer.uploadAudioFile(_audioFile);
    uploadedFileName = fileName;
    _setStepStatus('uploading', 'done');

    // ①-2 アクティベーション待機
    _setState('waiting');
    _setStepStatus('waiting', 'running');
    await analyzer.waitForFileActive(fileName);
    _setStepStatus('waiting', 'done');

    // ② 文字起こし
    _setState('transcribing');
    _setStepStatus('transcribing', 'running');
    const transcript = await analyzer.transcribeAudio(fileUri, mimeType);
    _setStepStatus('transcribing', 'done');
    _showTranscript(transcript);

    // ③ 構造化解析
    _setState('analyzing');
    _setStepStatus('analyzing', 'running');
    const result = await analyzer.analyzeStructure(fileUri, mimeType, transcript);
    _setStepStatus('analyzing', 'done');

    // 音源をプレーヤーにセット
    const audio = document.getElementById('analysis-audio');
    const prevSrc = audio.src;
    if (prevSrc && prevSrc.startsWith('blob:')) URL.revokeObjectURL(prevSrc);
    audio.src = URL.createObjectURL(_audioFile);
    _audioHasFile = true;
    document.getElementById('analysis-player-wrap').style.display = 'block';

    // 結果表示・保存
    _currentResult = result;
    _saveSession(result);
    _setState('done');
    _renderResults(result);
    _renderSessionsList();

  } catch (err) {
    _setState('error');
    _showError(err.message);
  } finally {
    if (uploadedFileName) {
      try { await analyzer.deleteFile(uploadedFileName); } catch (_) {}
    }
    document.getElementById('analysis-start-btn').disabled = false;
  }
}

// ─── 状態管理 ────────────────────────────────────

function _setState(state) {
  _state = state;
  const progress = document.getElementById('analysis-progress');
  const startBtn = document.getElementById('analysis-start-btn');

  if (['uploading', 'waiting', 'transcribing', 'analyzing'].includes(state)) {
    progress.style.display = 'block';
    startBtn.disabled = true;
    // 現在のステップ行をハイライト
    document.querySelectorAll('.analysis-step').forEach(el => {
      el.classList.toggle('active', el.dataset.step === state);
    });
  } else if (state === 'done' || state === 'error') {
    startBtn.disabled = false;
  } else if (state === 'idle') {
    progress.style.display = 'none';
    startBtn.disabled = !_audioFile;
  }
}

function _setStepStatus(step, status) {
  const row    = document.querySelector(`.analysis-step[data-step="${step}"]`);
  const dot    = row?.querySelector('.analysis-step-dot');
  const label  = row?.querySelector('.analysis-step-status');
  if (!row) return;

  row.classList.remove('running', 'done');
  if (status === 'running') {
    row.classList.add('running');
    if (label) label.textContent = '処理中…';
  } else if (status === 'done') {
    row.classList.add('done');
    if (label) label.textContent = '完了';
  }
}

// ─── 文字起こし表示 ──────────────────────────────

function _showTranscript(text) {
  const wrap = document.getElementById('analysis-transcript-wrap');
  const pre  = document.getElementById('analysis-transcript');
  pre.textContent    = text;
  wrap.style.display = 'block';
}

// ─── エラー表示 ──────────────────────────────────

function _showError(message) {
  const card = document.getElementById('analysis-error');
  document.getElementById('analysis-error-text').textContent = '❌ ' + message;
  card.style.display = 'block';
}

function _hideError() {
  document.getElementById('analysis-error').style.display = 'none';
}

// ─── 解析結果描画 ────────────────────────────────

function _renderResults(result) {
  const resultsEl = document.getElementById('analysis-results');
  resultsEl.style.display = 'block';
  document.getElementById('analysis-session-name').textContent =
    result.session_name || 'セッション';

  const cards = result.cards || [];
  const parts = [...new Set(cards.flatMap(c => c.part))].sort();
  const cats  = [...new Set(cards.map(c => c.category))];

  _buildChips('analysis-part-chips', parts, 'parts');
  _buildChips('analysis-cat-chips',  cats,  'categories');

  // フィルター全解除ボタンは選択があるときのみ表示
  document.getElementById('analysis-clear-filter').style.display = 'none';

  _renderCards(cards);
}

function _buildChips(containerId, values, filterKey) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  values.forEach(val => {
    const btn = document.createElement('button');
    btn.className    = 'analysis-chip';
    btn.textContent  = val;
    btn.dataset.key  = filterKey;
    btn.dataset.val  = val;
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const arr = _activeFilters[filterKey];
      const idx = arr.indexOf(val);
      if (idx === -1) arr.push(val); else arr.splice(idx, 1);

      const hasFilter = _activeFilters.parts.length > 0 || _activeFilters.categories.length > 0;
      document.getElementById('analysis-clear-filter').style.display = hasFilter ? 'inline-flex' : 'none';

      _applyFilter();
    });
    container.appendChild(btn);
  });
}

function _applyFilter() {
  if (!_currentResult) return;
  const { parts, categories } = _activeFilters;
  const filtered = (_currentResult.cards || []).filter(card => {
    const partOk = parts.length === 0      || parts.some(p => card.part.includes(p));
    const catOk  = categories.length === 0 || categories.includes(card.category);
    return partOk && catOk;
  });
  _renderCards(filtered);
}

function _clearFilters() {
  _activeFilters = { parts: [], categories: [] };
  document.querySelectorAll('.analysis-chip').forEach(c => c.classList.remove('active'));
  document.getElementById('analysis-clear-filter').style.display = 'none';
  if (_currentResult) _renderCards(_currentResult.cards || []);
}

function _renderCards(cards) {
  const container = document.getElementById('analysis-cards');
  container.innerHTML = '';

  if (cards.length === 0) {
    container.innerHTML = '<p class="analysis-empty">条件に合うカードがありません</p>';
    return;
  }

  cards.forEach(card => {
    const div = document.createElement('div');
    div.className = `analysis-card ${card.importance}`;

    // メタ行
    const meta = document.createElement('div');
    meta.className   = 'analysis-card-meta';
    meta.textContent = `${_formatTime(card.timestamp_sec)} ｜ ${card.part.join(' / ')} ｜ ${card.category}`;

    // 本文
    const text = document.createElement('p');
    text.className   = 'analysis-card-text';
    text.textContent = card.text;

    // フッター
    const footer = document.createElement('div');
    footer.className = 'analysis-card-footer';

    const seekBtn = document.createElement('button');
    seekBtn.className   = 'analysis-seek-btn';
    seekBtn.innerHTML   =
      '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><polygon points="2,1 11,6 2,11"/></svg> ' +
      _formatTime(card.timestamp_sec);
    seekBtn.addEventListener('click', () => _seekAudio(card.timestamp_sec));

    const reportBtn = document.createElement('button');
    reportBtn.className   = 'analysis-report-btn';
    reportBtn.textContent = '誤変換を報告';
    reportBtn.addEventListener('click', () => _openReportSheet(card.text));

    footer.appendChild(seekBtn);
    footer.appendChild(reportBtn);
    div.appendChild(meta);
    div.appendChild(text);
    div.appendChild(footer);
    container.appendChild(div);
  });
}

// ─── 音源シーク ──────────────────────────────────

function _seekAudio(sec) {
  const audio = document.getElementById('analysis-audio');
  if (!_audioHasFile) {
    showToast('音源ファイルを解析してから使用してください');
    return;
  }
  audio.currentTime = sec;
  audio.play().catch(() => {});
}

// ─── JSON エクスポート ────────────────────────────

function _exportJson() {
  if (!_currentResult) return;
  const base = `${_currentResult.session_name || 'session'}_${_currentResult.recorded_at || ''}_解析結果`
    .replace(/[\\/:*?"<>|]/g, '_');
  const blob = new Blob([JSON.stringify(_currentResult, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${base}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── セッション保存・一覧 ─────────────────────────

function _saveSession(result) {
  const store = getSessions();
  store.sessions.unshift({ id: 's' + Date.now(), ...result });
  store.sessions = store.sessions.slice(0, 20); // 最大20件
  saveSessions(store);
}

function _renderSessionsList() {
  const sessions  = getSessions().sessions;
  const container = document.getElementById('analysis-sessions-list');
  if (!container) return;

  if (sessions.length === 0) {
    container.innerHTML = '<p class="analysis-empty">過去のセッションはありません</p>';
    return;
  }

  container.innerHTML = '';
  sessions.forEach(session => {
    const div = document.createElement('div');
    div.className = 'library-card';

    const btn = document.createElement('button');
    btn.className = 'library-card-main';
    btn.innerHTML = `
      <span class="library-card-title">${_esc(session.session_name || 'セッション')}</span>
      <span class="library-card-meta">${_esc(session.recorded_at || '')} &middot; ${(session.cards || []).length}件</span>
    `;
    btn.addEventListener('click', () => _loadSession(session));

    div.appendChild(btn);
    container.appendChild(div);
  });
}

function _loadSession(session) {
  _currentResult = session;
  _activeFilters = { parts: [], categories: [] };
  _audioHasFile  = false;

  document.getElementById('analysis-progress').style.display     = 'none';
  document.getElementById('analysis-player-wrap').style.display  = 'none';
  document.getElementById('analysis-error').style.display        = 'none';

  _showTranscript(session.transcript || '');
  _renderResults(session);

  // 画面先頭へスクロール
  document.querySelector('.tab-content').scrollTop = 0;
}

// ─── 誤変換報告（ボトムシート） ──────────────────

function _openReportSheet(context) {
  document.getElementById('report-sheet')?.remove();
  document.getElementById('report-overlay')?.remove();

  const selected = window.getSelection().toString().trim();

  const sheet = document.createElement('div');
  sheet.id        = 'report-sheet';
  sheet.className = 'menu-sheet open';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', '誤変換を報告');
  sheet.innerHTML = `
    <div class="menu-sheet-handle"></div>
    <div class="report-sheet-content">
      <h3 class="report-sheet-title">誤変換を報告</h3>
      <div class="control-group report-field">
        <span class="control-label">誤った表記</span>
        <input type="text" id="report-wrong"   class="settings-api-input" placeholder="例：ワオン"
          value="${_esc(selected)}" autocomplete="off">
      </div>
      <div class="control-group report-field">
        <span class="control-label">正しい表記</span>
        <input type="text" id="report-correct" class="settings-api-input" placeholder="例：和音"
          autocomplete="off">
      </div>
      <button class="action-btn-primary" id="report-submit">送信</button>
      <button class="action-btn-ghost"   id="report-cancel">キャンセル</button>
    </div>
  `;

  const overlay = document.createElement('div');
  overlay.id        = 'report-overlay';
  overlay.className = 'menu-overlay open';
  overlay.setAttribute('aria-hidden', 'true');

  document.body.appendChild(overlay);
  document.body.appendChild(sheet);

  const close = () => {
    sheet.remove();
    overlay.remove();
  };

  overlay.addEventListener('click', close);
  document.getElementById('report-cancel').addEventListener('click', close);
  document.getElementById('report-submit').addEventListener('click', async () => {
    const wrong   = document.getElementById('report-wrong').value.trim();
    const correct = document.getElementById('report-correct').value.trim();
    if (!wrong || !correct) {
      showToast('誤った表記と正しい表記を入力してください');
      return;
    }
    addTerm(wrong, correct);
    await _reportToGas(wrong, correct, context);
    close();
    showToast('報告しました');
  });
}

async function _reportToGas(wrong, correct, context) {
  if (!GAS_URL) return;
  try {
    await fetch(GAS_URL, {
      method: 'POST',
      mode:   'no-cors',
      body:   JSON.stringify({ wrong, correct, context }),
    });
  } catch (_) {}
}

// ─── ユーティリティ ──────────────────────────────

function _formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
