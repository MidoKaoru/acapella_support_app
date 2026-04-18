'use strict';

/**
 * analysis.js
 * 録音解析タブのUI・解析フロー・カード描画を管理する。
 * 依存: storage.js, dict.js, gemini.js
 */

// ─── GAS エンドポイント（誤変換報告先・簡易難読化） ──────────
const GAS_URL = atob([
  'aHR0cHM6Ly9zY3JpcHQuZ29vZ2xlLmNvbS9tYW',
  'Nyb3Mvcy9BS2Z5Y2J5N2NFa3ljSmY1MjJkdEg2',
  'QklGdnBFYnpRMXdjQk1vaWpSQ2kxbE9uNUdnUz',
  'd0blR6VGZkU2xKbGlTUDI5UWtYeTBwdy9leGVj',
].join(''));

// ─── 内部状態 ────────────────────────────────────
let _state            = 'idle'; // 'idle'|'uploading'|'waiting'|'transcribing'|'analyzing'|'done'|'error'
let _currentResult    = null;   // 現在表示中の解析結果
let _currentTranscript = '';    // 現在の文字起こしテキスト
let _pendingGroupId   = null;   // 保存対象グループID
let _pendingSongId    = null;   // 保存対象曲ID
let _audioFile        = null;   // 選択中の音声ファイル
let _activeFilters    = { parts: [], categories: [], sections: [], favorite: false };
let _pendingAnalysis  = false;  // 曲0件で解析スタートした際の解析待ちフラグ

// ─── チップ・カードのソート順定義 ──────────────

const _PART_ORDER = ['リード', 'トップ', 'セカンド', 'サード', 'フォース', 'ベース', 'パーカス'];
const _CAT_ORDER  = ['ピッチ', 'リズム'];

function _sortParts(arr) {
  return [...arr].sort((a, b) => {
    const rank = v => v === 'その他' ? Infinity : (_PART_ORDER.indexOf(v) === -1 ? _PART_ORDER.length : _PART_ORDER.indexOf(v));
    return rank(a) - rank(b);
  });
}

function _sortCats(arr) {
  return [...arr].sort((a, b) => {
    const rank = v => v === 'その他' ? Infinity : (_CAT_ORDER.indexOf(v) === -1 ? _CAT_ORDER.length : _CAT_ORDER.indexOf(v));
    return rank(a) - rank(b);
  });
}

