process.env.TZ = 'Asia/Taipei';
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { db, migrate } = require('./db');
const S = require('./security');
const A = require('./access');
const { entities, ROLES, APPROVED_STATES, OWNER_FIELD } = require('./schema');
const { dashboard } = require('./metrics');
const sync = require('./sync');

const app = express();
const PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
app.disable('x-powered-by');
app.set('trust proxy', 1);
// Vercel 單一請求上限約 4.5MB，附件限制 3MB（base64 後約 4MB）
app.use(express.json({ limit: '4.4mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
  next();
});
// 自架時由 Express 提供前端；Vercel 上 public/ 由 CDN 提供
app.use(express.static(path.join(__dirname, '..', 'public')));

// 連線診斷：直接測試資料庫連線，回傳 Turso 的原始回應（不含任何密碼或 Token 內容）
app.get('/api/health', async (req, res) => {
  const raw = (process.env.TURSO_DATABASE_URL || '').trim();
  const token = (process.env.TURSO_AUTH_TOKEN || '').trim();
  const out = {
    env: {
      APP_SECRET: !!process.env.APP_SECRET, CRON_SECRET: !!process.env.CRON_SECRET, ADMIN_EMAIL: !!process.env.ADMIN_EMAIL,
      ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD, TURSO_DATABASE_URL: !!raw, TURSO_AUTH_TOKEN_length: token.length,
    },
  };
  try {
    const u = new URL(raw.replace(/^libsql:\/\//, 'https://'));
    out.db_host = u.host;
    out.url_ok = /\.turso\.io$/.test(u.host) && (u.pathname === '/' || u.pathname === '');
    const r = await fetch(`https://${u.host}/v2/pipeline`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }, { type: 'close' }] }),
      signal: AbortSignal.timeout(10000),
    });
    out.turso_status = r.status;
    out.turso_response = (await r.text()).slice(0, 500);
  } catch (e) { out.error = String(e.message || e).slice(0, 300); }
  res.set('Cache-Control', 'no-store').json(out);
});

// 冷啟動時建表／補欄位，並建立第一個管理員（只做一次）
let ready;
async function init() {
  await migrate();
  if (!(await db.get('SELECT COUNT(*) n FROM users')).n) {
    const email = (process.env.ADMIN_EMAIL || 'admin@neartohealth.local').toLowerCase();
    const pw = process.env.ADMIN_PASSWORD || S.tempPassword() + '7a';
    await db.run("INSERT OR IGNORE INTO users(email,name,role,pass_hash,must_change) VALUES(?,?,'admin',?,1)", email, process.env.ADMIN_NAME || '管理員', S.hashPassword(pw));
    console.log(`\n已建立管理員帳號：${email}\n${process.env.ADMIN_PASSWORD ? '密碼：使用 ADMIN_PASSWORD' : '臨時密碼：' + pw}\n（首次登入須更改密碼）\n`);
  }
}
app.use(async (req, res, next) => { try { await (ready ||= init().catch(e => { ready = null; throw e; })); next(); } catch (e) { next(e); } });

const now = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
const audit = (req, action, entity = null, id = null, detail = null) =>
  db.run('INSERT INTO audit_logs(user_id,action,entity,entity_id,detail,ip,created_at) VALUES(?,?,?,?,?,?,?)',
    req.user?.id ?? null, action, entity, id, detail ? JSON.stringify(detail) : null, req.ip, now());
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const getRow = (entity, id) => db.get(`SELECT * FROM ${entity} WHERE id=?`, id);
const getSetting = async (k, d) => (await db.get('SELECT value FROM settings WHERE key=?', k))?.value ?? d;
const putSetting = (k, v) => db.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));

// ── Vercel Cron（每日同步），用 CRON_SECRET 驗證 ─────────
app.get('/api/cron/sync', h(async (req, res) => {
  if (!process.env.CRON_SECRET || req.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return fail(res, 401, 'unauthorized');
  res.json(await sync.runSync('schedule'));
}));

// ── 登入 ─────────────────────────────────────────
const COOKIE = 'nth_sid';
app.post('/api/login', h(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = req.ip + '|' + email;
  const a = (await db.get('SELECT * FROM login_attempts WHERE key=?', key)) || { n: 0, until: 0 };
  if (a.until > Date.now()) return fail(res, 429, '嘗試次數過多，請 15 分鐘後再試');
  const u = await db.get('SELECT * FROM users WHERE email=?', email);
  if (!u || !u.active || !S.verifyPassword(String(req.body.password || ''), u.pass_hash)) {
    const n = a.n + 1;
    await db.run('INSERT INTO login_attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET n=excluded.n, until=excluded.until', key, n >= 5 ? 0 : n, n >= 5 ? Date.now() + 15 * 60e3 : 0);
    await db.run('INSERT INTO audit_logs(user_id,action,detail,ip,created_at) VALUES(?,?,?,?,?)', u?.id ?? null, 'login_fail', JSON.stringify({ email }), req.ip, now());
    return fail(res, 401, '帳號或密碼錯誤');
  }
  await db.run('DELETE FROM login_attempts WHERE key=?', key);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  const t = S.newToken();
  await db.run('INSERT INTO sessions VALUES(?,?,?)', S.tokenHash(t), u.id, Date.now() + 12 * 3600e3);
  res.cookie(COOKIE, t, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 12 * 3600e3 });
  req.user = u; await audit(req, 'login');
  res.json({ ok: true, must_change: !!u.must_change });
}));

