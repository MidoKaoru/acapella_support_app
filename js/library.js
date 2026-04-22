/**
 * library.js
 * 曲ライブラリ画面のロジック。
 * グループ一覧 → 曲一覧 → 曲詳細 → 編集 の4ビューをSPA的に切り替える。
 * データは storage.js の getSongs / saveSongs 経由で localStorage に保存。
 */

'use strict';

// ─── 状態 ────────────────────────────────────

let _view            = 'groups'; // 'groups' | 'group-edit' | 'songs' | 'detail' | 'edit' | 'session-detail'
let _currentGroupId  = null;
let _currentSongId   = null;
let _currentSessionId = null;   // 表示中のセッションID
let _editDraft       = null;    // 編集フォームの一時状態
let _isPitchPlaying  = false;   // ピッチパイプ再生中
let _isMetroPlaying  = false;   // メトロノーム再生中
let _pendingSnapshot = null;    // 「今の状態を保存」からの初期値
let _groupSort       = 'manual'; // グループ一覧の並び順
let _songSort        = 'manual'; // 曲一覧の並び順
let _tempBpm         = null;    // 曲詳細画面の一時BPM（保存しない）
let _isGroupSortEditing  = false; // グループ並び替え編集モード
let _isSongSortEditing   = false; // 曲並び替え編集モード
let _isSessionSelectMode = false; // セッション選択モード

// ─── 公開 API ────────────────────────────────

function openLibrary() {
  _navigate('groups', {});
  const screen = document.getElementById('screen-library');
  screen.classList.add('open');
  screen.setAttribute('aria-hidden', 'false');
}

/**
 * 練習中画面の現在状態をキャプチャして曲追加画面を開く。
 * グループが1つもない場合はグループ一覧へ誘導する。
 */
function openLibraryNewSong(snapshot) {
  const screen = document.getElementById('screen-library');
  screen.classList.add('open');
  screen.setAttribute('aria-hidden', 'false');

  const data = getSongs();
  if (data.groups.length === 0) {
    // グループがまだないのでグループ作成画面へ
    _pendingSnapshot = snapshot;
    _navigate('group-edit', { groupId: null });
  } else {
    // グループが1件以上あれば必ずグループ一覧でユーザーに選ばせる
    _pendingSnapshot = snapshot;
    _navigate('groups', {});
  }
}

function closeLibrary() {
  _stopPlayback();
  const screen = document.getElementById('screen-library');
  screen.classList.remove('open');
  screen.setAttribute('aria-hidden', 'true');
}

function openLibraryForNewEntry() {
  const screen = document.getElementById('screen-library');
  screen.classList.add('open');
  screen.setAttribute('aria-hidden', 'false');
  const data = getSongs();
  if (data.groups.length === 0) {
    _navigate('group-edit', { groupId: null });
  } else if (data.groups.length === 1) {
    _navigate('edit', { groupId: data.groups[0].id, songId: null });
  } else {
    _navigate('groups', {});
  }
}

function openLibrarySessionDetail(groupId, songId, sessionId) {
  const screen = document.getElementById('screen-library');
  screen.classList.add('open');
  screen.setAttribute('aria-hidden', 'false');
  _navigate('session-detail', { groupId, songId, sessionId });
}

function openLibraryForGroupAdd() {
  const screen = document.getElementById('screen-library');
  screen.classList.add('open');
  screen.setAttribute('aria-hidden', 'false');
  _navigate('group-edit', { groupId: null });
}

function openLibraryForSongAdd(groupId) {
  const screen = document.getElementById('screen-library');
  screen.classList.add('open');
  screen.setAttribute('aria-hidden', 'false');
  _navigate('edit', { groupId, songId: null });
}

// ─── ナビゲーション ──────────────────────────

function _navigate(view, options) {
  _stopPlayback();
  _view = view;
  if (options.groupId   !== undefined) _currentGroupId  = options.groupId;
  if (options.songId    !== undefined) _currentSongId   = options.songId;
  if (options.sessionId !== undefined) _currentSessionId = options.sessionId;
  if (options.snapshot  !== undefined) _pendingSnapshot = options.snapshot;
  _isGroupSortEditing  = false;
  _isSongSortEditing   = false;
  _isSessionSelectMode = false;
  _render();
}

function _goBack() {
  _stopPlayback();
  switch (_view) {
    case 'groups':         closeLibrary(); break;
    case 'group-edit':     _navigate('groups', {}); break;
    case 'songs':          _navigate('groups', {}); break;
    case 'detail':         _navigate('songs', { groupId: _currentGroupId }); break;
    case 'session-detail': _navigate('detail', { groupId: _currentGroupId, songId: _currentSongId }); break;
    case 'edit':
      _currentSongId
        ? _navigate('detail', { groupId: _currentGroupId, songId: _currentSongId })
        : _navigate('songs',  { groupId: _currentGroupId });
      break;
  }
}

// ─── 描画ディスパッチャ ──────────────────────

function _render(resetScroll = true) {
  _updateHeader();
  const content = document.getElementById('library-content');
  if (resetScroll) {
    document.getElementById('screen-library').scrollTop = 0;
  }

  switch (_view) {
    case 'groups':         _renderGroups(content);                                                    break;
    case 'group-edit':     _renderGroupEdit(content, _currentGroupId);                                break;
    case 'songs':          _renderSongs(content, _currentGroupId);                                    break;
    case 'detail':         _renderDetail(content, _currentGroupId, _currentSongId);                   break;
    case 'edit':           _renderEdit(content, _currentGroupId, _currentSongId, _pendingSnapshot);   break;
    case 'session-detail': _renderSessionDetail(content, _currentGroupId, _currentSongId, _currentSessionId); break;
  }
}

function _updateHeader() {
  const data    = getSongs();
  const group   = data.groups.find(g => g.id === _currentGroupId);
  const song    = group?.songs.find(s => s.id === _currentSongId);

  const titles = {
    groups:           'ライブラリ',
    'group-edit':     _currentGroupId ? 'グループを編集' : 'グループを追加',
    songs:            group?.name ?? '曲一覧',
    detail:           song?.title ?? '曲詳細',
    edit:             _currentSongId ? '曲を編集' : '曲を追加',
    'session-detail': 'セッション詳細',
  };

  document.getElementById('library-title').textContent = titles[_view] ?? '';

  const addBtn = document.getElementById('library-add-btn');
  addBtn.style.visibility = ['groups', 'songs'].includes(_view) ? 'visible' : 'hidden';
}

// ─── ソートヘルパー ──────────────────────────

function _sortItems(items, sortKey, nameField) {
  if (sortKey === 'manual') return [...items];
  return [...items].sort((a, b) => {
    if (sortKey === 'date-asc')  return (a.createdAt || 0) - (b.createdAt || 0);
    if (sortKey === 'date-desc') return (b.createdAt || 0) - (a.createdAt || 0);
    const na = String(a[nameField] || '');
    const nb = String(b[nameField] || '');
    const cmp = na.localeCompare(nb, 'ja');
    return sortKey === 'name-asc' ? cmp : -cmp;
  });
}