function _sortSecs(arr) {
  return [...arr].sort((a, b) => {
    const rank = v => {
      if (v === '全体')   return 0;
      if (v === 'その他') return Infinity;
      if (/1/.test(v))   return 1;
      if (/2/.test(v))   return 2;
      if (/3/.test(v))   return 3;
      return 4;
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return String(a).localeCompare(String(b), 'ja');
  });
}

// ─── 初期化 ──────────────────────────────────────

function initAnalysis() {
  loadDict();

  _checkApiKey();

  const fileInput = document.getElementById('analysis-file');
  const startBtn  = document.getElementById('analysis-start-btn');
  const fileLabel = document.getElementById('analysis-file-name');

  // 練習日の初期値として本日の日付をセット
  const practiceDateInput = document.getElementById('analysis-practice-date');
  if (practiceDateInput) {
    const _t = new Date();
    practiceDateInput.value = [
      _t.getFullYear(),
      String(_t.getMonth() + 1).padStart(2, '0'),
      String(_t.getDate()).padStart(2, '0'),
    ].join('-');
  }

  const fileClearBtn = document.getElementById('analysis-file-clear');

  fileInput.addEventListener('change', () => {
    _audioFile = fileInput.files[0] || null;
    fileLabel.textContent = _audioFile ? _audioFile.name : 'ファイルを選択';
    startBtn.disabled = !_audioFile;
    fileClearBtn.style.display = _audioFile ? 'flex' : 'none';
  });

  fileClearBtn.addEventListener('click', () => {
    _audioFile = null;
    fileInput.value = '';
    fileLabel.textContent = 'ファイルを選択';
    startBtn.disabled = true;
    fileClearBtn.style.display = 'none';
  });

  startBtn.addEventListener('click', _startAnalysis);

  document.getElementById('analysis-fav-filter').addEventListener('click', () => {
    _activeFilters.favorite = !_activeFilters.favorite;
    document.getElementById('analysis-fav-filter').classList.toggle('active', _activeFilters.favorite);
    const hasFilter = _activeFilters.parts.length > 0 || _activeFilters.categories.length > 0
      || _activeFilters.sections.length > 0 || _activeFilters.favorite;
    document.getElementById('analysis-clear-filter').style.display = hasFilter ? 'inline-flex' : 'none';
    _applyFilter();
  });

  document.getElementById('analysis-open-settings').addEventListener('click', () => {
    openSettings();
  });

  document.getElementById('analysis-clear-filter').addEventListener('click', _clearFilters);

  document.getElementById('analysis-save-btn').addEventListener('click', () => {
    if (!_currentResult || !_pendingGroupId || !_pendingSongId) return;
    const gId = _pendingGroupId;
    const sId = _pendingSongId;
    const sessionId = _saveSession(_currentResult, _currentTranscript, gId, sId);
    if (!sessionId) { showToast('保存に失敗しました'); return; }
    _clearAnalysisState();
    showToast('保存しました');
    openLibrarySessionDetail(gId, sId, sessionId);
  });

  document.getElementById('analysis-share-btn').addEventListener('click', () => {
    if (!_currentResult) return;
    exportShareHtml({ ..._currentResult, transcript: _currentTranscript });
  });
}

function _checkApiKey() {
  const hasKey = !!getApiKey();
  document.getElementById('analysis-no-key').style.display = hasKey ? 'none'  : 'block';
  document.getElementById('analysis-form').style.display   = hasKey ? 'block' : 'none';
}

function onApiKeySaved() {
  _checkApiKey();
}

// ─── 曲選択ボトムシート（2段階） ────────────────────

function _startAnalysis() {
  const _dateInput = document.getElementById('analysis-practice-date');
  let _validMsg = '';
  if (!_audioFile && !_dateInput.value)  _validMsg = '音声ファイルと練習日を入力してください';
  else if (!_audioFile)                  _validMsg = '音声ファイルを選択してください';
  else if (!_dateInput.value)            _validMsg = '練習日を入力してください';

  if (_validMsg) {
    const _sb = document.getElementById('analysis-start-btn');
    let _errEl = document.getElementById('analysis-start-error');
    if (!_errEl) {
      _errEl = document.createElement('p');
      _errEl.id = 'analysis-start-error';
      _errEl.style.cssText = 'color:var(--danger);font-size:13px;margin-top:-4px;';
      _sb.insertAdjacentElement('afterend', _errEl);
    }
    _errEl.textContent = _validMsg;
    setTimeout(() => { document.getElementById('analysis-start-error')?.remove(); }, 4000);
    return;
  }
  document.getElementById('analysis-start-error')?.remove();

  if (!getApiKey()) { _checkApiKey(); return; }

  const data = getSongs();
  if (data.groups.length === 0) {
    _pendingAnalysis = true;
    openLibraryForNewEntry();
    return;
  }

  _openGroupSelectSheet();
}

function _openGroupSelectSheet() {
  document.getElementById('song-select-sheet')?.remove();
  document.getElementById('song-select-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id        = 'song-select-overlay';
  overlay.className = 'menu-overlay open';
  overlay.setAttribute('aria-hidden', 'true');

  const sheet = document.createElement('div');
  sheet.id        = 'song-select-sheet';
  sheet.className = 'menu-sheet open';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'グループを選択');

  document.body.appendChild(overlay);
  document.body.appendChild(sheet);

  const close = () => {
    document.getElementById('song-select-sheet')?.remove();
    document.getElementById('song-select-overlay')?.remove();
  };

  overlay.addEventListener('click', close);
  _renderGroupSelectContent(sheet, close);
}

function _renderGroupSelectContent(sheet, close) {
  const data = getSongs();
  const groupListHtml = data.groups.map(g => `
    <div class="library-card song-select-item-wrap">
      <button class="library-card-main song-select-group-btn"
        data-group-id="${_esc(g.id)}">
        <span class="library-card-title">${_esc(g.name)}</span>
        <span class="library-card-meta">${g.songs.length}曲</span>
      </button>
    </div>
  `).join('');

  sheet.innerHTML = `
    <div class="menu-sheet-handle"></div>
    <div class="report-sheet-content">
      <h3 class="report-sheet-title">解析する曲を選択</h3>
      <div class="song-select-list">${groupListHtml}</div>
      <button class="action-btn-ghost" id="song-select-add-group">＋ 新規グループを追加</button>
      <button class="action-btn-ghost" id="song-select-cancel">キャンセル</button>
    </div>
  `;

  sheet.querySelector('#song-select-cancel').addEventListener('click', close);
  sheet.querySelector('#song-select-add-group').addEventListener('click', () => {
    close();
    _pendingAnalysis = true;
    openLibraryForGroupAdd();
  });

  sheet.querySelectorAll('.song-select-group-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const groupId = btn.dataset.groupId;
      const group = data.groups.find(g => g.id === groupId);
      if (group) _renderSongSelectContent(sheet, close, group);
    });
  });
}

