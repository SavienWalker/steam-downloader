const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');
const archiver = require('archiver');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway/proxy arkasında çalışırken gerçek IP'yi al
app.set('trust proxy', 1);

// ===== GÜVENLİK =====

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Çok fazla istek. Lütfen bir dakika bekleyin.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Çok fazla arama. Lütfen bir dakika bekleyin.' },
});

const zipLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: { error: 'ZIP indirme limiti aşıldı. 5 dakika bekleyin.' },
});

app.use(generalLimiter);
app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== ANALİTİK SİSTEMİ =====

const LOG_FILE = path.join(__dirname, 'logs.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'steamdl-admin-2024';

// Log dosyasını oku veya boş başlat
let logs = [];
try {
  if (fs.existsSync(LOG_FILE)) {
    logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  }
} catch(e) { logs = []; }

// Log kaydet
function addLog(type, data, req) {
  const entry = {
    id: Date.now(),
    type,
    timestamp: new Date().toISOString(),
    ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
    lang: req.headers['accept-language']?.slice(0, 5) || 'unknown',
    ...data
  };
  logs.unshift(entry);
  if (logs.length > 5000) logs = logs.slice(0, 5000);
  fs.writeFile(LOG_FILE, JSON.stringify(logs), () => {});
}

// ===== GÜVENLİK YARDIMCI FONKSİYONLAR =====

function isValidAppId(appid) {
  return /^\d{1,10}$/.test(String(appid));
}

const ALLOWED_DOMAINS = [
  'cdn.cloudflare.steamstatic.com',
  'cdn.akamai.steamstatic.com',
  'shared.akamai.steamstatic.com',
  'shared.cloudflare.steamstatic.com',
  'shared.fastly.steamstatic.com',
  'community.cloudflare.steamstatic.com',
  'community.akamai.steamstatic.com',
  'community.fastly.steamstatic.com',
  'media.st.dl.eccdnx.com',
  'media.steampowered.com',
  'steamcdn-a.akamaihd.net',
  'steamcdn-a.opskins.media',
];

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_DOMAINS.some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch { return false; }
}

function sanitizeFilename(name) {
  if (!name) return 'asset';
  return String(name).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
}

// Cache sistemi — 1 saat
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) { cache.set(key, { data, time: Date.now() }); }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
  'Referer': 'https://store.steampowered.com/',
};

// ===== API ENDPOINT'LERİ =====