function _sortSelectHtml(id, currentVal, isEditing) {
  const opts = [
    ['manual',    '手動'],
    ['date-asc',  '登録日時 古い順'],
    ['date-desc', '登録日時 新しい順'],
    ['name-asc',  'あいうえお順 A→Z'],
    ['name-desc', 'あいうえお順 Z→A'],
  ];
  const pencilBtn = currentVal === 'manual'
    ? `<button class="sort-edit-btn${isEditing ? ' active' : ''}" id="${id}-edit-btn" aria-label="並び替え編集">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
        </svg>
      </button>`
    : '';
  return `<div class="sort-row">
    <label class="sort-label" for="${id}">並び順</label>
    <select class="sort-select" id="${id}">
      ${opts.map(([v, l]) => `<option value="${v}"${currentVal === v ? ' selected' : ''}>${l}</option>`).join('')}
    </select>
    ${pencilBtn}
  </div>`;
}

// ─── グループ一覧ビュー ──────────────────────

function _renderGroups(content) {
  const data   = getSongs();
  const sorted = _sortItems(data.groups, _groupSort, 'name');
  let html = '<div class="library-groups-view">';

  if (data.groups.length >= 2) {
    html += _sortSelectHtml('group-sort-select', _groupSort, _isGroupSortEditing);
  }

  if (data.groups.length === 0) {
    html += `<div class="library-empty">
      <p class="library-empty-text">グループがありません</p>
      <p class="library-empty-hint">右上の ＋ からグループを追加してください</p>
    </div>`;
  } else {
    html += '<div class="library-list">';
    sorted.forEach((g, idx) => {
      const showMove = _groupSort === 'manual' && sorted.length >= 2 && _isGroupSortEditing;
      const moveBtns = showMove ? `
        <div class="library-card-sort-col">
          <button class="library-card-sort-btn" data-action="move-group-up"
            data-id="${_esc(g.id)}" ${idx === 0 ? 'disabled' : ''} aria-label="上へ">▲</button>
          <button class="library-card-sort-btn" data-action="move-group-down"
            data-id="${_esc(g.id)}" ${idx === sorted.length - 1 ? 'disabled' : ''} aria-label="下へ">▼</button>
        </div>` : '';
      html += `<div class="library-card">
        <button class="library-card-main" data-action="open-songs" data-group-id="${_esc(g.id)}">
          <span class="library-card-title">${_esc(g.name)}</span>
          <span class="library-card-meta">${g.songs.length}曲</span>
        </button>
        ${moveBtns}
        <button class="library-card-action-btn" data-action="edit-group" data-group-id="${_esc(g.id)}" aria-label="グループを編集">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
      </div>`;
    });
    html += '</div>';
  }

  html += `<div class="library-io-row">
    <button class="library-io-btn" data-action="export">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      エクスポート
    </button>
    <button class="library-io-btn" data-action="import">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      インポート
    </button>
  </div>
  <input type="file" id="library-import-file" accept=".json" style="display:none">`;

  html += '</div>';
  content.innerHTML = html;

  content.querySelector('#group-sort-select')?.addEventListener('change', e => {
    _groupSort = e.target.value;
    if (_groupSort !== 'manual') _isGroupSortEditing = false;
    _render(false);
  });
  content.querySelector('#group-sort-select-edit-btn')?.addEventListener('click', () => {
    _isGroupSortEditing = !_isGroupSortEditing;
    _render(false);
  });
  content.querySelectorAll('[data-action="open-songs"]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (_pendingSnapshot) {
        _navigate('edit', { groupId: btn.dataset.groupId, songId: null, snapshot: _pendingSnapshot });
      } else {
        _navigate('songs', { groupId: btn.dataset.groupId });
      }
    });
  });
  content.querySelectorAll('[data-action="edit-group"]').forEach(btn => {
    btn.addEventListener('click', () =>
      _navigate('group-edit', { groupId: btn.dataset.groupId }));
  });
  content.querySelectorAll('[data-action="move-group-up"]').forEach(btn => {
    btn.addEventListener('click', () => _moveGroup(btn.dataset.id, -1));
  });
  content.querySelectorAll('[data-action="move-group-down"]').forEach(btn => {
    btn.addEventListener('click', () => _moveGroup(btn.dataset.id, 1));
  });
  content.querySelector('[data-action="export"]')
    ?.addEventListener('click', _exportLibrary);
  const importBtn = content.querySelector('[data-action="import"]');
  const fileInput = content.querySelector('#library-import-file');
  importBtn?.addEventListener('click', () => fileInput.click());
  fileInput?.addEventListener('change', e => {
    if (e.target.files[0]) _importLibrary(e.target.files[0]);
  });
}

// ─── グループ編集ビュー ──────────────────────

function _renderGroupEdit(content, groupId) {
  const group = getSongs().groups.find(g => g.id === groupId) ?? null;

  content.innerHTML = `
    <div class="library-edit-form">
      <div class="card control-group">
        <span class="control-label">グループ名</span>
        <input type="text" id="group-edit-name" class="edit-text-input"
          placeholder="例：Harmony5" value="${_esc(group?.name ?? '')}">
      </div>
      <button class="action-btn-primary" id="group-edit-save">保存</button>
      ${group ? `<button class="action-btn-danger" id="group-edit-delete">このグループを削除</button>` : ''}
    </div>`;

  document.getElementById('group-edit-save').addEventListener('click', () => {
    const name = document.getElementById('group-edit-name').value.trim();
    if (!name) { document.getElementById('group-edit-name').focus(); return; }
    const d = getSongs();
    if (group) {
      d.groups.find(g => g.id === groupId).name = name;
      saveSongs(d);
      _navigate('groups', {});
    } else {
      const newId = _genId();
      d.groups.push({ id: newId, name, songs: [], createdAt: Date.now() });
      saveSongs(d);
      if (_pendingSnapshot) {
        // 「今の状態を保存」経由でグループ新規作成した場合：直接曲追加画面へ
        _navigate('edit', { groupId: newId, songId: null, snapshot: _pendingSnapshot });
      } else if (typeof isPendingAnalysis === 'function' && isPendingAnalysis()) {
        // 解析待ち状態でグループ新規作成した場合：直接曲追加画面へ
        _navigate('edit', { groupId: newId, songId: null });
      } else {
        _navigate('groups', {});
      }
    }
  });

  document.getElementById('group-edit-delete')?.addEventListener('click', () => {
    if (!confirm(`「${group.name}」を削除しますか？\n含まれる曲もすべて削除されます。`)) return;
    const d = getSongs();
    d.groups = d.groups.filter(g => g.id !== groupId);
    saveSongs(d);
    _navigate('groups', {});
  });
}

// ─── 曲一覧ビュー ────────────────────────────

