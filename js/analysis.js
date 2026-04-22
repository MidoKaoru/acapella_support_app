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

// ─── デモセッションデータ ─────────────────────────
const DEMO_SESSION = {
  session_name: 'サンプル：練習ふりかえり',
  practice_date: '',
  recorded_at: '2023年10月27日',
  transcript: 'えっと。\nえっと、ベースの、え、ピッチがちょっと気になってて、経過音がちょっと雑になってる気がするので、うん、もう少し、え、1個1個の音の発声をもう少しクリアに硬く、えー、出してほしいです。で、えーと、リードに関しては、ちょっとコーラスに埋もれ気味な感覚があるから、もう少し硬い発声、硬くて前に、え、出るような発声をちょっと心がけてみてほしいです。で、え、サードはちょっとピッチが下がってる気がするので、もう少しあの、えー、トップやベース、え、セカンドと分けてもいいのかな。ま、うまくその、周りの調整をもう少し聞きながら、えー、歌うっていうのを心がけつつ、自分の、えっと、自分の骨伝導で聞こえる音というよりは、機材を通して外から聞こえる音をちゃんと耳で聞きに行くっていう意識を持ってほしいです。で、トップに関してはちょっとピッチが上ずってるのと、あと音の立ち上がりが遅くて、うん、と、少し、えっと、フレーズが潰れてるのと、ちょっと後ろに持たってる感覚があるから、もう少しこう、音の立ち上がりをジャストで、えーと、なるようにすると、え、和音ももっとクリアになると思うし、えっと、リズムもパキッと出てくるんじゃないかな。で、えーと、パーカスに関しては、この曲が、えー、割とこう、コーラス陣が遊びを入れるからこそ、もう少しこうどっしりと構えてほしいというか。え、構えてほしい感じがあって、というのが、今、少し、えーと、フィルインを入れるタイミングとかでテンポが前後にこうブレてる感覚があるので、もう少しこう、ジャストのタイミングでメトロノーム通りに、え、テンポを刻むっていうのをまずが意識してほしい。ってのは感じました。',
  cards: [
    { id: 'card-1', section: '全体', part: ['ベース'], category: 'ピッチ', importance: 'normal',
      text: 'ピッチがちょっと気になってて、経過音がちょっと雑になってる気がするので、もう少し1個1個の音の発声をクリアに硬く出してほしいです。' },
    { id: 'card-2', section: '全体', part: ['リード'], category: 'ダイナミクス', importance: 'normal',
      text: 'コーラスに埋もれ気味な感覚があるから、もう少し硬く前に出るような発声を心がけてみてほしいです。' },
    { id: 'card-3', section: '全体', part: ['サード'], category: 'ピッチ', importance: 'normal',
      text: 'ピッチが下がっている。もう少しトップやベースとハモる意識をもって、周りを聴きながら歌うことを心がけて。自分の骨伝導で聞こえる音より、機材を通して外から聞こえる音を聴く意識を持つ。' },
    { id: 'card-5', section: '全体', part: ['トップ'], category: 'リズム', importance: 'normal',
      text: '音の立ち上がりが遅く、フレーズが潰れていて、後ろにモタっている。音の立ち上がりを早くし、ジャストで鳴るようにすると、和音がもっとクリアになる。リズムもパキッと出てくる。' },
    { id: 'card-6', section: '全体', part: ['パーカス'], category: 'リズム', importance: 'normal',
      text: 'コーラス陣が遊びを入れる曲だからこそ、もう少しどっしりと構えてほしい。フィルインを入れるタイミングなどでテンポが前後にブレるので、ジャストのタイミングでテンポキープすることをまず意識する。' },
  ],
};

// ─── 並列実行制御 ────────────────────────────────

const CONCURRENCY_LIMIT = 3;

async function parallelLimit(tasks, limit) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}