// Oyun bilgisi
app.get('/api/game/:appid', async (req, res) => {
  const { appid } = req.params;
  if (!isValidAppId(appid)) return res.status(400).json({ error: 'Geçersiz App ID' });
  const cacheKey = `game_${appid}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  try {
    const r = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`, { headers: HEADERS, timeout: 10000 });
    const d = r.data[appid];
    if (!d?.success) return res.status(404).json({ error: 'Oyun bulunamadı' });
    const result = { name: d.data.name, appid, img: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_231x87.jpg` };
    setCache(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Puan dükkanı öğeleri
app.get('/api/items/:appid', heavyLimiter, async (req, res) => {
  const { appid } = req.params;
  if (!isValidAppId(appid)) return res.status(400).json({ error: 'Geçersiz App ID' });
  const cacheKey = `items_${appid}`;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`Cache hit: ${appid}`);
    addLog('items', { appid, cached: true }, req);
    return res.json(cached);
  }
  console.log(`Cache miss: ${appid} — Puppeteer başlatılıyor...`);
  addLog('items', { appid, cached: false }, req);

  const items = [];
  const seen = new Set();

  const addItem = (name, type, typeId, imgUrl, videoUrl) => {
    const key = videoUrl || imgUrl;
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push({ name, type, typeId, imgUrl: imgUrl || null, videoUrl: videoUrl || null });
  };

  // 1) Steam Market - Arka Planlar
  try {
    const r = await axios.get(
      `https://steamcommunity.com/market/search/render/?query=&start=0&count=50&appid=753&category_753_Game[]=${appid}&category_753_item_class[]=tag_Profile+Background&norender=1`,
      { headers: HEADERS }
    );
    for (const i of (r.data?.results || [])) {
      const hash = i.asset_description?.icon_url;
      if (hash) addItem(i.name, 'Arka Plan', 1, `https://community.cloudflare.steamstatic.com/economy/image/${hash}/256fx256f`, null);
    }
  } catch (e) { console.log('market bg hata:', e.message); }

  // 2) Steam Market - Emoticonlar
  try {
    const r = await axios.get(
      `https://steamcommunity.com/market/search/render/?query=&start=0&count=50&appid=753&category_753_Game[]=${appid}&category_753_item_class[]=tag_Emoticon&norender=1`,
      { headers: HEADERS }
    );
    for (const i of (r.data?.results || [])) {
      const hash = i.asset_description?.icon_url;
      if (hash) addItem(i.name, 'Emoticon', 4, `https://community.cloudflare.steamstatic.com/economy/image/${hash}/128fx128f`, null);
    }
  } catch (e) { console.log('market emoticon hata:', e.message); }

  // 3) SteamCardExchange
  try {
    const r = await axios.get(`https://www.steamcardexchange.net/api/request.php?GetInventoryCard=${appid}`, { headers: HEADERS });
    const data = r.data?.data || {};
    const CDN = `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/items/${appid}/`;
    for (const b of (data.backgrounds || [])) {
      if (b.img) addItem(b.name || 'Arka Plan', 'Arka Plan', 1, CDN + b.img, null);
    }
    for (const e of (data.emoticons || [])) {
      if (e.img) addItem(e.name || 'Emoticon', 'Emoticon', 4, CDN + e.img, null);
    }
  } catch (e) { console.log('cardexchange hata:', e.message); }

  // 4) Puppeteer ile puan dükkanı sayfasını tara
  try {
    const launchOpts = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await page.setUserAgent(HEADERS['User-Agent']);
    await page.setCookie(
      { name: 'birthtime', value: '0', domain: 'store.steampowered.com' },
      { name: 'lastagecheckage', value: '1-0-1990', domain: 'store.steampowered.com' },
      { name: 'Steam_Language', value: 'turkish', domain: 'store.steampowered.com' }
    );

    const netUrls = new Set();
    page.on('response', res => {
      const url = res.url();
      if ((url.includes('steamstatic') || url.includes('akamai')) &&
          (url.endsWith('.webm') || url.endsWith('.mp4') || url.endsWith('.png') || url.endsWith('.jpg'))) {
        netUrls.add(url);
      }
    });

    await page.goto(`https://store.steampowered.com/points/shop/app/${appid}`, {
      waitUntil: 'networkidle2', timeout: 30000
    });
    await new Promise(r => setTimeout(r, 5000));

    const domUrls = await page.evaluate(() => {
      const found = [];
      document.querySelectorAll('video source[src], img[src]').forEach(el => {
        const src = el.src || el.getAttribute('src') || '';
        if (src.includes('steamstatic') || src.includes('akamai')) found.push(src);
      });
      return found;
    });

    await browser.close();

    const allPuppeteerUrls = [...new Set([...netUrls, ...domUrls])];
    let puppeteerIndex = 1;
    allPuppeteerUrls.forEach(url => {
      if (!url.includes('/items/') && !url.includes('community_assets')) return;
      const isVideo = url.endsWith('.webm') || url.endsWith('.mp4');
      const isFrame = url.includes('frame') || url.includes('border');
      const isEmote = url.includes('emot') || url.includes('emoji');
      const isAvatar = url.includes('avatar');
      let type = isVideo ? 'Animasyonlu Arka Plan' : isFrame ? 'Avatar Çerçeve' : isEmote ? 'Emoticon' : isAvatar ? 'Avatar' : 'Arka Plan';
      const rawName = url.split('/').pop().split('.')[0];
      const isHash = /^[a-f0-9]{32,}$/i.test(rawName);
      const name = isHash ? `${type} #${puppeteerIndex++}` : rawName.replace(/_/g, ' ');
      addItem(name, type, isVideo ? 1 : 0, isVideo ? null : url, isVideo ? url : null);
    });
  } catch (e) { console.log('puppeteer hata:', e.message); }

  const result = { items, total: items.length };
  setCache(cacheKey, result);
  res.json(result);
});