function _renderSongs(content, groupId) {
  const group = getSongs().groups.find(g => g.id === groupId);
  if (!group) { _navigate('groups', {}); return; }

  const sorted = _sortItems(group.songs, _songSort, 'title');
  let html = '<div class="library-songs-view">';

  if (group.songs.length >= 2) {
    html += _sortSelectHtml('song-sort-select', _songSort, _isSongSortEditing);
  }

  if (group.songs.length === 0) {
    html += `<div class="library-empty">
      <p class="library-empty-text">曲がありません</p>
      <p class="library-empty-hint">右上の ＋ から曲を追加してください</p>
    </div>`;
  } else {
    html += '<div class="library-list">';
    sorted.forEach((s, idx) => {
      const keysStr  = s.keys.length ? s.keys.join(' / ') : 'キーなし';
      const meta     = `${keysStr}　${s.bpm} BPM　${parseFloat(s.baseFreq).toFixed(1)} Hz　${s.timeSig || 4}拍子`;
      const showMove = _songSort === 'manual' && sorted.length >= 2 && _isSongSortEditing;
      const moveBtns = showMove ? `
        <div class="library-card-sort-col">
          <button class="library-card-sort-btn" data-action="move-song-up"
            data-id="${_esc(s.id)}" ${idx === 0 ? 'disabled' : ''} aria-label="上へ">▲</button>
          <button class="library-card-sort-btn" data-action="move-song-down"
            data-id="${_esc(s.id)}" ${idx === sorted.length - 1 ? 'disabled' : ''} aria-label="下へ">▼</button>
        </div>` : '';
      html += `<div class="library-card">
        <button class="library-card-main" data-action="open-detail" data-song-id="${_esc(s.id)}">
          <span class="library-card-title">${_esc(s.title)}</span>
          <span class="library-card-meta">${_esc(meta)}</span>
        </button>
        ${moveBtns}
      </div>`;
    });
    html += '</div>';
  }

  html += '</div>';
  content.innerHTML = html;

  content.querySelector('#song-sort-select')?.addEventListener('change', e => {
    _songSort = e.target.value;
    if (_songSort !== 'manual') _isSongSortEditing = false;
    _render(false);
  });
  content.querySelector('#song-sort-select-edit-btn')?.addEventListener('click', () => {
    _isSongSortEditing = !_isSongSortEditing;
    _render(false);
  });
  content.querySelectorAll('[data-action="open-detail"]').forEach(btn => {
    btn.addEventListener('click', () =>
      _navigate('detail', { groupId, songId: btn.dataset.songId }));
  });
  content.querySelectorAll('[data-action="move-song-up"]').forEach(btn => {
    btn.addEventListener('click', () => _moveSong(groupId, btn.dataset.id, -1));
  });
  content.querySelectorAll('[data-action="move-song-down"]').forEach(btn => {
    btn.addEventListener('click', () => _moveSong(groupId, btn.dataset.id, 1));
  });
}

// ─── 曲詳細ビュー ────────────────────────────