function _renderSongSelectContent(sheet, close, group) {
  const songs = group.songs || [];
  const songListHtml = songs.length
    ? songs.map(s => `
        <div class="library-card song-select-item-wrap">
          <button class="library-card-main song-select-item"
            data-song-id="${_esc(s.id)}">
            <span class="library-card-title">${_esc(s.title)}</span>
          </button>
        </div>
      `).join('')
    : '<p class="analysis-empty">このグループに曲がありません</p>';

  sheet.innerHTML = `
    <div class="menu-sheet-handle"></div>
    <div class="report-sheet-content">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <button class="action-btn-ghost" id="song-select-back" style="padding:4px 10px;font-size:13px;flex-shrink:0;width:auto;">← 戻る</button>
        <h3 class="report-sheet-title" style="margin:0;flex:1;">${_esc(group.name)}</h3>
      </div>
      <div class="song-select-list">${songListHtml}</div>
      <button class="action-btn-ghost" id="song-select-add-song">＋ 新規曲を追加</button>
      <button class="action-btn-ghost" id="song-select-cancel">キャンセル</button>
    </div>
  `;

  sheet.querySelector('#song-select-back').addEventListener('click', () => {
    _renderGroupSelectContent(sheet, close);
  });
  sheet.querySelector('#song-select-add-song').addEventListener('click', () => {
    close();
    _pendingAnalysis = true;
    openLibraryForSongAdd(group.id);
  });
  sheet.querySelector('#song-select-cancel').addEventListener('click', close);

  sheet.querySelectorAll('.song-select-item').forEach(btn => {
    btn.addEventListener('click', () => {
      close();
      _runAnalysis(group.id, btn.dataset.songId);
    });
  });
}

// ─── 解析フロー ──────────────────────────────────