// ─── 内部状態 ────────────────────────────────────
let _state            = 'idle'; // 'idle'|'uploading'|'waiting'|'transcribing'|'analyzing'|'done'|'error'
let _currentResult    = null;   // 現在表示中の解析結果
let _currentTranscript = '';    // 現在の文字起こしテキスト
let _pendingGroupId   = null;   // 保存対象グループID
let _pendingSongId    = null;   // 保存対象曲ID
let _audioFile        = null;   // 選択中の音声ファイル
let _activeFilters    = { parts: [], categories: [], sections: [], favorite: false };
let _pendingAnalysis  = false;  // 曲0件で解析スタートした際の解析待ちフラグ
let _chunks           = [];    // ファイルスライスチャンク配列
let _chunkTranscripts = [];    // チャンクごとの文字起こし
let _failedChunkIndex = -1;    // エラーが発生したチャンクのインデックス
let wakeLock          = null;  // スリープ抑止ロック
let _inputMode         = 'file'; // 'file' | 'record'

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

  window.addEventListener('online',  _updateConnectivityUI);
  window.addEventListener('offline', _updateConnectivityUI);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' &&
        ['uploading', 'waiting', 'transcribing'].includes(_state)) {
      showToast('バックグラウンドで処理が中断された可能性があります');
    }
  });

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
    _updateStartBtn();
    fileClearBtn.style.display = _audioFile ? 'flex' : 'none';
  });

  fileClearBtn.addEventListener('click', () => {
    _audioFile = null;
    fileInput.value = '';
    fileLabel.textContent = 'ファイルを選択';
    _updateStartBtn();
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
    if (navigator.share) {
      _shareAsText(_currentResult);
    } else {
      exportShareHtml({ ..._currentResult, transcript: _currentTranscript });
    }
  });

  // ─── 入力方式セグメント切り替え（要件3） ─────────────
  document.querySelectorAll('#analysis-input-mode .segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#analysis-input-mode .segment-btn')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _inputMode = btn.dataset.mode;
      _applyInputModeDisplay();
    });
  });

  // ─── 録音ボタン（要件4） ──────────────────────────
  const recordBtn = document.getElementById('record-btn');

  async function _onRecordDown(e) {
    e.preventDefault();
    try {
      if (window.recorder.state === 'idle') {
        await window.recorder.start();
      } else if (window.recorder.state === 'paused') {
        window.recorder.resume();
      }
    } catch (_err) {
      showToast('マイクにアクセスできませんでした');
      return;
    }
    _updateRecordingUI();
    _updateRecordingState();
  }

  function _onRecordUp(e) {
    e.preventDefault();
    window.recorder.pause();
    _updateRecordingUI();
    _updateRecordingState();
  }

  recordBtn.addEventListener('touchstart', _onRecordDown, { passive: false });
  recordBtn.addEventListener('mousedown',  _onRecordDown);
  recordBtn.addEventListener('touchend',   _onRecordUp,   { passive: false });
  recordBtn.addEventListener('mouseup',    _onRecordUp);
  recordBtn.addEventListener('contextmenu', e => e.preventDefault());

  // ─── クリアボタン（要件4） ──────────────────────
  document.getElementById('record-clear-btn').addEventListener('click', () => {
    window.recorder.clear();
    _updateRecordingUI();
    _updateRecordingState();
  });

  // ─── ファイル保存ボタン（要件4） ──────────────────
  document.getElementById('record-save-btn').addEventListener('click', async () => {
    const blob = await window.recorder.stop();
    if (!blob || blob.size === 0) { showToast('録音データがありません'); return; }
    const now = new Date();
    const ts  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'mp4' : 'webm';
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `recording_${ts}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    _updateRecordingUI();
    _updateRecordingState();
  });

  // ─── 解析スタートボタン（要件5） ─────────────────
  document.getElementById('record-analyze-btn').addEventListener('click', async () => {
    const blob = await window.recorder.stop();
    if (!blob || blob.size === 0) { showToast('録音データがありません'); return; }
    const now = new Date();
    const ts  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'mp4' : 'webm';
    _audioFile = new File([blob], `recorded_audio_${ts}.${ext}`, { type: blob.type, lastModified: now.getTime() });
    _updateRecordingUI();
    _updateRecordingState();
    _startAnalysis();
  });
}

function _applyInputModeDisplay() {
  const formEl   = document.getElementById('analysis-form');
  const recordEl = document.getElementById('analysis-record-panel');
  if (_inputMode === 'record') {
    formEl.style.display   = 'none';
    recordEl.style.display = 'block';
  } else {
    formEl.style.display   = 'block';
    recordEl.style.display = 'none';
  }
}

function _updateConnectivityUI() {
  const hasKey    = !!getApiKey();
  const noKeyEl   = document.getElementById('analysis-no-key');
  const offlineEl = document.getElementById('analysis-offline');
  const formEl    = document.getElementById('analysis-form');

  if (!hasKey) {
    noKeyEl.style.display   = 'block';
    offlineEl.style.display = 'none';
    formEl.style.display    = 'none';
    document.getElementById('analysis-record-panel').style.display = 'none';
    _showDemoSession();
  } else if (!navigator.onLine) {
    noKeyEl.style.display   = 'none';
    offlineEl.style.display = 'block';
    _applyInputModeDisplay();
    if (_currentResult === null) _clearAnalysisState();
    _updateStartBtn();
  } else {
    noKeyEl.style.display   = 'none';
    offlineEl.style.display = 'none';
    _applyInputModeDisplay();
    if (_currentResult === null) _clearAnalysisState();
    _updateStartBtn();
  }
}

function _updateRecordingUI() {
  if (!window.recorder) return;
  const state    = window.recorder.state;
  const isRec    = state === 'recording';
  const isPaused = state === 'paused';
  const recordBtn      = document.getElementById('record-btn');
  const recordBtnLabel = document.getElementById('record-btn-label');
  if (recordBtn)      recordBtn.classList.toggle('recording', isRec);
  if (recordBtnLabel) recordBtnLabel.textContent = isRec ? '一時停止' : (isPaused ? '再開' : '録音');
  const analyzeBtn = document.getElementById('record-analyze-btn');
  const saveBtn    = document.getElementById('record-save-btn');
  if (analyzeBtn) analyzeBtn.style.display = isPaused ? 'block' : 'none';
  if (saveBtn)    saveBtn.style.display    = isPaused ? 'block' : 'none';
}

function _updateStartBtn() {
  const btn = document.getElementById('analysis-start-btn');
  if (!btn) return;
  if (!navigator.onLine) {
    btn.textContent = 'オフラインのため解析不可';
    btn.disabled    = true;
  } else if (!_audioFile) {
    btn.textContent = '音声ファイルを選択';
    btn.disabled    = true;
  } else {
    btn.textContent = '解析スタート';
    btn.disabled    = false;
  }
}

function _checkApiKey() {
  _updateConnectivityUI();
}

function _showDemoSession() {
  _renderResults(DEMO_SESSION);

  const saveBtn = document.getElementById('analysis-save-btn');
  if (saveBtn) saveBtn.style.display = 'none';

  const shareBtn = document.getElementById('analysis-share-btn');
  if (shareBtn) shareBtn.style.display = 'none';

  document.getElementById('analysis-no-key').style.display = 'none';

  if (document.getElementById('analysis-demo-banner')) return;

  const banner = document.createElement('div');
  banner.id        = 'analysis-demo-banner';
  banner.className = 'card analysis-notice analysis-notice--demo';
  banner.innerHTML = `
    <p class="analysis-notice-text">⚠️ これはサンプルデータです</p>
    <p class="analysis-notice-sub">APIキー設定で練習音源を解析！</p>
    <ol class="onboarding-steps">
      <li><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio</a> を開く</li>
      <li>Googleアカウントにログイン</li>
      <li>[APIキーを作成] &gt; [キーを作成] &gt; コピー</li>
      <li>設定画面に貼り付けて完了</li>
    </ol>
    <div class="onboarding-reassurance">
      <span>💳 クレカ不要</span>
      <span>🔒 端末内保存</span>
      <span>¥ 無料</span>
    </div>
    <button class="action-btn-primary" id="demo-open-settings">
      APIキーを設定する →
    </button>`;

  const results = document.getElementById('analysis-results');
  results.insertBefore(banner, results.firstChild);

  document.getElementById('demo-open-settings')
    .addEventListener('click', openSettings);
}

function onApiKeySaved() {
  _updateConnectivityUI();
}

// ─── 曲選択ボトムシート（2段階） ────────────────────

function _startAnalysis() {
  const _dateInput = document.getElementById('analysis-practice-date');
  let _validMsg = '';
  if (!_audioFile && !_dateInput.value)  _validMsg = '音声ファイルと練習日を入力してください';
  else if (!_audioFile)                  _validMsg = '音声ファイルを選択してください';
  else if (!_dateInput.value)            _validMsg = '練習日を入力してください';

  if (_validMsg) {
    showToast(_validMsg);
    return;
  }

  if (!getApiKey()) { _checkApiKey(); return; }

  if (isStorageNearingLimit()) {
    _openStorageLimitSheet();
    return;
  }

  const data = getSongs();
  if (data.groups.length === 0) {
    _pendingAnalysis = true;
    openLibraryForNewEntry();
    return;
  }

  _openGroupSelectSheet();
}

// ─── 容量超過警告ボトムシート ─────────────────────

function _openStorageLimitSheet() {
  document.getElementById('storage-limit-sheet')?.remove();
  document.getElementById('storage-limit-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id        = 'storage-limit-overlay';
  overlay.className = 'menu-overlay open';
  overlay.setAttribute('aria-hidden', 'true');

  const sheet = document.createElement('div');
  sheet.id        = 'storage-limit-sheet';
  sheet.className = 'menu-sheet open';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', '容量の上限が近づいています');

  sheet.innerHTML = `
    <div class="menu-sheet-handle"></div>
    <div class="report-sheet-content">
      <h3 class="report-sheet-title">容量の上限が近づいています</h3>
      <p style="font-size:14px;line-height:1.6;color:var(--text-secondary);margin:0 0 16px;">データ容量が4.5MBを超過しました。新しく解析を行うには古いデータの削除が必要です。削除したくない場合は、ライブラリ画面から「エクスポート」を実行してデータを退避させてください。</p>
      <button class="action-btn-danger" id="storage-limit-delete">半年以上前の履歴を一括削除</button>
      <button class="action-btn-ghost"  id="storage-limit-cancel">キャンセル</button>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(sheet);

  const close = () => {
    document.getElementById('storage-limit-sheet')?.remove();
    document.getElementById('storage-limit-overlay')?.remove();
  };

  overlay.addEventListener('click', close);
  sheet.querySelector('#storage-limit-cancel').addEventListener('click', close);
  sheet.querySelector('#storage-limit-delete').addEventListener('click', () => {
    _deleteOldSessions(close);
  });
}

function _deleteOldSessions(closeSheet) {
  const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);

  const data = getSongs();
  let deletedCount = 0;

  for (const group of data.groups) {
    for (const song of group.songs || []) {
      if (!Array.isArray(song.sessions)) continue;
      const before = song.sessions.length;
      song.sessions = song.sessions.filter(session => {
        const date = _parseSessionDate(session);
        if (!date) return true;
        return date >= cutoff;
      });
      deletedCount += before - song.sessions.length;
    }
  }

  saveSongs(data);
  closeSheet();
  showToast(`${deletedCount}件の解析履歴を削除しました`);
}

