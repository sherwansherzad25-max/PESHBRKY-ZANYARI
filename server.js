const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const TIKTOK_USERNAME = 'poshaki.varin'; // بەبێ @
const PORT = process.env.PORT || 8080;
const EULER_KEY = process.env.EULER_KEY || 'euler_ZjBjZDdmNDFiN2EwZmFkYTc5M2ZjYmMzN2RmNWM1OWRmZjQ3NGQ3NDM3Y2EwZGNkNzY0MTlj';

// =====================================================================
//  HTTP: پەیجەکە و فایلە دەنگییەکان (فۆڵدەری audio/) پیشان دەدات
// =====================================================================
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
};
const BLOCKED = new Set(['server.js', 'package.json', 'package-lock.json']); // ئەمانە هەرگیز پیشان نادرێن
const ALLOWED_DIRS = new Set(['audio', 'images', 'img', 'assets', 'fonts']);

function resolveFile(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return null; }
  if (rel === '/') rel = '/index.html';
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts.some(p => p === '..' || p.startsWith('.') || /[\0\\:*?"<>|]/.test(p))) return null;
  if (parts.length === 1) { if (BLOCKED.has(parts[0].toLowerCase())) return null; }
  else if (!ALLOWED_DIRS.has(parts[0].toLowerCase())) return null;
  if (!MIME[path.extname(parts[parts.length - 1]).toLowerCase()]) return null;
  const file = path.join(ROOT, ...parts);
  return file.startsWith(ROOT + path.sep) ? file : null;
}

function notFound(res, what) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found: ' + what);
}

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res, req.url);
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext],
      'Accept-Ranges': 'bytes',
      'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.css') ? 'no-cache' : 'public, max-age=3600'
    };
    let start = 0, end = st.size - 1, status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') { start = Math.max(0, st.size - parseInt(m[2], 10)); }
        else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(parseInt(m[2], 10), st.size - 1); }
        if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
        status = 206; headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
      }
    }
    headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const rs = fs.createReadStream(file, { start, end });
    rs.on('error', () => res.destroy());
    rs.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const urlPath = (req.url || '/').split('?')[0];
  // /status: بۆ بینینی ئەوەی تیکتۆک چی ناردووە و چەند پەیج بەستراوە (کراوەیە لە براوزەر)
  if (urlPath === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      tiktokConnected, username: TIKTOK_USERNAME,
      connectedSecondsAgo: tiktokConnected ? Math.round((Date.now() - connectedAt) / 1000) : null,
      received: stats, gamePagesConnected: wss.clients.size
    }, null, 2));
  }
  const file = resolveFile(urlPath);
  if (!file) return notFound(res, req.url);
  sendFile(req, res, file);
});

