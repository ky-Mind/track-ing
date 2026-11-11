// LokasiBareng — Cloudflare Worker + D1 (consent-based location check-in).
// Logika sama dengan versi Node, tapi penyimpanan di D1 dan sesi pakai cookie
// stateless bertanda-tangan (HMAC) agar tidak butuh server yang menyala.

import dashboardHtml from "../public/dashboard.html";
import loginHtml from "../public/login.html";
import trackHtml from "../public/track.html";
import gameHtml from "../public/index.html";
import musicAsset from "../public/music.mp3";

const enc = new TextEncoder();

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
function page(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}
function getCookie(req, name) {
  const h = req.headers.get("cookie") || "";
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function makeSession(secret) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  return `${exp}.${await hmacHex(secret, String(exp))}`;
}
async function validSession(secret, token) {
  if (!token) return false;
  const i = token.indexOf(".");
  if (i < 0) return false;
  const exp = token.slice(0, i), sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEq(sig, await hmacHex(secret, exp));
}
function sessionCookie(t) { return `lb_session=${t}; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=604800`; }
const CLEAR_COOKIE = "lb_session=; HttpOnly; Path=/; Secure; Max-Age=0";

// Urutan penting: link yang dimatikan/kedaluwarsa/selesai tetap tertutup walau
// penerima pernah menarik izin. "revoked" sendiri BUKAN penutup permanen: penerima
// boleh membuka link lagi dan memilih berbagi lagi (izinnya tetap miliknya).
function statusOf(r, now) {
  if (!r.active) return "inactive";
  if (r.expires_at && now > r.expires_at) return "expired";
  if (r.mode === "once" && r.completed) return "done";
  if (r.revoked) return "revoked";
  if (r.sharing) return "live";
  if (r.points) return "shared";
  return "waiting";
}
function canReceive(r, now) {
  const s = statusOf(r, now);
  return s === "waiting" || s === "live" || s === "shared" || s === "revoked";
}

// Batas titik per link & jeda minimum antar-titik (anti banjir D1).
const MAX_POINTS = 1000;
const MIN_POINT_GAP_MS = 3000;