async function _runAnalysis(groupId, songId) {
  _pendingGroupId = groupId;
  _pendingSongId  = songId;
  _hideError();
  document.getElementById('analysis-results').style.display = 'none';
  document.getElementById('analysis-transcript-wrap').style.display = 'none';
  _activeFilters = { parts: [], categories: [], sections: [], favorite: false };

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

  let transcript = '';
  try {
    _setStepStatus('uploading', 'running');
    const { fileUri, mimeType, fileName } = await analyzer.uploadAudioFile(_audioFile);
    uploadedFileName = fileName;
    _setStepStatus('uploading', 'done');

    _setState('waiting');
    _setStepStatus('waiting', 'running');
    await analyzer.waitForFileActive(fileName);
    _setStepStatus('waiting', 'done');

    _setState('transcribing');
    _setStepStatus('transcribing', 'running');
    transcript = await analyzer.transcribeAudio(fileUri, mimeType);
    _setStepStatus('transcribing', 'done');
    _showTranscript(transcript);

    _setState('analyzing');
    _setStepStatus('analyzing', 'running');
    const result = await analyzer.analyzeStructure(transcript);
    _setStepStatus('analyzing', 'done');

    _currentResult    = result;
    _currentTranscript = transcript;
    _setState('done');
    _renderResults(result);

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
  const row   = document.querySelector(`.analysis-step[data-step="${step}"]`);
  const label = row?.querySelector('.analysis-step-status');
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

  const _nameEl = document.getElementById('analysis-session-name');
  _nameEl.textContent = result.session_name || 'セッション';
  _nameEl.classList.add('editable');
  _nameEl.onclick = () => {
    const _cur = result.session_name || 'セッション';
    const _inp = document.createElement('input');
    _inp.type = 'text';
    _inp.value = _cur;
    _inp.className = 'edit-text-input';
    _inp.style.cssText = 'font-size:15px;font-weight:600;padding:4px 8px;min-height:auto;box-shadow:none;width:auto;max-width:100%;';
    _nameEl.replaceWith(_inp);
    _inp.focus();
    _inp.select();
    const _commit = () => {
      result.session_name = _inp.value.trim() || _cur;
      _nameEl.textContent = result.session_name;
      _inp.replaceWith(_nameEl);
    };
    _inp.addEventListener('blur', _commit);
    _inp.addEventListener('keydown', e => { if (e.key === 'Enter') _inp.blur(); });
  };

  const cards = result.cards || [];
  const parts = _sortParts([...new Set(cards.flatMap(c => c.part))]);
  const cats  = _sortCats([...new Set(cards.map(c => c.category))]);
  const secs  = _sortSecs([...new Set(cards.map(c => c.section))]);

  _buildChips('analysis-part-chips', parts, 'parts');
  _buildChips('analysis-cat-chips',  cats,  'categories');
  _buildChips('analysis-sec-chips',  secs,  'sections');

  document.getElementById('analysis-clear-filter').style.display = 'none';
  document.getElementById('analysis-fav-filter').classList.remove('active');
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

      const hasFilter = _activeFilters.parts.length > 0 || _activeFilters.categories.length > 0
        || _activeFilters.sections.length > 0 || _activeFilters.favorite;
      document.getElementById('analysis-clear-filter').style.display = hasFilter ? 'inline-flex' : 'none';

      _applyFilter();
    });
    container.appendChild(btn);
  });
}

function _applyFilter() {
  if (!_currentResult) return;
  const { parts, categories, sections, favorite } = _activeFilters;
  const filtered = (_currentResult.cards || []).filter(card => {
    const partOk = parts.length === 0     || parts.some(p => card.part.includes(p));
    const catOk  = categories.length === 0 || categories.includes(card.category);
    const secOk  = sections.length === 0   || sections.includes(card.section);
    const favOk  = !favorite               || card.isFavorite === true;
    return partOk && catOk && secOk && favOk;
  });
  _renderCards(filtered);
}

