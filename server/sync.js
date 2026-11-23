// 平台同步（PRD 05）：每日台灣時間執行一次，各平台獨立，失敗不影響其他平台。
// 同步只呼叫平台 API 與寫入資料庫，不使用任何 AI 模型（token 用量 0）。
const { db } = require('./db');
const { decrypt } = require('./security');

const now = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
const ymd = (d, sep = '-') => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(/-/g, sep);
const setting = async (k, def) => ((await db.get('SELECT value FROM settings WHERE key=?', k))?.value ?? def);

async function getJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.message || body.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg); err.status = res.status; err.authError = res.status === 401 || body.error?.code === 190; throw err;
  }
  return body;
}

function upsertSnap(platform, metric, date, value, source) {
  return db.run(`INSERT INTO metric_snapshots(platform,metric,date,value,source,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(platform,metric,date) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=excluded.updated_at`,
    platform, metric, date, value, source, now());
}

// LINE OA：好友數、訊息發送數（重抓近 N 天，同期間重跑覆寫）
async function syncLine(ctx) {
  const integ = await db.get("SELECT * FROM integrations WHERE platform='line'");
  const token = decrypt(integ.token_enc);
  const headers = { Authorization: `Bearer ${token}` };
  const days = Number(await setting('refetch_days', 7));
  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.now() - i * 864e5);
    const dateStr = ymd(d, '');
    ctx.requests++;
    const f = await getJson(`https://api.line.me/v2/bot/insight/followers?date=${dateStr}`, { headers });
    if (f.status === 'ready') {
      await upsertSnap('line', 'followers', ymd(d), f.followers, 'LINE Insight API'); ctx.rows++;
      await upsertSnap('line', 'targeted_reaches', ymd(d), f.targetedReaches, 'LINE Insight API');
      await upsertSnap('line', 'blocks', ymd(d), f.blocks, 'LINE Insight API');
    }
    ctx.requests++;
    const m = await getJson(`https://api.line.me/v2/bot/insight/message/delivery?date=${dateStr}`, { headers });
    if (m.status === 'ready') {
      for (const k of ['broadcast', 'targeting', 'autoResponse', 'welcomeResponse', 'chat', 'apiPush', 'apiMulticast', 'apiBroadcast']) {
        if (m[k] != null) { await upsertSnap('line', `delivery_${k}`, ymd(d), m[k], 'LINE Insight API'); ctx.rows++; }
      }
    }
  }
}

// Meta：廣告活動／組合／廣告之狀態、預算、可讀成效
async function syncMeta(ctx) {
  const integ = await db.get("SELECT * FROM integrations WHERE platform='meta'");
  const token = decrypt(integ.token_enc);
  if (!integ.account_id) throw new Error('尚未選擇廣告帳號');
  const v = process.env.META_API_VERSION || 'v21.0';
  const levels = [['campaigns', '廣告活動', null], ['adsets', '廣告組合', 'campaign_id'], ['ads', '廣告', 'adset_id']];
  const since = ymd(new Date(Date.now() - Number(await setting('refetch_days', 7)) * 864e5));
  for (const [edge, level, parentKey] of levels) {
    let url = `https://graph.facebook.com/${v}/${integ.account_id}/${edge}?limit=200&fields=id,name,effective_status,daily_budget,start_time,stop_time${parentKey ? ',' + parentKey : ''},insights.time_range({"since":"${since}","until":"${ymd(new Date())}"}){spend,impressions,inline_link_clicks}&access_token=${encodeURIComponent(token)}`;
    while (url) {
      ctx.requests++;
      const page = await getJson(url);
      for (const it of page.data || []) {
        const ins = it.insights?.data?.[0] || {};
        const parent = parentKey ? await db.get('SELECT id, project_id FROM ads WHERE ext_id=?', it[parentKey]) : null;
        const row = {
          name: it.name, level, ext_id: it.id, parent_id: parent?.id ?? null,
          status: { ACTIVE: '投放中', PAUSED: '暫停', ARCHIVED: '已結束', DELETED: '已結束' }[it.effective_status] || it.effective_status,
          daily_budget: it.daily_budget != null ? Number(it.daily_budget) / 100 : null, // 依帳戶幣別最小單位換算，正式上線前以公司帳號驗證
          start_date: it.start_time?.slice(0, 10) ?? null, end_date: it.stop_time?.slice(0, 10) ?? null,
          spend: ins.spend != null ? Number(ins.spend) : null, impressions: ins.impressions != null ? Number(ins.impressions) : null,
          link_clicks: ins.inline_link_clicks != null ? Number(ins.inline_link_clicks) : null,
          metric_status: it.insights ? '已回填' : '平台未提供',
        };
        const ex = await db.get('SELECT id FROM ads WHERE ext_id=?', it.id);
        const keys = Object.keys(row);
        if (ex) await db.run(`UPDATE ads SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=? WHERE id=?`, ...keys.map(k => row[k]), now(), ex.id);
        else await db.run(`INSERT INTO ads(${keys.join(',')},project_id) VALUES(${keys.map(() => '?').join(',')},?)`, ...keys.map(k => row[k]), parent?.project_id ?? null);
        ctx.rows++;
      }
      url = page.paging?.next || null;
    }
  }
}

const RUNNERS = { line: syncLine, meta: syncMeta };

async function runSync(trigger = 'schedule') {
  const results = [];
  const enabled = await db.all('SELECT platform FROM integrations WHERE enabled=1');
  for (const { platform } of enabled) {
    const ctx = { requests: 0, rows: 0 };
    const started = now();
    const run = await db.run('INSERT INTO sync_runs(trigger,platform,status,started_at) VALUES(?,?,?,?)', trigger, platform, 'running', started);
    try {
      await RUNNERS[platform](ctx);
      await db.run('UPDATE sync_runs SET status=?,requests=?,rows=?,finished_at=? WHERE id=?', 'success', ctx.requests, ctx.rows, now(), run.lastInsertRowid);
      await db.run('UPDATE integrations SET last_success=?, last_error=NULL WHERE platform=?', now(), platform);
      results.push({ platform, status: 'success', ...ctx });
    } catch (e) {
      const msg = (e.authError ? '授權失效，請重新授權：' : '') + e.message;
      await db.run('UPDATE sync_runs SET status=?,requests=?,rows=?,error=?,finished_at=? WHERE id=?', 'failed', ctx.requests, ctx.rows, msg, now(), run.lastInsertRowid);
      await db.run('UPDATE integrations SET last_error=? WHERE platform=?', msg, platform);
      results.push({ platform, status: 'failed', error: msg });
    }
  }
  await db.run("INSERT INTO settings(key,value) VALUES('last_sync_day',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", ymd(new Date()));
  return results;
}

// 自架主機用：每分鐘檢查一次，到了設定時刻（台灣時間）且今天還沒跑 → 執行。
// Vercel 上不用這個，改由 vercel.json 的 Cron 呼叫 /api/cron/sync。
function startScheduler() {
  setInterval(async () => {
    try {
      const hour = Number(await setting('sync_hour', 6));
      const nowTw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      if (nowTw.getHours() >= hour && (await setting('last_sync_day', '')) !== ymd(new Date())) await runSync('schedule');
    } catch {}
  }, 60_000).unref();
}

async function testLine(token) {
  const info = await getJson('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${token}` } });
  return { account_id: info.basicId || info.userId, account_name: info.displayName };
}

module.exports = { runSync, startScheduler, testLine, getJson, now };
