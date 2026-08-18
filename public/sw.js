/* =====================================================================
   sw.js  —  Service Worker
   ・アプリ本体（HTML/CSS/JS/Leaflet/アイコン）をキャッシュしてオフライン起動
   ・OSM のタイル画像も一定枚数キャッシュ（一度見た地図は圏外でも表示できる）
   ・GAS API と Nominatim はキャッシュせず常にネットワークへ
   ===================================================================== */

const VERSION    = 'v1.0.0';
const APP_CACHE  = `sales-logger-${VERSION}`;
const TILE_CACHE = 'sales-logger-tiles-v1';
const TILE_LIMIT = 400;                      // 保持するタイル画像の最大枚数

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/store.js',
  './js/app.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

/* ------------------------------ インストール ------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

/* -------------------------------- 有効化 -------------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== APP_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ------------------------------- フェッチ ------------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) API 系は常にネットワーク（キャッシュ厳禁）
  if (url.hostname.endsWith('script.google.com') ||
      url.hostname.endsWith('googleusercontent.com') ||
      url.hostname.endsWith('nominatim.openstreetmap.org')) {
    return;   // ブラウザ標準の処理に任せる
  }

  // 2) 地図タイル → キャッシュ優先（無いときだけ取得して保存）
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(tileStrategy(req));
    return;
  }

  // 3) ページ遷移 → ネットワーク優先、失敗時はキャッシュの index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html', { ignoreSearch: true }))
    );
    return;
  }

  // 4) 同一オリジンの静的ファイル → キャッシュ即返し＋裏で更新（stale-while-revalidate）
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

/* ------------------------------ 各種戦略 ------------------------------ */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || new Response('オフラインです', { status: 503, statusText: 'Offline' });
}

async function tileStrategy(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) {   // opaque(no-cors) も保存対象にする
      cache.put(req, res.clone());
      trimCache(TILE_CACHE, TILE_LIMIT);
    }
    return res;
  } catch (e) {
    // 圏外でキャッシュにも無い場合。画像は表示されないが地図操作は継続できる
    return new Response(null, { status: 504, statusText: 'Tile unavailable' });
  }
}

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  for (let i = 0; i < keys.length - limit; i++) await cache.delete(keys[i]);
}

/* --------------------------- 即時更新メッセージ --------------------------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
