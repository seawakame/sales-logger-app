/* =====================================================================
   app.js  —  UI 層（記録 / 一覧 / マップ / 設定）
   ===================================================================== */
'use strict';

const APP_VERSION = '1.0.0';

/* ----------------------------- ユーティリティ ----------------------------- */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DDTHH:mm'（datetime-local 用） */
const toInputValue = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Date → タイムゾーン付き ISO（例 2026-08-18T14:30:00+09:00） */
function toIsoWithOffset(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
         `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/** ISO → 表示用（今日/昨日は相対表記） */
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const now = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const yst = new Date(now.getTime() - 86400000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, now)) return `今日 ${hm}`;
  if (sameDay(d, yst)) return `昨日 ${hm}`;
  return `${d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '/'}${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

/* -------------------------------- 状態 -------------------------------- */
const state = {
  logs: [],
  members: [],
  pos: null,               // { lat, lng, accuracy, address }
  filter: { member: '', q: '', from: '', to: '' },
  hiddenMembers: new Set(),
  maps: { current: null, main: null },
  markers: { current: null, layer: null },
  view: 'record',
  deferredInstall: null,
  editingId: null
};

/* ------------------------------ ピン（SVG） ------------------------------ */
function pinIcon(color) {
  const svg =
    `<svg class="pin" width="26" height="36" viewBox="0 0 26 36" xmlns="http://www.w3.org/2000/svg">
       <path d="M13 0C5.82 0 0 5.82 0 13c0 9.25 11.62 21.63 12.12 22.15a1.22 1.22 0 0 0 1.76 0C14.38 34.63 26 22.25 26 13 26 5.82 20.18 0 13 0z" fill="${color}"/>
       <circle cx="13" cy="13" r="5.1" fill="#fff" opacity=".95"/>
     </svg>`;
  return L.divIcon({ html: svg, className: 'pin-wrap', iconSize: [26, 36], iconAnchor: [13, 36], popupAnchor: [0, -32] });
}

/** OSM タイルレイヤー（APIキー不要・無料） */
function osmLayer() {
  return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    crossOrigin: true,   // ServiceWorker がタイルをキャッシュできるよう CORS で取得する
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });
}

/* ============================== 画面切り替え ============================== */
function switchView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  window.scrollTo(0, 0);

  if (name === 'map') {
    initMainMap();
    setTimeout(() => { state.maps.main.invalidateSize(); renderMap(); }, 60);
  }
  if (name === 'record' && state.maps.current) {
    setTimeout(() => state.maps.current.invalidateSize(), 60);
  }
  if (name === 'settings') renderSettings();
}

