/* =====================================================================
   store.js  —  データ層
   ・GAS(スプレッドシート) 連携 / 未設定時は端末内ローカル保存で単体動作
   ・オフライン時は送信キューに退避し、オンライン復帰で自動再送
   ・逆ジオコーディング（GAS 経由 / 直接 Nominatim のフォールバック）
   ===================================================================== */
'use strict';

const Store = (() => {

  const KEYS = {
    settings: 'sl.settings.v1',
    logs:     'sl.logs.v1',      // GASモード=表示キャッシュ / ローカルモード=本体
    queue:    'sl.queue.v1',
    members:  'sl.members.v1',
    sync:     'sl.lastSync.v1'
  };

  const PALETTE = [
    '#e11d48', '#2563eb', '#16a34a', '#f97316', '#9333ea',
    '#0d9488', '#db2777', '#a16207', '#4f46e5', '#65a30d'
  ];
  const FALLBACK_MEMBERS = ['営業A', '営業B', '営業C', '営業D'];

  /* ------------------------- localStorage ------------------------- */
  const load = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  };
  const save = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { console.warn('保存に失敗しました', e); return false; }
  };

  /* ---------------------------- 設定 ---------------------------- */
  let settings = Object.assign(
    { apiUrl: '', token: '', myMember: '' },
    load(KEYS.settings, {})
  );

  const getSettings = () => Object.assign({}, settings);
  const setSettings = (patch) => {
    settings = Object.assign({}, settings, patch);
    settings.apiUrl = String(settings.apiUrl || '').trim();
    settings.token = String(settings.token || '').trim();
    save(KEYS.settings, settings);
    return getSettings();
  };
  /** 'gas' = スプレッドシート連携 / 'local' = 端末内のみ */
  const mode = () => (settings.apiUrl ? 'gas' : 'local');

  /* --------------------------- 通信基盤 --------------------------- */
  const withTimeout = (ms) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    return { signal: ac.signal, done: () => clearTimeout(timer) };
  };

  async function apiGet(action, params = {}, timeoutMs = 20000) {
    if (!settings.apiUrl) throw new Error('GAS のウェブアプリ URL が未設定です');
    const url = new URL(settings.apiUrl);
    url.searchParams.set('action', action);
    if (settings.token) url.searchParams.set('token', settings.token);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    const t = withTimeout(timeoutMs);
    try {
      const res = await fetch(url.toString(), { method: 'GET', redirect: 'follow', signal: t.signal });
      if (!res.ok) throw new Error(`通信エラー (HTTP ${res.status})`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'サーバーがエラーを返しました');
      return data;
    } finally { t.done(); }
  }

  /**
   * POST は Content-Type: text/plain で送るのが重要。
   * application/json にすると CORS プリフライトが飛び、GAS では必ず失敗します。
   */
  async function apiPost(action, body = {}, timeoutMs = 30000) {
    if (!settings.apiUrl) throw new Error('GAS のウェブアプリ URL が未設定です');
    const t = withTimeout(timeoutMs);
    try {
      const res = await fetch(settings.apiUrl, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, token: settings.token }, body)),
        signal: t.signal
      });
      if (!res.ok) throw new Error(`通信エラー (HTTP ${res.status})`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'サーバーがエラーを返しました');
      return data;
    } finally { t.done(); }
  }

  const ping = () => apiGet('ping', {}, 15000);

  /* --------------------------- 担当者 --------------------------- */
  const getMembers = () => {
    const cached = load(KEYS.members, null);
    if (Array.isArray(cached) && cached.length) return cached;
    return FALLBACK_MEMBERS.map((name, i) => ({ name, color: PALETTE[i % PALETTE.length] }));
  };
  const setMembers = (list) => {
    if (Array.isArray(list) && list.length) save(KEYS.members, list);
  };
  /** 担当者名 → ピン色。マスタに無い名前は名前のハッシュから自動採番。 */
  const colorFor = (name) => {
    const hit = getMembers().find((m) => m.name === name);
    if (hit && hit.color) return hit.color;
    let h = 0;
    for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };

  /* --------------------------- ログ本体 --------------------------- */
  const getLogs  = () => load(KEYS.logs, []);
  const setLogs  = (logs) => save(KEYS.logs, logs);
  const getQueue = () => load(KEYS.queue, []);
  const setQueue = (q) => save(KEYS.queue, q);
  const lastSync = () => load(KEYS.sync, '');

  const upsert = (logs, rec) => {
    const i = logs.findIndex((l) => l.id === rec.id);
    if (i >= 0) logs[i] = Object.assign({}, logs[i], rec); else logs.unshift(rec);
    logs.sort((a, b) => String(b.visited_at).localeCompare(String(a.visited_at)));
    return logs;
  };

  const uuid = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));

  /** サーバー（またはローカル）から一覧を取得して端末キャッシュを更新 */
  async function fetchAll() {
    if (mode() === 'local') {
      return { logs: getLogs(), members: getMembers(), source: 'local' };
    }
    const data = await apiGet('list', { limit: 2000 });
    const pending = getLogs().filter((l) => l._pending);          // 未送信ぶんは残す
    const merged = data.logs.slice();
    pending.forEach((p) => { if (!merged.some((l) => l.id === p.id)) merged.push(p); });
    merged.sort((a, b) => String(b.visited_at).localeCompare(String(a.visited_at)));
    setLogs(merged);
    setMembers(data.members);
    save(KEYS.sync, new Date().toISOString());
    return { logs: merged, members: data.members, source: 'server' };
  }

  /**
   * 1件登録。
   * 戻り値 {record, pending} … pending=true なら未送信キューに入った状態。
   */
  async function create(input) {
    const rec = {
      id: input.id || uuid(),
      visited_at: input.visited_at,
      member: input.member || '',
      company: input.company || '',
      contact: input.contact || '',
      category: input.category || '',
      memo: input.memo || '',
      lat: (input.lat ?? null),
      lng: (input.lng ?? null),
      accuracy: (input.accuracy ?? null),
      address: input.address || '',
      device: navigator.userAgent.slice(0, 120),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (mode() === 'local') {
      setLogs(upsert(getLogs(), rec));
      return { record: rec, pending: false };
    }

    try {
      const data = await apiPost('create', { record: rec });
      setLogs(upsert(getLogs(), data.record));
      return { record: data.record, pending: false };
    } catch (err) {
      // オフライン・通信失敗 → キューに退避して後で自動再送
      const queued = Object.assign({}, rec, { _pending: true, _error: String(err.message || err) });
      setQueue(getQueue().concat([rec]));
      setLogs(upsert(getLogs(), queued));
      return { record: queued, pending: true, error: err };
    }
  }

  /** 未送信キューをまとめて再送。戻り値 {sent, failed, remaining} */
  async function flushQueue() {
    const queue = getQueue();
    if (!queue.length || mode() === 'local') return { sent: 0, failed: 0, remaining: queue.length };

    let sent = 0, failed = 0;
    const remain = [];
    for (const rec of queue) {
      try {
        const data = await apiPost('create', { record: rec });
        const logs = getLogs();
        const i = logs.findIndex((l) => l.id === rec.id);
        if (i >= 0) { delete logs[i]._pending; delete logs[i]._error; logs[i] = data.record; }
        setLogs(logs);
        sent++;
      } catch (e) {
        remain.push(rec);
        failed++;
      }
    }
    setQueue(remain);
    return { sent, failed, remaining: remain.length };
  }

  /** 削除（GAS 側は論理削除） */
  async function remove(id) {
    setQueue(getQueue().filter((r) => r.id !== id));
    if (mode() === 'gas') await apiPost('delete', { id });
    setLogs(getLogs().filter((l) => l.id !== id));
  }

  /* --------------------- 逆ジオコーディング --------------------- */
  /**
   * 緯度経度 → 住所。
   *  GAS 連携時 : GAS 経由（サーバー側キャッシュ・レート制御あり／推奨）
   *  ローカル時 : ブラウザから直接 Nominatim を呼ぶ
   * 失敗しても例外にせず空文字を返します（記録は止めない）。
   */
  async function reverseGeocode(lat, lng) {
    if (!isFinite(lat) || !isFinite(lng)) return '';
    try {
      if (mode() === 'gas') {
        const data = await apiGet('geocode', { lat, lng }, 20000);
        return data.address || '';
      }
      const url = 'https://nominatim.openstreetmap.org/reverse'
        + '?format=jsonv2&zoom=18&addressdetails=1&accept-language=ja'
        + `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
      const t = withTimeout(12000);
      try {
        const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: t.signal });
        if (!res.ok) return '';
        return formatJpAddress(await res.json());
      } finally { t.done(); }
    } catch (e) {
      return '';
    }
  }

  /**
   * Nominatim のレスポンスを日本式の住所表記へ整形（GAS 側と同じロジック）
   * 例) 〒100-0005 東京都千代田区丸の内一丁目
   * ※ 東京都のように state/province が空で display_name にしか都道府県が
   *   入らないケースがあるため、その場合は display_name から補完します。
   */
  function formatJpAddress(data) {
    if (!data) return '';
    const a = data.address || {};
    const segments = String(data.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);

    let pref = a.state || a.province || '';
    if (!pref) {
      for (let i = segments.length - 1; i >= 0; i--) {
        if (/(都|道|府|県)$/.test(segments[i])) { pref = segments[i]; break; }
      }
    }

    const ordered = [
      pref,
      a.city || a.town || a.village || a.county || '',
      a.city_district || '',
      a.suburb || '',
      a.neighbourhood || '',
      a.quarter || '',
      a.block || '',
      a.house_number || ''
    ];

    let out = '';
    ordered.forEach((p) => {
      const v = String(p || '').trim();
      if (v && out.indexOf(v) === -1) out += v;   // 重複表記を除去
    });
    if (out) return (a.postcode ? `〒${a.postcode} ` : '') + out;

    // address 詳細が無い場合は display_name を日本式（逆順）に組み替え
    return segments
      .filter((s) => s && s !== '日本' && s !== 'Japan' && !/^\d{3}-?\d{4}$/.test(s))
      .reverse().join('');
  }

  /** ローカルモードで貯めた記録をまとめて送信キューへ（ローカル→GAS 切替時に使用） */
  function enqueueAll(records) {
    const q = getQueue();
    const ids = new Set(q.map((r) => r.id));
    (records || []).forEach((r) => { if (r && r.id && !ids.has(r.id)) q.push(r); });
    setQueue(q);
    return q.length;
  }

  /* ----------------------- 訪問先名の候補 ----------------------- */

  /** 2点間の距離（メートル） */
  function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const rad = (d) => d * Math.PI / 180;
    const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /**
   * 現在地の近くにある「過去に訪問した先」を距離順に返します。
   * 通信不要・即座に返るため、再訪問の多い営業ではこちらが主役になります。
   */
  function nearbyPastVisits(lat, lng, radiusM = 250, limit = 5) {
    if (!isFinite(lat) || !isFinite(lng)) return [];
    const seen = new Set();
    const out = [];
    getLogs().forEach((l) => {
      const name = String(l.company || '').trim();
      if (!name || l.lat == null || l.lng == null || seen.has(name)) return;
      const d = distanceM(lat, lng, l.lat, l.lng);
      if (d > radiusM) return;
      seen.add(name);
      out.push({ name, distance: Math.round(d), source: 'history' });
    });
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, limit);
  }

  /**
   * OpenStreetMap（Overpass API・無料/キー不要）から周辺の施設名を取得します。
   * 初訪問先の補助用。日本の B2B 事業所は収録が少なく、混雑時は応答しないため、
   * 失敗しても空配列を返すだけにして記録の妨げにはしません。
   */
  async function nearbyPlaces(lat, lng, radiusM = 120, timeoutMs = 8000) {
    if (!isFinite(lat) || !isFinite(lng) || !navigator.onLine) return [];
    const query =
      '[out:json][timeout:10];(' +
      `node(around:${radiusM},${lat},${lng})["name"];` +
      `way(around:${radiusM},${lat},${lng})["name"];` +
      ');out center tags 40;';
    const t = withTimeout(timeoutMs);
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: query, signal: t.signal
      });
      if (!res.ok) return [];
      const data = await res.json();
      const BIZ = ['office', 'industrial', 'craft', 'shop', 'amenity', 'healthcare', 'tourism', 'leisure'];
      const seen = new Set();
      const out = [];
      (data.elements || []).forEach((e) => {
        const tag = e.tags || {};
        const name = String(tag.name || '').trim();
        if (!name || seen.has(name)) return;
        const isBiz = BIZ.some((k) => tag[k]) || (tag.building && tag.building !== 'yes');
        if (!isBiz) return;
        const p = e.center || e;
        seen.add(name);
        out.push({
          name,
          distance: (p && p.lat != null) ? Math.round(distanceM(lat, lng, p.lat, p.lon)) : null,
          source: 'osm'
        });
      });
      out.sort((a, b) => (a.distance == null ? 9999 : a.distance) - (b.distance == null ? 9999 : b.distance));
      return out.slice(0, 8);
    } catch (e) {
      return [];
    } finally {
      t.done();
    }
  }

  /**
   * 指定した訪問先で過去に会った「先方担当者」を、直近に会った順で返します。
   * （getLogs() は訪問日時の降順で保持しているため、先頭が最新）
   */
  function contactsFor(company) {
    const key = String(company || '').trim();
    if (!key) return [];
    const seen = new Set();
    const out = [];
    getLogs().forEach((l) => {
      if (String(l.company || '').trim() !== key) return;
      const name = String(l.contact || '').trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      out.push({ name, visited_at: l.visited_at });
    });
    return out;
  }

  /* ------------------------------ CSV ------------------------------ */
  function toCsv(logs) {
    const cols = ['visited_at', 'member', 'company', 'contact', 'category', 'memo', 'address', 'lat', 'lng', 'accuracy'];
    const head = ['訪問日時', '担当者', '訪問先名', '先方担当者', '訪問区分', 'メモ', '住所', '緯度', '経度', '精度(m)'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.map(esc).join(',')];
    logs.forEach((l) => lines.push(cols.map((c) => esc(l[c])).join(',')));
    return '﻿' + lines.join('\r\n');   // BOM 付き = Excel で文字化けしない
  }

  /** 端末内データを全消去 */
  function clearLocal() {
    Object.values(KEYS).forEach((k) => { if (k !== KEYS.settings) localStorage.removeItem(k); });
  }

  return {
    KEYS, PALETTE,
    getSettings, setSettings, mode,
    apiGet, apiPost, ping,
    getMembers, setMembers, colorFor,
    getLogs, setLogs, getQueue, lastSync, enqueueAll,
    fetchAll, create, flushQueue, remove,
    reverseGeocode, toCsv, clearLocal, uuid,
    nearbyPastVisits, nearbyPlaces, distanceM, contactsFor
  };
})();
