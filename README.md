# LokasiBareng — berbagi lokasi berbasis izin

Web app untuk membuat **link check-in lokasi**. Kamu buat link, kirim ke seseorang
(WA/Telegram/QR), dia buka, melihat siapa yang minta + alasannya, lalu **memilih sendiri**
menekan "Bagikan lokasi saya". Lokasi presisinya (GPS, dengan izin browser) masuk ke
dashboard + peta kamu, dan dia bisa berhenti kapan saja.

Ini **bukan** alat mata-mata:
- Tidak bisa melacak dari nomor/email/username — data itu tidak menyimpan koordinat.
  Field itu cuma penanda & tujuan kirim link.
- Tidak mengambil lokasi tanpa izin — browser selalu minta izin GPS ke pemiliknya.
- Tidak jalan saat perangkat offline — tidak ada yang terkirim.
- Orang yang dibagikan selalu tahu dan bisa menarik izin.

## Fitur

- **Dashboard responsif** (desktop & mobile) dengan peta live.
- **Buat link** dengan: penanda, alasan, catatan pribadi, warna, mode, masa berlaku.
- **Mode**: *Live terus* (lokasi diperbarui real-time) atau *Sekali kirim*.
- **Masa berlaku**: 1 jam / 6 jam / 24 jam / tanpa batas; bisa diperpanjang (+1 jam)
  atau link dimatikan kapan saja.
- **Bagikan**: QR code (scan), tombol WhatsApp & Telegram, salin link sekali tap.
- **Riwayat & rute**: setiap titik lokasi disimpan; tombol "Lihat rute" menggambar
  garis pergerakan di peta.
- **Kelola kontak**: daftar bisa dicari (nama/catatan/alasan), tiap kontak punya
  warna & catatan pribadi.
- **Tema terang/gelap** (ikut sistem, bisa di-toggle).

## Jalankan

```bash
node server.js
```

Buka http://localhost:3000. Tidak perlu `npm install` — hanya modul bawaan Node.js.
Ganti port: `PORT=8080 node server.js`.

> Catatan: QR code & peta memakai pustaka dari CDN (qrcodejs, Leaflet), jadi mesin yang
> menjalankan dashboard butuh internet. Data lokasi tetap di server kamu sendiri.

## Password dashboard

Dashboard dilindungi password; halaman penerima (`/t/xxx`) tetap terbuka.

- Password dibaca dari: env `LB_PASSWORD` → file `password.txt` → kalau belum ada,
  dibuat acak otomatis dan disimpan ke `password.txt` (dicetak di konsol saat start).
- Ganti password: edit isi `password.txt` lalu restart, atau jalankan
  `LB_PASSWORD="rahasiaku" node server.js`.
- Tombol keluar ada di pojok kanan atas dashboard.
- Sesi login hilang saat server di-restart (perlu login lagi) — ini normal.

## GPS & HTTPS (penting)

Browser hanya mengizinkan GPS akurat di `localhost` atau situs **HTTPS**. Supaya orang
lain bisa buka link dari HP mereka, taruh di belakang HTTPS, mis.:

```bash
cloudflared tunnel --url http://localhost:3000
```

Kamu akan dapat URL `https://…`; link `/t/xxxx` dari situ bisa minta GPS di HP penerima.
Di HTTP biasa (bukan localhost), HP menolak GPS presisi.

## Struktur

- `server.js` — server HTTP + API + penyimpanan ke `data.json`
- `public/dashboard.html` — dashboard kamu
- `public/track.html` — halaman persetujuan yang dilihat penerima
- `data.json` — dibuat otomatis saat ada data

## API

| Method | Path | Guna |
|---|---|---|
| POST | `/api/requests` | buat `{label,reason,note,color,mode,ttlMinutes}` → `{id,expiresAt}` |
| GET | `/api/requests` | daftar + lokasi terakhir + `serverTime` |
| GET | `/api/requests/:id` atau `/trail` | detail + seluruh titik (trail) |
| GET | `/api/requests/:id/info` | info utk halaman penerima (+status) |
| POST | `/api/requests/:id/location` | penerima kirim `{lat,lng,accuracy,live}` |
| POST | `/api/requests/:id/stop` | penerima tarik izin |
| PATCH | `/api/requests/:id` | edit `{note,color,active,label,ttlMinutes}` |
| DELETE | `/api/requests/:id` | hapus |

Status link: `waiting` (menunggu klik), `live`, `shared`, `done` (sekali-pakai selesai),
`expired`, `inactive` (dimatikan), `revoked` (izin ditarik).

---

## Produksi: Cloudflare Workers + D1 (serverless, 24 jam)

Aplikasi live di **https://tracker.xianzing.my.id** berjalan di Cloudflare Workers +
database D1 — tanpa server/laptop. Sumbernya: `src/worker.js` (+ `public/*.html` di-import
sebagai teks), config `wrangler.toml`, skema `schema.sql`.

### Deploy

```bash
npm i -g wrangler        # atau pakai: npx wrangler@4 <perintah>
wrangler login           # login akun Cloudflare
wrangler d1 create lokasibareng          # sekali saja; salin database_id ke wrangler.toml
wrangler d1 execute lokasibareng --remote --file=schema.sql
wrangler secret put LB_PASSWORD          # password dashboard
wrangler secret put SESSION_SECRET       # kunci acak utk cookie sesi (mis. `openssl rand -hex 32`)
wrangler deploy
```

Custom domain (`tracker.xianzing.my.id`) dipasang lewat dashboard:
Workers & Pages → worker → **Domains** → Add → Custom domain.

### Konfigurasi

- `wrangler.toml` → `[vars]`: `GOOGLE_CLIENT_ID`, `LB_ALLOWED_EMAILS` (daftar email yang
  boleh login Google, dipisah koma).
- Secret (via `wrangler secret put`, tidak masuk repo): `LB_PASSWORD`, `SESSION_SECRET`.

### Tidak ikut ke repo (lihat `.gitignore`)

`password.txt`, `data.json`, `lokasibareng.env` — dipakai hanya oleh versi Node lama
(`server.js`) dan berisi nilai rahasia/pribadi. Versi produksi (Worker) memakai D1 +
secret Cloudflare, jadi file-file itu tidak diperlukan.

> `server.js` disimpan sebagai asal-usul logika Worker (versi Node mandiri, opsional).
