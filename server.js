#!/usr/bin/env node
// LokasiBareng — berbagi lokasi berbasis izin (consent-based).
// Setiap orang yang dibagikan TAHU & SETUJU. Bukan alat mata-mata.
// Jalankan: node server.js  → http://localhost:3000
// Tanpa npm install — hanya modul bawaan Node.

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const PASS_FILE = path.join(__dirname, "password.txt");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------- password dashboard ----------
// Urutan: env LB_PASSWORD → file password.txt → dibuat otomatis (acak) & disimpan.
let PASSWORD = (process.env.LB_PASSWORD || "").trim();
if (!PASSWORD) {
  try { PASSWORD = fs.readFileSync(PASS_FILE, "utf8").trim(); } catch (e) {}
  if (!PASSWORD) {
    PASSWORD = crypto.randomBytes(4).toString("hex"); // mis. "a1b2c3d4"
    try { fs.writeFileSync(PASS_FILE, PASSWORD + "\n"); } catch (e) {}
  }
}
const sessions = new Set(); // token sesi yang valid (hilang saat restart)
function newToken() { return crypto.randomBytes(24).toString("hex"); }
function getCookie(req, name) {
  const h = req.headers.cookie || "";
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
function authed(req) { const t = getCookie(req, "lb_session"); return t && sessions.has(t); }
function passwordOk(input) {
  const a = Buffer.from(String(input || "")), b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- login Google (opsional, pakai Google Identity Services) ----------
const https = require("https");
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
// Email yang boleh masuk via Google. Kosong = Google login dimatikan (demi keamanan).
const ALLOWED_EMAILS = new Set(
  (process.env.LB_ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);
function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (r) => {
      let d = "";
      r.on("data", (c) => (d += c));
      r.on("end", () => { try { resolve({ status: r.statusCode, json: JSON.parse(d) }); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

let db = { requests: {} };
try { if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
catch (e) { console.error("data.json rusak, mulai kosong:", e.message); }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
    catch (e) { console.error("Gagal simpan:", e.message); }
  }, 150);
}

const id = () => crypto.randomBytes(5).toString("hex");
const now = () => Date.now();

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "", tooBig = false;
    req.on("data", (c) => { data += c; if (data.length > 2e5) { tooBig = true; req.destroy(); } });
    req.on("end", () => {
      if (tooBig) return reject(new Error("body terlalu besar"));
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
function serveFile(res, file) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(file).toLowerCase();
    const type = ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".js" ? "text/javascript; charset=utf-8"
      : ext === ".css" ? "text/css; charset=utf-8"
      : ext === ".svg" ? "image/svg+xml" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

// ---------- status & bentuk data ----------
function statusOf(r) {
  if (r.revoked) return "revoked";              // penerima menarik izin
  if (!r.active) return "inactive";             // dimatikan pembuat
  if (r.expiresAt && now() > r.expiresAt) return "expired";
  if (r.mode === "once" && r.completed) return "done";
  if (r.sharing) return "live";
  if (r.locations.length) return "shared";      // pernah dibagikan (mode once selesai / live berhenti)
  return "waiting";                             // belum diklik
}
function canReceive(r) {
  const s = statusOf(r);
  return s === "waiting" || s === "live" || s === "shared";
}
function summary(r) {
  const last = r.locations[r.locations.length - 1] || null;
  return {
    id: r.id, label: r.label, reason: r.reason, note: r.note, color: r.color,
    mode: r.mode, createdAt: r.createdAt, expiresAt: r.expiresAt,
    active: r.active, status: statusOf(r),
    lastLocation: last, points: r.locations.length,
  };
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // --- login / logout ---
    if (req.method === "POST" && p === "/api/login") {
      const b = await readBody(req);
      if (!passwordOk(b.password)) return sendJSON(res, 401, { error: "password salah" });
      const t = newToken(); sessions.add(t);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `lb_session=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "POST" && p === "/api/logout") {
      sessions.delete(getCookie(req, "lb_session"));
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": "lb_session=; HttpOnly; Path=/; Max-Age=0",
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // konfigurasi publik untuk halaman login (apakah Google aktif)
    if (req.method === "GET" && p === "/api/config") {
      return sendJSON(res, 200, { google: GOOGLE_CLIENT_ID, googleReady: !!(GOOGLE_CLIENT_ID && ALLOWED_EMAILS.size) });
    }
    // verifikasi ID token Google, lalu buat sesi jika email diizinkan
    if (req.method === "POST" && p === "/auth/google") {
      const b = await readBody(req);
      if (!GOOGLE_CLIENT_ID) return sendJSON(res, 400, { error: "Google login belum dikonfigurasi (set GOOGLE_CLIENT_ID)" });
      if (!ALLOWED_EMAILS.size) return sendJSON(res, 403, { error: "Belum ada email yang diizinkan (set LB_ALLOWED_EMAILS)" });
      if (!b.credential) return sendJSON(res, 400, { error: "token kosong" });
      let info;
      try { info = await httpsGetJSON("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(b.credential)); }
      catch (e) { return sendJSON(res, 502, { error: "gagal menghubungi Google" }); }
      const c = info.json || {};
      if (info.status !== 200 || c.aud !== GOOGLE_CLIENT_ID) return sendJSON(res, 401, { error: "token Google tidak valid" });
      if (String(c.email_verified) !== "true") return sendJSON(res, 403, { error: "email Google belum terverifikasi" });
      const email = String(c.email || "").toLowerCase();
      if (!ALLOWED_EMAILS.has(email)) return sendJSON(res, 403, { error: "Email " + email + " tidak diizinkan masuk" });
      const t = newToken(); sessions.add(t);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `lb_session=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`,
      });
      return res.end(JSON.stringify({ ok: true, email }));
    }

    // --- rute yang TERBUKA untuk penerima (tanpa password) ---
    const openRecipient =
      (req.method === "GET" && p.startsWith("/t/")) ||
      /^\/api\/requests\/[a-f0-9]+\/info$/.test(p) && req.method === "GET" ||
      /^\/api\/requests\/[a-f0-9]+\/(location|stop)$/.test(p) && req.method === "POST";

    // --- gerbang password untuk dashboard & API pengelolaan ---
    if (!openRecipient && !authed(req)) {
      if (p === "/" || p === "/index.html") return serveFile(res, "login.html");
      if (p.startsWith("/api/")) return sendJSON(res, 401, { error: "unauthorized" });
      return serveFile(res, "login.html");
    }

    if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveFile(res, "dashboard.html");
    if (req.method === "GET" && p.startsWith("/t/")) return serveFile(res, "track.html");

    // buat request
    if (req.method === "POST" && p === "/api/requests") {
      const b = await readBody(req);
      const rid = id();
      const ttl = Math.max(0, Number(b.ttlMinutes) || 0);
      const r = {
        id: rid,
        label: String(b.label || "Tanpa nama").slice(0, 120),
        reason: String(b.reason || "Berbagi lokasi").slice(0, 200),
        note: String(b.note || "").slice(0, 300),
        color: /^#[0-9a-fA-F]{6}$/.test(b.color || "") ? b.color : "#4f8cff",
        mode: b.mode === "once" ? "once" : "live",
        createdAt: now(),
        expiresAt: ttl ? now() + ttl * 60000 : null,
        active: true, revoked: false, sharing: false, completed: false,
        locations: [],
      };
      db.requests[rid] = r; save();
      return sendJSON(res, 201, { id: rid, expiresAt: r.expiresAt });
    }

    // daftar
    if (req.method === "GET" && p === "/api/requests") {
      const list = Object.values(db.requests).sort((a, b) => b.createdAt - a.createdAt).map(summary);
      return sendJSON(res, 200, { requests: list, serverTime: now() });
    }

    const m = p.match(/^\/api\/requests\/([a-f0-9]+)(\/(info|location|stop|trail))?$/);
    if (m) {
      const r = db.requests[m[1]];
      const sub = m[3];

      // detail penuh + trail (dashboard, saat kartu dipilih)
      if (req.method === "GET" && (sub === "trail" || !sub)) {
        if (!r) return sendJSON(res, 404, { error: "not_found" });
        return sendJSON(res, 200, { ...summary(r), trail: r.locations, serverTime: now() });
      }
      // info untuk halaman penerima
      if (req.method === "GET" && sub === "info") {
        if (!r) return sendJSON(res, 404, { error: "not_found", status: "not_found" });
        return sendJSON(res, 200, {
          id: r.id, label: r.label, reason: r.reason, mode: r.mode,
          status: statusOf(r), expiresAt: r.expiresAt, serverTime: now(),
        });
      }
      // penerima kirim lokasi
      if (req.method === "POST" && sub === "location") {
        if (!r) return sendJSON(res, 404, { error: "not_found" });
        if (!canReceive(r)) return sendJSON(res, 410, { error: "closed", status: statusOf(r) });
        const b = await readBody(req);
        const lat = Number(b.lat), lng = Number(b.lng);
        if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
          return sendJSON(res, 400, { error: "koordinat tidak valid" });
        r.locations.push({ lat, lng, accuracy: isFinite(Number(b.accuracy)) ? Number(b.accuracy) : null, at: now() });
        if (r.locations.length > 1000) r.locations.shift();
        if (r.mode === "once") { r.completed = true; r.sharing = false; }
        else r.sharing = b.live === true;
        r.revoked = false; save();
        return sendJSON(res, 200, { ok: true, status: statusOf(r) });
      }
      // penerima tarik izin
      if (req.method === "POST" && sub === "stop") {
        if (!r) return sendJSON(res, 404, { error: "not_found" });
        r.sharing = false; r.revoked = true; save();
        return sendJSON(res, 200, { ok: true });
      }
      // pembuat edit (note, color, active, perpanjang/ubah expiry)
      if (req.method === "PATCH" && !sub) {
        if (!r) return sendJSON(res, 404, { error: "not_found" });
        const b = await readBody(req);
        if (typeof b.note === "string") r.note = b.note.slice(0, 300);
        if (/^#[0-9a-fA-F]{6}$/.test(b.color || "")) r.color = b.color;
        if (typeof b.active === "boolean") r.active = b.active;
        if (typeof b.label === "string") r.label = b.label.slice(0, 120);
        if ("ttlMinutes" in b) {
          const ttl = Math.max(0, Number(b.ttlMinutes) || 0);
          r.expiresAt = ttl ? now() + ttl * 60000 : null;
        }
        save();
        return sendJSON(res, 200, summary(r));
      }
      // hapus
      if (req.method === "DELETE" && !sub) {
        if (db.requests[m[1]]) { delete db.requests[m[1]]; save(); }
        return sendJSON(res, 200, { ok: true });
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) { sendJSON(res, 400, { error: e.message }); }
});

server.listen(PORT, () => {
  console.log(`LokasiBareng → http://localhost:${PORT}`);
  console.log(`Password dashboard: ${PASSWORD}   (ubah di password.txt atau set env LB_PASSWORD)`);
});