function _renderDetail(content, groupId, songId) {
  const group = getSongs().groups.find(g => g.id === groupId);
  const song  = group?.songs.find(s => s.id === songId);
  if (!song) { _navigate('songs', { groupId }); return; }

  _tempBpm = song.bpm;

  const keysHtml = song.keys.length
    ? song.keys.map(k => `<span class="detail-key-chip">${_esc(k)}</span>`).join('')
    : '<span class="detail-key-none">キー未設定</span>';

  const sessions = Array.isArray(song.sessions) ? song.sessions : [];

  const TRASH_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6M14 11v6"/>
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
  </svg>`;

  let sessionsHtml;
  if (sessions.length === 0) {
    sessionsHtml = '<p class="session-history-empty">解析履歴はありません</p>';
  } else if (_isSessionSelectMode) {
    sessionsHtml = sessions.map(s => `
      <div class="library-card session-history-item session-select-item">
        <label class="session-select-checkbox-wrap">
          <input type="checkbox" class="session-select-checkbox" data-session-id="${_esc(s.id)}">
        </label>
        <button class="library-card-main session-select-main" data-session-id="${_esc(s.id)}">
          <span class="library-card-title">${_esc(s.session_name || 'セッション')}</span>
          <span class="library-card-meta">${s.practice_date ? _formatPracticeDate(s.practice_date) : _esc(s.recorded_at || '')} &middot; ${(s.cards || []).length}件</span>
        </button>
        <button class="library-card-action-btn session-delete-btn" data-session-id="${_esc(s.id)}" aria-label="このセッションを削除">
          ${TRASH_SVG}
        </button>
      </div>`).join('');
  } else {
    sessionsHtml = sessions.map(s => `
      <div class="library-card session-history-item">
        <button class="library-card-main" data-session-id="${_esc(s.id)}">
          <span class="library-card-title">${_esc(s.session_name || 'セッション')}</span>
          <span class="library-card-meta">${s.practice_date ? _formatPracticeDate(s.practice_date) : _esc(s.recorded_at || '')} &middot; ${(s.cards || []).length}件</span>
        </button>
      </div>`).join('');
  }

  const selectBtnHtml = sessions.length > 0
    ? `<button class="session-select-toggle-btn" id="session-select-toggle">
         ${_isSessionSelectMode ? 'キャンセル' : '選択'}
       </button>`
    : '';

  const bulkDeleteHtml = _isSessionSelectMode
    ? `<button class="action-btn-danger session-bulk-delete-btn" id="session-bulk-delete" disabled>選択したセッションを削除</button>`
    : '';

  content.innerHTML = `
    <div class="library-detail-view">
      <div class="card detail-card">
        <div class="detail-keys-row">${keysHtml}</div>
        <div class="detail-bpm-section">
          <span class="detail-info-label">BPM</span>
          <div class="detail-bpm-ctrl">
            <button class="bpm-adj-btn" id="detail-bpm-down10" aria-label="BPM −10">−10</button>
            <button class="bpm-adj-btn" id="detail-bpm-down1"  aria-label="BPM −1">−1</button>
            <span class="detail-info-value" id="detail-bpm-value">${song.bpm}</span>
            <button class="bpm-adj-btn" id="detail-bpm-up1"   aria-label="BPM +1">+1</button>
            <button class="bpm-adj-btn" id="detail-bpm-up10"  aria-label="BPM +10">+10</button>
            <button class="detail-bpm-reset" id="detail-bpm-reset" aria-label="元のBPMに戻す">↺</button>
          </div>
        </div>
        <div class="detail-info-cols">
          <div class="detail-info-col">
            <span class="detail-info-label">基準周波数</span>
            <span class="detail-info-value">${parseFloat(song.baseFreq).toFixed(1)} Hz</span>
          </div>
          <div class="detail-info-col">
            <span class="detail-info-label">拍子</span>
            <span class="detail-info-value">${song.timeSig || 4}拍子</span>
          </div>
        </div>
        ${song.notes ? `<p class="detail-notes">${_esc(song.notes)}</p>` : ''}
      </div>
      <div class="detail-play-row">
        <button class="detail-play-btn" id="detail-pitch-btn">${BTN_ICON_PITCH}${BTN_PLAY}</button>
        <button class="detail-play-btn" id="detail-metro-btn">${BTN_ICON_METRO}${BTN_PLAY}</button>
      </div>
      <button class="action-btn-secondary" id="detail-edit-btn">編集</button>

      <div class="session-history-section">
        <div class="session-history-header">
          <p class="settings-section-label">解析履歴</p>
          ${selectBtnHtml}
        </div>
        <div class="session-history-list">${sessionsHtml}</div>
        ${bulkDeleteHtml}
      </div>
    </div>`;

  function _applyDetailBpm(bpm) {
    _tempBpm = Math.max(40, Math.min(240, Math.round(bpm)));
    document.getElementById('detail-bpm-value').textContent = _tempBpm;
    if (_isMetroPlaying) {
      metronome.setBPM(_tempBpm);
      document.getElementById('bpm-input').value  = String(_tempBpm);
      document.getElementById('bpm-slider').value = Math.round(bpmToSlider(_tempBpm));
      const bottomBpmEl = document.getElementById('bottom-bpm');
      if (bottomBpmEl) bottomBpmEl.textContent = String(_tempBpm);
    }
  }

  document.getElementById('detail-bpm-down10').addEventListener('click', () => _applyDetailBpm(_tempBpm - 10));
  document.getElementById('detail-bpm-down1') .addEventListener('click', () => _applyDetailBpm(_tempBpm - 1));
  document.getElementById('detail-bpm-up1')   .addEventListener('click', () => _applyDetailBpm(_tempBpm + 1));
  document.getElementById('detail-bpm-up10')  .addEventListener('click', () => _applyDetailBpm(_tempBpm + 10));
  document.getElementById('detail-bpm-reset') .addEventListener('click', () => _applyDetailBpm(song.bpm));

  document.getElementById('detail-pitch-btn').addEventListener('click', () => {
    if (_isPitchPlaying) { _stopPitch(); } else { _playPitch(song); }
  });

  document.getElementById('detail-metro-btn').addEventListener('click', () => {
    if (_isMetroPlaying) { _stopMetro(); } else { _playMetro(song, _tempBpm); }
  });

  document.getElementById('detail-edit-btn').addEventListener('click', () =>
    _navigate('edit', { groupId, songId }));

  document.getElementById('session-select-toggle')?.addEventListener('click', () => {
    _isSessionSelectMode = !_isSessionSelectMode;
    _render(false);
  });

  if (!_isSessionSelectMode) {
    content.querySelectorAll('.session-history-item .library-card-main').forEach(btn => {
      btn.addEventListener('click', () =>
        _navigate('session-detail', { sessionId: btn.dataset.sessionId }));
    });
  }

  const bulkDeleteBtn = document.getElementById('session-bulk-delete');

  const _updateBulkBtn = () => {
    if (!bulkDeleteBtn) return;
    const any = [...content.querySelectorAll('.session-select-checkbox')].some(c => c.checked);
    bulkDeleteBtn.disabled = !any;
  };

  content.querySelectorAll('.session-select-main').forEach(btn => {
    btn.addEventListener('click', () => {
      const cb = btn.closest('.session-select-item').querySelector('.session-select-checkbox');
      if (cb) { cb.checked = !cb.checked; _updateBulkBtn(); }
    });
  });

  content.querySelectorAll('.session-select-checkbox').forEach(cb => {
    cb.addEventListener('change', _updateBulkBtn);
  });

  content.querySelectorAll('.session-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.sessionId;
      const sess = sessions.find(s => s.id === sid);
      if (!confirm(`「${sess?.session_name || 'セッション'}」を削除しますか？`)) return;
      const d = getSongs();
      const sng = d.groups.find(g => g.id === groupId)?.songs.find(s => s.id === songId);
      if (sng) { sng.sessions = (sng.sessions || []).filter(s => s.id !== sid); saveSongs(d); }
      _isSessionSelectMode = false;
      _render(false);
    });
  });

  bulkDeleteBtn?.addEventListener('click', () => {
    const ids = [...content.querySelectorAll('.session-select-checkbox:checked')]
      .map(c => c.dataset.sessionId);
    if (ids.length === 0) return;
    if (!confirm(`選択した${ids.length}件のセッションを削除しますか？`)) return;
    const d = getSongs();
    const sng = d.groups.find(g => g.id === groupId)?.songs.find(s => s.id === songId);
    if (sng) { sng.sessions = (sng.sessions || []).filter(s => !ids.includes(s.id)); saveSongs(d); }
    _isSessionSelectMode = false;
    _render(false);
  });
}

// ─── セッション詳細ビュー ────────────────────────

function _renderSessionDetail(content, groupId, songId, sessionId) {
  const group   = getSongs().groups.find(g => g.id === groupId);
  const song    = group?.songs.find(s => s.id === songId);
  const session = (song?.sessions || []).find(s => s.id === sessionId);
  if (!session) { _navigate('detail', { groupId, songId }); return; }

  const cards = session.cards || [];
  let libFilters = { parts: [], categories: [], sections: [], favorite: false };

  const parts = _sortParts([...new Set(cards.flatMap(c => c.part || []))]);
  const cats  = _sortCats([...new Set(cards.map(c => c.category).filter(Boolean))]);
  const secs  = _sortSecs([...new Set(cards.map(c => c.section).filter(Boolean))]);
  const hasFilterData = parts.length > 0 || cats.length > 0 || secs.length > 0;

  const transcriptHtml = session.transcript
    ? `<details class="card analysis-transcript-wrap">
        <summary class="analysis-transcript-summary">文字起こし結果</summary>
        <pre class="analysis-transcript-text">${_esc(session.transcript)}</pre>
       </details>`
    : '';

  const filterHtml = hasFilterData
    ? `<div class="card analysis-filters" id="lib-session-filters">
        <div class="analysis-filter-row">
          <span class="control-label">パート</span>
          <div class="analysis-chips" id="lib-part-chips"></div>
        </div>
        <div class="analysis-filter-row">
          <span class="control-label">カテゴリ</span>
          <div class="analysis-chips" id="lib-cat-chips"></div>
        </div>
        <div class="analysis-filter-row">
          <span class="control-label">セクション</span>
          <div class="analysis-chips" id="lib-sec-chips"></div>
        </div>
        <div class="analysis-filter-row">
          <span class="control-label">絞り込み</span>
          <div class="analysis-chips" id="lib-fav-chip-wrap"></div>
        </div>
        <button class="analysis-clear-filter" id="lib-clear-filter" style="display:none">全解除</button>
      </div>`
    : '';

  const dateDisplay = session.practice_date
    ? _formatPracticeDate(session.practice_date)
    : _esc(session.recorded_at || '');

  content.innerHTML = `
    <div class="session-detail-view">
      <div class="card session-detail-header-card">
        <p class="session-detail-name" id="lib-session-name">${_esc(session.session_name || 'セッション')}</p>
        <p class="session-detail-date">${dateDisplay}</p>
        <p class="session-detail-count">${cards.length}件のカード</p>
        <button class="action-btn-secondary lib-share-btn" id="lib-share-btn" style="margin-top:10px;font-size:13px;min-height:44px;gap:6px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          共有する
        </button>
      </div>
      ${transcriptHtml}
      ${filterHtml}
      <button class="action-btn-secondary add-card-btn" id="lib-add-card-btn">＋ カードを追加</button>
      <div class="session-detail-cards" id="lib-session-cards"></div>
    </div>`;

  // 共有
  content.querySelector('#lib-share-btn').addEventListener('click', () => {
    if (navigator.share) {
      _libShareAsText(session);
    } else {
      exportShareHtml(session);
    }
  });

  // カード追加ボタン
  content.querySelector('#lib-add-card-btn').addEventListener('click', () => {
    _openCardEditSheet({
      card: null,
      existingCards: cards,
      onSave: (savedCard, isNew) => {
        if (!isNew) return;
        savedCard.id = 'c' + Date.now();
        const _d = getSongs();
        const _g = _d.groups.find(g => g.id === groupId);
        const _sng = _g?.songs.find(s => s.id === songId);
        const _sess = _sng?.sessions?.find(s => s.id === sessionId);
        if (_sess) {
          if (!Array.isArray(_sess.cards)) _sess.cards = [];
          _sess.cards.unshift(savedCard);
          saveSongs(_d);
        }
        _render(false);
      },
    });
  });

  // セッション名のインライン編集
  const _libNameEl = content.querySelector('#lib-session-name');
  _libNameEl.classList.add('editable');
  _libNameEl.onclick = () => {
    const _cur = session.session_name || 'セッション';
    const _inp = document.createElement('input');
    _inp.type = 'text';
    _inp.value = _cur;
    _inp.className = 'edit-text-input';
    _inp.style.cssText = 'font-size:17px;font-weight:700;padding:4px 8px;min-height:auto;box-shadow:none;';
    _libNameEl.replaceWith(_inp);
    _inp.focus();
    _inp.select();
    const _commit = () => {
      const _newName = _inp.value.trim() || _cur;
      session.session_name = _newName;
      const _d = getSongs();
      const _g = _d.groups.find(g => g.id === groupId);
      const _sng = _g?.songs.find(s => s.id === songId);
      const _sess = _sng?.sessions?.find(s => s.id === sessionId);
      if (_sess) { _sess.session_name = _newName; saveSongs(_d); }
      _libNameEl.textContent = _newName;
      _inp.replaceWith(_libNameEl);
    };
    _inp.addEventListener('blur', _commit);
    _inp.addEventListener('keydown', e => { if (e.key === 'Enter') _inp.blur(); });
  };

  function renderLibCards() {
    const { parts: pf, categories: cf, sections: sf, favorite: fv } = libFilters;
    const filtered = (pf.length === 0 && cf.length === 0 && sf.length === 0 && !fv)
      ? cards
      : cards.filter(card => {
          const partOk = pf.length === 0 || pf.some(p => (card.part || []).includes(p));
          const catOk  = cf.length === 0 || cf.includes(card.category);
          const secOk  = sf.length === 0 || sf.includes(card.section);
          const favOk  = !fv            || card.isFavorite === true;
          return partOk && catOk && secOk && favOk;
        });

    const cardsEl = content.querySelector('#lib-session-cards');
    if (filtered.length === 0) {
      cardsEl.innerHTML = '<p class="analysis-empty">条件に合うカードがありません</p>';
      return;
    }

    cardsEl.innerHTML = '';
    filtered.forEach(card => {
      const importance = card.importance || '';
      const metaText = `${card.section || ''} ｜ ${(card.part || []).join(' / ')} ｜ ${card.category || ''}`;

      const cardDiv = document.createElement('div');
      cardDiv.className = `analysis-card ${importance}`;

      const headerDiv = document.createElement('div');
      headerDiv.className = 'analysis-card-header';

      const metaDiv = document.createElement('div');
      metaDiv.className   = 'analysis-card-meta editable-tag';
      metaDiv.textContent = metaText;
      metaDiv.addEventListener('click', (e) => {
        e.stopPropagation();
        _openCardEditSheet({
          card,
          existingCards: cards,
          onSave: () => {
            const _d = getSongs();
            const _g = _d.groups.find(g => g.id === groupId);
            const _sng = _g?.songs.find(s => s.id === songId);
            const _sess = _sng?.sessions?.find(s => s.id === sessionId);
            if (_sess?.cards) {
              const _idx = cards.indexOf(card);
              if (_idx !== -1) {
                _sess.cards[_idx] = { ..._sess.cards[_idx], ...card };
                saveSongs(_d);
              }
            }
            _render(false);
          },
        });
      });

      const starBtn = document.createElement('button');
      starBtn.className = 'card-fav-btn' + (card.isFavorite ? ' active' : '');
      starBtn.setAttribute('aria-label', 'お気に入り');
      starBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>';
      starBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        card.isFavorite = !card.isFavorite;
        starBtn.classList.toggle('active', card.isFavorite);
        const _d = getSongs();
        const _g = _d.groups.find(g => g.id === groupId);
        const _sng = _g?.songs.find(s => s.id === songId);
        const _sess = _sng?.sessions?.find(s => s.id === sessionId);
        if (_sess?.cards) {
          const _idx = cards.indexOf(card);
          if (_idx !== -1 && _sess.cards[_idx]) {
            _sess.cards[_idx].isFavorite = card.isFavorite;
            saveSongs(_d);
          }
        }
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'card-fav-btn';
      delBtn.style.color = 'var(--danger)';
      delBtn.setAttribute('aria-label', 'カードを削除');
      delBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('このカードを削除しますか？')) return;
        const cardIdx = cards.indexOf(card);
        if (cardIdx !== -1) {
          const _d = getSongs();
          const _g = _d.groups.find(g => g.id === groupId);
          const _sng = _g?.songs.find(s => s.id === songId);
          const _sess = _sng?.sessions?.find(s => s.id === sessionId);
          if (_sess?.cards) {
            _sess.cards.splice(cardIdx, 1);
            saveSongs(_d);
          }
          cards.splice(cardIdx, 1);
        }
        cardDiv.remove();
      });

      headerDiv.appendChild(metaDiv);
      headerDiv.appendChild(starBtn);
      headerDiv.appendChild(delBtn);

      const textP = document.createElement('p');
      textP.className   = 'analysis-card-text editable';
      textP.textContent = card.text || '';

      textP.onclick = () => {
        const _curText = card.text || '';
        const ta = document.createElement('textarea');
        ta.className = 'analysis-card-text-inline';
        ta.value     = _curText;
        ta.rows      = Math.max(3, Math.ceil(_curText.length / 36));
        textP.classList.remove('editable');
        textP.replaceWith(ta);
        ta.focus();
        ta.addEventListener('blur', () => {
          const _newText = ta.value.trim() || _curText;
          card.text = _newText;
          const _d = getSongs();
          const _g = _d.groups.find(g => g.id === groupId);
          const _sng = _g?.songs.find(s => s.id === songId);
          const _sess = _sng?.sessions?.find(s => s.id === sessionId);
          if (_sess?.cards) {
            const _idx = cards.indexOf(card);
            if (_idx !== -1 && _sess.cards[_idx]) {
              _sess.cards[_idx].text = _newText;
              saveSongs(_d);
            }
          }
          textP.textContent = _newText;
          textP.classList.add('editable');
          ta.replaceWith(textP);
        });
      };

      cardDiv.appendChild(headerDiv);
      cardDiv.appendChild(textP);
      cardsEl.appendChild(cardDiv);
    });
  }

  function buildLibChips(containerId, values, filterKey) {
    const container = content.querySelector('#' + containerId);
    if (!container) return;
    values.forEach(val => {
      const btn = document.createElement('button');
      btn.className   = 'analysis-chip';
      btn.textContent = val;
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        const arr = libFilters[filterKey];
        const idx = arr.indexOf(val);
        if (idx === -1) arr.push(val); else arr.splice(idx, 1);
        const has = libFilters.parts.length > 0 || libFilters.categories.length > 0
          || libFilters.sections.length > 0 || libFilters.favorite;
        const clearBtn = content.querySelector('#lib-clear-filter');
        if (clearBtn) clearBtn.style.display = has ? 'inline-flex' : 'none';
        renderLibCards();
      });
      container.appendChild(btn);
    });
  }

  if (hasFilterData) {
    buildLibChips('lib-part-chips', parts, 'parts');
    buildLibChips('lib-cat-chips',  cats,  'categories');
    buildLibChips('lib-sec-chips',  secs,  'sections');

    const favWrap = content.querySelector('#lib-fav-chip-wrap');
    if (favWrap) {
      const favBtn = document.createElement('button');
      favBtn.className   = 'analysis-chip';
      favBtn.textContent = '★ お気に入り';
      favBtn.addEventListener('click', () => {
        libFilters.favorite = !libFilters.favorite;
        favBtn.classList.toggle('active', libFilters.favorite);
        const has = libFilters.parts.length > 0 || libFilters.categories.length > 0
          || libFilters.sections.length > 0 || libFilters.favorite;
        const clearBtn = content.querySelector('#lib-clear-filter');
        if (clearBtn) clearBtn.style.display = has ? 'inline-flex' : 'none';
        renderLibCards();
      });
      favWrap.appendChild(favBtn);
    }

    content.querySelector('#lib-clear-filter')?.addEventListener('click', () => {
      libFilters = { parts: [], categories: [], sections: [], favorite: false };
      content.querySelectorAll('#lib-session-filters .analysis-chip').forEach(c => c.classList.remove('active'));
      content.querySelector('#lib-clear-filter').style.display = 'none';
      renderLibCards();
    });
  }

  renderLibCards();
}

// ─── ライブラリ共有（テキスト） ──────────────────

async function _libShareAsText(session) {
  const cards = session.cards || [];
  const name  = session.session_name || 'セッション';
  const date  = session.practice_date
    ? session.practice_date.replace(/(\d{4})-(\d{2})-(\d{2})/, '$1年$2月$3日')
    : session.recorded_at || '';

  const lines = [`【${name}】${date ? ' ' + date : ''}`, ''];
  cards.forEach(card => {
    lines.push(`▶ ${card.section || ''} ｜ ${(card.part || []).join(' / ')} ｜ ${card.category || ''}`);
    lines.push(card.text || '');
    lines.push('');
  });

  try {
    await navigator.share({ title: name, text: lines.join('\n') });
  } catch (e) {
    if (e.name !== 'AbortError') showToast('共有に失敗しました');
  }
}

// ─── ピッチパイプ再生・停止 ─────────────────────

function _playPitch(song) {
  const ctx = getAudioContext();
  pitchPipe.stopAll();
  pitchPipe.setBaseFreq(song.baseFreq);
  pitchPipe.setAudioContext(ctx);
  song.keys.forEach(k => pitchPipe.toggle(k));
  _isPitchPlaying = true;
  const btn = document.getElementById('detail-pitch-btn');
  if (btn) { btn.innerHTML = BTN_ICON_PITCH + BTN_STOP; btn.classList.add('playing'); }
}

function _stopPitch() {
  if (!_isPitchPlaying) return;
  pitchPipe.stopAll();
  document.querySelectorAll('.note-btn').forEach(b => b.classList.remove('active'));
  _isPitchPlaying = false;
  const btn = document.getElementById('detail-pitch-btn');
  if (btn) { btn.innerHTML = BTN_ICON_PITCH + BTN_PLAY; btn.classList.remove('playing'); }
}

// ─── メトロノーム再生・停止 ──────────────────────

function _playMetro(song, bpm) {
  const actualBpm = bpm ?? song.bpm;
  const ts = song.timeSig || 4;
  const ctx = getAudioContext();
  if (metronome.isPlaying) metronome.stop();
  metronome.setAudioContext(ctx);
  metronome.setBPM(actualBpm);
  metronome.setTimeSignature(String(ts));
  document.getElementById('time-sig').value = String(ts);
  buildBeatDots(metronome.beatsPerMeasure);
  metronome.setSubdivisionSteps([]);
  const bpmVal = String(actualBpm);
  document.getElementById('bpm-input').value  = bpmVal;
  document.getElementById('bpm-slider').value = Math.round(bpmToSlider(actualBpm));
  const _bottomBpmEl = document.getElementById('bottom-bpm');
  if (_bottomBpmEl) _bottomBpmEl.textContent = bpmVal;
  metronome.start();
  document.getElementById('metro-toggle-label').innerHTML = BTN_PAUSE;
  document.getElementById('metro-toggle').classList.add('playing');
  _isMetroPlaying = true;
  const btn = document.getElementById('detail-metro-btn');
  if (btn) { btn.innerHTML = BTN_ICON_METRO + BTN_STOP; btn.classList.add('playing'); }
}

function _stopMetro() {
  if (!_isMetroPlaying) return;
  if (metronome.isPlaying) {
    metronome.stop();
    document.getElementById('metro-toggle-label').innerHTML = BTN_PLAY;
    document.getElementById('metro-toggle').classList.remove('playing');
  }
  _isMetroPlaying = false;
  const btn = document.getElementById('detail-metro-btn');
  if (btn) { btn.innerHTML = BTN_ICON_METRO + BTN_PLAY; btn.classList.remove('playing'); }
}

// ─── 全停止（ナビゲーション時に呼ぶ） ────────────

function _stopPlayback() {
  _stopPitch();
  _stopMetro();
  // 編集画面の試奏ボタンもリセット
  const tryBtn = document.getElementById('edit-tryplay-btn');
  if (tryBtn) tryBtn.innerHTML = BTN_PLAY + ' 試奏';
}

// ─── 曲編集ビュー ────────────────────────────

function _renderEdit(content, groupId, songId, snapshot) {
  const group = getSongs().groups.find(g => g.id === groupId);
  const song  = songId ? group?.songs.find(s => s.id === songId) : null;

  if (song) {
    _editDraft = { title: song.title, keys: [...song.keys], bpm: song.bpm,
                   baseFreq: song.baseFreq, notes: song.notes ?? '',
                   timeSig: song.timeSig ?? 4 };
  } else if (snapshot) {
    // 「今の状態を保存」から開いた場合：キャプチャ値を初期値に使う
    _editDraft = { title: '', keys: [...snapshot.keys], bpm: snapshot.bpm,
                   baseFreq: snapshot.baseFreq, notes: '',
                   timeSig: snapshot.timeSig ?? 4 };
    _pendingSnapshot = null;
  } else {
    _editDraft = { title: '', keys: [], bpm: 120,
                   baseFreq: getSettings().baseFreq, notes: '',
                   timeSig: 4 };
  }

  content.innerHTML = `
    <div class="library-edit-form">
      <div class="card control-group">
        <span class="control-label">曲名</span>
        <input type="text" id="edit-title" class="edit-text-input"
          placeholder="曲名を入力" value="${_esc(_editDraft.title)}">
      </div>

      <div class="card control-group">
        <span class="control-label">キー音（複数選択可）</span>
        <div class="edit-note-grid" id="edit-note-grid"></div>
      </div>

      <div class="card control-group">
        <span class="control-label">拍子</span>
        <select id="edit-time-sig" class="sort-select" aria-label="拍子選択">
          <option value="2"${_editDraft.timeSig === 2 ? ' selected' : ''}>2拍子</option>
          <option value="3"${_editDraft.timeSig === 3 ? ' selected' : ''}>3拍子</option>
          <option value="4"${_editDraft.timeSig === 4 ? ' selected' : ''}>4拍子</option>
          <option value="5"${_editDraft.timeSig === 5 ? ' selected' : ''}>5拍子</option>
          <option value="6"${_editDraft.timeSig === 6 ? ' selected' : ''}>6拍子</option>
          <option value="7"${_editDraft.timeSig === 7 ? ' selected' : ''}>7拍子</option>
        </select>
      </div>

      <div class="card bpm-control">
        <button class="bpm-adj-btn" id="edit-bpm-down-big">−10</button>
        <button class="bpm-adj-btn" id="edit-bpm-down">−1</button>
        <div class="bpm-display-wrap">
          <input type="number" id="edit-bpm" class="bpm-input"
            value="${_editDraft.bpm}" min="20" max="300">
          <span class="bpm-unit">BPM</span>
        </div>
        <button class="bpm-adj-btn" id="edit-bpm-up">+1</button>
        <button class="bpm-adj-btn" id="edit-bpm-up-big">+10</button>
      </div>

      <div class="card control-group">
        <div class="freq-header">
          <span class="control-label">基準周波数（A4）</span>
          <span class="freq-display" id="edit-freq-display">
            ${parseFloat(_editDraft.baseFreq).toFixed(1)} Hz
          </span>
        </div>
        <div class="freq-controls">
          <button class="adj-btn" id="edit-freq-down-big">−1</button>
          <button class="adj-btn" id="edit-freq-down">−0.1</button>
          <input type="range" id="edit-freq-slider" min="420" max="460" step="0.1"
            value="${_editDraft.baseFreq}" class="freq-slider">
          <button class="adj-btn" id="edit-freq-up">+0.1</button>
          <button class="adj-btn" id="edit-freq-up-big">+1</button>
        </div>
      </div>

      <button class="action-btn-secondary" id="edit-tryplay-btn">${BTN_PLAY} 試奏</button>

      <div class="card control-group">
        <span class="control-label">メモ</span>
        <textarea id="edit-notes" class="edit-textarea" rows="3"
          placeholder="転調情報・注意事項など">${_esc(_editDraft.notes)}</textarea>
      </div>

      <button class="action-btn-primary" id="edit-save-btn">保存</button>
      ${songId ? `<button class="action-btn-danger" id="edit-delete-btn">この曲を削除</button>` : ''}
    </div>`;

  _buildEditNoteGrid();
  _bindEditEvents(groupId, songId);
}

function _buildEditNoteGrid() {
  const grid = document.getElementById('edit-note-grid');
  pitchPipe.notes.forEach(note => {
    const btn = document.createElement('button');
    btn.className = `edit-note-btn${note.isSharp ? ' sharp' : ''}`;
    btn.dataset.note = note.name;
    btn.innerHTML = `${_esc(note.name)}<span class="note-sub">${_esc(note.solfege)}</span>`;
    btn.classList.toggle('active', _editDraft.keys.includes(note.name));
    btn.addEventListener('click', () => {
      const idx = _editDraft.keys.indexOf(note.name);
      if (idx === -1) _editDraft.keys.push(note.name);
      else            _editDraft.keys.splice(idx, 1);
      btn.classList.toggle('active', _editDraft.keys.includes(note.name));
    });
    grid.appendChild(btn);
  });
}

function _bindEditEvents(groupId, songId) {
  // 拍子
  document.getElementById('edit-time-sig').addEventListener('change', e => {
    _editDraft.timeSig = parseInt(e.target.value, 10);
  });

  // BPM
  const bpmInput = document.getElementById('edit-bpm');
  const _applyBpm = v => {
    _editDraft.bpm = Math.max(20, Math.min(300, Math.round(Number(v))));
    bpmInput.value = _editDraft.bpm;
  };
  bpmInput.addEventListener('change', () => _applyBpm(bpmInput.value));
  document.getElementById('edit-bpm-down-big').addEventListener('click', () => _applyBpm(_editDraft.bpm - 10));
  document.getElementById('edit-bpm-down').addEventListener('click',     () => _applyBpm(_editDraft.bpm - 1));
  document.getElementById('edit-bpm-up').addEventListener('click',       () => _applyBpm(_editDraft.bpm + 1));
  document.getElementById('edit-bpm-up-big').addEventListener('click',   () => _applyBpm(_editDraft.bpm + 10));

  // 基準周波数
  const freqSlider  = document.getElementById('edit-freq-slider');
  const freqDisplay = document.getElementById('edit-freq-display');
  const _applyFreq  = v => {
    _editDraft.baseFreq = Math.max(420, Math.min(460, Math.round(parseFloat(v) * 10) / 10));
    freqSlider.value    = _editDraft.baseFreq;
    freqDisplay.textContent = `${_editDraft.baseFreq.toFixed(1)} Hz`;
  };
  freqSlider.addEventListener('input', () => _applyFreq(freqSlider.value));
  document.getElementById('edit-freq-down-big').addEventListener('click', () => _applyFreq(_editDraft.baseFreq - 1));
  document.getElementById('edit-freq-down').addEventListener('click',     () => _applyFreq(_editDraft.baseFreq - 0.1));
  document.getElementById('edit-freq-up').addEventListener('click',       () => _applyFreq(_editDraft.baseFreq + 0.1));
  document.getElementById('edit-freq-up-big').addEventListener('click',   () => _applyFreq(_editDraft.baseFreq + 1));

  // 試奏（ピッチパイプ＋メトロノーム）
  document.getElementById('edit-tryplay-btn').addEventListener('click', () => {
    const btn = document.getElementById('edit-tryplay-btn');
    if (_isPitchPlaying || _isMetroPlaying) {
      _stopPitch();
      _stopMetro();
      btn.innerHTML = BTN_PLAY + ' 試奏';
    } else {
      const ctx = getAudioContext();

      // ピッチパイプ
      pitchPipe.stopAll();
      pitchPipe.setBaseFreq(_editDraft.baseFreq);
      pitchPipe.setAudioContext(ctx);
      _editDraft.keys.forEach(k => pitchPipe.toggle(k));
      _isPitchPlaying = true;

      // メトロノーム
      if (metronome.isPlaying) metronome.stop();
      metronome.setAudioContext(ctx);
      metronome.setBPM(_editDraft.bpm);
      const _ts = _editDraft.timeSig || 4;
      metronome.setTimeSignature(String(_ts));
      document.getElementById('time-sig').value = String(_ts);
      buildBeatDots(metronome.beatsPerMeasure);
      metronome.setSubdivisionSteps([]);
      const bpmVal = String(_editDraft.bpm);
      document.getElementById('bpm-input').value  = bpmVal;
      document.getElementById('bpm-slider').value = Math.round(bpmToSlider(_editDraft.bpm));
      const _bpmEl = document.getElementById('bottom-bpm');
      if (_bpmEl) _bpmEl.textContent = bpmVal;
      metronome.start();
      document.getElementById('metro-toggle-label').innerHTML = BTN_PAUSE;
      document.getElementById('metro-toggle').classList.add('playing');
      _isMetroPlaying = true;

      btn.innerHTML = BTN_STOP + ' 停止';
    }
  });

  // メモ
  document.getElementById('edit-notes').addEventListener('input', e => {
    _editDraft.notes = e.target.value;
  });

  // 保存
  document.getElementById('edit-save-btn').addEventListener('click', () => {
    const title = document.getElementById('edit-title').value.trim();
    if (!title) { document.getElementById('edit-title').focus(); return; }
    _editDraft.title = title;
    _editDraft.notes = document.getElementById('edit-notes').value;

    const d     = getSongs();
    const group = d.groups.find(g => g.id === groupId);
    let savedSongId = songId;
    if (songId) {
      const idx = group.songs.findIndex(s => s.id === songId);
      group.songs[idx] = { id: songId, ..._editDraft };
    } else {
      savedSongId = _genId();
      group.songs.push({ id: savedSongId, createdAt: Date.now(), ..._editDraft });
    }
    saveSongs(d);
    _stopPlayback();
    if (typeof isPendingAnalysis === 'function' && isPendingAnalysis()) {
      clearPendingAnalysis();
      closeLibrary();
      startAnalysisForSong(groupId, savedSongId);
    } else {
      _navigate('songs', { groupId });
    }
  });

  // 削除
  document.getElementById('edit-delete-btn')?.addEventListener('click', () => {
    const song = getSongs().groups.find(g => g.id === groupId)?.songs.find(s => s.id === songId);
    if (!confirm(`「${song?.title}」を削除しますか？`)) return;
    const d     = getSongs();
    const group = d.groups.find(g => g.id === groupId);
    group.songs = group.songs.filter(s => s.id !== songId);
    saveSongs(d);
    _stopPlayback();
    _navigate('songs', { groupId });
  });
}

// ─── エクスポート・インポート ─────────────────

function _exportLibrary() {
  const data = getSongs();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `acapella_library_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function _importLibrary(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!Array.isArray(imported.groups)) throw new Error('invalid');

      const current = getSongs();

      // グループ名でマージ：同名グループがあれば曲を追加、なければグループごと追加
      imported.groups.forEach(ig => {
        const existing = current.groups.find(g => g.name === ig.name);
        if (existing) {
          ig.songs.forEach(s => existing.songs.push({ ...s, id: _genId() }));
        } else {
          current.groups.push({
            id:    _genId(),
            name:  ig.name,
            songs: ig.songs.map(s => ({ ...s, id: _genId() })),
          });
        }
      });

      saveSongs(current);
      _navigate('groups', {});
    } catch {
      alert('ファイルの形式が正しくありません。');
    }
  };
  reader.readAsText(file);
}

