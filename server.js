'use strict';

/**
 * Copyright (c) Collision IQ LLC, owned by CuelJuris. All rights reserved.
 *
 * CollisionIQ v3
 * - Free public ADAS calibration requirement lookup (/check) with lead capture
 * - Shop accounts: job documentation (scans, calibration, photos), shareable reports
 * - Admin view of leads and usage (ADMIN_EMAIL)
 * Zero native dependencies: uses Node's built-in node:sqlite and crypto.scrypt.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');
const { runADASEngine } = require('./adasEngine');

const scrypt = promisify(crypto.scrypt);

// ─── Brand ───────────────────────────────────────────────────────────────────
const BRAND = 'CollisionIQ';
const LEGAL = 'Collision IQ LLC';
const OWNER = 'CuelJuris';
const OWNER_LINE = `${LEGAL} · Owned by ${OWNER}`;

// ─── Config ──────────────────────────────────────────────────────────────────
const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'collisioniq.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

if (PROD && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAKES = ['Toyota','Lexus','Ford','Lincoln','Chevrolet','GMC','Buick','Cadillac','Chrysler','Dodge','Ram','Jeep','Honda','Acura','Nissan','Infiniti','Kia','Hyundai','Genesis','Subaru','Mazda','Mercedes-Benz','Jaguar','Land Rover','Volvo','Tesla'];
const REPAIRS = ['Windshield','Front Camera Area','Front Bumper','Rear Bumper','Radar','Structural Body Repair','Airbag / SRS Deployment','Wheel Alignment','Suspension','Door / Mirror Repair','EV / Hybrid Vehicle'];
const PHOTO_LABELS = ['Pre-repair scan report','Post-repair scan report','Calibration result','Target / equipment setup','VIN / odometer','Damage','Other'];
const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

// ─── Database ────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, city TEXT, state TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  ro TEXT, vin TEXT, year TEXT, make TEXT, model TEXT, trim TEXT, tech TEXT,
  repairs TEXT,
  adas_systems TEXT, rationale TEXT, liability TEXT, make_notes TEXT,
  pre_req TEXT, post_req TEXT, scan_tool TEXT, source TEXT,
  pre_done INTEGER DEFAULT 0, pre_date TEXT, pre_tool TEXT, pre_result TEXT,
  post_done INTEGER DEFAULT 0, post_date TEXT, post_tool TEXT, post_result TEXT,
  cal_done INTEGER DEFAULT 0, cal_date TEXT, cal_type TEXT, cal_tool TEXT, cal_result TEXT,
  job_notes TEXT,
  share_token TEXT NOT NULL UNIQUE,
  created_by TEXT, updated_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_shop ON jobs(shop_id, id DESC);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  shop_id INTEGER NOT NULL,
  label TEXT, file TEXT NOT NULL, orig_name TEXT, mime TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_job ON photos(job_id);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL, vehicle TEXT, repairs TEXT, source TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_email_vehicle ON leads(email, vehicle);
CREATE TABLE IF NOT EXISTS lookups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, make TEXT, source TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL
);
`);

// ─── Session store (node:sqlite; connect-sqlite3 is not used) ───────────────
class SqliteStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    const purge = () => { try { this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); } catch (_) {} };
    purge();
    setInterval(purge, 60 * 60 * 1000).unref();
  }
  _exp(sess) {
    return sess && sess.cookie && sess.cookie.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 8 * 60 * 60 * 1000;
  }
  get(sid, cb) {
    try {
      const r = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!r) return cb(null, null);
      if (r.expires < Date.now()) { this.destroy(sid, () => {}); return cb(null, null); }
      cb(null, JSON.parse(r.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), this._exp(sess));
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try {
      this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(this._exp(sess), sid);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); }
    catch (e) { cb && cb(e); }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const asArray = v => (Array.isArray(v) ? v : v == null ? [] : [v]);
const jobCode = id => 'CIQ-' + String(id).padStart(6, '0');
const isEmail = e => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return 's1$' + salt.toString('hex') + '$' + h.toString('hex');
}
async function checkPw(pw, stored) {
  const [v, s, h] = String(stored || '').split('$');
  if (v !== 's1' || !s || !h) return false;
  const got = await scrypt(pw, Buffer.from(s, 'hex'), 64);
  const want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const DUMMY_HASH_PROMISE = hashPw('dummy-password-for-timing');

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/** Documentation steps: the "omission risk" hook. */
function docSteps(job, photoCount) {
  const calNeeded = /calibration/i.test(job.adas_systems || '');
  const join = (...a) => a.filter(Boolean).join(' · ');
  return [
    { key: 'pre', label: 'Pre-repair scan', applicable: true, done: !!job.pre_done,
      detail: join(job.pre_tool, job.pre_result, job.pre_date ? fmtDate(job.pre_date + 'T12:00:00Z') : ''),
      gap: 'Pre-repair scan not documented' },
    { key: 'cal', label: 'Calibration', applicable: calNeeded, done: !!job.cal_done,
      detail: calNeeded ? join(job.cal_type, job.cal_tool, job.cal_result, job.cal_date ? fmtDate(job.cal_date + 'T12:00:00Z') : '') : 'Not called for by the OEM guidance for these repairs',
      gap: 'Required calibration not documented' },
    { key: 'post', label: 'Post-repair scan', applicable: true, done: !!job.post_done,
      detail: join(job.post_tool, job.post_result, job.post_date ? fmtDate(job.post_date + 'T12:00:00Z') : ''),
      gap: 'Post-repair scan not documented' },
    { key: 'photos', label: 'Photos and scan reports', applicable: true, done: photoCount > 0,
      detail: `${photoCount} file${photoCount === 1 ? '' : 's'} attached`,
      gap: 'No supporting photos or scan reports attached' },
  ];
}
function docGaps(job, photoCount) {
  return docSteps(job, photoCount).filter(x => x.applicable && !x.done).map(x => x.gap);
}
function gapBadge(gaps) {
  if (gaps.length === 0) return '<span class="badge b-green">Documented</span>';
  return `<span class="badge ${gaps.length >= 3 ? 'b-red' : 'b-yellow'}">${gaps.length} gap${gaps.length > 1 ? 's' : ''}</span>`;
}