// Oyun detay
app.get('/api/gamedetail/:appid', async (req, res) => {
  const { appid } = req.params;
  if (!isValidAppId(appid)) return res.status(400).json({ error: 'Geçersiz App ID' });
  const cacheKey = `detail_${appid}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);
  try {
    const r = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=TR&l=turkish`, { headers: HEADERS, timeout: 10000 });
    const d = r.data[appid]?.data;
    if (!d) return res.json({ error: 'Bulunamadı' });
    const result = {
      price: d.is_free ? 'Ücretsiz' : d.price_overview?.final_formatted || null,
      score: d.metacritic?.score || null,
      releaseDate: d.release_date?.date || null,
      developer: d.developers?.[0] || null,
      genres: d.genres?.slice(0, 3).map(g => g.description) || [],
    };
    setCache(cacheKey, result);
    res.json(result);
  } catch(e) { res.json({ error: 'Sunucu hatası' }); }
});

// Oyun adıyla arama
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').slice(0, 100);
  if (!q || q.length < 2) return res.json([]);
  try {
    const r = await axios.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=turkish&cc=TR`, { headers: HEADERS, timeout: 10000 });
    const items = (r.data?.items || []).slice(0, 10).map(i => ({ appid: String(i.id), name: String(i.name).slice(0, 100) }));
    addLog('search', { query: q, results: items.length }, req);
    res.json(items);
  } catch(e) { res.json([]); }
});

// Toplu ZIP indirme
app.post('/api/zip', zipLimiter, async (req, res) => {
  const { items, appid, gameName } = req.body;

  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Öğe bulunamadı' });
  if (items.length > 100) return res.status(400).json({ error: 'Çok fazla öğe (max 100)' });
  if (!isValidAppId(appid)) return res.status(400).json({ error: 'Geçersiz App ID' });

  const validItems = items.filter(item => {
    const url = item.videoUrl || item.imgUrl;
    return url && isAllowedUrl(url);
  });
  if (!validItems.length) return res.status(400).json({ error: 'Geçerli URL bulunamadı' });

  addLog('zip', { appid, gameName, itemCount: validItems.length }, req);

  const safeName = sanitizeFilename(gameName || appid);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}_assets.zip"`);
  res.setHeader('Content-Type', 'application/zip');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  for (const item of validItems) {
    const url = item.videoUrl || item.imgUrl;
    try {
      const ext = sanitizeFilename(url.split('.').pop().split('?')[0]);
      const fname = `${sanitizeFilename(item.type || 'item')}/${sanitizeFilename(item.name)}.${ext}`;
      const r = await axios.get(url, { responseType: 'stream', headers: HEADERS, timeout: 15000, maxContentLength: 50 * 1024 * 1024 });
      archive.append(r.data, { name: fname });
    } catch(e) { console.log(`ZIP hata (${item.name}):`, e.message); }
  }

  archive.finalize();
});

// Proxy indirme
app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url || !isAllowedUrl(url)) return res.status(400).json({ error: 'Geçersiz veya izinsiz URL' });
  addLog('download', { filename: filename || url.split('/').slice(-1)[0] }, req);
  try {
    const r = await axios.get(url, { responseType: 'stream', headers: HEADERS, timeout: 15000, maxContentLength: 50 * 1024 * 1024 });
    const ext = sanitizeFilename(String(url).split('.').pop().split('?')[0]);
    const fname = sanitizeFilename(filename) || `steam_asset.${ext}`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type', r.headers['content-type'] || 'application/octet-stream');
    r.data.pipe(res);
  } catch (e) {
    res.status(500).json({ error: 'İndirme hatası' });
  }
});