// Rate limit login: maks LOGIN_MAX_FAILS gagal per IP dalam LOGIN_WINDOW_MS.
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
async function loginBlocked(DB, ip, now) {
  await DB.prepare("CREATE TABLE IF NOT EXISTS login_fails (ip TEXT PRIMARY KEY, count INTEGER, first_at INTEGER)").run();
  const row = await DB.prepare("SELECT count, first_at FROM login_fails WHERE ip=?").bind(ip).first();
  if (!row || now - row.first_at > LOGIN_WINDOW_MS) return 0;
  return row.count >= LOGIN_MAX_FAILS ? Math.ceil((row.first_at + LOGIN_WINDOW_MS - now) / 1000) : 0;
}
async function loginFailed(DB, ip, now) {
  await DB.prepare(
    `INSERT INTO login_fails(ip,count,first_at) VALUES(?,1,?)
     ON CONFLICT(ip) DO UPDATE SET
       count = CASE WHEN ?-first_at > ? THEN 1 ELSE count+1 END,
       first_at = CASE WHEN ?-first_at > ? THEN ? ELSE first_at END`
  ).bind(ip, now, now, LOGIN_WINDOW_MS, now, LOGIN_WINDOW_MS, now).run();
}
function summaryRow(r, now) {
  const last = r.last_at != null ? { lat: r.last_lat, lng: r.last_lng, accuracy: r.last_acc, at: r.last_at } : null;
  return {
    id: r.id, label: r.label, reason: r.reason, note: r.note, color: r.color, mode: r.mode,
    createdAt: r.created_at, expiresAt: r.expires_at, active: !!r.active, status: statusOf(r, now),
    lastLocation: last, points: r.points || 0,
  };
}
const ROW_WITH_LAST = (where) => `
  SELECT r.*,
    (SELECT COUNT(*) FROM locations l WHERE l.req_id=r.id) AS points,
    (SELECT lat FROM locations l WHERE l.req_id=r.id ORDER BY at DESC LIMIT 1) AS last_lat,
    (SELECT lng FROM locations l WHERE l.req_id=r.id ORDER BY at DESC LIMIT 1) AS last_lng,
    (SELECT accuracy FROM locations l WHERE l.req_id=r.id ORDER BY at DESC LIMIT 1) AS last_acc,
    (SELECT at FROM locations l WHERE l.req_id=r.id ORDER BY at DESC LIMIT 1) AS last_at
  FROM requests r ${where}`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;
    const now = Date.now();
    const DB = env.DB;
    // Tanpa SESSION_SECRET yang layak, sesi tidak bisa dibuat maupun divalidasi
    // (tidak ada fallback — fallback statis = siapa pun bisa memalsukan cookie).
    const SECRET = (env.SESSION_SECRET || "").length >= 16 ? env.SESSION_SECRET : "";
    const PASSWORD = env.LB_PASSWORD || "";
    const IP = request.headers.get("cf-connecting-ip") || "unknown";
    const GOOGLE_CLIENT_ID = (env.GOOGLE_CLIENT_ID || "").trim();
    const ALLOWED = new Set((env.LB_ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    const body = async () => { try { return await request.json(); } catch { return {}; } };

    try {
      // ---- login / logout / config / google (terbuka) ----
      if (method === "POST" && p === "/api/login") {
        if (!SECRET || !PASSWORD) return json({ error: "server belum dikonfigurasi (SESSION_SECRET / LB_PASSWORD)" }, 503);
        const wait = await loginBlocked(DB, IP, now);
        if (wait) return json({ error: `terlalu banyak percobaan, coba lagi ${Math.ceil(wait / 60)} menit lagi` }, 429, { "retry-after": String(wait) });
        const b = await body();
        // bandingkan HMAC (panjang sama) agar panjang password tidak bocor lewat timing
        const ok = safeEq(await hmacHex(SECRET, String(b.password || "")), await hmacHex(SECRET, PASSWORD));
        if (!ok) { await loginFailed(DB, IP, now); return json({ error: "password salah" }, 401); }
        await DB.prepare("DELETE FROM login_fails WHERE ip=?").bind(IP).run();
        return json({ ok: true }, 200, { "set-cookie": sessionCookie(await makeSession(SECRET)) });
      }
      if (method === "POST" && p === "/api/logout") return json({ ok: true }, 200, { "set-cookie": CLEAR_COOKIE });
      if (method === "GET" && p === "/api/config")
        return json({ google: GOOGLE_CLIENT_ID, googleReady: !!(GOOGLE_CLIENT_ID && ALLOWED.size) });
      if (method === "POST" && p === "/auth/google") {
        const b = await body();
        if (!SECRET) return json({ error: "server belum dikonfigurasi (SESSION_SECRET)" }, 503);
        if (!GOOGLE_CLIENT_ID) return json({ error: "Google login belum dikonfigurasi" }, 400);
        if (!ALLOWED.size) return json({ error: "Belum ada email yang diizinkan" }, 403);
        if (!b.credential) return json({ error: "token kosong" }, 400);
        let st, c;
        try {
          const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(b.credential));
          st = r.status; c = await r.json();
        } catch { return json({ error: "gagal menghubungi Google" }, 502); }
        if (st !== 200 || c.aud !== GOOGLE_CLIENT_ID) return json({ error: "token Google tidak valid" }, 401);
        if (String(c.email_verified) !== "true") return json({ error: "email Google belum terverifikasi" }, 403);
        const email = String(c.email || "").toLowerCase();
        if (!ALLOWED.has(email)) return json({ error: "Email " + email + " tidak diizinkan masuk" }, 403);
        return json({ ok: true, email }, 200, { "set-cookie": sessionCookie(await makeSession(SECRET)) });
      }

      // ---- rute penerima (tanpa login) ----
      if (method === "GET" && p.startsWith("/t/")) return page(trackHtml);
      if (method === "GET" && p === "/game") return page(gameHtml);
      if (method === "GET" && p === "/music.mp3") {
        return new Response(musicAsset, {
          headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=3600" },
        });
      }
      const mInfo = p.match(/^\/api\/requests\/([a-f0-9]+)\/info$/);
      if (method === "GET" && mInfo) {
        const r = await DB.prepare(ROW_WITH_LAST("WHERE r.id=?")).bind(mInfo[1]).first();
        if (!r) return json({ error: "not_found", status: "not_found" }, 404);
        return json({ id: r.id, label: r.label, reason: r.reason, mode: r.mode, status: statusOf(r, now), expiresAt: r.expires_at });
      }
      const mLoc = p.match(/^\/api\/requests\/([a-f0-9]+)\/location$/);
      if (method === "POST" && mLoc) {
        const r = await DB.prepare(ROW_WITH_LAST("WHERE r.id=?")).bind(mLoc[1]).first();
        if (!r) return json({ error: "not_found" }, 404);
        if (!canReceive(r, now)) return json({ error: "closed", status: statusOf(r, now) }, 410);
        const b = await body();
        const lat = Number(b.lat), lng = Number(b.lng);
        if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
          return json({ error: "koordinat tidak valid" }, 400);
        const acc = isFinite(Number(b.accuracy)) ? Number(b.accuracy) : null;
        // terlalu rapat dengan titik sebelumnya → tidak disimpan (status tetap diperbarui)
        const tooSoon = r.last_at != null && now - r.last_at < MIN_POINT_GAP_MS && r.mode !== "once";
        if (!tooSoon) {
          await DB.prepare("INSERT INTO locations(req_id,lat,lng,accuracy,at) VALUES(?,?,?,?,?)").bind(r.id, lat, lng, acc, now).run();
          if ((r.points || 0) + 1 > MAX_POINTS)
            await DB.prepare(
              "DELETE FROM locations WHERE req_id=? AND id NOT IN (SELECT id FROM locations WHERE req_id=? ORDER BY at DESC LIMIT ?)"
            ).bind(r.id, r.id, MAX_POINTS).run();
        }
        if (r.mode === "once") await DB.prepare("UPDATE requests SET completed=1, sharing=0, revoked=0 WHERE id=?").bind(r.id).run();
        else await DB.prepare("UPDATE requests SET sharing=?, revoked=0 WHERE id=?").bind(b.live === true ? 1 : 0, r.id).run();
        return json({ ok: true, skipped: tooSoon });
      }
      // penerima menarik izin secara sadar (tombol)
      const mStop = p.match(/^\/api\/requests\/([a-f0-9]+)\/stop$/);
      if (method === "POST" && mStop) {
        await DB.prepare("UPDATE requests SET sharing=0, revoked=1 WHERE id=?").bind(mStop[1]).run();
        return json({ ok: true });
      }
      // halaman penerima ditutup/ditinggal → live berhenti, TAPI link tidak dicabut
      const mPause = p.match(/^\/api\/requests\/([a-f0-9]+)\/pause$/);
      if (method === "POST" && mPause) {
        await DB.prepare("UPDATE requests SET sharing=0 WHERE id=?").bind(mPause[1]).run();
        return json({ ok: true });
      }

      // ---- gerbang login ----
      const authed = !!SECRET && await validSession(SECRET, getCookie(request, "lb_session"));
      if (!authed) {
        if (p === "/" || p === "/index.html") return page(loginHtml);
        if (p.startsWith("/api/") || p.startsWith("/auth/")) return json({ error: "unauthorized" }, 401);
        return page(loginHtml);
      }

      // ---- area terproteksi ----
      if (method === "GET" && (p === "/" || p === "/index.html")) return page(dashboardHtml);
      if (method === "GET" && p === "/api/requests") {
        const { results } = await DB.prepare(ROW_WITH_LAST("ORDER BY r.created_at DESC")).all();
        return json({ requests: (results || []).map((r) => summaryRow(r, now)), serverTime: now });
      }
      const mId = p.match(/^\/api\/requests\/([a-f0-9]+)(\/trail)?$/);
      if (method === "GET" && mId) {
        const r = await DB.prepare(ROW_WITH_LAST("WHERE r.id=?")).bind(mId[1]).first();
        if (!r) return json({ error: "not_found" }, 404);
        const { results } = await DB.prepare("SELECT lat,lng,accuracy,at FROM locations WHERE req_id=? ORDER BY at ASC").bind(r.id).all();
        return json({ ...summaryRow(r, now), trail: results || [], serverTime: now });
      }
      if (method === "POST" && p === "/api/requests") {
        const b = await body();
        const id = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
        const ttl = Math.max(0, Number(b.ttlMinutes) || 0);
        const expires = ttl ? now + ttl * 60000 : null;
        const color = /^#[0-9a-fA-F]{6}$/.test(b.color || "") ? b.color : "#4f8cff";
        const mode = b.mode === "once" ? "once" : "live";
        await DB.prepare(
          "INSERT INTO requests(id,label,reason,note,color,mode,created_at,expires_at,active,revoked,completed,sharing) VALUES(?,?,?,?,?,?,?,?,1,0,0,0)"
        ).bind(id, String(b.label || "Tanpa nama").slice(0, 120), String(b.reason || "Berbagi lokasi").slice(0, 200),
          String(b.note || "").slice(0, 300), color, mode, now, expires).run();
        return json({ id, expiresAt: expires }, 201);
      }
      const mOne = p.match(/^\/api\/requests\/([a-f0-9]+)$/);
      if (method === "PATCH" && mOne) {
        const b = await body();
        const sets = [], vals = [];
        if (typeof b.note === "string") { sets.push("note=?"); vals.push(b.note.slice(0, 300)); }
        if (/^#[0-9a-fA-F]{6}$/.test(b.color || "")) { sets.push("color=?"); vals.push(b.color); }
        if (typeof b.active === "boolean") { sets.push("active=?"); vals.push(b.active ? 1 : 0); }
        if (typeof b.label === "string") { sets.push("label=?"); vals.push(b.label.slice(0, 120)); }
        if ("ttlMinutes" in b) { const ttl = Math.max(0, Number(b.ttlMinutes) || 0); sets.push("expires_at=?"); vals.push(ttl ? now + ttl * 60000 : null); }
        if (sets.length) { vals.push(mOne[1]); await DB.prepare(`UPDATE requests SET ${sets.join(", ")} WHERE id=?`).bind(...vals).run(); }
        const r = await DB.prepare(ROW_WITH_LAST("WHERE r.id=?")).bind(mOne[1]).first();
        return r ? json(summaryRow(r, now)) : json({ error: "not_found" }, 404);
      }
      if (method === "DELETE" && mOne) {
        await DB.prepare("DELETE FROM locations WHERE req_id=?").bind(mOne[1]).run();
        await DB.prepare("DELETE FROM requests WHERE id=?").bind(mOne[1]).run();
        return json({ ok: true });
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: "server error", detail: String(e && e.message || e) }, 500);
    }
  },
};
