# Steam Point Shop Downloader

Steam Puan Dükkanı öğelerini (arka planlar, emoticonlar, animasyonlu arka planlar, avatar çerçeveleri) tarayıp tek tıkla ZIP olarak indirmenizi sağlayan web uygulaması.

## Özellikler

- Oyun adı veya App ID ile arama
- Puan Dükkanı öğelerini otomatik tarama (Puppeteer + Steam Market API)
- Arka plan, emoticon, animasyonlu arka plan ve avatar çerçevelerini listeleme
- Seçili öğeleri toplu ZIP olarak indirme
- Tek tek dosya indirme
- 1 saatlik önbellekleme sistemi
- Docker desteği

## Kurulum

### Yerel

```bash
npm install
node server.js
```

Uygulama `http://localhost:3000` adresinde çalışır.

### Docker

```bash
docker build -t steam-downloader .
docker run -p 3000:3000 steam-downloader
```

## API

| Method | Endpoint | Açıklama |
|--------|----------|----------|
| GET | `/api/game/:appid` | Oyun adı ve görseli |
| GET | `/api/gamedetail/:appid` | Fiyat, puan, çıkış tarihi, geliştirici |
| GET | `/api/items/:appid` | Puan dükkanı öğeleri |
| GET | `/api/search?q=` | Oyun adıyla arama |
| POST | `/api/zip` | Seçili öğeleri ZIP indir |
| GET | `/api/download?url=&filename=` | Tek dosya proxy indirme |

## Kullanılan Teknolojiler

- [Express](https://expressjs.com/) — Web sunucusu
- [Puppeteer](https://pptr.dev/) — Steam Puan Dükkanı tarama
- [Axios](https://axios-http.com/) — Steam API istekleri
- [Archiver](https://github.com/archiverjs/node-archiver) — ZIP oluşturma
- [Cheerio](https://cheerio.js.org/) — HTML ayrıştırma

## Gereksinimler

- Node.js 18+
- (Docker kullanıyorsanız) Docker

## Lisans

MIT
