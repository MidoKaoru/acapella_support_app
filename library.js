/**
 * library.js
 * 曲ライブラリ画面のロジック。
 * グループ一覧 → 曲一覧 → 曲詳細 → 編集 の4ビューをSPA的に切り替える。
 * データは storage.js の getSongs / saveSongs 経由で localStorage に保存。
 */

'use strict';

// ─── 状態 ────────────────────────────────────

let _view            = 'groups'; // 'groups' | 'group-edit' | 'songs' | 'detail' | 'edit'
let _currentGroupId  = null;
let _currentSongId   = null;
let _editDraft       = null;    // 編集フォームの一時状態
let _isPitchPlaying  = false;   // ピッチパイプ再生中
let _isMetroPlaying  = false;   // メトロノーム再生中
let _pendingSnapshot = null;    // 「今の状態を保存」からの初期値
let _groupSort       = 'manual'; // グループ一覧の並び順
let _songSort        = 'manual'; // 曲一覧の並び順

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

// ─── ナビゲーション ──────────────────────────

function _navigate(view, options) {
  _stopPlayback();
  _view = view;
  if (options.groupId  !== undefined) _currentGroupId = options.groupId;
  if (options.songId   !== undefined) _currentSongId  = options.songId;
  if (options.snapshot !== undefined) _pendingSnapshot = options.snapshot;
  _render();
}

function _goBack() {
  _stopPlayback();
  switch (_view) {
    case 'groups':     closeLibrary(); break;
    case 'group-edit': _navigate('groups', {}); break;
    case 'songs':      _navigate('groups', {}); break;
    case 'detail':     _navigate('songs', { groupId: _currentGroupId }); break;
    case 'edit':
      _currentSongId
        ? _navigate('detail', { groupId: _currentGroupId, songId: _currentSongId })
        : _navigate('songs',  { groupId: _currentGroupId });
      break;
  }
}

// ─── 描画ディスパッチャ ──────────────────────

function _render() {
  _updateHeader();
  const content = document.getElementById('library-content');
  // スクロール位置をリセット
  document.getElementById('screen-library').scrollTop = 0;

  switch (_view) {
    case 'groups':     _renderGroups(content);                                                    break;
    case 'group-edit': _renderGroupEdit(content, _currentGroupId);                                break;
    case 'songs':      _renderSongs(content, _currentGroupId);                                    break;
    case 'detail':     _renderDetail(content, _currentGroupId, _currentSongId);                   break;
    case 'edit':       _renderEdit(content, _currentGroupId, _currentSongId, _pendingSnapshot);   break;
  }
}

