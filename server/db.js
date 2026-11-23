// 資料庫：libSQL（Turso）。本機開發用檔案（file:），Vercel 上用 Turso 雲端資料庫。
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const { entities } = require('./schema');

const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || (() => {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  return 'file:' + path.join(dir, 'app.db');
})();
// 雲端上改用 HTTPS 連線（無伺服器環境比 WebSocket 穩定）
const client = createClient({ url: url.trim().replace(/^libsql:\/\//, 'https://'), authToken: process.env.TURSO_AUTH_TOKEN?.trim() });

const plain = rs => rs.rows.map(r => Object.fromEntries(rs.columns.map((c, i) => [c, r[i] instanceof ArrayBuffer ? Buffer.from(r[i]) : r[i]])));
const norm = args => args.map(a => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
const db = {
  all: async (sql, ...args) => plain(await client.execute({ sql, args: norm(args) })),
  get: async (sql, ...args) => (await db.all(sql, ...args))[0],
  run: async (sql, ...args) => { const r = await client.execute({ sql, args: norm(args) }); return { lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null, changes: r.rowsAffected }; },
  // 多筆寫入一次送出（交易）
  batch: async stmts => client.batch(stmts.map(([sql, ...args]) => ({ sql, args: norm(args) })), 'write'),
};

const BASE = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  pass_hash TEXT NOT NULL, must_change INTEGER DEFAULT 1, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now','+8 hours')));
CREATE TABLE IF NOT EXISTS user_projects (user_id INTEGER, project_id INTEGER, PRIMARY KEY(user_id, project_id));
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, n INTEGER, until INTEGER);
CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, entity TEXT, entity_id INTEGER, user_id INTEGER, body TEXT, created_at TEXT DEFAULT (datetime('now','+8 hours')));
CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY, entity TEXT, entity_id INTEGER, user_id INTEGER, snapshot TEXT, note TEXT, created_at TEXT DEFAULT (datetime('now','+8 hours')));
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT, entity TEXT, entity_id INTEGER, detail TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now','+8 hours')));
CREATE TABLE IF NOT EXISTS attachments (id INTEGER PRIMARY KEY, entity TEXT, entity_id INTEGER, filename TEXT, size INTEGER, data BLOB, user_id INTEGER, created_at TEXT DEFAULT (datetime('now','+8 hours')));
CREATE TABLE IF NOT EXISTS integrations (platform TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, token_enc TEXT, account_id TEXT, account_name TEXT, last_success TEXT, last_error TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY, trigger TEXT, platform TEXT, status TEXT, requests INTEGER, rows INTEGER, error TEXT, started_at TEXT, finished_at TEXT);
CREATE TABLE IF NOT EXISTS metric_snapshots (platform TEXT, metric TEXT, date TEXT, value REAL, source TEXT, updated_at TEXT, PRIMARY KEY(platform, metric, date));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`;

// 依 schema 建表／補欄位。schema 沒變時只查一次 settings 就結束（冷啟動快）。
async function migrate() {
  const sig = require('crypto').createHash('md5').update(BASE + JSON.stringify(entities)).digest('hex');
  try { if ((await db.get("SELECT value FROM settings WHERE key='schema_sig'"))?.value === sig) return; } catch {}
  await client.executeMultiple(BASE);
  for (const [name, def] of Object.entries(entities)) {
    await client.execute(`CREATE TABLE IF NOT EXISTS ${name} (id INTEGER PRIMARY KEY, created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','+8 hours')), updated_at TEXT DEFAULT (datetime('now','+8 hours')))`);
    const cols = (await db.all(`PRAGMA table_info(${name})`)).map(c => c.name);
    for (const f of def.fields) if (!cols.includes(f.key)) {
      const t = ['number', 'money', 'bool', 'user', 'project', 'ref'].includes(f.type) ? 'REAL' : 'TEXT';
      await client.execute(`ALTER TABLE ${name} ADD COLUMN ${f.key} ${t}`);
    }
  }
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS ux_outcomes_ref ON outcomes(ref_no)');
  for (const p of ['line', 'meta']) await db.run('INSERT OR IGNORE INTO integrations(platform) VALUES(?)', p);
  await db.run("INSERT INTO settings VALUES('schema_sig',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", sig);
}

module.exports = { db, migrate };