// =====================================================================
//  WebSocket: پردی نێوان تیکتۆک و یاری
// =====================================================================
const wss = new WebSocket.Server({ server });
wss.on('connection', () => console.log('✅ یارییەکە بەستراوەتەوە بە پردەکەوە'));
function sendToGame(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// زانیاری بەکارهێنەر: لەگەڵ وەشانی ١ و ٢ هەردووکیان دەگونجێت
function who(d) {
  const u = d.user || {};
  const pp = u.profilePicture || {};
  const pic = d.profilePictureUrl || (pp.urls && pp.urls[0]) || (pp.url && pp.url[0]) || '';
  return {
    userId: d.uniqueId || u.uniqueId || d.userId || u.userId || '',
    nickname: d.nickname || u.nickname || d.uniqueId || u.uniqueId || '',
    avatar: pic
  };
}

// =====================================================================
//  TikTok (وەشانی ٢، بە import() چونکە ESM ـە) لەگەڵ هەوڵدانەوەی هێواش
// =====================================================================
let lib = null;
let tt = null;
let connecting = false;
let retryTimer = null;
let fails = 0;
let tiktokConnected = false;
let connectedAt = 0;
const stats = { chat: 0, gift: 0, like: 0, share: 0 }; // ئەوەی لە تیکتۆکەوە گەیشتووە

function scheduleRetry(was429) {
  if (retryTimer) return;
  fails++;
  let wait = Math.min(60000 * Math.pow(2, fails - 1), 600000);
  if (was429) wait = Math.max(wait, 300000);
  console.log('⏳ هەوڵی دووبارە دوای ' + Math.round(wait / 1000) + ' چرکە');
  retryTimer = setTimeout(() => { retryTimer = null; connectTikTok(); }, wait);
}

async function connectTikTok() {
  if (connecting) return;
  connecting = true;
  try {
    if (!lib) lib = await import('tiktok-live-connector');
    const { TikTokLiveConnection, WebcastEvent } = lib;
    const EV = (name, fallback) => (WebcastEvent && WebcastEvent[name]) || fallback;

    if (tt) { try { tt.removeAllListeners(); tt.disconnect(); } catch (e) {} }
    tt = new TikTokLiveConnection(TIKTOK_USERNAME, {
      signApiKey: EULER_KEY,
      processInitialData: false,      // نامە کۆنەکانی چەند چرکەی پێشوو پشتگوێ دەخات
      fetchRoomInfoOnConnect: true,
      enableExtendedGiftInfo: false
    });

    tt.on('disconnected', () => { tiktokConnected = false; console.warn('⚠️ پچڕا'); scheduleRetry(false); });
    tt.on('error', e => console.warn('⚠️ هەڵەی تیکتۆک:', (e && (e.message || e.info)) || e));
    tt.on(EV('STREAM_END', 'streamEnd'), () => console.warn('⚠️ لایڤ کۆتایی هات'));

    tt.on(EV('CHAT', 'chat'), d => {
      stats.chat++;
      const w = who(d);
      console.log('💬 ' + w.nickname + ': ' + String(d.comment || '').slice(0, 60));
      sendToGame('chat', { ...w, comment: d.comment });
    });

    tt.on(EV('GIFT', 'gift'), d => {
      // دیاری بەردەوام (streak): تەنها کاتێک دەژمێردرێت کە تەواو بوو.
      // لە وەشانی ٢ repeatEnd ژمارەیە (٠ یان ١) و لە وەشانی ١ true/false ـە
      const gt = d.giftType != null ? d.giftType : (d.giftDetails && d.giftDetails.giftType);
      const ended = d.repeatEnd === true || Number(d.repeatEnd) === 1;
      if (gt === 1 && !ended) return;
      const diamonds = d.diamondCount || (d.giftDetails && d.giftDetails.diamondCount) || 1;
      const coins = diamonds * (d.repeatCount || 1);
      const w = who(d);
      stats.gift++;
      console.log('🎁 ' + w.nickname + ': ' + coins + ' کۆین');
      sendToGame('gift', { ...w, coins });
    });

    tt.on(EV('LIKE', 'like'), d => { stats.like += (d.likeCount || 1); sendToGame('like', { ...who(d), count: d.likeCount || 1 }); });
    tt.on(EV('SHARE', 'share'), d => {
      const w = who(d);
      stats.share++;
      console.log('↗️ ' + w.nickname + ' لایڤی شەیر کرد');
      sendToGame('share', w);
    });

    const state = await tt.connect();
    fails = 0;
    tiktokConnected = true;
    connectedAt = Date.now();
    console.info('✅ بە لایڤەکە بەسترایەوە، roomId: ' + state.roomId);
  } catch (err) {
    const msg = String((err && (err.message || (err.exception && err.exception.message))) || err);
    const is429 = msg.includes('429');
    console.error(is429
      ? '❌ تیکتۆک IP ـەکەتی کاتییانە سنووردار کردووە (٤٢٩). چاوەڕێ بکە.'
      : '❌ نەتوانرا ببەسترێتەوە: ' + msg);
    if (!is429 && err && err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
    scheduleRetry(is429);
  } finally {
    connecting = false;
  }
}

// هەڵەی چاوەڕوان نەکراو سێرڤەرەکە ناکوژێنێتەوە
process.on('unhandledRejection', e => console.warn('⚠️ unhandledRejection:', (e && e.message) || e));
process.on('uncaughtException', e => console.warn('⚠️ uncaughtException:', (e && e.message) || e));

// =====================================================================
//  دەستپێکردن
// =====================================================================
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error('❌ پۆرتی ' + PORT + ' پێشتر بەکارهاتووە. تێرمینالێکی تری کراوە هەیە کە node server.js ی تێدا کار دەکات؟ بیکوژێنەوە (Ctrl+C) و دووبارە هەوڵ بدە.');
    process.exit(1);
  }
  console.error('❌ هەڵەی سێرڤەر:', e.message);
});

server.listen(PORT, () => {
  console.log('🎮 یاری لێرە بکەرەوە: http://localhost:' + PORT);
  // پشکنینی فایلە دەنگییەکان
  const want = ['welcome.mp3', 'countdown.mp3', 'final.mp3'];
  for (let i = 1; i <= 4; i++) want.push('question_' + i + '.mp3');
  ['a', 'b', 'c', 'd'].forEach(l => want.push('correct_' + l + '.mp3'));
  const missing = want.filter(f => !fs.existsSync(path.join(ROOT, 'audio', f)));
  if (missing.length) console.warn('⚠️ ئەم فایلە دەنگییانە لە فۆڵدەری audio نین: ' + missing.join(', '));
  else console.log('🔊 هەموو فایلە دەنگییەکان دۆزرانەوە');
});

// هەر ٣٠ چرکە: چەند ڕووداو لە تیکتۆکەوە گەیشتووە و چەند پەیجی یاری بەستراوە
setInterval(() => {
  if (!tiktokConnected) return;
  const pages = wss.clients.size;
  const total = stats.chat + stats.gift + stats.like + stats.share;
  console.log('📊 لە تیکتۆکەوە: کۆمێنت ' + stats.chat + ' · دیاری ' + stats.gift + ' · لایک ' + stats.like + ' · شەیر ' + stats.share + '   |   پەیجی یاری بەستراو: ' + pages);
  if (pages === 0) console.warn('⚠️ هیچ پەیجێکی یاری بەستراو نییە، ڕووداوەکان دەفەوتێن. پەیجەکە بکەرەوە.');
  else if (total === 0 && Date.now() - connectedAt > 60000) console.warn('⚠️ ٦٠ چرکە تێپەڕی و تیکتۆک هیچی نەناردووە. لە ئەکاونتێکی تر کۆمێنت و لایک بکە؛ ئەگەر هێشتا هیچ نەبوو، IP ـی سێرڤەر سنووردارە.');
}, 30000);

connectTikTok();