function _parseSessionDate(session) {
  if (session.practice_date) {
    const d = new Date(session.practice_date);
    if (!isNaN(d)) return d;
  }
  if (session.recorded_at) {
    const m = session.recorded_at.match(/(\d{4})年(\d{2})月(\d{2})日/);
    if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  }
  return null;
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

  _chunks = [_audioFile];
  _chunkTranscripts = new Array(_chunks.length).fill(null);
  _failedChunkIndex = -1;

  await _processChunksFrom(0);
}

async function _acquireWakeLock() {
  if (!navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      if (!['idle', 'done', 'error'].includes(_state)) {
        _acquireWakeLock();
      }
    });
  } catch (_) {}
}

function _deduplicateTranscript(text, cutoffMinutes) {
  if (cutoffMinutes === 0) return text;
  const lines = text.split('\n');
  const result = [];
  let keep = false;
  for (const line of lines) {
    const m = line.match(/^\[(\d+):(\d{2})\]/);
    if (m) keep = parseInt(m[1]) >= cutoffMinutes;
    if (keep) result.push(line);
  }
  return result.join('\n');
}

async function _processChunksFrom(startIndex) {
  let analyzer;
  try {
    analyzer = new GeminiAudioAnalyzer();
  } catch (e) {
    _setState('error');
    _showError(e.message);
    return;
  }

  let uploadedFileName = null;

  try {
    await _acquireWakeLock();
    showToast('処理中は画面をスリープさせないでください');

    _setState('uploading');
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

    // 30分ステップ・5分オーバーラップ・35分区間で最大3時間をカバー
    const segments = [];
    for (let start = 0; start < 180; start += 30) {
      segments.push({ startMin: start, endMin: start + 35 });
    }

    let completedCount = 0;
    const totalSegments = segments.length;

    const tasks = segments.map(({ startMin, endMin }) => () =>
      analyzer.transcribeAudio(fileUri, mimeType, startMin, endMin).then(text => {
        completedCount++;
        _setStepStatus('transcribing', 'running', `(${completedCount}/${totalSegments})`);
        return { startMin, text };
      })
    );

    const segmentResults = await parallelLimit(tasks, CONCURRENCY_LIMIT);

    const fullTranscript = segmentResults
      .map(({ startMin, text }) => _deduplicateTranscript(text, startMin))
      .map(t => t.trim())
      .filter(Boolean)
      .join('\n');

    _setStepStatus('transcribing', 'done');
    _showTranscript(fullTranscript);

    _setState('analyzing');
    _setStepStatus('analyzing', 'running');
    const result = await analyzer.analyzeStructure(fullTranscript);
    _setStepStatus('analyzing', 'done');

    _currentResult     = result;
    _currentTranscript = fullTranscript;
    _setState('done');
    _renderResults(result);

  } catch (err) {
    _setState('error');
    _showError(err.message);
  } finally {
    if (uploadedFileName) {
      try { await analyzer.deleteFile(uploadedFileName); } catch (_) {}
    }
    if (wakeLock) { try { await wakeLock.release(); } catch (_) {} }
    _updateStartBtn();
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
    _updateStartBtn();
  } else if (state === 'idle') {
    progress.style.display = 'none';
    _updateStartBtn();
  }
}