// ─── Layout ──────────────────────────────────────────────────────────────────
const CSS = `
:root{--ink:#0B0B0C;--ink2:#1C1C1E;--yellow:#FFC61A;--yellow-d:#E6AE00;--yellow-t:#FFF6D6;--ground:#F4F3EF;--line:#E2E0D8;--muted:#5F5E58;--display:'Barlow Condensed','Arial Narrow',Arial,sans-serif;--body:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;--mono:'IBM Plex Mono',ui-monospace,Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--body);background:var(--ground);color:var(--ink);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--ink);text-decoration-color:var(--yellow-d);text-decoration-thickness:2px;text-underline-offset:3px}
a:hover{background:var(--yellow)}
:focus-visible{outline:3px solid var(--ink);outline-offset:2px;box-shadow:0 0 0 6px var(--yellow)}
.nav{background:var(--ink);color:#fff;padding:.55rem 1rem;display:flex;flex-wrap:wrap;gap:.25rem 1.2rem;align-items:center;border-bottom:4px solid var(--yellow)}
.nav a,.nav button{color:#fff;text-decoration:none;font-size:.92rem;font-weight:500;background:none;border:none;cursor:pointer;font-family:inherit;min-height:44px;display:inline-flex;align-items:center}
.nav a:hover,.nav button:hover{background:none;color:var(--yellow)}
.nav .brand{margin-right:auto;gap:.6rem;font-family:var(--display);font-weight:700;font-size:1.45rem;letter-spacing:.06em;text-transform:uppercase}
.nav .brand i{font-style:normal;color:var(--yellow)}
.mark{width:30px;height:30px;border-radius:7px;background:var(--yellow);color:var(--ink);display:inline-flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:.7rem;font-weight:500;letter-spacing:0}
.nav .navcta{background:var(--yellow);color:var(--ink);padding:0 1rem;border-radius:8px;font-weight:700}
.nav .navcta:hover{background:#fff;color:var(--ink)}
.wrap{max-width:880px;margin:0 auto;padding:1rem}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:1.25rem;margin-bottom:1rem}
h1{font-family:var(--display);font-weight:700;font-size:2rem;line-height:1.05;text-transform:uppercase;letter-spacing:.01em;color:var(--ink);margin-bottom:.35rem}
h2{font-family:var(--display);font-weight:700;font-size:1.25rem;text-transform:uppercase;letter-spacing:.04em;color:var(--ink);margin:1.1rem 0 .45rem;display:flex;align-items:center;gap:.6rem}
h2::before{content:'';width:18px;height:6px;background:var(--yellow);border-radius:2px;flex-shrink:0}
.eyebrow{font-size:.75rem;font-weight:600;letter-spacing:.14em;color:var(--muted);text-transform:uppercase;margin-bottom:.4rem}
.sub{color:var(--muted);font-size:.92rem;margin-bottom:.8rem}
label.f{display:block;font-size:.8rem;font-weight:600;color:#3A3A36;margin:.85rem 0 .25rem}
input[type=text],input[type=email],input[type=password],input[type=number],input[type=date],select,textarea{width:100%;min-height:48px;border:1.5px solid #B9B6AA;border-radius:10px;padding:.6rem .75rem;font-size:1rem;font-family:inherit;background:#fff;color:var(--ink)}
textarea{min-height:90px}
input:focus,select:focus,textarea:focus{border-color:var(--ink)}
input[readonly]{background:#FAF9F5;font-family:var(--mono);font-size:.85rem}
.row{display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem}
.row2{display:grid;grid-template-columns:repeat(2,1fr);gap:.6rem}
@media(max-width:560px){.row,.row2{grid-template-columns:1fr}h1{font-size:1.75rem}}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.4rem;margin-top:.3rem}
@media(max-width:560px){.grid{grid-template-columns:1fr}}
.chk{display:flex;gap:.6rem;align-items:center;font-size:.95rem;min-height:46px;padding:.4rem .7rem;border:1.5px solid var(--line);border-radius:10px;background:#FBFAF6;cursor:pointer}
.chk input{width:20px;height:20px;accent-color:var(--ink);flex-shrink:0}
.chk:has(input:checked){border-color:var(--ink);background:var(--yellow-t)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:.6rem 1.3rem;background:var(--yellow);color:var(--ink);border:2px solid var(--ink);border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;text-decoration:none;font-family:inherit;letter-spacing:.01em}
.btn:hover{background:var(--ink);color:var(--yellow)}
.btn:disabled{opacity:.6;cursor:wait}
.btn.block{display:flex;width:100%;margin-top:1.1rem}
.btn.ghost{background:#fff}
.btn.ghost:hover{background:var(--ink);color:#fff}
.btn.sm{min-height:40px;padding:.35rem .9rem;font-size:.88rem}
.btn.danger{background:#fff;color:#9B1C1C;border-color:#9B1C1C}
.btn.danger:hover{background:#9B1C1C;color:#fff}
.flash{background:#E3F4EA;color:#14532d;border:1px solid #A9D9BC;border-radius:10px;padding:.7rem .95rem;font-size:.92rem;margin-bottom:1rem}
.flash.err{background:#FDE7E7;color:#7A1616;border-color:#F0B3B3}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:.6rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;font-weight:600}
.tablewrap{overflow-x:auto}
.badge{display:inline-block;padding:.18rem .6rem;border-radius:99px;font-size:.75rem;font-weight:700;white-space:nowrap}
.b-green{background:#DFF3E7;color:#17603C}.b-yellow{background:var(--yellow-t);color:#6B4A00;border:1px solid var(--yellow-d)}.b-red{background:#FDE7E7;color:#9B1C1C}.b-dark{background:var(--ink);color:var(--yellow)}
ul.plain{padding-left:1.2rem;font-size:.95rem}ul.plain li{margin-bottom:.4rem}
.kv{font-size:.93rem;margin:.3rem 0}.kv b{color:var(--ink)}.kv b:first-child{font-weight:600}
.warn{background:var(--yellow-t);color:#4F3800;border:1px solid var(--yellow-d);border-radius:10px;padding:.75rem .95rem;font-size:.88rem;margin-top:.9rem}
.gap{background:#FDE7E7;color:#7A1616;border:1px solid #F0B3B3;border-radius:10px;padding:.75rem .95rem;font-size:.92rem;margin:.7rem 0}
.dark{background:var(--ink);color:#fff;border-color:var(--ink)}
.dark h1,.dark h2{color:#fff}
.dark h2::before{background:var(--yellow)}
.dark p{color:#D8D6CC}
.cta{background:var(--ink);color:#fff;border-color:var(--ink)}
.cta p{margin-bottom:.9rem;color:#D8D6CC}
.cta .btn{background:var(--yellow);border-color:var(--yellow)}
.cta .btn:hover{background:#fff;color:var(--ink);border-color:#fff}
.fine{font-size:.76rem;color:var(--muted);line-height:1.55;margin-top:.5rem}
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.6rem;margin-top:.6rem}
.thumb{border:1px solid var(--line);border-radius:10px;padding:.45rem;font-size:.78rem;background:#FBFAF6}
.thumb img{width:100%;height:110px;object-fit:cover;border-radius:6px;display:block;margin-bottom:.35rem}
.thumb .pdf{height:110px;display:flex;align-items:center;justify-content:center;background:var(--yellow-t);border-radius:6px;margin-bottom:.35rem;font-family:var(--mono);font-weight:500}
.hero{padding:2.2rem 1.4rem;background:var(--ink);color:#fff;border-color:var(--ink);text-align:left}
.hero h1{font-size:2.6rem;color:#fff;max-width:640px;margin-bottom:.8rem}
.hero h1 em{font-style:normal;color:var(--yellow)}
.hero p{color:#D8D6CC;max-width:560px;margin-bottom:1.3rem;font-size:1.02rem}
.hero .btn.ghost{background:transparent;color:#fff;border-color:#fff}
.hero .btn.ghost:hover{background:#fff;color:var(--ink)}
@media(max-width:560px){.hero h1{font-size:2.1rem}}
.progress{height:12px;background:#E9E7DF;border-radius:99px;overflow:hidden;margin:.5rem 0 .2rem}
.progress i{display:block;height:100%;background:var(--yellow);border-right:2px solid var(--ink)}
.steps{display:flex;flex-direction:column}
.step{display:flex;gap:.8rem;padding:.9rem 0;border-bottom:1px solid var(--line);align-items:flex-start}
.step:last-child{border-bottom:0}
.step svg{flex-shrink:0;margin-top:1px}
.step .t{display:flex;justify-content:space-between;gap:.6rem;font-weight:600;font-size:.98rem}
.step .d{font-size:.84rem;color:var(--muted);margin-top:.15rem}
.step.grow{flex-grow:1}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap}
.mono{font-family:var(--mono)}
.legal{font-size:.78rem;color:var(--muted);text-align:center}
.footer{text-align:center;font-size:.8rem;color:var(--muted);padding:1.6rem 1rem 2rem;border-top:4px solid var(--yellow);background:var(--ink);margin-top:1rem}
.footer,.footer a{color:#D8D6CC}
.footer a:hover{background:none;color:var(--yellow)}
.footer b{color:var(--yellow);font-weight:600}
.hidden{display:none}
.rpt-head{border-bottom:4px solid var(--ink);padding-bottom:1rem;margin-bottom:1rem;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-end}
.rpt-brand{display:flex;align-items:center;gap:.6rem;margin-bottom:.6rem}
.rpt-brand .mark{width:34px;height:34px}
.rpt-brand span{font-family:var(--display);font-weight:700;font-size:1.3rem;letter-spacing:.06em;text-transform:uppercase}
.rpt-brand small{display:block;font-family:var(--body);font-size:.68rem;letter-spacing:.08em;color:var(--muted);font-weight:500}
@media print{.nav,.noprint,.footer{display:none!important}body{background:#fff}.card{border:1px solid #bbb}.rpt-legal{display:block!important}}
.rpt-legal{display:none}
`;

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%230B0B0C'/%3E%3Ctext x='32' y='44' font-family='Arial,sans-serif' font-size='30' font-weight='700' text-anchor='middle' fill='%23FFC61A'%3EIQ%3C/text%3E%3C/svg%3E";
const FONTS = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap';