function _updateHeader() {
  const data    = getSongs();
  const group   = data.groups.find(g => g.id === _currentGroupId);
  const song    = group?.songs.find(s => s.id === _currentSongId);

  const titles = {
    groups:       'ライブラリ',
    'group-edit': _currentGroupId ? 'グループを編集' : 'グループを追加',
    songs:        group?.name ?? '曲一覧',
    detail:       song?.title ?? '曲詳細',
    edit:         _currentSongId ? '曲を編集' : '曲を追加',
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

function _sortSelectHtml(id, currentVal) {
  const opts = [
    ['manual',    '手動'],
    ['date-asc',  '登録日時 古い順'],
    ['date-desc', '登録日時 新しい順'],
    ['name-asc',  'あいうえお順 A→Z'],
    ['name-desc', 'あいうえお順 Z→A'],
  ];
  return `<div class="sort-row">
    <label class="sort-label" for="${id}">並び順</label>
    <select class="sort-select" id="${id}">
      ${opts.map(([v, l]) => `<option value="${v}"${currentVal === v ? ' selected' : ''}>${l}</option>`).join('')}
    </select>
  </div>`;
}

// ─── グループ一覧ビュー ──────────────────────

function _renderGroups(content) {
  const data   = getSongs();
  const sorted = _sortItems(data.groups, _groupSort, 'name');
  let html = '<div class="library-groups-view">';

  if (data.groups.length >= 2) {
    html += _sortSelectHtml('group-sort-select', _groupSort);
  }

  if (data.groups.length === 0) {
    html += `<div class="library-empty">
      <p class="library-empty-text">グループがありません</p>
      <p class="library-empty-hint">右上の ＋ からグループを追加してください</p>
    </div>`;
  } else {
    html += '<div class="library-list">';
    sorted.forEach((g, idx) => {
      const showMove = _groupSort === 'manual' && sorted.length >= 2;
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
    _render();
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
    html += _sortSelectHtml('song-sort-select', _songSort);
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
      const meta     = `${keysStr}　${s.bpm} BPM　${parseFloat(s.baseFreq).toFixed(1)} Hz`;
      const showMove = _songSort === 'manual' && sorted.length >= 2;
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
    _render();
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

  const keysHtml = song.keys.length
    ? song.keys.map(k => `<span class="detail-key-chip">${_esc(k)}</span>`).join('')
    : '<span class="detail-key-none">キー未設定</span>';

  content.innerHTML = `
    <div class="library-detail-view">
      <div class="card detail-card">
        <div class="detail-keys-row">${keysHtml}</div>
        <div class="detail-info-row">
          <span class="detail-info-item">
            <span class="detail-info-label">BPM</span>
            <span class="detail-info-value">${song.bpm}</span>
          </span>
          <span class="detail-info-item">
            <span class="detail-info-label">基準周波数</span>
            <span class="detail-info-value">${parseFloat(song.baseFreq).toFixed(1)} Hz</span>
          </span>
        </div>
        ${song.notes ? `<p class="detail-notes">${_esc(song.notes)}</p>` : ''}
      </div>
      <div class="detail-play-row">
        <button class="detail-play-btn" id="detail-pitch-btn">${BTN_ICON_PITCH}${BTN_PLAY}</button>
        <button class="detail-play-btn" id="detail-metro-btn">${BTN_ICON_METRO}${BTN_PLAY}</button>
      </div>
      <button class="action-btn-secondary" id="detail-edit-btn">編集</button>
    </div>`;

  document.getElementById('detail-pitch-btn').addEventListener('click', () => {
    if (_isPitchPlaying) {
      _stopPitch();
    } else {
      _playPitch(song);
    }
  });

  document.getElementById('detail-metro-btn').addEventListener('click', () => {
    if (_isMetroPlaying) {
      _stopMetro();
    } else {
      _playMetro(song);
    }
  });

  document.getElementById('detail-edit-btn').addEventListener('click', () =>
    _navigate('edit', { groupId, songId }));
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

function _playMetro(song) {
  const ctx = getAudioContext();
  if (metronome.isPlaying) metronome.stop();
  metronome.setAudioContext(ctx);
  metronome.setBPM(song.bpm);
  metronome.setSubdivisionSteps([]); // 裏拍をリセットして表拍のみ鳴らす
  const bpmVal = String(song.bpm);
  document.getElementById('bpm-input').value        = bpmVal;
  document.getElementById('bpm-slider').value       = Math.round(bpmToSlider(song.bpm));
  document.getElementById('bottom-bpm').textContent = bpmVal;
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
                   baseFreq: song.baseFreq, notes: song.notes ?? '' };
  } else if (snapshot) {
    // 「今の状態を保存」から開いた場合：キャプチャ値を初期値に使う
    _editDraft = { title: '', keys: [...snapshot.keys], bpm: snapshot.bpm,
                   baseFreq: snapshot.baseFreq, notes: '' };
    _pendingSnapshot = null;
  } else {
    _editDraft = { title: '', keys: [], bpm: 120,
                   baseFreq: getSettings().baseFreq, notes: '' };
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
      metronome.setSubdivisionSteps([]); // 裏拍をリセットして表拍のみ鳴らす
      const bpmVal = String(_editDraft.bpm);
      document.getElementById('bpm-input').value        = bpmVal;
      document.getElementById('bpm-slider').value       = Math.round(bpmToSlider(_editDraft.bpm));
      document.getElementById('bottom-bpm').textContent = bpmVal;
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
    if (songId) {
      const idx = group.songs.findIndex(s => s.id === songId);
      group.songs[idx] = { id: songId, ..._editDraft };
    } else {
      group.songs.push({ id: _genId(), createdAt: Date.now(), ..._editDraft });
    }
    saveSongs(d);
    _stopPlayback();
    _navigate('songs', { groupId });
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
  _render();
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
  _render();
}

// ─── ユーティリティ ──────────────────────────

function _genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
    // 詳細ビューなら、その曲のBPMをメトロノームに反映してから閉じる
    if (_view === 'detail' && _currentGroupId && _currentSongId) {
      const group = getSongs().groups.find(g => g.id === _currentGroupId);
      const song  = group?.songs.find(s => s.id === _currentSongId);
      if (song && song.bpm) {
        const bpmVal = String(song.bpm);
        const bpmInput  = document.getElementById('bpm-input');
        const bpmSlider = document.getElementById('bpm-slider');
        const bottomBpm = document.getElementById('bottom-bpm');
        if (bpmInput)  bpmInput.value  = bpmVal;
        if (bpmSlider) bpmSlider.value = bpmVal;
        if (bottomBpm) bottomBpm.textContent = bpmVal;
        metronome.setBPM(song.bpm);
      }
    }
    closeLibrary();
  });
}