function _setStepStatus(step, status, chunkLabel) {
  const row   = document.querySelector(`.analysis-step[data-step="${step}"]`);
  const label = row?.querySelector('.analysis-step-status');
  if (!row) return;

  row.classList.remove('running', 'done');
  if (status === 'running') {
    row.classList.add('running');
    if (label) label.textContent = chunkLabel ? `処理中… ${chunkLabel}` : '処理中…';
  } else if (status === 'done') {
    row.classList.add('done');
    if (label) label.textContent = chunkLabel ? `完了 ${chunkLabel}` : '完了';
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
  card.querySelector('.analysis-retry-btn')?.remove();
  card.style.display = 'block';
}

function _hideError() {
  const card = document.getElementById('analysis-error');
  card.querySelector('.analysis-retry-btn')?.remove();
  card.style.display = 'none';
}

function _showRetryButton(chunkIndex) {
  const card = document.getElementById('analysis-error');
  const btn = document.createElement('button');
  btn.className = 'action-btn-primary analysis-retry-btn';
  btn.textContent = _chunks.length > 1
    ? `チャンク ${chunkIndex + 1} から再試行`
    : '最初から再試行';
  btn.addEventListener('click', () => {
    _failedChunkIndex = -1;
    _hideError();
    _processChunksFrom(chunkIndex);
  });
  card.appendChild(btn);
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

// ─── ネイティブ共有（テキスト） ──────────────────

async function _shareAsText(result) {
  const cards = result.cards || [];
  const name  = result.session_name || 'セッション';
  const date  = result.practice_date
    ? result.practice_date.replace(/(\d{4})-(\d{2})-(\d{2})/, '$1年$2月$3日')
    : result.recorded_at || '';

  const lines = [`【${name}】${date ? ' ' + date : ''}`, ''];
  cards.forEach(card => {
    lines.push(`▶ ${card.section} ｜ ${(card.part || []).join(' / ')} ｜ ${card.category}`);
    lines.push(card.text || '');
    lines.push('');
  });

  try {
    await navigator.share({ title: name, text: lines.join('\n') });
  } catch (e) {
    if (e.name !== 'AbortError') showToast('共有に失敗しました');
  }
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
  const safeJson = jsonData.replace(/<\//g, '<\\/');

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
const SESSION = ${safeJson};
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
    ...result,
    practice_date: document.getElementById('analysis-practice-date')?.value || '',
    transcript:   '',
  };
  song.sessions.unshift(session);
  try {
    saveSongs(data);
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      showToast('容量不足のため保存できませんでした。古い履歴を削除してください。');
      return null;
    }
    throw e;
  }
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
  _chunks            = [];
  _chunkTranscripts  = [];
  _failedChunkIndex  = -1;
  _state             = 'idle';
  document.getElementById('analysis-demo-banner')?.remove();

  const saveBtn = document.getElementById('analysis-save-btn');
  if (saveBtn) saveBtn.style.display = 'flex';
  const shareBtn = document.getElementById('analysis-share-btn');
  if (shareBtn) shareBtn.style.display = '';

  _updateStartBtn();
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