function _clearFilters() {
  _activeFilters = { parts: [], categories: [], sections: [], favorite: false };
  document.querySelectorAll('#tab-analysis .analysis-chip').forEach(c => c.classList.remove('active'));
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

    const header = document.createElement('div');
    header.className = 'analysis-card-header';

    const meta = document.createElement('div');
    meta.className   = 'analysis-card-meta';
    meta.textContent = `${card.section} ｜ ${card.part.join(' / ')} ｜ ${card.category}`;

    const starBtn = document.createElement('button');
    starBtn.className = 'card-fav-btn' + (card.isFavorite ? ' active' : '');
    starBtn.setAttribute('aria-label', 'お気に入り');
    starBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>';
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      card.isFavorite = !card.isFavorite;
      starBtn.classList.toggle('active', card.isFavorite);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'card-fav-btn';
    delBtn.style.color = 'var(--danger)';
    delBtn.setAttribute('aria-label', 'カードを削除');
    delBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('このカードを削除しますか？')) return;
      if (_currentResult) {
        const idx = _currentResult.cards.indexOf(card);
        if (idx !== -1) _currentResult.cards.splice(idx, 1);
      }
      div.remove();
    });

    header.appendChild(meta);
    header.appendChild(starBtn);
    header.appendChild(delBtn);

    const text = document.createElement('p');
    text.className   = 'analysis-card-text editable';
    text.textContent = card.text;

    text.onclick = () => {
      const ta = document.createElement('textarea');
      ta.className = 'analysis-card-text-inline';
      ta.value     = card.text;
      ta.rows      = Math.max(3, Math.ceil(card.text.length / 36));
      text.classList.remove('editable');
      div.replaceChild(ta, text);
      ta.focus();
      ta.addEventListener('blur', () => {
        card.text        = ta.value;
        text.textContent = card.text;
        text.classList.add('editable');
        div.replaceChild(text, ta);
      });
    };

    const footer = document.createElement('div');
    footer.className = 'analysis-card-footer';

    const reportBtn = document.createElement('button');
    reportBtn.className   = 'analysis-report-btn';
    reportBtn.textContent = '誤変換を報告';
    reportBtn.addEventListener('click', () => _openReportSheet(card.text));

    footer.appendChild(reportBtn);
    div.appendChild(header);
    div.appendChild(text);
    div.appendChild(footer);
    container.appendChild(div);
  });
}

// ─── 共有用 HTML エクスポート ─────────────────────