async function auth(req, res, next) {
  const t = req.cookies[COOKIE];
  if (!t) return fail(res, 401, '請先登入');
  const s = await db.get('SELECT * FROM sessions WHERE token_hash=?', S.tokenHash(t));
  if (!s || s.expires_at < Date.now()) return fail(res, 401, '登入已逾時');
  const u = await db.get('SELECT id,email,name,role,must_change,active FROM users WHERE id=?', s.user_id);
  if (!u || !u.active) { await db.run('DELETE FROM sessions WHERE user_id=?', s.user_id); return fail(res, 401, '帳號已停用'); }
  // 防 CSRF：寫入請求需帶自訂標頭
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'nth') return fail(res, 403, '請求來源不正確');
  req.user = u;
  if (u.must_change && !['/api/me', '/api/change-password', '/api/logout'].includes(req.originalUrl.split('?')[0])) return fail(res, 428, '首次登入請先更改密碼');
  req.ctx = await A.loadCtx(u);
  next();
}
app.use('/api', h(auth));
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : fail(res, 403, '僅管理員可操作'));

app.post('/api/logout', h(async (req, res) => {
  await db.run('DELETE FROM sessions WHERE token_hash=?', S.tokenHash(req.cookies[COOKIE]));
  res.clearCookie(COOKIE); res.json({ ok: true });
}));
app.get('/api/me', (req, res) => res.json({ ...req.user, role_label: ROLES[req.user.role], scope: req.ctx.scope, on_vercel: !!process.env.VERCEL }));
app.post('/api/change-password', h(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id=?', req.user.id);
  if (!S.verifyPassword(String(req.body.old || ''), u.pass_hash)) return fail(res, 400, '原密碼錯誤');
  const p = S.passwordProblem(req.body.new); if (p) return fail(res, 400, p);
  if (req.body.new === req.body.old) return fail(res, 400, '新密碼不可與原密碼相同');
  await db.run('UPDATE users SET pass_hash=?, must_change=0 WHERE id=?', S.hashPassword(req.body.new), u.id);
  await db.run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', u.id, S.tokenHash(req.cookies[COOKIE]));
  await audit(req, 'change_password'); res.json({ ok: true });
}));
app.get('/api/schema', (req, res) => res.json({ entities: A.schemaFor(req.user), roles: ROLES }));
app.get('/api/user-options', h(async (req, res) => res.json(await db.all('SELECT id,name,role FROM users WHERE active=1 ORDER BY name'))));

// ── 帳號管理（管理員）───────────────────────────
app.get('/api/users', adminOnly, h(async (req, res) => {
  const rows = await db.all('SELECT id,email,name,role,must_change,active,created_at FROM users ORDER BY id');
  const sc = await db.all('SELECT * FROM user_projects');
  res.json(rows.map(u => ({ ...u, scope: sc.filter(s => s.user_id === u.id).map(s => s.project_id) })));
}));
const setScope = (uid, scope) => db.batch([['DELETE FROM user_projects WHERE user_id=?', uid], ...(scope || []).map(p => ['INSERT OR IGNORE INTO user_projects VALUES(?,?)', uid, Number(p)])]);
app.post('/api/users', adminOnly, h(async (req, res) => {
  const { email, name, role, scope } = req.body;
  if (!email || !name || !ROLES[role]) return fail(res, 400, '請填寫 Email、姓名與角色');
  const temp = S.tempPassword() + '7a';
  try {
    const r = await db.run('INSERT INTO users(email,name,role,pass_hash,must_change) VALUES(?,?,?,?,1)', email.trim().toLowerCase(), name, role, S.hashPassword(temp));
    await setScope(r.lastInsertRowid, scope);
    await audit(req, 'user_create', 'users', r.lastInsertRowid, { email, role, scope });
    res.json({ id: r.lastInsertRowid, temp_password: temp });
  } catch (e) { if (String(e.message).includes('UNIQUE')) return fail(res, 409, '此 Email 已存在'); throw e; }
}));
app.put('/api/users/:id', adminOnly, h(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id=?', req.params.id);
  if (!u) return fail(res, 404, '找不到帳號');
  const { name, role, active, scope } = req.body;
  if (u.id === req.user.id && (active === false || (role && role !== 'admin'))) return fail(res, 400, '不能停用或降級自己');
  await db.run('UPDATE users SET name=?, role=?, active=? WHERE id=?', name ?? u.name, ROLES[role] ? role : u.role, active === undefined ? u.active : active ? 1 : 0, u.id);
  if (scope) await setScope(u.id, scope);
  // 停用或改權限 → 立即撤銷既有登入
  if (active === false || (role && role !== u.role) || scope) await db.run('DELETE FROM sessions WHERE user_id=?', u.id);
  await audit(req, active === false ? 'user_disable' : 'user_update', 'users', u.id, { role, active, scope });
  res.json({ ok: true });
}));
app.post('/api/users/:id/reset', adminOnly, h(async (req, res) => {
  const temp = S.tempPassword() + '7a';
  await db.run('UPDATE users SET pass_hash=?, must_change=1 WHERE id=?', S.hashPassword(temp), req.params.id);
  await db.run('DELETE FROM sessions WHERE user_id=?', req.params.id);
  await audit(req, 'user_reset_password', 'users', Number(req.params.id));
  res.json({ temp_password: temp });
}));
app.get('/api/audit', adminOnly, h(async (req, res) => {
  res.json(await db.all('SELECT a.*, u.name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 500'));
}));

