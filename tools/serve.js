/* =====================================================================
   serve.js  —  依存パッケージ不要のローカル静的サーバー
   使い方:  node tools/serve.js  [ポート番号]
            → http://localhost:5173 を開く
   ===================================================================== */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT = path.join(__dirname, '..', 'public');
const PORT = Number(process.argv[2] || process.env.PORT || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(req.url.split('?')[0]);
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(ROOT, path.normalize(pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',                    // 開発中は常に最新を配信
      'Service-Worker-Allowed': '/'
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const ips = [];
  Object.values(os.networkInterfaces()).forEach((list) =>
    (list || []).forEach((i) => { if (i.family === 'IPv4' && !i.internal) ips.push(i.address); }));

  console.log('');
  console.log('  営業訪問ログ - ローカルサーバー起動');
  console.log('  ------------------------------------------------');
  console.log(`  PC から      : http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  同一LANの端末 : http://${ip}:${PORT}`));
  console.log('');
  console.log('  ※ GPS(位置情報) と PWA は localhost か https でのみ動作します。');
  console.log('     スマホ実機で試す場合は GitHub Pages 等の https 公開を推奨。');
  console.log('  ------------------------------------------------');
  console.log('  終了: Ctrl + C');
  console.log('');
});
