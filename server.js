const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer');
const archiver = require('archiver');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway/proxy arkasında çalışırken gerçek IP'yi al
app.set('trust proxy', 1);

// ===== GÜVENLİK =====

// Helmet — güvenlik header'ları
app.use(helmet({
  contentSecurityPolicy: false, // frontend için disable
  crossOriginEmbedderPolicy: false
}));

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 dakika
  max: 60, // dakikada 60 istek
  message: { error: 'Çok fazla istek. Lütfen bir dakika bekleyin.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // puppeteer kullanan endpoint'ler için daha sıkı
  message: { error: 'Çok fazla arama. Lütfen bir dakika bekleyin.' },
});

const zipLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 dakika
  max: 5, // 5 dakikada 5 zip
  message: { error: 'ZIP indirme limiti aşıldı. 5 dakika bekleyin.' },
});

app.use(generalLimiter);
app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== GÜVENLİK YARDIMCI FONKSİYONLAR =====

// App ID sadece sayı olmalı, max 10 haneli
function isValidAppId(appid) {
  return /^\d{1,10}$/.test(String(appid));
}

// URL whitelist — sadece Steam/Akamai/Fastly CDN'lerinden indirmeye izin
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

// Filename sanitize — directory traversal önleme
function sanitizeFilename(name) {
  if (!name) return 'asset';
  return String(name).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
}

// Cache sistemi — 1 saat geçerli
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
  if (cached) { console.log(`Cache hit: ${appid}`); return res.json(cached); }
  console.log(`Cache miss: ${appid} — Puppeteer başlatılıyor...`);
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

    // Network isteklerini dinle
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

    // DOM'dan topla
    const domUrls = await page.evaluate(() => {
      const found = [];
      document.querySelectorAll('video source[src], img[src]').forEach(el => {
        const src = el.src || el.getAttribute('src') || '';
        if (src.includes('steamstatic') || src.includes('akamai')) found.push(src);
      });
      return found;
    });

    await browser.close();

    // Puppeteer'dan gelen URL'lerden isim ve tür bilgisini düzgün çıkar
    const allPuppeteerUrls = [...new Set([...netUrls, ...domUrls])];
    let puppeteerIndex = 1;
    allPuppeteerUrls.forEach(url => {
      if (!url.includes('/items/') && !url.includes('community_assets')) return;
      const isVideo = url.endsWith('.webm') || url.endsWith('.mp4');
      const isFrame = url.includes('frame') || url.includes('border');
      const isEmote = url.includes('emot') || url.includes('emoji');
      const isAvatar = url.includes('avatar');
      let type = isVideo ? 'Animasyonlu Arka Plan' : isFrame ? 'Avatar Çerçeve' : isEmote ? 'Emoticon' : isAvatar ? 'Avatar' : 'Arka Plan';
      // Hash ismi yerine anlamlı isim
      const rawName = url.split('/').pop().split('.')[0];
      const isHash = /^[a-f0-9]{32,}$/i.test(rawName);
      const name = isHash ? `${type} #${puppeteerIndex++}` : rawName.replace(/_/g,' ');
      addItem(name, type, isVideo ? 1 : 0, isVideo ? null : url, isVideo ? url : null);
    });
  } catch (e) { console.log('puppeteer hata:', e.message); }

  const result = { items, total: items.length };
  setCache(cacheKey, result);
  res.json(result);
});

// Oyun detay (fiyat, puan, tarih, geliştirici)
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
      genres: d.genres?.slice(0,3).map(g=>g.description) || [],
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
    res.json(items);
  } catch(e) { res.json([]); }
});

// Toplu ZIP indirme
app.post('/api/zip', zipLimiter, async (req, res) => {
  const { items, appid, gameName } = req.body;

  // Validation
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Öğe bulunamadı' });
  if (items.length > 100) return res.status(400).json({ error: 'Çok fazla öğe (max 100)' });
  if (!isValidAppId(appid)) return res.status(400).json({ error: 'Geçersiz App ID' });

  // URL'leri whitelist kontrolü
  const validItems = items.filter(item => {
    const url = item.videoUrl || item.imgUrl;
    return url && isAllowedUrl(url);
  });
  if (!validItems.length) return res.status(400).json({ error: 'Geçerli URL bulunamadı' });

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
      const r = await axios.get(url, { responseType: 'stream', headers: HEADERS, timeout: 15000, maxContentLength: 50 * 1024 * 1024 }); // max 50MB
      archive.append(r.data, { name: fname });
    } catch(e) { console.log(`ZIP hata (${item.name}):`, e.message); }
  }

  archive.finalize();
});

// Proxy indirme (whitelisted URL'ler için)
app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url || !isAllowedUrl(url)) return res.status(400).json({ error: 'Geçersiz veya izinsiz URL' });
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

app.listen(PORT, () => console.log(`✅ Steam Downloader çalışıyor: http://localhost:${PORT}`));