/* ============================== ① 現在地取得 ============================== */
function getCurrentPosition() {
  const btn = $('#btn-gps');
  if (!navigator.geolocation) { toast('この端末は位置情報に対応していません', 'err'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 取得中…';

  navigator.geolocation.getCurrentPosition(
    async (p) => {
      btn.disabled = false;
      btn.innerHTML = '📍 現在地を再取得';
      state.pos = {
        lat: +p.coords.latitude.toFixed(6),
        lng: +p.coords.longitude.toFixed(6),
        accuracy: p.coords.accuracy ? Math.round(p.coords.accuracy) : null,
        address: ''
      };
      renderGeoBox('住所を取得中…');
      showCurrentMap();
      toast('現在地を取得しました', 'ok');
      state.pos.address = await Store.reverseGeocode(state.pos.lat, state.pos.lng);
      renderGeoBox();
    },
    (err) => {
      btn.disabled = false;
      btn.innerHTML = '📍 現在地を取得';
      const msgs = {
        1: '位置情報の利用が許可されていません。ブラウザ/端末の設定で許可してください。',
        2: '位置を特定できませんでした。屋外や窓際で再度お試しください。',
        3: 'タイムアウトしました。もう一度お試しください。'
      };
      toast(msgs[err.code] || `取得に失敗しました（${err.message}）`, 'err');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

function renderGeoBox(addressOverride) {
  const box = $('#geo-box');
  if (!state.pos) {
    box.className = 'geo-box empty';
    box.textContent = '位置情報が未取得です。上のボタンを押してください。';
    return;
  }
  const { lat, lng, accuracy, address } = state.pos;
  const addr = addressOverride !== undefined ? addressOverride : (address || '（住所は取得できませんでした）');
  box.className = 'geo-box';
  box.innerHTML =
    `<div class="addr">${esc(addr)}</div>` +
    `<div class="coords">${lat}, ${lng}</div>` +
    (accuracy ? `<div class="acc">誤差およそ ±${accuracy}m</div>` : '');
}

/** 記録画面のミニ地図（初回のみ生成） */
function showCurrentMap() {
  const el = $('#map-current');
  el.classList.add('shown');
  $('#geo-hint').style.display = 'block';

  if (!state.maps.current) {
    state.maps.current = L.map(el, { zoomControl: true, attributionControl: true })
      .setView([state.pos.lat, state.pos.lng], 17);
    osmLayer().addTo(state.maps.current);

    state.markers.current = L.marker([state.pos.lat, state.pos.lng], {
      icon: pinIcon(Store.colorFor($('#f-member').value)), draggable: true
    }).addTo(state.maps.current);

    const onMove = async (lat, lng) => {
      state.pos.lat = +lat.toFixed(6);
      state.pos.lng = +lng.toFixed(6);
      state.pos.accuracy = null;      // 手動調整したので GPS 精度は無効化
      renderGeoBox('住所を取得中…');
      state.pos.address = await Store.reverseGeocode(state.pos.lat, state.pos.lng);
      renderGeoBox();
    };
    state.markers.current.on('dragend', (e) => {
      const ll = e.target.getLatLng();
      onMove(ll.lat, ll.lng);
    });
    state.maps.current.on('click', (e) => {
      state.markers.current.setLatLng(e.latlng);
      onMove(e.latlng.lat, e.latlng.lng);
    });
  } else {
    state.maps.current.setView([state.pos.lat, state.pos.lng], 17);
    state.markers.current.setLatLng([state.pos.lat, state.pos.lng]);
  }
  setTimeout(() => state.maps.current.invalidateSize(), 60);
}

/* ============================== ② 記録の保存 ============================== */
async function onSubmit(e) {
  e.preventDefault();
  const company = $('#f-company').value.trim();
  const member  = $('#f-member').value;
  const visited = $('#f-visited').value;

  if (!company) { toast('訪問先名を入力してください', 'err'); $('#f-company').focus(); return; }
  if (!member)  { toast('担当者を選択してください', 'err'); return; }
  if (!visited) { toast('訪問日時を入力してください', 'err'); return; }
  if (!state.pos && !confirm('位置情報が未取得です。地図に表示されない記録になりますが、保存しますか？')) return;

  const btn = $('#btn-save');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 保存中…';

  try {
    const { record, pending } = await Store.create({
      visited_at: toIsoWithOffset(new Date(visited)),
      member, company,
      contact:  $('#f-contact').value.trim(),
      category: $('#f-category').value,
      memo:     $('#f-memo').value.trim(),
      lat: state.pos ? state.pos.lat : null,
      lng: state.pos ? state.pos.lng : null,
      accuracy: state.pos ? state.pos.accuracy : null,
      address:  state.pos ? state.pos.address : ''
    });

    state.logs = Store.getLogs();
    renderList(); renderMap(); renderStatus();
    toast(pending ? 'オフラインのため端末に保存しました（後で自動送信）' : '記録しました', pending ? '' : 'ok');
    resetForm();
  } catch (err) {
    toast(`保存に失敗しました: ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'この内容で記録する';
  }
}

function resetForm() {
  $('#f-company').value = '';
  $('#f-contact').value = '';
  $('#f-memo').value = '';
  $('#f-visited').value = toInputValue(new Date());
  state.pos = null;
  renderGeoBox();
  $('#map-current').classList.remove('shown');
  $('#geo-hint').style.display = 'none';
  $('#btn-gps').innerHTML = '📍 現在地を取得';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ================================ 一覧 ================================ */
function applyFilter(logs) {
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  return logs.filter((l) => {
    if (f.member && l.member !== f.member) return false;
    const day = String(l.visited_at || '').slice(0, 10);
    if (f.from && day && day < f.from) return false;
    if (f.to && day && day > f.to) return false;
    if (q) {
      const hay = `${l.company} ${l.member} ${l.contact} ${l.category} ${l.memo} ${l.address}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderList() {
  const list = applyFilter(state.logs);
  $('#list-count').textContent = `${list.length} 件${state.logs.length !== list.length ? ` / 全 ${state.logs.length} 件` : ''}`;

  const box = $('#log-list');
  if (!list.length) {
    box.innerHTML = `<div class="empty-state"><span class="big">📋</span>
      ${state.logs.length ? '条件に一致する記録がありません' : 'まだ記録がありません。<br>「記録」タブから登録してください。'}</div>`;
    return;
  }

  box.innerHTML = list.slice(0, 300).map((l) => {
    const color = Store.colorFor(l.member);
    return `<div class="log-item ${l._pending ? 'pending' : ''}" data-id="${esc(l.id)}" style="border-left-color:${color}">
      <div class="top">
        <span class="company">${esc(l.company || '(訪問先名なし)')}</span>
        <span class="time">${esc(fmtDateTime(l.visited_at))}</span>
      </div>
      <div class="meta">
        <span class="dot" style="background:${color}"></span>${esc(l.member)}
        ${l.category ? `<span class="badge">${esc(l.category)}</span>` : ''}
        ${l.address ? `<span>📍 ${esc(l.address)}</span>` : ''}
      </div>
      ${l.memo ? `<div class="memo">${esc(l.memo)}</div>` : ''}
    </div>`;
  }).join('') + (list.length > 300 ? `<p class="note" style="text-align:center">先頭 300 件を表示しています（全 ${list.length} 件）</p>` : '');
}

/* ================================ マップ ================================ */
function initMainMap() {
  if (state.maps.main) return;
  state.maps.main = L.map('map-main', { zoomControl: true }).setView([35.681236, 139.767125], 12);
  osmLayer().addTo(state.maps.main);
  state.markers.layer = L.layerGroup().addTo(state.maps.main);
}

function renderMap(fit = true) {
  if (!state.maps.main) return;
  state.markers.layer.clearLayers();

  const list = applyFilter(state.logs).filter((l) =>
    isFinite(l.lat) && isFinite(l.lng) && l.lat !== null && l.lng !== null && !state.hiddenMembers.has(l.member));

  const bounds = [];
  list.forEach((l) => {
    const color = Store.colorFor(l.member);
    const m = L.marker([l.lat, l.lng], { icon: pinIcon(color) });
    m.bindPopup(
      `<div class="pc">${esc(l.company || '(訪問先名なし)')}</div>
       <div class="pm"><span class="dot" style="background:${color};margin-right:5px"></span>${esc(l.member)}
         ${l.category ? ` ・ ${esc(l.category)}` : ''}</div>
       <div class="pm">${esc(fmtDateTime(l.visited_at))}</div>
       ${l.contact ? `<div>👤 ${esc(l.contact)}</div>` : ''}
       ${l.memo ? `<div style="margin-top:5px">${esc(l.memo)}</div>` : ''}
       ${l.address ? `<div class="pm" style="margin-top:5px">📍 ${esc(l.address)}</div>` : ''}
       <div style="margin-top:7px">
         <a href="https://www.google.com/maps?q=${l.lat},${l.lng}" target="_blank" rel="noopener">地図アプリで開く</a>
       </div>`,
      { maxWidth: 260 }
    );
    m.addTo(state.markers.layer);
    bounds.push([l.lat, l.lng]);
  });

  renderLegend();
  if (fit && bounds.length) {
    state.maps.main.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
  }
}

function renderLegend() {
  const names = [...new Set(state.logs.map((l) => l.member).filter(Boolean))];
  $('#legend').innerHTML = names.map((n) => {
    const off = state.hiddenMembers.has(n) ? ' off' : '';
    return `<span class="legend-chip${off}" data-member="${esc(n)}">
      <span class="dot" style="background:${Store.colorFor(n)}"></span>${esc(n)}</span>`;
  }).join('');
}

/* ============================== 詳細モーダル ============================== */
function openDetail(id) {
  const l = state.logs.find((x) => x.id === id);
  if (!l) return;
  state.editingId = id;

  const kv = (k, v) => v ? `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>` : '';
  $('#m-title').innerHTML =
    `<span class="dot" style="background:${Store.colorFor(l.member)};margin-right:6px"></span>${esc(l.company || '(訪問先名なし)')}`;
  $('#m-body').innerHTML =
    kv('訪問日時', new Date(l.visited_at).toLocaleString('ja-JP')) +
    kv('担当者', l.member) +
    kv('訪問区分', l.category) +
    kv('先方担当', l.contact) +
    kv('住所', l.address) +
    kv('座標', (l.lat != null && l.lng != null) ? `${l.lat}, ${l.lng}${l.accuracy ? `（±${l.accuracy}m）` : ''}` : '') +
    kv('メモ', l.memo) +
    (l._pending ? '<p class="note" style="color:#d97706;margin-top:8px">未送信（オンライン復帰時に自動送信されます）</p>' : '');

  $('#m-map').style.display = (l.lat != null && l.lng != null) ? '' : 'none';
  $('#modal').classList.add('open');
}

const closeModal = () => { $('#modal').classList.remove('open'); state.editingId = null; };

async function deleteCurrent() {
  const id = state.editingId;
  if (!id || !confirm('この訪問ログを削除しますか？')) return;
  try {
    await Store.remove(id);
    state.logs = Store.getLogs();
    closeModal(); renderList(); renderMap(); renderStatus();
    toast('削除しました', 'ok');
  } catch (err) {
    toast(`削除に失敗しました: ${err.message}`, 'err');
  }
}

/* ================================ 設定 ================================ */
function renderSettings() {
  const s = Store.getSettings();
  $('#s-url').value = s.apiUrl;
  $('#s-token').value = s.token;
  $('#s-member').value = s.myMember;
  $('#member-list').innerHTML = Store.getMembers().map((m) => `<option value="${esc(m.name)}">`).join('');

  $('#st-mode').textContent  = Store.mode() === 'gas' ? 'Google スプレッドシート（GAS）' : 'この端末のみ（ローカル）';
  $('#st-count').textContent = `${state.logs.length} 件`;
  $('#st-queue').textContent = `${Store.getQueue().length} 件`;
  const sync = Store.lastSync();
  $('#st-sync').textContent = sync ? new Date(sync).toLocaleString('ja-JP') : '—';
  $('#conn-note').innerHTML = Store.mode() === 'gas'
    ? 'GAS 連携中です。記録はスプレッドシートに保存されます。'
    : 'URL が未設定のため<b>ローカルモード</b>で動作中です。この端末の中だけにデータが保存されます（そのまま試用できます）。';
  $('#app-version').textContent = `バージョン ${APP_VERSION}`;
}

async function testConnection() {
  const url = $('#s-url').value.trim();
  if (!url) { toast('URL を入力してください', 'err'); return; }
  Store.setSettings({ apiUrl: url, token: $('#s-token').value.trim() });
  const btn = $('#btn-test');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 確認中…';
  try {
    const r = await Store.ping();
    toast(`接続 OK：${r.sheet}`, 'ok');
    $('#conn-note').innerHTML =
      `接続成功：スプレッドシート「${esc(r.sheet)}」 / サーバー時刻 ${esc(r.time)}` +
      (r.tokenRequired ? '<br>このサーバーはトークン必須です。トークン欄も入力してください。' : '');
  } catch (err) {
    toast(`接続に失敗しました: ${err.message}`, 'err');
    $('#conn-note').innerHTML =
      `<b style="color:#dc2626">接続失敗：${esc(err.message)}</b><br>` +
      'URL が <code>/exec</code> で終わっているか、デプロイの「アクセスできるユーザー」が<b>全員</b>になっているか確認してください。';
  } finally {
    btn.disabled = false; btn.textContent = '接続テスト';
  }
}

async function saveSettings() {
  const before = Store.mode();
  Store.setSettings({
    apiUrl: $('#s-url').value.trim(),
    token: $('#s-token').value.trim(),
    myMember: $('#s-member').value.trim()
  });

  // ローカルモードで貯めた記録があれば、GAS 連携に切り替える際にアップロードするか確認
  if (before === 'local' && Store.mode() === 'gas') {
    const local = Store.getLogs();
    if (local.length && confirm(
      `この端末に ${local.length} 件の記録があります。\nスプレッドシートへアップロードしますか？\n\n` +
      '「キャンセル」を選ぶと、これらはスプレッドシート側のデータに置き換えられて表示されなくなります。')) {
      Store.enqueueAll(local);
    }
  }

  toast('設定を保存しました', 'ok');
  await syncNow();
  renderMembers();
  const my = Store.getSettings().myMember;
  if (my && [...$('#f-member').options].some((o) => o.value === my)) $('#f-member').value = my;
  renderSettings();
}

/* ============================= 同期 / ステータス ============================= */
async function syncNow(silent = false) {
  renderStatus();
  if (Store.mode() === 'gas' && navigator.onLine) {
    const q = await Store.flushQueue();
    if (q.sent && !silent) toast(`未送信 ${q.sent} 件を送信しました`, 'ok');
  }
  try {
    const { logs, members } = await Store.fetchAll();
    state.logs = logs;
    if (members && members.length) { state.members = members; renderMembers(); }
    renderList(); renderMap(); renderStatus(); renderCompanyList();
    if (!silent) toast('最新データを取得しました', 'ok');
  } catch (err) {
    state.logs = Store.getLogs();
    renderList(); renderMap();
    if (!silent) toast(`取得に失敗しました: ${err.message}`, 'err');
  }
  renderStatus();
}

function renderStatus() {
  const chip = $('#status-chip');
  const pending = Store.getQueue().length;
  if (!navigator.onLine) {
    chip.className = 'chip offline';
    chip.textContent = pending ? `オフライン・未送信${pending}` : 'オフライン';
  } else if (pending) {
    chip.className = 'chip pending';
    chip.textContent = `未送信 ${pending} 件`;
  } else {
    chip.className = 'chip online';
    chip.textContent = Store.mode() === 'gas' ? 'GAS 連携中' : 'ローカル保存';
  }
  if ($('#view-settings').classList.contains('active')) renderSettings();
}

function renderMembers() {
  const members = Store.getMembers();
  state.members = members;
  const cur = $('#f-member').value || Store.getSettings().myMember;
  $('#f-member').innerHTML = members.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
  if (members.some((m) => m.name === cur)) $('#f-member').value = cur;
  $('#fl-member').innerHTML = '<option value="">全担当者</option>' +
    members.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
  $('#fl-member').value = state.filter.member;
}

function renderCompanyList() {
  const names = [...new Set(state.logs.map((l) => l.company).filter(Boolean))].slice(0, 200);
  $('#company-list').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
}

function downloadCsv() {
  const rows = applyFilter(state.logs);
  if (!rows.length) { toast('出力対象のデータがありません', 'err'); return; }
  const blob = new Blob([Store.toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `訪問ログ_${toInputValue(new Date()).replace(/[-T:]/g, '')}.csv`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast(`${rows.length} 件を出力しました`, 'ok');
}

/* ============================== イベント登録 ============================== */
function bindEvents() {
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

  $('#btn-gps').addEventListener('click', getCurrentPosition);
  $('#log-form').addEventListener('submit', onSubmit);
  $('#f-member').addEventListener('change', () => {
    if (state.markers.current) state.markers.current.setIcon(pinIcon(Store.colorFor($('#f-member').value)));
  });

  // 一覧のフィルタ
  const onFilter = () => {
    state.filter = {
      member: $('#fl-member').value,
      q: $('#fl-q').value,
      from: $('#fl-from').value,
      to: $('#fl-to').value
    };
    renderList(); renderMap();
  };
  ['#fl-member', '#fl-from', '#fl-to'].forEach((s) => $(s).addEventListener('change', onFilter));
  $('#fl-q').addEventListener('input', onFilter);
  $('#btn-filter-clear').addEventListener('click', () => {
    $('#fl-member').value = ''; $('#fl-q').value = ''; $('#fl-from').value = ''; $('#fl-to').value = '';
    onFilter();
  });

  $('#btn-refresh').addEventListener('click', () => syncNow());
  $('#btn-csv').addEventListener('click', downloadCsv);
  $('#btn-export').addEventListener('click', downloadCsv);
  $('#btn-sync').addEventListener('click', () => syncNow());

  $('#log-list').addEventListener('click', (e) => {
    const item = e.target.closest('.log-item');
    if (item) openDetail(item.dataset.id);
  });

  // 凡例タップで担当者の表示 / 非表示
  $('#legend').addEventListener('click', (e) => {
    const chip = e.target.closest('.legend-chip');
    if (!chip) return;
    const name = chip.dataset.member;
    state.hiddenMembers.has(name) ? state.hiddenMembers.delete(name) : state.hiddenMembers.add(name);
    renderMap(false);
  });
  $('#btn-map-fit').addEventListener('click', () => renderMap(true));
  $('#btn-map-here').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => state.maps.main.setView([p.coords.latitude, p.coords.longitude], 16),
      () => toast('現在地を取得できませんでした', 'err'),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });

  // モーダル
  $('#m-close').addEventListener('click', closeModal);
  $('#m-delete').addEventListener('click', deleteCurrent);
  $('#m-map').addEventListener('click', () => {
    const l = state.logs.find((x) => x.id === state.editingId);
    closeModal();
    if (!l || l.lat == null) return;
    switchView('map');
    setTimeout(() => { state.maps.main.setView([l.lat, l.lng], 17); }, 200);
  });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  // 設定
  $('#btn-test').addEventListener('click', testConnection);
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-clear').addEventListener('click', () => {
    if (!confirm('端末内のログ・キャッシュ・未送信キューを削除します。よろしいですか？')) return;
    Store.clearLocal();
    state.logs = [];
    renderList(); renderMap(); renderStatus(); renderSettings();
    toast('端末内のデータを削除しました', 'ok');
  });
  $('#btn-update').addEventListener('click', async () => {
    if (!('serviceWorker' in navigator)) { location.reload(); return; }
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.update()));
    toast('更新を確認しました。再読み込みします', 'ok');
    setTimeout(() => location.reload(), 900);
  });

  // オンライン / オフライン
  window.addEventListener('online', async () => {
    renderStatus();
    if (Store.getQueue().length) {
      const q = await Store.flushQueue();
      if (q.sent) { state.logs = Store.getLogs(); renderList(); renderMap(); toast(`未送信 ${q.sent} 件を送信しました`, 'ok'); }
    }
    renderStatus();
  });
  window.addEventListener('offline', renderStatus);

  // PWA インストール
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    $('#btn-install').style.display = '';
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!state.deferredInstall) {
      alert('メニューから「ホーム画面に追加」を選択してください。\n\niPhone (Safari)：共有ボタン → ホーム画面に追加\nAndroid (Chrome)：︙ → アプリをインストール');
      return;
    }
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    $('#btn-install').style.display = 'none';
  });
}

/* ================================ 起動 ================================ */
async function init() {
  $('#f-visited').value = toInputValue(new Date());
  renderMembers();
  const my = Store.getSettings().myMember;
  if (my && [...$('#f-member').options].some((o) => o.value === my)) $('#f-member').value = my;

  state.logs = Store.getLogs();
  renderList(); renderCompanyList(); renderStatus();
  bindEvents();

  if (Store.mode() === 'gas') {
    syncNow(true);
  } else {
    renderSettings();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .catch((err) => console.warn('ServiceWorker の登録に失敗しました', err));
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