function layout({ title, body, user, csrf, flash, flashErr, noindex }) {
  const isAdmin = user && ADMIN_EMAIL && user.email.toLowerCase() === ADMIN_EMAIL;
  const nav = user
    ? `<a href="/jobs">Jobs</a><a href="/jobs/new">New Job</a><a href="/check">Free Check</a>${isAdmin ? '<a href="/admin">Admin</a>' : ''}
       <form method="POST" action="/logout" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button type="submit">Sign out</button></form>`
    : '<a href="/check">Free Check</a><a href="/login">Sign in</a><a class="navcta" href="/register">Create account</a>';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="author" content="${esc(LEGAL)}"><meta name="copyright" content="${esc(LEGAL)}, owned by ${esc(OWNER)}">
<meta name="theme-color" content="#0B0B0C">
${noindex ? '<meta name="robots" content="noindex,nofollow">' : ''}
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<title>${esc(title)} — ${BRAND}</title>
<style>${CSS}</style></head>
<body>
<div class="nav"><a class="brand" href="/"><span class="mark">CIQ</span>Collision<i>IQ</i></a>${nav}</div>
<div class="wrap">
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
${flashErr ? `<div class="flash err">${esc(flashErr)}</div>` : ''}
${body}
</div>
<div class="footer">© ${new Date().getFullYear()} <b>${esc(LEGAL)}</b> · Owned by <b>${esc(OWNER)}</b> · All rights reserved<br>${BRAND} is a product of ${esc(LEGAL)}. <a href="/terms">Terms &amp; Disclaimer</a></div>
</body></html>`;
}

function errorPage(res, code, msg) {
  return res.status(code).send(layout({
    title: 'Error',
    body: `<div class="card"><h1>${esc(msg)}</h1><p class="sub"><a href="/">Back to home</a></p></div>`,
  }));
}

// ─── App + middleware ────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
  },
}));

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '8kb' }));
app.use(session({
  store: new SqliteStore(db),
  name: 'ciq.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, secure: PROD, sameSite: 'lax' },
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: 'Too many attempts. Try again in 15 minutes.' });
const checkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many lookups. Please try again in a few minutes.' } });
const leadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Try again later.' } });
const publicLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false });

// Load user + shop for the request
app.use((req, res, next) => {
  req.user = null;
  const uid = req.session && req.session.userId;
  if (uid) {
    const u = db.prepare('SELECT u.id, u.name, u.email, u.shop_id, s.name AS shop_name FROM users u JOIN shops s ON s.id = u.shop_id WHERE u.id = ?').get(uid);
    if (u) req.user = u; else delete req.session.userId;
  }
  next();
});

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}
function csrfValid(req) {
  const t = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  const s = String((req.session && req.session.csrf) || '');
  return !!s && t.length === s.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(s));
}
function csrfCheck(req, res, next) {
  if (!csrfValid(req)) return errorPage(res, 403, 'Your session expired. Go back, refresh the page, and try again.');
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || !ADMIN_EMAIL || req.user.email.toLowerCase() !== ADMIN_EMAIL) return errorPage(res, 403, 'Access denied.');
  next();
}
function render(req, res, opts) {
  const flash = req.session && req.session.flash;
  const flashErr = req.session && req.session.flashErr;
  if (flash) delete req.session.flash;
  if (flashErr) delete req.session.flashErr;
  res.send(layout({ ...opts, user: req.user, csrf: req.user ? csrfToken(req) : opts.csrf, flash, flashErr }));
}
const csrfField = t => `<input type="hidden" name="_csrf" value="${esc(t)}">`;

// ─── Landing ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.user) return res.redirect('/jobs');
  render(req, res, {
    title: 'ADAS Calibration Requirements & Documentation',
    body: `<div class="card hero">
      <div class="eyebrow" style="color:var(--yellow)">ADAS calibration documentation</div>
      <h1>Know what the repair requires. <em>Prove it was done.</em></h1>
      <p>Free lookup of OEM calibration and scan requirements by vehicle and repair. Then document every job with scans, calibration results and photos in one shareable report.</p>
      <div style="display:flex;gap:.7rem;flex-wrap:wrap">
        <a class="btn" href="/check">Free calibration check</a>
        <a class="btn ghost" href="/register">Create free account</a>
      </div>
    </div>
    <div class="card"><h2 style="margin-top:0">How it works</h2>
      <ul class="plain">
        <li><b>Check.</b> Enter year, make, model and the repairs performed. See the required calibrations, the scans and the OEM source.</li>
        <li><b>Document.</b> Log the pre and post scans and the calibration. Attach photos or scan reports. See exactly what is missing.</li>
        <li><b>Share.</b> Send an insurer, fleet or customer a read-only report link, or print it to PDF.</li>
      </ul></div>
    <p class="legal">${esc(OWNER_LINE)}</p>`,
  });
});

// ─── Free public check ───────────────────────────────────────────────────────
function cleanRepairs(list) {
  return asArray(list).map(r => String(r)).filter(r => REPAIRS.includes(r));
}
function validVehicle(b) {
  const make = clip(b.make, 40), model = clip(b.model, 40), year = parseInt(b.year, 10);
  if (!make || !model) return { error: 'Make and model are required.' };
  if (!Number.isInteger(year) || year < 1990 || year > 2030) return { error: 'Enter a valid model year (1990–2030).' };
  return { make, model, year };
}

app.post('/api/check', checkLimiter, (req, res) => {
  const b = req.body || {};
  const v = validVehicle(b);
  if (v.error) return res.status(400).json({ error: v.error });
  const repairs = cleanRepairs(b.repairs);
  if (!repairs.length) return res.status(400).json({ error: 'Select at least one repair performed.' });
  let out;
  try { out = runADASEngine(v.make, v.model, String(v.year), repairs); }
  catch (e) { console.error('[check] engine error:', e.message); return res.status(500).json({ error: 'Lookup failed. Please try again.' }); }
  try { db.prepare('INSERT INTO lookups (make, source, created_at) VALUES (?, ?, ?)').run(v.make, clip(b.src, 40) || null, nowIso()); } catch (_) {}
  res.json({
    vehicle: `${v.year} ${v.make} ${v.model}`, repairs,
    systems: lines(out.adasSystems), rationale: lines(out.rationale),
    preScan: out.preScanRequired || '', postScan: out.postScanRequired || '',
    scanTool: out.approvedScanTool || '', notes: out.makeSpecificNotes || '',
    liability: out.liabilityWarning || '', source: out.sourceCitation || '',
  });
});

app.post('/api/lead', leadLimiter, (req, res) => {
  const b = req.body || {};
  const email = clip(b.email, 254).toLowerCase();
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  try {
    db.prepare('INSERT OR IGNORE INTO leads (email, vehicle, repairs, source, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(email, clip(b.vehicle, 80), clip(asArray(b.repairs).join(', '), 200), clip(b.src, 40) || null, nowIso());
  } catch (e) { console.error('[lead]', e.message); return res.status(500).json({ error: 'Could not save. Try again.' }); }
  res.json({ ok: true });
});

app.get('/check', (req, res) => {
  const makeOpts = MAKES.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  const boxes = REPAIRS.map((r, i) => `<label class="chk"><input type="checkbox" name="repairs" value="${esc(r)}" id="r${i}"> ${esc(r)}</label>`).join('');
  res.set('Cache-Control', 'no-store');
  render(req, res, {
    title: 'Free ADAS Calibration Check',
    body: `
<div class="card">
  <h1>Free ADAS Calibration Check</h1>
  <p class="sub">Enter the vehicle and the repairs performed. See which calibrations and scans the OEM position statements call for. No login.</p>
  <form id="f" novalidate>
    <div class="row">
      <div><label class="f" for="year">Year</label><input id="year" type="number" inputmode="numeric" min="1990" max="2030" placeholder="2024"></div>
      <div><label class="f" for="make">Make</label><select id="make"><option value="">Select</option>${makeOpts}</select></div>
      <div><label class="f" for="model">Model</label><input id="model" type="text" maxlength="40" placeholder="Camry"></div>
    </div>
    <label class="f">Repairs performed</label>
    <div class="grid">${boxes}</div>
    <div class="flash err hidden" id="err" style="margin-top:1rem"></div>
    <button class="btn block" type="submit" id="go">Check requirements</button>
  </form>
</div>
<div id="result" class="hidden">
  <div class="card">
    <h1 id="veh"></h1>
    <h2>Calibrations &amp; checks required</h2><ul class="plain" id="systems"></ul>
    <h2>Why</h2><ul class="plain" id="why"></ul>
    <h2>Scans</h2>
    <div class="kv"><b>Pre-repair scan:</b> <span id="pre"></span></div>
    <div class="kv"><b>Post-repair scan:</b> <span id="post"></span></div>
    <div class="kv"><b>Scan tool:</b> <span id="tool"></span></div>
    <div class="kv"><b>Source:</b> <span id="src"></span></div>
    <div class="warn" id="notes"></div>
  </div>
  <div class="card">
    <h2 style="margin-top:0">Get notified when OEM requirements change for this vehicle</h2>
    <form id="lf" novalidate><div class="row2">
      <div><input type="email" id="lemail" placeholder="you@yourshop.com" maxlength="254" autocomplete="email"></div>
      <div><button class="btn" type="submit" id="lgo" style="width:100%">Notify me</button></div></div>
      <p class="fine" id="lmsg">We email occasional ADAS requirement updates. Unsubscribe anytime.</p></form>
  </div>
  <div class="card cta"><p>Knowing what's required is half of it. Being able to prove it was done is the other half. CollisionIQ documents every job with scans, calibration results and photos, and gives you a shareable report.</p>
    <a href="/register">Create your free account &rarr;</a></div>
</div>
<p class="fine">Informational only. Requirements are summarized from published OEM position statements and may change. Always confirm against the manufacturer's current service information before performing or signing off on repairs. This tool is not legal advice and does not certify compliance with any law or standard.</p>
<script>
(function(){
  var src=(new URLSearchParams(location.search).get('src')||'').slice(0,40);
  var f=document.getElementById('f'),err=document.getElementById('err'),go=document.getElementById('go'),last=null;
  function fill(id,arr){var ul=document.getElementById(id);ul.textContent='';arr.forEach(function(t){var li=document.createElement('li');li.textContent=t;ul.appendChild(li);});}
  function txt(id,v){document.getElementById(id).textContent=v||'—';}
  f.addEventListener('submit',function(e){
    e.preventDefault();err.classList.add('hidden');
    var repairs=[].slice.call(document.querySelectorAll('input[name=repairs]:checked')).map(function(x){return x.value;});
    var p={year:document.getElementById('year').value,make:document.getElementById('make').value,model:document.getElementById('model').value,repairs:repairs,src:src};
    go.disabled=true;go.textContent='Checking…';
    fetch('/api/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)})
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
    .then(function(o){
      if(!o.ok){err.textContent=o.j.error||'Something went wrong.';err.classList.remove('hidden');return;}
      var d=o.j;last=d;
      txt('veh',d.vehicle);fill('systems',d.systems);fill('why',d.rationale);
      txt('pre',d.preScan);txt('post',d.postScan);txt('tool',d.scanTool);txt('src',d.source);
      var n=document.getElementById('notes');n.textContent=[d.notes,d.liability].filter(Boolean).join(' ');
      n.style.display=n.textContent?'block':'none';
      var res=document.getElementById('result');res.classList.remove('hidden');res.scrollIntoView({behavior:'smooth'});
    })
    .catch(function(){err.textContent='Network error. Please try again.';err.classList.remove('hidden');})
    .then(function(){go.disabled=false;go.textContent='Check requirements';});
  });
  document.getElementById('lf').addEventListener('submit',function(e){
    e.preventDefault();var m=document.getElementById('lmsg'),b=document.getElementById('lgo');
    b.disabled=true;
    fetch('/api/lead',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('lemail').value,vehicle:last?last.vehicle:'',repairs:last?last.repairs:[],src:src})})
    .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
    .then(function(o){m.textContent=o.ok?'Thanks — you are on the list.':(o.j.error||'Could not save.');})
    .catch(function(){m.textContent='Network error. Please try again.';})
    .then(function(){b.disabled=false;});
  });
})();
</script>`,
  });
});

// ─── Auth ────────────────────────────────────────────────────────────────────
function authForm({ title, action, csrf, fields, cta, alt }) {
  return `<div class="card" style="max-width:480px;margin:1rem auto"><h1>${esc(title)}</h1>
  <form method="POST" action="${action}">${csrfField(csrf)}${fields}<button class="btn block" type="submit">${esc(cta)}</button></form>
  <p class="fine" style="text-align:center;margin-top:1rem">${alt}</p></div>`;
}

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/jobs');
  const t = csrfToken(req);
  render(req, res, {
    title: 'Create account', csrf: t,
    body: authForm({
      title: 'Create your free account', action: '/register', csrf: t, cta: 'Create account →',
      fields: `<label class="f">Shop name</label><input type="text" name="shop_name" required maxlength="80">
        <label class="f">Your name</label><input type="text" name="name" required maxlength="80">
        <label class="f">Email</label><input type="email" name="email" required maxlength="254" autocomplete="email">
        <div class="row2"><div><label class="f">City</label><input type="text" name="city" required maxlength="60"></div>
        <div><label class="f">State</label><input type="text" name="state" required maxlength="2" placeholder="TX"></div></div>
        <label class="f">Password (min 8 characters)</label><input type="password" name="password" required minlength="8" maxlength="200" autocomplete="new-password">`,
      alt: 'Already have an account? <a href="/login">Sign in</a>',
    }),
  });
});

app.post('/register', authLimiter, csrfCheck, async (req, res) => {
  const b = req.body || {};
  const shop_name = clip(b.shop_name, 80), name = clip(b.name, 80), email = clip(b.email, 254).toLowerCase();
  const city = clip(b.city, 60), state = clip(b.state, 2).toUpperCase(), password = String(b.password || '');
  const fail = msg => { req.session.flashErr = msg; res.redirect('/register'); };
  if (!shop_name || !name || !city || !state) return fail('All fields are required.');
  if (!isEmail(email)) return fail('Enter a valid email address.');
  if (password.length < 8 || password.length > 200) return fail('Password must be 8–200 characters.');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return fail('An account with that email already exists.');
  try {
    const pw = await hashPw(password);
    const shopId = db.prepare('INSERT INTO shops (name, city, state, created_at) VALUES (?, ?, ?, ?)').run(shop_name, city, state, nowIso()).lastInsertRowid;
    const userId = db.prepare('INSERT INTO users (shop_id, name, email, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(shopId, name, email, pw, nowIso()).lastInsertRowid;
    req.session.regenerate(err => {
      if (err) return fail('Could not start your session. Please sign in.');
      req.session.userId = Number(userId);
      req.session.flash = 'Account created. Create your first job to get started.';
      req.session.save(() => res.redirect('/jobs'));
    });
  } catch (e) { console.error('[register]', e.message); fail('Could not create the account. Please try again.'); }
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/jobs');
  const t = csrfToken(req);
  render(req, res, {
    title: 'Sign in', csrf: t,
    body: authForm({
      title: 'Sign in', action: '/login', csrf: t, cta: 'Sign in',
      fields: `<label class="f">Email</label><input type="email" name="email" required autocomplete="email">
        <label class="f">Password</label><input type="password" name="password" required autocomplete="current-password">`,
      alt: 'New here? <a href="/register">Create a free account</a>',
    }),
  });
});

app.post('/login', authLimiter, csrfCheck, async (req, res) => {
  const email = clip(req.body.email, 254).toLowerCase(), password = String(req.body.password || '').slice(0, 200);
  const u = db.prepare('SELECT id, pw_hash FROM users WHERE email = ?').get(email);
  const ok = u ? await checkPw(password, u.pw_hash) : (await checkPw(password, await DUMMY_HASH_PROMISE), false);
  if (!ok) { req.session.flashErr = 'Incorrect email or password.'; return res.redirect('/login'); }
  req.session.regenerate(err => {
    if (err) { req.session.flashErr = 'Could not sign in. Try again.'; return res.redirect('/login'); }
    req.session.userId = Number(u.id);
    req.session.save(() => res.redirect('/jobs'));
  });
});

app.post('/logout', csrfCheck, (req, res) => {
  req.session.destroy(() => { res.clearCookie('ciq.sid'); res.redirect('/'); });
});

// ─── Jobs ────────────────────────────────────────────────────────────────────
function getJob(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return null;
  return db.prepare('SELECT * FROM jobs WHERE id = ? AND shop_id = ?').get(id, req.user.shop_id) || null;
}

app.get('/jobs', requireAuth, (req, res) => {
  const jobs = db.prepare(`SELECT j.*, (SELECT COUNT(*) FROM photos p WHERE p.job_id = j.id) AS photo_count
    FROM jobs j WHERE j.shop_id = ? ORDER BY j.id DESC LIMIT 300`).all(req.user.shop_id);
  const rows = jobs.map(j => `<tr>
    <td><a href="/jobs/${j.id}"><b>${jobCode(j.id)}</b></a></td><td>${esc(j.ro) || '—'}</td>
    <td>${esc(j.year)} ${esc(j.make)} ${esc(j.model)}</td><td>${fmtDate(j.created_at)}</td>
    <td>${gapBadge(docGaps(j, j.photo_count))}</td></tr>`).join('');
  render(req, res, {
    title: 'Jobs',
    body: `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap">
      <div><h1>${esc(req.user.shop_name)}</h1><p class="sub">${jobs.length} job${jobs.length === 1 ? '' : 's'}</p></div>
      <a class="btn" href="/jobs/new">+ New job</a></div>
      ${jobs.length ? `<div class="tablewrap"><table><tr><th>Job</th><th>RO</th><th>Vehicle</th><th>Created</th><th>Documentation</th></tr>${rows}</table></div>`
        : '<p class="sub" style="margin-top:1rem">No jobs yet. Create your first one.</p>'}</div>`,
  });
});

app.get('/jobs/new', requireAuth, (req, res) => {
  const t = csrfToken(req);
  const makeOpts = MAKES.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  const boxes = REPAIRS.map(r => `<label class="chk"><input type="checkbox" name="repairs" value="${esc(r)}"> ${esc(r)}</label>`).join('');
  render(req, res, {
    title: 'New job', csrf: t,
    body: `<div class="card"><h1>New job</h1>
    <form method="POST" action="/jobs">${csrfField(t)}
      <div class="row2"><div><label class="f">RO number</label><input type="text" name="ro" maxlength="40"></div>
      <div><label class="f">VIN</label><input type="text" name="vin" maxlength="17" style="text-transform:uppercase"></div></div>
      <div class="row"><div><label class="f">Year *</label><input type="number" name="year" min="1990" max="2030" required></div>
      <div><label class="f">Make *</label><select name="make" required><option value="">Select</option>${makeOpts}</select></div>
      <div><label class="f">Model *</label><input type="text" name="model" maxlength="40" required></div></div>
      <div class="row2"><div><label class="f">Trim</label><input type="text" name="trim" maxlength="40"></div>
      <div><label class="f">Technician</label><input type="text" name="tech" maxlength="60"></div></div>
      <label class="f">Repairs performed *</label><div class="grid">${boxes}</div>
      <label class="f">Other repairs</label><input type="text" name="other" maxlength="200">
      <button class="btn block" type="submit">Create job &amp; see requirements</button>
    </form></div>`,
  });
});

app.post('/jobs', requireAuth, csrfCheck, (req, res) => {
  const b = req.body || {};
  const v = validVehicle(b);
  const repairs = cleanRepairs(b.repairs);
  const other = clip(b.other, 200);
  if (other) repairs.push(other);
  if (v.error || !repairs.length) {
    req.session.flashErr = v.error || 'Select at least one repair performed.';
    return res.redirect('/jobs/new');
  }
  let out;
  try { out = runADASEngine(v.make, v.model, String(v.year), repairs); }
  catch (e) { console.error('[job] engine:', e.message); req.session.flashErr = 'Could not evaluate requirements. Try again.'; return res.redirect('/jobs/new'); }
  const ts = nowIso();
  const id = db.prepare(`INSERT INTO jobs (shop_id, ro, vin, year, make, model, trim, tech, repairs,
      adas_systems, rationale, liability, make_notes, pre_req, post_req, scan_tool, source,
      share_token, created_by, updated_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.user.shop_id, clip(b.ro, 40), clip(b.vin, 17).toUpperCase(), String(v.year), v.make, v.model, clip(b.trim, 40), clip(b.tech, 60),
    repairs.join(', '), out.adasSystems || '', out.rationale || '', out.liabilityWarning || '', out.makeSpecificNotes || '',
    out.preScanRequired || '', out.postScanRequired || '', out.approvedScanTool || '', out.sourceCitation || '',
    crypto.randomBytes(16).toString('hex'), req.user.name, req.user.name, ts, ts).lastInsertRowid;
  res.redirect('/jobs/' + id);
});