// ===== ADMIN DASHBOARD =====
app.get('/admin', (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).send('Yetkisiz erişim');
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayLogs = logs.filter(l => l.timestamp.startsWith(today));

  const searches = logs.filter(l => l.type === 'search');
  const topQueries = searches.reduce((acc, l) => {
    acc[l.query] = (acc[l.query] || 0) + 1;
    return acc;
  }, {});
  const topQueriesSorted = Object.entries(topQueries).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const downloads = logs.filter(l => l.type === 'download' || l.type === 'zip');

  const topAppids = logs.filter(l => l.appid).reduce((acc, l) => {
    acc[l.appid] = (acc[l.appid] || 0) + 1;
    return acc;
  }, {});
  const topAppidsSorted = Object.entries(topAppids).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const last7 = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    last7[d] = logs.filter(l => l.timestamp.startsWith(d)).length;
  }

  const maxDay = Math.max(...Object.values(last7), 1);

  res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SteamDL Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0f1a; color: #c7d5e0; font-family: 'Segoe UI', sans-serif; padding: 24px; min-height: 100vh; }
    h1 { color: #66c0f4; font-size: 22px; margin-bottom: 24px; display: flex; align-items: center; gap: 10px; }
    h2 { color: #66c0f4; font-size: 12px; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 28px; }
    .card { background: #1b2838; border-radius: 8px; padding: 18px; border: 1px solid #2a3f5f; }
    .card .num { font-size: 28px; font-weight: bold; color: #66c0f4; }
    .card .label { font-size: 12px; color: #8f98a0; margin-top: 4px; }
    .section { background: #1b2838; border-radius: 8px; padding: 18px; margin-bottom: 20px; border: 1px solid #2a3f5f; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
    @media(max-width: 600px) { .two-col { grid-template-columns: 1fr; } }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 10px; color: #66c0f4; border-bottom: 1px solid #2a3f5f; font-size: 12px; }
    td { padding: 7px 10px; border-bottom: 1px solid #16202d; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #16202d; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: bold; }
    .badge-search  { background: #1a3a5c; color: #66c0f4; }
    .badge-items   { background: #1a3a1a; color: #4caf50; }
    .badge-download{ background: #3a1a1a; color: #ef5350; }
    .badge-zip     { background: #3a2a1a; color: #ff9800; }
    .bar-wrap { background: #16202d; border-radius: 4px; height: 8px; width: 100%; }
    .bar { height: 8px; background: #66c0f4; border-radius: 4px; }
    a { color: #66c0f4; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty { color: #4a5568; font-size: 13px; padding: 8px 0; }
  </style>
</head>
<body>
  <h1>🎮 SteamDL Analytics</h1>

  <div class="grid">
    <div class="card"><div class="num">${logs.length}</div><div class="label">Toplam İşlem</div></div>
    <div class="card"><div class="num">${todayLogs.length}</div><div class="label">Bugün</div></div>
    <div class="card"><div class="num">${searches.length}</div><div class="label">Toplam Arama</div></div>
    <div class="card"><div class="num">${downloads.length}</div><div class="label">İndirme</div></div>
    <div class="card"><div class="num">${new Set(logs.map(l => l.ip)).size}</div><div class="label">Tekil IP</div></div>
  </div>

  <div class="section">
    <h2>📅 Son 7 Gün</h2>
    <table>
      <tr><th>Tarih</th><th>İşlem</th><th style="width:60%">Graf</th></tr>
      ${Object.entries(last7).map(([d, n]) => `
        <tr>
          <td>${d}</td>
          <td>${n}</td>
          <td><div class="bar-wrap"><div class="bar" style="width:${Math.round((n / maxDay) * 100)}%"></div></div></td>
        </tr>`).join('')}
    </table>
  </div>

  <div class="two-col">
    <div class="section">
      <h2>🔍 En Çok Arananlar</h2>
      ${topQueriesSorted.length ? `
      <table>
        <tr><th>Arama</th><th>Sayı</th></tr>
        ${topQueriesSorted.map(([q, n]) => `<tr><td>${q}</td><td>${n}</td></tr>`).join('')}
      </table>` : '<div class="empty">Henüz veri yok</div>'}
    </div>
    <div class="section">
      <h2>🎮 En Çok Görüntülenen App ID</h2>
      ${topAppidsSorted.length ? `
      <table>
        <tr><th>App ID</th><th>Sayı</th></tr>
        ${topAppidsSorted.map(([id, n]) => `<tr><td><a href="https://store.steampowered.com/app/${id}" target="_blank">${id}</a></td><td>${n}</td></tr>`).join('')}
      </table>` : '<div class="empty">Henüz veri yok</div>'}
    </div>
  </div>

  <div class="section">
    <h2>📋 Son 50 İşlem</h2>
    <table>
      <tr><th>Zaman</th><th>Tür</th><th>Detay</th><th>IP</th><th>Dil</th></tr>
      ${logs.slice(0, 50).map(l => `
        <tr>
          <td style="white-space:nowrap">${new Date(l.timestamp).toLocaleString('tr-TR')}</td>
          <td><span class="badge badge-${l.type}">${l.type}</span></td>
          <td>${l.query || l.appid || l.filename || '-'}</td>
          <td style="font-size:11px;color:#8f98a0">${l.ip}</td>
          <td style="font-size:11px;color:#8f98a0">${l.lang}</td>
        </tr>`).join('')}
    </table>
  </div>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`✅ Steam Downloader çalışıyor: http://localhost:${PORT}`));