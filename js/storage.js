/**
 * storage.js
 * localStorageアクセスを一元管理するデータアクセス層。
 * アプリ全体から直接 localStorage を操作しない。
 * 将来的な IndexedDB 移行・暗号化対応時はこのファイルの内部実装を差し替えるだけで対応可能。
 */

'use strict';

const KEYS = {
  SONGS:     'acapella:songs',
  SETTINGS:  'acapella:settings',
  DICT:      'acapella:dict',
};

// ─── 曲ライブラリ ────────────────────────────

/**
 * 曲ライブラリデータを取得する。
 * @returns {{ groups: Group[] }}
 */
function getSongs() {
  try {
    const raw = localStorage.getItem(KEYS.SONGS);
    return raw ? JSON.parse(raw) : { groups: [] };
  } catch {
    return { groups: [] };
  }
}

/**
 * 曲ライブラリデータを保存する。
 * @param {{ groups: Group[] }} data
 */
function saveSongs(data) {
  localStorage.setItem(KEYS.SONGS, JSON.stringify(data));
}

// ─── 設定 ────────────────────────────────────

/**
 * 設定データを取得する。
 * @returns {Settings}
 */
function getSettings() {
  try {
    const raw = localStorage.getItem(KEYS.SETTINGS);
    return raw ? JSON.parse(raw) : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

/**
 * 設定データを保存する。
 * @param {Settings} data
 */
function saveSettings(data) {
  localStorage.setItem(KEYS.SETTINGS, JSON.stringify(data));
}

/**
 * 設定のデフォルト値。
 * @returns {Settings}
 */
function defaultSettings() {
  return {
    baseFreq:  440,
    waveType:  'sine',
    soundType: 'woodblock',
    apiKey:    '',
  };
}

// ─── 誤変換辞書 ──────────────────────────────

/**
 * 誤変換辞書を取得する。
 * @returns {Object|null}
 */
function getDict() {
  try {
    const raw = localStorage.getItem(KEYS.DICT);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 誤変換辞書を保存する。
 * @param {Object} dict
 */
function saveDict(dict) {
  localStorage.setItem(KEYS.DICT, JSON.stringify(dict));
}

// ─── APIキー（設定の一部だが頻繁にアクセスするため個別に公開） ───

/**
 * Gemini APIキーを取得する。
 * @returns {string}
 */
function getApiKey() {
  return getSettings().apiKey ?? '';
}

/**
 * Gemini APIキーを保存する。
 * @param {string} key
 */
function saveApiKey(key) {
  const settings = getSettings();
  settings.apiKey = key;
  saveSettings(settings);
}