// ── 業務規則 ─────────────────────────────────────
async function rightProblem(rightId, purpose) {
  if (!rightId) return null;
  const r = await getRow('rights', rightId);
  if (!r) return '找不到素材授權';
  const today = now().slice(0, 10);
  if (!r.confirmed) return '素材用途尚未確認，不可選用';
  if (r.end_date && r.end_date < today) return '素材授權已到期，不可選用';
  if (r.start_date && r.start_date > today) return '素材授權尚未生效';
  if (purpose === 'ads' && !r.r_ads && !r.r_creator_ads) return '此素材未取得廣告投放權利';
  if (purpose === 'web' && !r.r_web_line) return '此素材未取得官網／LINE OA 使用權利';
  if (purpose === 'social' && !r.r_repost && !r.r_edit) return '此素材未取得轉發或剪輯權利';
  return null;
}
function rightStatus(r) {
  const today = now().slice(0, 10);
  if (!r.confirmed) return '用途未確認';
  if (r.end_date && r.end_date < today) return '已到期';
  if (r.start_date && r.start_date > today) return '未生效';
  return '有效';
}
async function validate(entity, data, existing) {
  const merged = { ...existing, ...data };
  for (const f of entities[entity].fields) {
    const v = data[f.key];
    if (f.required && (merged[f.key] === undefined || merged[f.key] === null || merged[f.key] === '')) return `「${f.label}」為必填`;
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'select' && !f.options.includes(v)) return `「${f.label}」選項不正確`;
    if (['number', 'money'].includes(f.type) && isNaN(Number(v))) return `「${f.label}」須為數字`;
    if (f.type === 'url' && !/^https?:\/\//i.test(v)) return `「${f.label}」須為 http(s) 網址`;
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return `「${f.label}」日期格式為 YYYY-MM-DD`;
  }
  if (entity === 'contents' && merged.right_id) return rightProblem(merged.right_id, ['LINE OA', 'SHOPLINE Blog'].includes(merged.channel) ? 'web' : 'social');
  if (entity === 'ads' && merged.right_id) return rightProblem(merged.right_id, 'ads');
  if (entity === 'partners' && data.status === '已結案' && existing) {
    const ds = await db.all('SELECT * FROM deliverables WHERE partner_id=?', existing.id);
    if (!ds.length) return '尚無交付項目，不能結案';
    if (ds.some(d => !d.accepted)) return '仍有交付項目未驗收';
    if (!merged.ugc_only && ds.some(d => !d.live_at)) return '非 UGC 原檔案件需所有交付都已上線才能結案';
  }
  return null;
}
function coerce(entity, data) {
  const out = {};
  for (const f of entities[entity].fields) {
    if (!(f.key in data)) continue;
    let v = data[f.key];
    if (v === '' || v === undefined) v = null;
    else if (['number', 'money', 'user', 'project', 'ref'].includes(f.type)) v = v === null ? null : Number(v);
    else if (f.type === 'bool') v = v ? 1 : 0;
    else v = String(v);
    out[f.key] = v;
  }
  return out;
}
function decorate(user, entity, row, ctx) {
  const r = A.sanitize(user, entity, row, ctx);
  if (entity === 'rights') r._status = rightStatus(row);
  if (entity === 'ads') {
    r._ctr = row.impressions ? (row.link_clicks ?? 0) / row.impressions : null;
    if (A.seesFinance(user)) r._cpc = row.spend != null && row.link_clicks ? row.spend / row.link_clicks : null;
  }
  r._can_edit = A.canEditRow(user, entity, row, ctx);
  return r;
}
function checkEntity(req, res, next) {
  if (!entities[req.params.entity]) return fail(res, 404, '找不到資料類型');
  if (!A.can(req.user, req.params.entity, 'r')) return fail(res, 403, '沒有權限');
  next();
}

// ── 內容流程 ────────────────────────────────────
const TRANSITIONS = {
  assign:   { from: ['draft'], to: 'assigned', admin: true },
  submit:   { from: ['draft', 'assigned', 'revise'], to: 'review' },
  approve:  { from: ['review'], to: 'approved', admin: true },
  reject:   { from: ['review'], to: 'revise', admin: true, note: true },
  schedule: { from: ['approved'], to: 'scheduled' },
  publish:  { from: ['approved', 'scheduled'], to: 'published' },
  report:   { from: ['published'], to: 'reported' },
};
app.post('/api/contents/:id/action', h(async (req, res) => {
  const row = await getRow('contents', req.params.id);
  if (!row || !A.canSeeRow(req.user, 'contents', row, req.ctx)) return fail(res, 404, '找不到內容');
  const t = TRANSITIONS[req.body.action];
  if (!t) return fail(res, 400, '未知動作');
  if (t.admin ? req.user.role !== 'admin' : !A.canEditRow(req.user, 'contents', row, req.ctx)) return fail(res, 403, '沒有權限執行此動作');
  if (!t.from.includes(row.status)) return fail(res, 409, '目前狀態不能執行此動作');
  if (t.note && !req.body.note) return fail(res, 400, '退修請填寫原因');
  if (req.body.action === 'assign' && !row.assignee_id) return fail(res, 400, '請先指定負責人');
  if (req.body.action === 'schedule' && !row.planned_at) return fail(res, 400, '請先填寫預計上線時間');
  const extra = {};
  if (req.body.action === 'publish' && !row.published_at) extra.published_at = now().slice(0, 16).replace(' ', 'T');
  if (req.body.action === 'report' && !row.metric_status) extra.metric_status = '已回填';
  const sets = Object.keys(extra).map(k => `${k}=?`);
  await db.run(`UPDATE contents SET status=?, updated_at=? ${sets.length ? ',' + sets.join(',') : ''} WHERE id=?`, t.to, now(), ...Object.values(extra), row.id);
  if (req.body.note) await db.run('INSERT INTO comments(entity,entity_id,user_id,body,created_at) VALUES(?,?,?,?,?)', 'contents', row.id, req.user.id, `【${req.body.action === 'reject' ? '退修' : '備註'}】${req.body.note}`, now());
  await audit(req, `content_${req.body.action}`, 'contents', row.id, { from: row.status, to: t.to });
  res.json({ ok: true, status: t.to });
}));

