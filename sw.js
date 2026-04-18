/**
 * sw.js — Service Worker（PWA 用）
 * 目的：ホーム画面追加・起動高速化のみ
 * オフラインキャッシュは不要のため、ネットワーク優先で動作
 */

const CACHE_NAME = 'acapella-v55';
const CACHE_URLS = [
  './index.html',
  './style.css',
  './js/storage.js',
  './js/library.js',
  './js/settings.js',
  './js/app.js',
  './js/pitch-pipe.js',
  './js/metronome.js',
  './js/dict.js',
  './js/gemini.js',
  './js/analysis.js',
  './manifest.json',
];

// インストール：静的アセットをキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// アクティベート：古いキャッシュを削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// フェッチ：ネットワーク優先 → 失敗時にキャッシュへフォールバック
self.addEventListener('fetch', event => {
  // POST や chrome-extension などは無視
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // 成功したらキャッシュも更新
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