// ─── 並び順の手動変更 ─────────────────────────

function _moveGroup(id, dir) {
  const d   = getSongs();
  const idx = d.groups.findIndex(g => g.id === id);
  const to  = idx + dir;
  if (to < 0 || to >= d.groups.length) return;
  [d.groups[idx], d.groups[to]] = [d.groups[to], d.groups[idx]];
  saveSongs(d);
  _render(false);
}

function _moveSong(groupId, songId, dir) {
  const d     = getSongs();
  const group = d.groups.find(g => g.id === groupId);
  if (!group) return;
  const idx = group.songs.findIndex(s => s.id === songId);
  const to  = idx + dir;
  if (to < 0 || to >= group.songs.length) return;
  [group.songs[idx], group.songs[to]] = [group.songs[to], group.songs[idx]];
  saveSongs(d);
  _render(false);
}

// ─── ユーティリティ ──────────────────────────

function _genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function _formatPracticeDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return `${parts[0]}年${parts[1]}月${parts[2]}日`;
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── 初期化 ──────────────────────────────────

function initLibrary() {
  document.getElementById('library-back-btn').addEventListener('click', _goBack);

  document.getElementById('library-add-btn').addEventListener('click', () => {
    if (_view === 'groups') _navigate('group-edit', { groupId: null });
    if (_view === 'songs')  _navigate('edit', { groupId: _currentGroupId, songId: null });
  });

  // 右スワイプで戻る（グループ一覧・曲一覧のみ）
  const _screen = document.getElementById('screen-library');
  let _sx = 0, _sy = 0;
  _screen.addEventListener('touchstart', e => {
    if (e.target.closest('input[type="range"]')) return;
    _sx = e.touches[0].clientX;
    _sy = e.touches[0].clientY;
  }, { passive: true });
  _screen.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - _sx;
    const dy = e.changedTouches[0].clientY - _sy;
    if (dx > 50 && Math.abs(dx) > Math.abs(dy) && (_view === 'groups' || _view === 'songs')) {
      _goBack();
    }
  }, { passive: true });

  document.getElementById('library-close-btn').addEventListener('click', () => {
    // 詳細ビューなら、一時BPM（変更済みの場合はそれ）をメインに反映してから閉じる
    if (_view === 'detail' && _currentGroupId && _currentSongId) {
      const bpm = _tempBpm ?? (() => {
        const group = getSongs().groups.find(g => g.id === _currentGroupId);
        return group?.songs.find(s => s.id === _currentSongId)?.bpm;
      })();
      if (bpm) {
        const bpmVal = String(bpm);
        const bpmInput  = document.getElementById('bpm-input');
        const bpmSlider = document.getElementById('bpm-slider');
        const bottomBpm = document.getElementById('bottom-bpm');
        if (bpmInput)  bpmInput.value  = bpmVal;
        if (bpmSlider) bpmSlider.value = Math.round(bpmToSlider(bpm));
        if (bottomBpm) bottomBpm.textContent = bpmVal;
        metronome.setBPM(bpm);
      }
    }
    closeLibrary();
  });
}