// ── 首頁 / 行事曆 / 儀表板 ─────────────────────
app.get('/api/home', h(async (req, res) => {
  const u = req.user, today = now().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const [c, assets, outs, dels] = await Promise.all(['contents', 'assets', 'outcomes', 'deliverables'].map(e => A.visible(u, e, req.ctx)));
  const pick = (r, e) => ({ id: r.id, entity: e, title: r.title || r.brief || r.ref_no, channel: r.channel, status: r.status, date: r.planned_at || r.due_date || r.asset_due || r.occurred_on });
  res.json({
    mine: [
      ...c.filter(r => r.assignee_id === u.id && ['draft', 'assigned', 'revise'].includes(r.status)).map(r => pick(r, 'contents')),
      ...outs.filter(r => r.assignee_id === u.id && !r.filled).map(r => ({ ...pick(r, 'outcomes'), title: `回填 ${r.outcome_type}｜${r.ref_no}` })),
      ...assets.filter(r => r.owner_id === u.id && r.status !== '已定稿').map(r => pick(r, 'assets')),
    ],
    review: c.filter(r => r.status === 'review').map(r => pick(r, 'contents')),
    due: [
      ...c.filter(r => r.asset_due && r.asset_due >= today && r.asset_due <= in7 && !APPROVED_STATES.includes(r.status)).map(r => ({ ...pick(r, 'contents'), date: r.asset_due, kind: '素材交期' })),
      ...c.filter(r => r.review_date && r.review_date >= today && r.review_date <= in7 && !APPROVED_STATES.includes(r.status)).map(r => ({ ...pick(r, 'contents'), date: r.review_date, kind: '核稿日' })),
      ...assets.filter(r => r.due_date && r.due_date >= today && r.due_date <= in7 && r.status !== '已定稿').map(r => ({ ...pick(r, 'assets'), kind: '素材交件' })),
      ...dels.filter(r => r.due_date && r.due_date >= today && r.due_date <= in7 && !r.accepted).map(r => ({ id: r.partner_id, entity: 'partners', title: r.title, date: r.due_date, kind: '合作交付' })),
    ].sort((a, b) => a.date.localeCompare(b.date)),
    upcoming: c.filter(r => r.planned_at && r.planned_at.slice(0, 10) >= today && r.planned_at.slice(0, 10) <= in7).map(r => pick(r, 'contents')).sort((a, b) => a.date.localeCompare(b.date)),
  });
}));
app.get('/api/calendar', h(async (req, res) => {
  const { from, to, channel, status, assignee_id, scope, audience, tag, topic } = req.query;
  const rows = (await A.visible(req.user, 'contents', req.ctx)).filter(r => {
    const d = String(r.planned_at || r.published_at || '').slice(0, 10);
    return d && (!from || d >= from) && (!to || d <= to) && (!channel || r.channel === channel) && (!status || r.status === status)
      && (!assignee_id || String(r.assignee_id) === assignee_id) && (!audience || String(r.audience || '').includes(audience))
      && (!tag || String(r.tags || '').includes(tag)) && (!topic || String(r.title + (r.topic_group || '')).includes(topic))
      && (scope === 'daily' ? r.project_id == null : scope === 'project' ? r.project_id != null : true);
  });
  res.json(rows.map(r => ({ id: r.id, title: r.title, channel: r.channel, status: r.status, date: (r.planned_at || r.published_at).slice(0, 10), time: String(r.planned_at || '').slice(11, 16), project_id: r.project_id, assignee_id: r.assignee_id })));
}));
app.get('/api/dashboard', h(async (req, res) => res.json(await dashboard(req.user, req.query, req.ctx))));
app.get('/api/projects/:id/summary', h(async (req, res) => {
  const p = await getRow('projects', req.params.id);
  if (!p || !A.canSeeRow(req.user, 'projects', p, req.ctx)) return fail(res, 404, '找不到專案');
  const d = await dashboard(req.user, { project_id: p.id }, req.ctx);
  const counts = {};
  for (const e of ['contents', 'ads', 'partners', 'outcomes', 'milestones'])
    counts[e] = A.can(req.user, e, 'r') ? (await A.visible(req.user, e, req.ctx)).filter(r => A.projectOf(e, r, req.ctx) === p.id).length : null;
  res.json({ project: A.sanitize(req.user, 'projects', p, req.ctx), counts, dashboard: d });
}));

