'use strict';

/**
 * dict.js
 * 音楽用語の誤変換補正辞書。
 * storage.js の getDict() / saveDict() に依存する（storage.js より後に読み込むこと）。
 */

const _DEFAULT_DICT = {
  '機体':   '機材',
  'ワオン':  '和音',
  'ケカ音':  '経過音',
  'ケカおん': '経過音',
  '経家音':  '経過音',
};

// ─── 辞書読み込み（デフォルトとマージ） ─────────

function loadDict() {
  const stored = getDict();
  if (!stored || Object.keys(stored).length === 0) {
    saveDict({ ..._DEFAULT_DICT });
    return { ..._DEFAULT_DICT };
  }
  let updated = false;
  for (const [wrong, correct] of Object.entries(_DEFAULT_DICT)) {
    if (!(wrong in stored)) {
      stored[wrong] = correct;
      updated = true;
    }
  }
  if (updated) saveDict(stored);
  return stored;
}

// ─── 用語追加 ────────────────────────────────────

function addTerm(wrong, correct) {
  const dict = loadDict();
  dict[wrong] = correct;
  saveDict(dict);
}

// ─── テキスト正規化 ──────────────────────────────

function normalizeMusicTerms(text) {
  const dict = loadDict();
  let result = text;
  for (const [wrong, correct] of Object.entries(dict)) {
    result = result.replaceAll(wrong, correct);
  }
  return result;
}

// ─── エクスポート / インポート ───────────────────

function exportDictFile() {
  const dict = loadDict();
  const blob = new Blob([JSON.stringify(dict, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'musicTermDict.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importDictFromJson(json) {
  saveDict(JSON.parse(json));
}