async function exportShareHtml(sessionData) {
  if (!sessionData) return;

  let css = '';
  try {
    const res = await fetch('style.css');
    css = await res.text();
  } catch (_) {}

  const name  = sessionData.session_name || 'セッション';
  const date  = sessionData.practice_date
    ? sessionData.practice_date.replace(/(\d{4})-(\d{2})-(\d{2})/, '$1年$2月$3日')
    : sessionData.recorded_at || '';
  const cards = sessionData.cards || [];

  const jsonData = JSON.stringify({
    session_name:  name,
    practice_date: sessionData.practice_date || '',
    recorded_at:   sessionData.recorded_at || '',
    transcript:    sessionData.transcript || '',
    cards,
  });

  const transcriptBlock = sessionData.transcript
    ? `<details class="card analysis-transcript-wrap">
        <summary class="analysis-transcript-summary">文字起こし結果</summary>
        <pre class="analysis-transcript-text">${_escHtml(sessionData.transcript)}</pre>
       </details>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${_escHtml(name)}</title>
<style>
${css}
/* ── share page overrides ── */
body { padding: 16px; max-width: 640px; margin: 0 auto; }
.share-wrap { display: flex; flex-direction: column; gap: 12px; padding-bottom: 40px; }
.share-badge { display: inline-block; font-size: 11px; font-weight: 700; color: var(--text-secondary);
  border: 1px solid var(--border); border-radius: 100px; padding: 2px 10px; margin-bottom: 4px; }
</style>
</head>
<body>
<div class="share-wrap">
  <div class="card session-detail-header-card">
    <span class="share-badge">共有用・読み取り専用</span>
    <p class="session-detail-name">${_escHtml(name)}</p>
    <p class="session-detail-date">${_escHtml(date)}</p>
    <p class="session-detail-count" id="card-count">${cards.length}件のカード</p>
  </div>
  ${transcriptBlock}
  <div class="card analysis-filters" id="filter-area" style="display:none">
    <div class="analysis-filter-row">
      <span class="control-label">パート</span>
      <div class="analysis-chips" id="part-chips"></div>
    </div>
    <div class="analysis-filter-row">
      <span class="control-label">カテゴリ</span>
      <div class="analysis-chips" id="cat-chips"></div>
    </div>
    <div class="analysis-filter-row">
      <span class="control-label">セクション</span>
      <div class="analysis-chips" id="sec-chips"></div>
    </div>
    <div class="analysis-filter-row">
      <span class="control-label">絞り込み</span>
      <div class="analysis-chips" id="fav-chip-wrap"></div>
    </div>
    <button class="analysis-clear-filter" id="clear-filter" style="display:none">全解除</button>
  </div>
  <div id="cards-area"></div>
</div>
<script>
const SESSION = ${jsonData};
const PART_ORDER = ['リード','トップ','セカンド','サード','フォース','ベース','パーカス'];
const CAT_ORDER  = ['ピッチ','リズム'];
const sortParts = a => [...a].sort((x,y) => {
  const r = v => v==='その他' ? Infinity : (PART_ORDER.indexOf(v)===-1 ? PART_ORDER.length : PART_ORDER.indexOf(v));
  return r(x)-r(y);
});
const sortCats = a => [...a].sort((x,y) => {
  const r = v => v==='その他' ? Infinity : (CAT_ORDER.indexOf(v)===-1 ? CAT_ORDER.length : CAT_ORDER.indexOf(v));
  return r(x)-r(y);
});
const sortSecs = a => [...a].sort((x,y) => {
  const r = v => { if(v==='全体') return 0; if(v==='その他') return Infinity;
    if(/1/.test(v)) return 1; if(/2/.test(v)) return 2; if(/3/.test(v)) return 3; return 4; };
  const ra=r(x), rb=r(y);
  return ra!==rb ? ra-rb : String(x).localeCompare(String(y),'ja');
});
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

let filters = { parts:[], categories:[], sections:[], favorite:false };
const cards = SESSION.cards || [];
const parts = sortParts([...new Set(cards.flatMap(c => c.part||[]))]);
const cats  = sortCats([...new Set(cards.map(c => c.category).filter(Boolean))]);
const secs  = sortSecs([...new Set(cards.map(c => c.section).filter(Boolean))]);
const hasFilterData = parts.length > 0 || cats.length > 0 || secs.length > 0;
if (hasFilterData) document.getElementById('filter-area').style.display = '';

function updateClearBtn() {
  const has = filters.parts.length>0 || filters.categories.length>0 || filters.sections.length>0 || filters.favorite;
  document.getElementById('clear-filter').style.display = has ? 'inline-flex' : 'none';
}

function renderCards() {
  const { parts:pf, categories:cf, sections:sf, favorite:fv } = filters;
  const filtered = (pf.length===0 && cf.length===0 && sf.length===0 && !fv)
    ? cards
    : cards.filter(c => {
        const partOk = pf.length===0 || pf.some(p => (c.part||[]).includes(p));
        const catOk  = cf.length===0 || cf.includes(c.category);
        const secOk  = sf.length===0 || sf.includes(c.section);
        const favOk  = !fv || c.isFavorite===true;
        return partOk && catOk && secOk && favOk;
      });
  document.getElementById('card-count').textContent = filtered.length + '件のカード';
  const area = document.getElementById('cards-area');
  if (filtered.length===0) { area.innerHTML='<p class="analysis-empty">条件に合うカードがありません</p>'; return; }
  area.innerHTML = filtered.map(c => \`
    <div class="analysis-card \${esc(c.importance||'')}">
      <div class="analysis-card-header">
        <div class="analysis-card-meta">\${esc(c.section||'')} ｜ \${esc((c.part||[]).join(' / '))} ｜ \${esc(c.category||'')}</div>
        \${c.isFavorite ? '<span class="card-fav-btn active" aria-label="お気に入り"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg></span>' : ''}
      </div>
      <p class="analysis-card-text">\${esc(c.text||'')}</p>
    </div>
  \`).join('');
}

function buildChips(containerId, values, filterKey) {
  const el = document.getElementById(containerId);
  if (!el) return;
  values.forEach(val => {
    const btn = document.createElement('button');
    btn.className = 'analysis-chip';
    btn.textContent = val;
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const arr = filters[filterKey];
      const idx = arr.indexOf(val);
      if (idx===-1) arr.push(val); else arr.splice(idx,1);
      updateClearBtn(); renderCards();
    });
    el.appendChild(btn);
  });
}

buildChips('part-chips', parts, 'parts');
buildChips('cat-chips',  cats,  'categories');
buildChips('sec-chips',  secs,  'sections');

const favWrap = document.getElementById('fav-chip-wrap');
if (favWrap) {
  const btn = document.createElement('button');
  btn.className = 'analysis-chip';
  btn.textContent = '★ お気に入り';
  btn.addEventListener('click', () => {
    filters.favorite = !filters.favorite;
    btn.classList.toggle('active', filters.favorite);
    updateClearBtn(); renderCards();
  });
  favWrap.appendChild(btn);
}

document.getElementById('clear-filter').addEventListener('click', () => {
  filters = { parts:[], categories:[], sections:[], favorite:false };
  document.querySelectorAll('.analysis-chip').forEach(c => c.classList.remove('active'));
  updateClearBtn(); renderCards();
});

renderCards();
<\/script>
</body>
</html>`;

  const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${safeName}_共有用.html`;
  a.click();
  URL.revokeObjectURL(url);
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

// ─── セッション保存 ───────────────────────────────

function _saveSession(result, transcript, groupId, songId) {
  const data  = getSongs();
  const group = data.groups.find(g => g.id === groupId);
  if (!group) return null;
  const song = group.songs.find(s => s.id === songId);
  if (!song) return null;

  if (!Array.isArray(song.sessions)) song.sessions = [];
  const sessionId = 's' + Date.now();
  const session = {
    id:           sessionId,
    recorded_at:  _jstDateString(),
    transcript:   transcript || result.transcript || '',
    ...result,
    practice_date: document.getElementById('analysis-practice-date')?.value || '',
  };
  song.sessions.unshift(session);
  saveSongs(data);
  return sessionId;
}

// ─── 解析タブ状態クリア ───────────────────────────

function _clearAnalysisState() {
  document.getElementById('analysis-cards').innerHTML = '';
  document.getElementById('analysis-transcript-wrap').style.display = 'none';
  document.getElementById('analysis-transcript').textContent = '';

  document.getElementById('analysis-results').style.display = 'none';

  _activeFilters = { parts: [], categories: [], sections: [], favorite: false };
  document.getElementById('analysis-part-chips').innerHTML = '';
  document.getElementById('analysis-cat-chips').innerHTML  = '';
  document.getElementById('analysis-sec-chips').innerHTML  = '';
  document.getElementById('analysis-clear-filter').style.display = 'none';
  document.getElementById('analysis-fav-filter')?.classList.remove('active');

  document.getElementById('analysis-progress').style.display = 'none';
  document.querySelectorAll('.analysis-step').forEach(el => {
    el.classList.remove('running', 'done');
    const lbl = el.querySelector('.analysis-step-status');
    if (lbl) lbl.textContent = '';
  });

  _currentResult     = null;
  _currentTranscript = '';
  _pendingGroupId    = null;
  _pendingSongId     = null;
  _state             = 'idle';
  document.getElementById('analysis-start-btn').disabled = !_audioFile;
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

  const close = () => { sheet.remove(); overlay.remove(); };

  overlay.addEventListener('click', close);
  document.getElementById('report-cancel').addEventListener('click', close);
  document.getElementById('report-submit').addEventListener('click', () => {
    const wrong   = document.getElementById('report-wrong').value.trim();
    const correct = document.getElementById('report-correct').value.trim();
    if (!wrong || !correct) {
      showToast('誤った表記と正しい表記を入力してください');
      return;
    }
    addTerm(wrong, correct);
    close();
    showToast('報告しました');
    _reportToGas(wrong, correct, context);
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

function _jstDateString() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y   = jst.getUTCFullYear();
  const m   = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d   = String(jst.getUTCDate()).padStart(2, '0');
  const h   = String(jst.getUTCHours()).padStart(2, '0');
  const min = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${y}年${m}月${d}日 ${h}:${min}`;
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── 解析待ち状態の公開 API ──────────────────────

function isPendingAnalysis() { return _pendingAnalysis; }
function clearPendingAnalysis() { _pendingAnalysis = false; }
function startAnalysisForSong(groupId, songId) { _runAnalysis(groupId, songId); }