// ── 匯入（CSV 預覽 → 錯誤列 → 去重寫入）─────────
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
const IMPORT_KEYS = { outcomes: ['ref_no'], ads: ['ext_id', 'name+level'], contents: ['id', 'title+channel'], partners: ['name'], faqs: ['question'] };
function findExisting(entity, rec, all) {
  for (const k of IMPORT_KEYS[entity]) {
    const parts = k.split('+');
    if (parts.some(p => rec[p] == null || rec[p] === '')) continue;
    const r = all.find(x => parts.every(p => String(x[p] ?? '') === String(rec[p])));
    if (r) return r;
  }
  return null;
}
async function importPlan(req) {
  const { entity, csv } = req.body;
  if (!IMPORT_KEYS[entity]) throw Object.assign(new Error('此資料類型不支援匯入'), { code: 400 });
  const def = entities[entity];
  const rows = parseCsv(csv);
  if (rows.length < 2) throw Object.assign(new Error('CSV 至少需要標題列與一筆資料'), { code: 400 });
  const header = rows[0].map(x => x.trim());
  const [users, projects, all] = await Promise.all([db.all('SELECT id,name,email FROM users'), db.all('SELECT id,name FROM projects'), db.all(`SELECT * FROM ${entity}`)]);
  const map = header.map(x => (x === 'id' ? { key: 'id' } : def.fields.find(f => f.key === x || f.label === x)));
  const seen = new Set();
  const items = [];
  for (const [i, cells] of rows.slice(1).entries()) {
    const rec = {}; const errors = [];
    map.forEach((f, j) => {
      if (!f) return; let v = (cells[j] ?? '').trim(); if (v === '') return;
      if (f.type === 'user') { const u = users.find(u => u.name === v || u.email === v || String(u.id) === v); if (!u) errors.push(`找不到使用者「${v}」`); else v = u.id; }
      if (f.type === 'project') { const p = projects.find(p => p.name === v || String(p.id) === v); if (!p) errors.push(`找不到專案「${v}」`); else v = p.id; }
      if (f.type === 'bool') v = ['1', 'true', '是', 'y', 'yes', 'v'].includes(String(v).toLowerCase());
      if (['number', 'money'].includes(f.type)) v = v.replace(/[,$\s]/g, '');
      if (f.type === 'date' && /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(v)) v = v.split('/').map((x, k) => (k ? x.padStart(2, '0') : x)).join('-');
      rec[f.key] = v;
    });
    const existing = findExisting(entity, rec, all);
    const data = coerce(entity, rec);
    const err = await validate(entity, data, existing || undefined); if (err) errors.push(err);
    const dk = IMPORT_KEYS[entity].map(k => k.split('+').map(p => rec[p]).join('|')).join('#');
    if (seen.has(dk)) errors.push('與本檔前面列重複'); seen.add(dk);
    items.push({ line: i + 2, data, existing_id: existing?.id ?? null, action: errors.length ? 'error' : existing ? 'update' : 'create', errors });
  }
  return { header, unknown: header.filter((x, i) => !map[i]), items };
}
app.post('/api/import/preview', adminOnly, h(async (req, res) => {
  try { const p = await importPlan(req); res.json({ header: p.header, unknown: p.unknown, items: p.items.slice(0, 1000) }); }
  catch (e) { if (e.code) return fail(res, e.code, e.message); throw e; }
}));
app.post('/api/import/commit', adminOnly, h(async (req, res) => {
  let p; try { p = await importPlan(req); } catch (e) { if (e.code) return fail(res, e.code, e.message); throw e; }
  const entity = req.body.entity; let created = 0, updated = 0; const stmts = [];
  for (const it of p.items) {
    if (it.action === 'error') continue;
    const keys = Object.keys(it.data).filter(k => k !== 'id');
    if (it.existing_id) { stmts.push([`UPDATE ${entity} SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=? WHERE id=?`, ...keys.map(k => it.data[k]), now(), it.existing_id]); updated++; }
    else {
      const cols = [...keys, 'created_by', ...(entity === 'contents' ? ['status'] : [])];
      stmts.push([`INSERT INTO ${entity}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...keys.map(k => it.data[k]), req.user.id, ...(entity === 'contents' ? ['draft'] : [])]); created++;
    }
  }
  if (stmts.length) await db.batch(stmts); // 單一交易，全部成功或全部不寫
  await audit(req, 'import', entity, null, { created, updated, errors: p.items.filter(i => i.action === 'error').length });
  res.json({ created, updated, errors: p.items.filter(i => i.action === 'error') });
}));

// ── 匯出（同樣經過欄位遮蔽）────────────────────
app.get('/api/export/:entity', checkEntity, h(async (req, res) => {
  if (req.user.role === 'cs') return fail(res, 403, '客服無匯出權限');
  const e = req.params.entity; const sch = A.schemaFor(req.user)[e];
  const rows = (await A.visible(req.user, e, req.ctx)).map(r => A.sanitize(req.user, e, r, req.ctx));
  const cols = sch.fields.filter(f => rows.some(r => f.key in r) || !rows.length);
  const esc = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = '﻿' + ['id', ...cols.map(f => f.label)].join(',') + '\n' + rows.map(r => [r.id, ...cols.map(f => r[f.key])].map(esc).join(',')).join('\n');
  await audit(req, 'export', e, null, { rows: rows.length });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${e}-${now().slice(0, 10)}.csv"` }).send(csv);
}));

// ── 附件（存在資料庫，只能經授權 API 下載）───────
app.post('/api/attachments', h(async (req, res) => {
  const { entity, entity_id, filename, data } = req.body;
  if (!entities[entity]) return fail(res, 400, '資料類型錯誤');
  const row = await getRow(entity, entity_id);
  if (!row || !A.canEditRow(req.user, entity, row, req.ctx)) return fail(res, 403, '沒有權限上傳');
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length || buf.length > 3 * 1024 * 1024) return fail(res, 400, '附件需小於 3MB；較大的檔案請貼雲端連結');
  const name = path.basename(String(filename)).slice(0, 200);
  const r = await db.run('INSERT INTO attachments(entity,entity_id,filename,size,data,user_id,created_at) VALUES(?,?,?,?,?,?,?)', entity, entity_id, name, buf.length, buf, req.user.id, now());
  await audit(req, 'attachment_upload', entity, Number(entity_id), { filename: name });
  res.json({ id: r.lastInsertRowid });
}));
app.get('/api/attachments/:id', h(async (req, res) => {
  const a = await db.get('SELECT * FROM attachments WHERE id=?', req.params.id);
  if (!a || !A.can(req.user, a.entity, 'r')) return fail(res, 404, '找不到附件');
  const row = await getRow(a.entity, a.entity_id);
  if (!row || !A.canSeeRow(req.user, a.entity, row, req.ctx)) return fail(res, 404, '找不到附件');
  await audit(req, 'attachment_download', a.entity, a.entity_id, { file: a.filename });
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}` }).send(Buffer.from(a.data));
}));

// ── 留言 ─────────────────────────────────────────
app.post('/api/comments', h(async (req, res) => {
  const { entity, entity_id, body } = req.body;
  if (!entities[entity] || !body) return fail(res, 400, '請輸入留言');
  const row = await getRow(entity, entity_id);
  if (!row || !A.canSeeRow(req.user, entity, row, req.ctx)) return fail(res, 404, '找不到資料');
  if (['boss', 'pitcher'].includes(req.user.role)) return fail(res, 403, '唯讀角色不能留言');
  await db.run('INSERT INTO comments(entity,entity_id,user_id,body,created_at) VALUES(?,?,?,?,?)', entity, entity_id, req.user.id, String(body).slice(0, 4000), now());
  res.json({ ok: true });
}));

// ── 平台串接 ───────────────────────────────────
app.get('/api/integrations', h(async (req, res) => {
  if (!['admin', 'boss'].includes(req.user.role)) return fail(res, 403, '沒有權限');
  const rows = (await db.all('SELECT * FROM integrations')).map(r => {
    let masked = ''; try { masked = S.mask(S.decrypt(r.token_enc)); } catch { masked = '（無法解密，請重新設定）'; }
    const { token_enc, ...rest } = r; return { ...rest, token_masked: masked };
  });
  res.json({ integrations: rows, runs: await db.all('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 30'),
    settings: { sync_hour: Number(await getSetting('sync_hour', 6)), refetch_days: Number(await getSetting('refetch_days', 7)) },
    on_vercel: !!process.env.VERCEL, meta_app_configured: !!(process.env.META_APP_ID && process.env.META_APP_SECRET) });
}));
app.post('/api/integrations/settings', adminOnly, h(async (req, res) => {
  const hr = Number(req.body.sync_hour), d = Number(req.body.refetch_days);
  if (!(hr >= 0 && hr <= 23) || !(d >= 1 && d <= 60)) return fail(res, 400, '時刻 0–23、重抓天數 1–60');
  await putSetting('sync_hour', hr); await putSetting('refetch_days', d); await audit(req, 'sync_settings', null, null, { hr, d }); res.json({ ok: true });
}));
app.post('/api/integrations/line/test', adminOnly, h(async (req, res) => {
  const token = String(req.body.token || '').trim();
  if (!token) return fail(res, 400, '請貼上 Channel Access Token');
  let info; try { info = await sync.testLine(token); } catch (e) { return fail(res, 400, `測試失敗：${e.message}`); }
  await db.run("UPDATE integrations SET token_enc=?, account_id=?, account_name=?, enabled=0, last_error=NULL, updated_at=? WHERE platform='line'", S.encrypt(token), info.account_id, info.account_name, now());
  await audit(req, 'integration_line_test', null, null, { account: info.account_id });
  res.json({ ok: true, ...info });
}));
app.post('/api/integrations/:platform/enable', adminOnly, h(async (req, res) => {
  const r = await db.get('SELECT * FROM integrations WHERE platform=?', req.params.platform);
  if (!r) return fail(res, 404, '未知平台');
  if (req.body.enabled && (!r.token_enc || !r.account_id)) return fail(res, 400, '請先完成授權並確認帳號');
  await db.run('UPDATE integrations SET enabled=?, updated_at=? WHERE platform=?', req.body.enabled ? 1 : 0, now(), r.platform);
  await audit(req, req.body.enabled ? 'integration_enable' : 'integration_disable', null, null, { platform: r.platform }); res.json({ ok: true });
}));
app.post('/api/integrations/:platform/revoke', adminOnly, h(async (req, res) => {
  await db.run('UPDATE integrations SET enabled=0, token_enc=NULL, account_id=NULL, account_name=NULL, updated_at=? WHERE platform=?', now(), req.params.platform);
  await audit(req, 'integration_revoke', null, null, { platform: req.params.platform }); res.json({ ok: true });
}));
const metaRedirect = req => `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/api/oauth/meta/callback`;
app.get('/api/integrations/meta/connect', adminOnly, h(async (req, res) => {
  if (!process.env.META_APP_ID) return fail(res, 400, '尚未設定 META_APP_ID／META_APP_SECRET（正式上線前配置 Meta App）');
  const state = S.newToken(); await putSetting('meta_oauth_state', state);
  const v = process.env.META_API_VERSION || 'v21.0';
  res.json({ url: `https://www.facebook.com/${v}/dialog/oauth?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(metaRedirect(req))}&state=${state}&scope=ads_read,read_insights,business_management` });
}));
app.get('/api/oauth/meta/callback', adminOnly, h(async (req, res) => {
  if (req.query.state !== (await getSetting('meta_oauth_state', '_'))) return res.status(403).send('授權驗證失敗');
  try {
    const v = process.env.META_API_VERSION || 'v21.0';
    const short = await sync.getJson(`https://graph.facebook.com/${v}/oauth/access_token?client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&redirect_uri=${encodeURIComponent(metaRedirect(req))}&code=${encodeURIComponent(req.query.code)}`);
    const long = await sync.getJson(`https://graph.facebook.com/${v}/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${short.access_token}`);
    await db.run("UPDATE integrations SET token_enc=?, enabled=0, last_error=NULL, updated_at=? WHERE platform='meta'", S.encrypt(long.access_token), now());
    await audit(req, 'integration_meta_oauth');
    res.redirect('/#/integrations?meta=ok');
  } catch (e) { res.redirect('/#/integrations?meta_error=' + encodeURIComponent(e.message)); }
}));
app.get('/api/integrations/meta/accounts', adminOnly, h(async (req, res) => {
  const r = await db.get("SELECT token_enc FROM integrations WHERE platform='meta'");
  if (!r?.token_enc) return fail(res, 400, '尚未授權');
  try {
    const d = await sync.getJson(`https://graph.facebook.com/${process.env.META_API_VERSION || 'v21.0'}/me/adaccounts?fields=id,name,account_status&access_token=${encodeURIComponent(S.decrypt(r.token_enc))}`);
    res.json(d.data || []);
  } catch (e) { fail(res, 400, e.message); }
}));
app.post('/api/integrations/meta/account', adminOnly, h(async (req, res) => {
  await db.run("UPDATE integrations SET account_id=?, account_name=?, updated_at=? WHERE platform='meta'", req.body.id, req.body.name, now());
  await audit(req, 'integration_meta_account', null, null, { id: req.body.id }); res.json({ ok: true });
}));
app.post('/api/sync/run', adminOnly, h(async (req, res) => { await audit(req, 'sync_manual'); res.json(await sync.runSync('manual')); }));