function requirementsBlock(j) {
  return `<h2>Required by OEM guidance</h2><ul class="plain">${lines(j.adas_systems).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
  <h2>Why</h2><ul class="plain">${lines(j.rationale).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
  <div class="kv"><b>Pre-repair scan:</b> ${esc(j.pre_req)}</div>
  <div class="kv"><b>Post-repair scan:</b> ${esc(j.post_req)}</div>
  <div class="kv"><b>Scan tool:</b> ${esc(j.scan_tool)}</div>
  <div class="kv"><b>Source:</b> ${esc(j.source)}</div>
  ${(j.make_notes || j.liability) ? `<div class="warn">${esc([j.make_notes, j.liability].filter(Boolean).join(' '))}</div>` : ''}`;
}

app.get('/jobs/:id', requireAuth, (req, res) => {
  const j = getJob(req);
  if (!j) return errorPage(res, 404, 'Job not found.');
  const t = csrfToken(req);
  const photos = db.prepare('SELECT * FROM photos WHERE job_id = ? ORDER BY id').all(j.id);
  const gaps = docGaps(j, photos.length);
  const shareUrl = `${req.protocol}://${req.get('host')}/r/${j.share_token}`;
  const steps = docSteps(j, photos.length);
  const applicable = steps.filter(x => x.applicable);
  const doneCount = applicable.filter(x => x.done).length;
  const pct = applicable.length ? Math.round((doneCount / applicable.length) * 100) : 100;
  const iconDone = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1F7A4D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M8 12.5l2.7 2.7L16 9.5"></path></svg>';
  const iconMiss = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#9B1C1C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><path d="M12 16h.01"></path></svg>';
  const iconNa = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#8A8880" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M8 12h8"></path></svg>';
  const stepsCard = `<div class="head"><h1 style="margin:0">Documentation</h1><div class="sub" style="margin:0"><b style="font-size:1.3rem;color:var(--ink)">${doneCount}</b> of ${applicable.length} complete</div></div>
    <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    <div class="steps">${steps.map(x => `<div class="step">${!x.applicable ? iconNa : x.done ? iconDone : iconMiss}
      <div class="grow"><div class="t"><span>${esc(x.label)}</span><span class="badge ${!x.applicable ? 'b-yellow' : x.done ? 'b-green' : 'b-red'}">${!x.applicable ? 'Not required' : x.done ? 'Documented' : 'Missing'}</span></div>
      <div class="d">${esc(x.detail) || '—'}</div></div></div>`).join('')}</div>`;
  const chk = (n, v) => `<label class="chk"><input type="checkbox" name="${n}" value="1" ${v ? 'checked' : ''}> Documented</label>`;
  const tx = (n, v, ph, max) => `<input type="text" name="${n}" value="${esc(v)}" maxlength="${max || 200}" placeholder="${esc(ph || '')}">`;
  const dt = (n, v) => `<input type="date" name="${n}" value="${esc(v)}">`;
  const thumbs = photos.map(p => `<div class="thumb">
    ${p.mime === 'application/pdf' ? '<div class="pdf">PDF</div>' : `<img src="/photos/${p.id}" alt="${esc(p.label)}" loading="lazy">`}
    <div>${esc(p.label)}</div><a href="/photos/${p.id}" target="_blank" rel="noopener">Open</a>
    <form method="POST" action="/jobs/${j.id}/photos/${p.id}/delete" style="display:inline" onsubmit="return confirm('Remove this file?')">${csrfField(t)}<button class="btn sm danger" type="submit" style="margin-left:.4rem">Remove</button></form></div>`).join('');
  const labelOpts = PHOTO_LABELS.map(l => `<option>${esc(l)}</option>`).join('');
  render(req, res, {
    title: jobCode(j.id), csrf: t,
    body: `
<div class="card"><div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap">
  <div><h1>${jobCode(j.id)} · ${esc(j.year)} ${esc(j.make)} ${esc(j.model)}</h1>
  <p class="sub">RO ${esc(j.ro) || '—'} · VIN ${esc(j.vin) || '—'} · Tech ${esc(j.tech) || '—'}<br>Repairs: ${esc(j.repairs)}</p></div>
  <div class="noprint" style="display:flex;gap:.5rem;align-items:flex-start"><a class="btn sm" href="/jobs/${j.id}/report">Report</a><a class="btn sm ghost" href="/jobs">All jobs</a></div></div>
  ${gaps.length ? `<div class="gap"><b>Documentation gaps:</b><ul class="plain" style="margin-top:.3rem">${gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>` : '<p><span class="badge b-green">Fully documented</span></p>'}
</div>
<div class="card">${stepsCard}</div>
<div class="card">${requirementsBlock(j)}</div>
<div class="card"><h1>Document the work</h1>
<form method="POST" action="/jobs/${j.id}/record">${csrfField(t)}
  <h2>Pre-repair scan</h2>${chk('pre_done', j.pre_done)}
  <div class="row"><div>${dt('pre_date', j.pre_date)}</div><div>${tx('pre_tool', j.pre_tool, 'Scan tool', 80)}</div><div>${tx('pre_result', j.pre_result, 'Result / DTCs')}</div></div>
  <h2>Post-repair scan</h2>${chk('post_done', j.post_done)}
  <div class="row"><div>${dt('post_date', j.post_date)}</div><div>${tx('post_tool', j.post_tool, 'Scan tool', 80)}</div><div>${tx('post_result', j.post_result, 'Result / DTCs')}</div></div>
  <h2>Calibration</h2>${chk('cal_done', j.cal_done)}
  <div class="row"><div>${dt('cal_date', j.cal_date)}</div>
  <div><select name="cal_type"><option value="">Type</option>${['Static', 'Dynamic', 'Static + Dynamic'].map(o => `<option ${j.cal_type === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
  <div>${tx('cal_tool', j.cal_tool, 'Equipment / tool', 80)}</div></div>
  <div style="margin-top:.6rem">${tx('cal_result', j.cal_result, 'Result (e.g. passed, target distances, notes)')}</div>
  <h2>Notes</h2><textarea name="job_notes" maxlength="2000">${esc(j.job_notes)}</textarea>
  <button class="btn block" type="submit">Save documentation</button>
</form></div>
<div class="card"><h1>Photos &amp; scan reports</h1>
<form method="POST" action="/jobs/${j.id}/photos" enctype="multipart/form-data">${csrfField(t)}
  <div class="row2"><div><label class="f">Type</label><select name="label">${labelOpts}</select></div>
  <div><label class="f">Files (JPG, PNG, WebP, PDF · 10 MB each)</label><input type="file" name="photos" accept="image/jpeg,image/png,image/webp,application/pdf" multiple required></div></div>
  <button class="btn block" type="submit">Upload</button></form>
  ${photos.length ? `<div class="thumbs">${thumbs}</div>` : '<p class="sub" style="margin-top:.8rem">Nothing attached yet.</p>'}</div>
<div class="card"><h1>Share</h1><p class="sub">Anyone with this link can view a read-only report for this job. Regenerate the link to revoke access.</p>
  <input type="text" readonly value="${esc(shareUrl)}" onclick="this.select()">
  <form method="POST" action="/jobs/${j.id}/share-reset" style="margin-top:.6rem" onsubmit="return confirm('The old link will stop working. Continue?')">${csrfField(t)}<button class="btn sm ghost" type="submit">Regenerate link</button></form></div>`,
  });
});

app.post('/jobs/:id/record', requireAuth, csrfCheck, (req, res) => {
  const j = getJob(req);
  if (!j) return errorPage(res, 404, 'Job not found.');
  const b = req.body || {};
  const d = v => { const s = clip(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };
  const type = ['Static', 'Dynamic', 'Static + Dynamic'].includes(b.cal_type) ? b.cal_type : '';
  db.prepare(`UPDATE jobs SET
    pre_done=?, pre_date=?, pre_tool=?, pre_result=?,
    post_done=?, post_date=?, post_tool=?, post_result=?,
    cal_done=?, cal_date=?, cal_type=?, cal_tool=?, cal_result=?,
    job_notes=?, updated_by=?, updated_at=? WHERE id=? AND shop_id=?`).run(
    b.pre_done ? 1 : 0, d(b.pre_date), clip(b.pre_tool, 80), clip(b.pre_result, 200),
    b.post_done ? 1 : 0, d(b.post_date), clip(b.post_tool, 80), clip(b.post_result, 200),
    b.cal_done ? 1 : 0, d(b.cal_date), type, clip(b.cal_tool, 80), clip(b.cal_result, 200),
    clip(b.job_notes, 2000), req.user.name, nowIso(), j.id, req.user.shop_id);
  req.session.flash = 'Documentation saved.';
  res.redirect('/jobs/' + j.id);
});

// Photo upload (multer first, then CSRF check on the parsed body)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (MIME_EXT[file.mimetype] || '.bin')),
  }),
  fileFilter: (req, file, cb) => cb(null, Object.prototype.hasOwnProperty.call(MIME_EXT, file.mimetype)),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
});
function removeFiles(files) { (files || []).forEach(f => fs.unlink(f.path, () => {})); }

app.post('/jobs/:id/photos', requireAuth, (req, res, next) => {
  upload.array('photos', 10)(req, res, err => {
    if (err) {
      removeFiles(req.files);
      req.session.flashErr = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10 MB or smaller.' : 'Upload failed. Try again.';
      return res.redirect('/jobs/' + parseInt(req.params.id, 10));
    }
    next();
  });
}, (req, res, next) => {
  if (!csrfValid(req)) {
    removeFiles(req.files);
    return errorPage(res, 403, 'Your session expired. Go back, refresh the page, and try again.');
  }
  next();
}, (req, res) => {
  const j = getJob(req);
  if (!j) { removeFiles(req.files); return errorPage(res, 404, 'Job not found.'); }
  const files = req.files || [];
  if (!files.length) { req.session.flashErr = 'No valid files. Use JPG, PNG, WebP or PDF.'; return res.redirect('/jobs/' + j.id); }
  const label = PHOTO_LABELS.includes(req.body.label) ? req.body.label : 'Other';
  const ins = db.prepare('INSERT INTO photos (job_id, shop_id, label, file, orig_name, mime, created_at) VALUES (?,?,?,?,?,?,?)');
  files.forEach(f => ins.run(j.id, j.shop_id, label, f.filename, clip(f.originalname, 120), f.mimetype, nowIso()));
  db.prepare('UPDATE jobs SET updated_by=?, updated_at=? WHERE id=?').run(req.user.name, nowIso(), j.id);
  req.session.flash = `${files.length} file${files.length > 1 ? 's' : ''} uploaded.`;
  res.redirect('/jobs/' + j.id);
});

app.post('/jobs/:id/photos/:pid/delete', requireAuth, csrfCheck, (req, res) => {
  const j = getJob(req);
  if (!j) return errorPage(res, 404, 'Job not found.');
  const p = db.prepare('SELECT * FROM photos WHERE id = ? AND job_id = ?').get(parseInt(req.params.pid, 10), j.id);
  if (p) {
    db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
    fs.unlink(path.join(UPLOAD_DIR, path.basename(p.file)), () => {});
    req.session.flash = 'File removed.';
  }
  res.redirect('/jobs/' + j.id);
});

app.post('/jobs/:id/share-reset', requireAuth, csrfCheck, (req, res) => {
  const j = getJob(req);
  if (!j) return errorPage(res, 404, 'Job not found.');
  db.prepare('UPDATE jobs SET share_token = ? WHERE id = ?').run(crypto.randomBytes(16).toString('hex'), j.id);
  req.session.flash = 'Share link regenerated. The old link no longer works.';
  res.redirect('/jobs/' + j.id);
});

function sendPhoto(res, p) {
  if (!p) return errorPage(res, 404, 'File not found.');
  const full = path.join(UPLOAD_DIR, path.basename(p.file));
  if (!fs.existsSync(full)) return errorPage(res, 404, 'File not found.');
  res.set('Cache-Control', 'private, max-age=3600');
  res.type(p.mime);
  res.sendFile(full);
}
app.get('/photos/:pid', requireAuth, (req, res) => {
  sendPhoto(res, db.prepare('SELECT * FROM photos WHERE id = ? AND shop_id = ?').get(parseInt(req.params.pid, 10), req.user.shop_id));
});

// ─── Reports ─────────────────────────────────────────────────────────────────
function reportHtml(j, shopName, photos, photoBase) {
  const doc = (label, done, date, tool, result) => `<tr><td><b>${label}</b></td><td>${done ? '✔ Documented' : '— Not documented'}</td>
    <td>${esc(date)}</td><td>${esc(tool)}</td><td>${esc(result)}</td></tr>`;
  const thumbs = photos.map(p => `<div class="thumb">${p.mime === 'application/pdf'
    ? '<div class="pdf">PDF</div>' : `<img src="${photoBase}${p.id}" alt="${esc(p.label)}">`}
    <div>${esc(p.label)}</div><a href="${photoBase}${p.id}" target="_blank" rel="noopener">Open</a></div>`).join('');
  const gapsR = docGaps(j, photos.length);
  return `<div class="card">
  <div class="rpt-head"><div>
    <div class="rpt-brand"><span class="mark">CIQ</span><span>Collision<i style="font-style:normal;background:var(--yellow);padding:0 .15rem">IQ</i><small>${esc(OWNER_LINE)}</small></span></div>
    <h1 style="margin:0">ADAS Calibration<br>Documentation Record</h1>
    <p class="sub" style="margin:.4rem 0 0">${esc(shopName)}</p></div>
    <div style="text-align:right"><div class="mono" style="font-size:1.1rem;font-weight:500">${jobCode(j.id)}</div>
    <div class="sub" style="margin:.2rem 0 .4rem">Generated ${fmtDate(nowIso())}</div>
    ${gapsR.length ? `<span class="badge b-yellow">${gapsR.length} open item${gapsR.length > 1 ? 's' : ''}</span>` : '<span class="badge b-green">Fully documented</span>'}</div></div>
  <div class="kv"><b>Vehicle:</b> ${esc(j.year)} ${esc(j.make)} ${esc(j.model)} ${esc(j.trim)}</div>
  <div class="kv"><b>VIN:</b> ${esc(j.vin) || '—'} &nbsp; <b>RO:</b> ${esc(j.ro) || '—'} &nbsp; <b>Technician:</b> ${esc(j.tech) || '—'}</div>
  <div class="kv"><b>Repairs performed:</b> ${esc(j.repairs)}</div>
  ${requirementsBlock(j)}
  <h2>Documented work</h2>
  <div class="tablewrap"><table><tr><th>Step</th><th>Status</th><th>Date</th><th>Tool</th><th>Result</th></tr>
  ${doc('Pre-repair scan', j.pre_done, j.pre_date, j.pre_tool, j.pre_result)}
  ${doc('Post-repair scan', j.post_done, j.post_date, j.post_tool, j.post_result)}
  ${doc('Calibration' + (j.cal_type ? ' (' + esc(j.cal_type) + ')' : ''), j.cal_done, j.cal_date, j.cal_tool, j.cal_result)}
  </table></div>
  ${j.job_notes ? `<h2>Notes</h2><p style="font-size:.92rem;white-space:pre-wrap">${esc(j.job_notes)}</p>` : ''}
  ${photos.length ? `<h2>Attachments</h2><div class="thumbs">${thumbs}</div>` : ''}
  <p class="fine">Last updated ${fmtDate(j.updated_at)}${j.updated_by ? ' by ' + esc(j.updated_by) : ''}. Requirements are summarized from published OEM position statements and may change; confirm against current manufacturer service information. This record documents what the shop reported and does not certify compliance with any law or standard.</p>
  <p class="fine" style="border-top:1px solid var(--line);padding-top:.7rem"><b>${esc(LEGAL)}</b> · Owned by <b>${esc(OWNER)}</b> · Generated by ${BRAND}. © ${new Date().getFullYear()} ${esc(LEGAL)}. All rights reserved.</p>
  </div>`;
}

app.get('/jobs/:id/report', requireAuth, (req, res) => {
  const j = getJob(req);
  if (!j) return errorPage(res, 404, 'Job not found.');
  const photos = db.prepare('SELECT * FROM photos WHERE job_id = ? ORDER BY id').all(j.id);
  render(req, res, {
    title: jobCode(j.id) + ' Report',
    body: `<div class="noprint" style="margin-bottom:.8rem"><button class="btn sm" onclick="window.print()">Print / Save as PDF</button> <a class="btn sm ghost" href="/jobs/${j.id}">Back to job</a></div>` + reportHtml(j, req.user.shop_name, photos, '/photos/'),
  });
});

app.get('/r/:token', publicLimiter, (req, res) => {
  const token = String(req.params.token || '');
  const j = /^[a-f0-9]{32}$/.test(token) ? db.prepare('SELECT * FROM jobs WHERE share_token = ?').get(token) : null;
  if (!j) return errorPage(res, 404, 'This report link is not valid.');
  const shop = db.prepare('SELECT name FROM shops WHERE id = ?').get(j.shop_id);
  const photos = db.prepare('SELECT * FROM photos WHERE job_id = ? ORDER BY id').all(j.id);
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.send(layout({
    title: jobCode(j.id) + ' Report', noindex: true,
    body: '<div class="noprint" style="margin-bottom:.8rem"><button class="btn sm" onclick="window.print()">Print / Save as PDF</button></div>' + reportHtml(j, shop ? shop.name : '', photos, `/r/${token}/photo/`),
  }));
});
app.get('/r/:token/photo/:pid', publicLimiter, (req, res) => {
  const token = String(req.params.token || '');
  const p = /^[a-f0-9]{32}$/.test(token)
    ? db.prepare('SELECT p.* FROM photos p JOIN jobs j ON j.id = p.job_id WHERE j.share_token = ? AND p.id = ?').get(token, parseInt(req.params.pid, 10))
    : null;
  sendPhoto(res, p);
});

// ─── Admin ───────────────────────────────────────────────────────────────────
app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const c = sql => db.prepare(sql).get().n;
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const leads = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 200').all();
  const bySrc = db.prepare("SELECT COALESCE(source,'(none)') AS s, COUNT(*) AS n FROM lookups GROUP BY s ORDER BY n DESC LIMIT 15").all();
  render(req, res, {
    title: 'Admin',
    body: `<div class="card"><h1>Admin</h1>
    <div class="kv"><b>Shops:</b> ${c('SELECT COUNT(*) n FROM shops')} · <b>Jobs:</b> ${c('SELECT COUNT(*) n FROM jobs')} · <b>Leads:</b> ${c('SELECT COUNT(*) n FROM leads')}</div>
    <div class="kv"><b>Free lookups:</b> ${c('SELECT COUNT(*) n FROM lookups')} total · ${db.prepare('SELECT COUNT(*) n FROM lookups WHERE created_at > ?').get(since).n} in last 7 days</div>
    <h2>Lookups by source (?src=)</h2><ul class="plain">${bySrc.map(r => `<li>${esc(r.s)}: ${r.n}</li>`).join('') || '<li>None yet</li>'}</ul></div>
    <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h1>Leads</h1><a class="btn sm" href="/admin/leads.csv">Download CSV</a></div>
    <div class="tablewrap"><table><tr><th>Email</th><th>Vehicle</th><th>Repairs</th><th>Source</th><th>Date</th></tr>
    ${leads.map(l => `<tr><td>${esc(l.email)}</td><td>${esc(l.vehicle)}</td><td>${esc(l.repairs)}</td><td>${esc(l.source)}</td><td>${fmtDate(l.created_at)}</td></tr>`).join('')}</table></div></div>`,
  });
});
app.get('/admin/leads.csv', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY id DESC').all();
  const csv = ['email,vehicle,repairs,source,created_at']
    .concat(rows.map(r => [r.email, r.vehicle, r.repairs, r.source, r.created_at].map(csvCell).join(','))).join('\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"' }).send(csv);
});

// ─── Terms ───────────────────────────────────────────────────────────────────
app.get('/terms', (req, res) => {
  render(req, res, {
    title: 'Terms & Disclaimer',
    body: `<div class="card"><h1>Terms &amp; Disclaimer</h1>
    <p class="sub">${esc(BRAND)} is a product of <b>${esc(LEGAL)}</b>, owned by <b>${esc(OWNER)}</b>. Draft terms — have counsel review before relying on them.</p>
    <h2>Informational use</h2><p style="font-size:.92rem">CollisionIQ summarizes publicly available OEM position statements and repair guidance to help shops identify calibration and scan requirements. Requirements change. Always confirm against the vehicle manufacturer's current service information before performing or signing off on any repair. CollisionIQ does not replace OEM repair procedures.</p>
    <h2>No compliance certification</h2><p style="font-size:.92rem">Records created in CollisionIQ reflect information entered by the shop. CollisionIQ does not verify that work was performed and does not certify compliance with any law, regulation, standard or insurer requirement. Nothing here is legal advice.</p>
    <h2>Your data</h2><p style="font-size:.92rem">Shop records and uploaded files are visible only to the shop's users and to anyone the shop shares a report link with. Regenerating a link revokes the old one. Email addresses submitted through the free check are used to send ADAS requirement updates; ask us to remove yours at any time.</p>
    <h2>Availability</h2><p style="font-size:.92rem">The service is provided as is, without warranty. Keep your own copies of records you are required to retain.</p></div>`,
  });
});

// ─── 404 / errors ────────────────────────────────────────────────────────────
app.use((req, res) => errorPage(res, 404, 'Page not found.'));
app.use((err, req, res, next) => {
  console.error('[error]', err && err.stack || err);
  if (res.headersSent) return next(err);
  errorPage(res, 500, 'Something went wrong. Please try again.');
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`CollisionIQ running on port ${PORT}`));
}
module.exports = app;
