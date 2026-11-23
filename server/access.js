// 所有權限判斷都在伺服器端：頁面、API、附件、匯出共用同一套規則。
// 每個請求先用 loadCtx() 一次載入範圍與合作負責人，之後的判斷都是同步的（避免對雲端資料庫逐筆查詢）。
const { db } = require('./db');
const { entities, ACCESS, CS_CHANNELS, APPROVED_STATES, OWNER_FIELD } = require('./schema');

function can(user, entity, op) {
  const a = ACCESS[user.role] || {};
  const perm = a[entity] ?? a['*'] ?? '';
  return perm.includes(op);
}
const seesFinance = u => ['admin', 'boss', 'pitcher'].includes(u.role);

async function scopeIds(user) {
  return (await db.all('SELECT project_id FROM user_projects WHERE user_id=?', user.id)).map(r => r.project_id);
}
async function loadCtx(user) {
  const [scope, partners] = await Promise.all([scopeIds(user), db.all('SELECT id, project_id, owner_id FROM partners')]);
  return { scope, partners: new Map(partners.map(p => [p.id, p])) };
}

function projectOf(entity, row, ctx) {
  if (!row) return null;
  if (entity === 'projects') return row.id;
  if ('project_id' in row) return row.project_id ?? null;
  if (entity === 'deliverables' || entity === 'rights') return ctx.partners.get(row.partner_id)?.project_id ?? null;
  return null;
}
function isOwner(user, entity, row, ctx) {
  const f = OWNER_FIELD[entity];
  if (f && row[f] === user.id) return true;
  if (entity === 'deliverables' || entity === 'rights') return ctx.partners.get(row.partner_id)?.owner_id === user.id;
  return false;
}

// 列層級可見性
function canSeeRow(user, entity, row, ctx) {
  if (!can(user, entity, 'r')) return false;
  if (user.role === 'admin' || user.role === 'boss') return true;
  const pid = projectOf(entity, row, ctx);
  if (user.role === 'pitcher') {
    if (pid == null || !ctx.scope.includes(pid)) return false;
    if (entity === 'contents' && !APPROVED_STATES.includes(row.status)) return false;
    return true;
  }
  // 小編／客服：有設定專案範圍時，專案資料僅限範圍內；日常（無專案）皆可見
  if (pid != null && ctx.scope.length && !ctx.scope.includes(pid) && !isOwner(user, entity, row, ctx)) return false;
  if (user.role === 'cs' && entity === 'contents' && !CS_CHANNELS.includes(row.channel)) return false;
  return true;
}

// 欄位遮蔽
function sanitize(user, entity, row, ctx) {
  const out = { ...row };
  const fin = seesFinance(user);
  const priv = user.role === 'admin' || isOwner(user, entity, row, ctx);
  for (const f of entities[entity].fields) {
    if (f.finance && !fin) delete out[f.key];
    if (f.private && !priv) delete out[f.key];
  }
  return out;
}

function writableFields(user, entity, row, ctx) {
  const priv = user.role === 'admin' || (row ? isOwner(user, entity, row, ctx) : true);
  return entities[entity].fields.filter(f => {
    if (f.readonly) return false;
    if (f.finance && user.role !== 'admin') return false;
    if (f.private && !priv) return false;
    if (user.role !== 'admin' && f.key === OWNER_FIELD[entity]) return !row; // 只有管理員能改指派
    return true;
  }).map(f => f.key);
}

function canEditRow(user, entity, row, ctx) {
  if (!can(user, entity, 'u')) return false;
  if (user.role === 'admin') return true;
  return isOwner(user, entity, row, ctx);
}

function schemaFor(user) {
  const out = {};
  for (const [name, def] of Object.entries(entities)) {
    if (!can(user, name, 'r')) continue;
    out[name] = { ...def, perms: { create: can(user, name, 'c'), update: can(user, name, 'u'), delete: can(user, name, 'd') },
      fields: def.fields.filter(f => !(f.finance && !seesFinance(user))) };
  }
  return out;
}

// 讀取使用者可見的資料
async function visible(user, entity, ctx) {
  if (!can(user, entity, 'r')) return [];
  return (await db.all(`SELECT * FROM ${entity}`)).filter(r => canSeeRow(user, entity, r, ctx));
}

module.exports = { can, scopeIds, loadCtx, seesFinance, projectOf, isOwner, canSeeRow, sanitize, writableFields, canEditRow, schemaFor, visible };