// ── 通用 CRUD ───────────────────────────────────
app.get('/api/:entity', checkEntity, h(async (req, res) => {
  const e = req.params.entity; const def = entities[e];
  let rows = await A.visible(req.user, e, req.ctx);
  for (const [k, v] of Object.entries(req.query)) {
    if (k === 'q') rows = rows.filter(r => def.fields.some(f => String(r[f.key] ?? '').toLowerCase().includes(String(v).toLowerCase())));
    else if (k === 'project_id' && v === 'none') rows = rows.filter(r => r.project_id == null);
    else if (def.fields.some(f => f.key === k) && v !== '') rows = rows.filter(r => String(r[k] ?? '') === String(v));
  }
  rows.sort((a, b) => b.id - a.id);
  res.json(rows.slice(0, 2000).map(r => decorate(req.user, e, r, req.ctx)));
}));
app.get('/api/:entity/:id', checkEntity, h(async (req, res) => {
  const e = req.params.entity; const row = await getRow(e, req.params.id); const ctx = req.ctx;
  if (!row || !A.canSeeRow(req.user, e, row, ctx)) return fail(res, 404, '找不到資料');
  const comments = await db.all('SELECT c.*, u.name user_name FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE entity=? AND entity_id=? ORDER BY c.id', e, row.id);
  const versions = e === 'contents' && req.user.role !== 'pitcher'
    ? await db.all('SELECT v.id, v.note, v.created_at, u.name user_name, v.snapshot FROM versions v LEFT JOIN users u ON u.id=v.user_id WHERE entity=? AND entity_id=? ORDER BY v.id DESC', e, row.id) : [];
  const attachments = await db.all('SELECT id, filename, size, created_at FROM attachments WHERE entity=? AND entity_id=?', e, row.id);
  const related = {};
  const rel = async (ent, fn) => (await A.visible(req.user, ent, ctx)).filter(fn).map(r => decorate(req.user, ent, r, ctx));
  if (e === 'contents' && row.topic_group) related.same_topic = (await A.visible(req.user, 'contents', ctx)).filter(r => r.topic_group === row.topic_group && r.id !== row.id).map(r => ({ id: r.id, title: r.title, channel: r.channel, status: r.status }));
  if (e === 'partners') { related.deliverables = await rel('deliverables', d => d.partner_id === row.id); related.rights = await rel('rights', d => d.partner_id === row.id); }
  if (e === 'projects') related.milestones = await rel('milestones', m => m.project_id === row.id);
  if (e === 'ads') related.children = await rel('ads', a => a.parent_id === row.id);
  res.json({ row: decorate(req.user, e, row, ctx), comments, versions: versions.map(v => ({ ...v, snapshot: JSON.parse(v.snapshot) })), attachments, related });
}));
app.post('/api/:entity', checkEntity, h(async (req, res) => {
  const e = req.params.entity;
  if (!A.can(req.user, e, 'c')) return fail(res, 403, '沒有建立權限');
  const allowed = A.writableFields(req.user, e, null, req.ctx);
  const data = coerce(e, Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k))));
  if (req.user.role !== 'admin' && OWNER_FIELD[e]) data[OWNER_FIELD[e]] = req.user.id; // 非管理員建立 → 自己負責
  if (req.user.role === 'cs' && e === 'contents' && !['LINE OA', 'SHOPLINE Blog'].includes(data.channel)) return fail(res, 403, '客服僅可建立 Blog 與 LINE OA 草稿');
  if (req.user.role !== 'admin' && ['deliverables', 'rights'].includes(e) && req.ctx.partners.get(data.partner_id)?.owner_id !== req.user.id) return fail(res, 403, '僅能為自己負責的合作新增');
  if (req.user.role !== 'admin' && data.project_id && req.ctx.scope.length && !req.ctx.scope.includes(data.project_id)) return fail(res, 403, '不在你的專案範圍');
  const err = await validate(e, data); if (err) return fail(res, 400, err);
  if (e === 'contents') data.status = 'draft';
  const keys = Object.keys(data);
  try {
    const r = await db.run(`INSERT INTO ${e}(${[...keys, 'created_by', 'created_at', 'updated_at'].join(',')}) VALUES(${[...keys, 1, 2, 3].map(() => '?').join(',')})`, ...keys.map(k => data[k]), req.user.id, now(), now());
    await audit(req, 'create', e, r.lastInsertRowid, data);
    res.json({ id: r.lastInsertRowid });
  } catch (ex) { if (String(ex.message).includes('UNIQUE')) return fail(res, 409, '參照編號已存在（重複成果不重複計算）'); throw ex; }
}));
app.put('/api/:entity/:id', checkEntity, h(async (req, res) => {
  const e = req.params.entity; const row = await getRow(e, req.params.id); const ctx = req.ctx;
  if (!row || !A.canSeeRow(req.user, e, row, ctx)) return fail(res, 404, '找不到資料');
  if (!A.canEditRow(req.user, e, row, ctx)) return fail(res, 403, '只能編輯指派給你的項目');
  const allowed = A.writableFields(req.user, e, row, ctx);
  const data = coerce(e, Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k))));
  if (req.user.role === 'cs' && e === 'contents' && data.channel && !['LINE OA', 'SHOPLINE Blog'].includes(data.channel)) return fail(res, 403, '客服僅可處理 Blog 與 LINE OA');
  const err = await validate(e, data, row); if (err) return fail(res, 400, err);
  const changed = Object.keys(data).filter(k => String(data[k] ?? '') !== String(row[k] ?? ''));
  if (!changed.length) return res.json({ ok: true, changed: [] });
  let reReview = false;
  if (e === 'contents') {
    const ext = entities.contents.fields.filter(f => f.external).map(f => f.key);
    if (APPROVED_STATES.includes(row.status) && changed.some(k => ext.includes(k))) { data.status = 'review'; reReview = true; }
    await db.run('INSERT INTO versions(entity,entity_id,user_id,snapshot,note,created_at) VALUES(?,?,?,?,?,?)', e, row.id, req.user.id, JSON.stringify(Object.fromEntries(changed.map(k => [k, { from: row[k], to: data[k] }]))), reReview ? '核准後修改對外內容 → 重新送審' : '編輯', now());
  }
  const keys = Object.keys(data);
  try { await db.run(`UPDATE ${e} SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=? WHERE id=?`, ...keys.map(k => data[k]), now(), row.id); }
  catch (ex) { if (String(ex.message).includes('UNIQUE')) return fail(res, 409, '參照編號已存在'); throw ex; }
  await audit(req, e === 'outcomes' && changed.includes('assignee_id') ? 'outcome_assign' : 'update', e, row.id,
    Object.fromEntries(changed.map(k => [k, A.seesFinance(req.user) || !entities[e].fields.find(f => f.key === k)?.finance ? data[k] : '***'])));
  // UGC 原檔：交付全數驗收後自動完成
  if (e === 'deliverables' && data.accepted) {
    const p = await getRow('partners', row.partner_id);
    const ds = await db.all('SELECT accepted FROM deliverables WHERE partner_id=?', p.id);
    if (p.ugc_only && ds.every(d => d.accepted)) await db.run("UPDATE partners SET status='已結案', updated_at=? WHERE id=?", now(), p.id);
  }
  res.json({ ok: true, changed, re_review: reReview });
}));
app.delete('/api/:entity/:id', checkEntity, adminOnly, h(async (req, res) => {
  const e = req.params.entity; const row = await getRow(e, req.params.id);
  if (!row) return fail(res, 404, '找不到資料');
  await db.run(`DELETE FROM ${e} WHERE id=?`, row.id);
  await audit(req, 'delete', e, row.id, { title: row[entities[e].title] });
  res.json({ ok: true });
}));

app.use('/api', (req, res) => fail(res, 404, '找不到 API'));
// 不回傳堆疊或除錯資訊
app.use((err, req, res, next) => { console.error(err); fail(res, 500, '系統錯誤，請稍後再試'); });

if (require.main === module) {
  sync.startScheduler();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`鄰近健康 行銷社群系統：http://localhost:${port}`));
}
module.exports = app;
