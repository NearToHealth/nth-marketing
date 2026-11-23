// 儀表板統計口徑（對應 PRD 04）
const { db } = require('./db');
const { seesFinance, visible } = require('./access');

const sum = (rows, k) => {
  const v = rows.map(r => r[k]).filter(x => x !== null && x !== undefined && x !== '');
  return v.length ? v.reduce((a, b) => a + Number(b), 0) : null; // null = 待回填
};
const ratio = (a, b) => (a == null || !b ? null : a / b); // 分母為零或缺值 → null（前端顯示「—」）
// 同口徑 CTR：只取同時有點擊與曝光的列
function sameBasisCtr(rows, clickKey, imprKey) {
  const ok = rows.filter(r => r[clickKey] != null && r[imprKey] != null);
  if (!ok.length) return null;
  return ratio(sum(ok, clickKey), sum(ok, imprKey));
}
const dayOf = r => String(r.published_at || r.planned_at || '').slice(0, 10);
function weekKey(d) {
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return null;
  const day = (dt.getDay() + 6) % 7;
  dt.setDate(dt.getDate() - day);
  return dt.toISOString().slice(0, 10);
}

async function dashboard(user, q, ctx) {
  const inRange = d => (!q.from || (d && d >= q.from)) && (!q.to || (d && d <= q.to));
  const scopeOk = r => (q.scope === 'daily' ? r.project_id == null : q.scope === 'project' ? r.project_id != null : true)
    && (!q.project_id || String(r.project_id) === String(q.project_id));

  let contents = (await visible(user, 'contents', ctx)).filter(r => ['published', 'reported'].includes(r.status) || r.impressions != null)
    .filter(r => inRange(dayOf(r)) && scopeOk(r))
    .filter(r => !q.channel || r.channel === q.channel)
    .filter(r => !q.audience || String(r.audience || '').includes(q.audience))
    .filter(r => q.paid === 'paid' ? r.paid : q.paid === 'organic' ? !r.paid : true);

  let ads = (await visible(user, 'ads', ctx)).filter(scopeOk)
    .filter(r => !q.from || !r.end_date || r.end_date >= q.from)
    .filter(r => !q.to || !r.start_date || r.start_date <= q.to);
  if (q.paid === 'organic' || (q.channel && !['Facebook', 'Instagram'].includes(q.channel))) ads = [];

  const outcomes = (await visible(user, 'outcomes', ctx)).filter(r => inRange(r.occurred_on) && scopeOk(r));
  const partners = (await visible(user, 'partners', ctx)).filter(scopeOk);

  // 品牌曝光：分平台
  const byChannel = {};
  for (const r of contents) (byChannel[r.channel] ||= []).push(r);
  const exposure = Object.entries(byChannel).map(([ch, rows]) => ({
    channel: ch, impressions: sum(rows, 'impressions'), reach: sum(rows, 'reach'), video_views: sum(rows, 'video_views'),
    video_def: [...new Set(rows.map(r => r.video_view_def).filter(Boolean))].join('、') || null,
  }));
  const leafAds = ads.filter(a => a.level === '廣告');
  exposure.push({ channel: 'Meta 廣告（付費）', impressions: sum(leafAds, 'impressions'), reach: null, video_views: null, video_def: null });

  const interaction = {
    saves: sum(contents, 'saves'), shares: sum(contents, 'shares'), link_clicks: sum(contents, 'link_clicks'),
    ctr: sameBasisCtr(contents, 'link_clicks', 'impressions'),
  };

  const blogs = contents.filter(r => r.channel === 'SHOPLINE Blog');
  const seo = {
    search_impressions: sum(blogs, 'search_impressions'), search_clicks: sum(blogs, 'search_clicks'),
    search_ctr: sameBasisCtr(blogs, 'search_clicks', 'search_impressions'),
    organic_sessions: sum(blogs, 'organic_sessions'), cta_clicks: sum(blogs, 'cta_clicks'),
  };

  const adIds = new Set(leafAds.map(a => a.id));
  const outcomeRows = ['完成報名', '有效諮詢', '到店核銷', 'B端有效洽談'].map(t => {
    const rows = outcomes.filter(o => o.outcome_type === t);
    const attributed = rows.filter(o => o.content_id || o.ad_id || o.partner_id).length;
    return { type: t, total: rows.length, attributed, unattributed: rows.length - attributed, pending: rows.filter(o => !o.filled).length };
  });

  let efficiency = null;
  if (seesFinance(user)) {
    const spend = sum(leafAds, 'spend');
    const adClicks = sum(leafAds, 'link_clicks');
    const adOutcomes = outcomes.filter(o => o.ad_id && adIds.has(o.ad_id) && (!q.outcome_type || o.outcome_type === q.outcome_type));
    // 日預算：取有設定預算的最上層，避免活動預算（CBO）與下層重複加總
    const byId = Object.fromEntries(ads.map(a => [a.id, a]));
    const ancestorHasBudget = a => { let p = byId[a.parent_id]; while (p) { if (p.daily_budget != null) return true; p = byId[p.parent_id]; } return false; };
    const budgetRows = ads.filter(a => a.daily_budget != null && !ancestorHasBudget(a));
    efficiency = {
      spend, link_clicks: adClicks, cpc: ratio(spend, adClicks),
      outcome_count: adOutcomes.length, cost_per_outcome: ratio(spend, adOutcomes.length),
      daily_budget: sum(budgetRows, 'daily_budget'),
      partner_fee: sum(partners, 'fee'), partner_product_cost: sum(partners, 'product_cost'), partner_shipping: sum(partners, 'shipping_fee'),
    };
  }

  // 資料狀態：區分 零、待回填、平台未提供、同步失敗
  const status = {};
  for (const r of contents) { const s = r.metric_status || '待回填'; status[s] = (status[s] || 0) + 1; }

  // 時間趨勢（週）
  const trend = {};
  for (const r of contents) {
    const w = weekKey(dayOf(r)); if (!w) continue;
    trend[w] ||= { week: w, impressions: 0, link_clicks: 0, outcomes: 0 };
    trend[w].impressions += Number(r.impressions || 0); trend[w].link_clicks += Number(r.link_clicks || 0);
  }
  for (const o of outcomes) {
    const w = weekKey(o.occurred_on || ''); if (!w) continue;
    trend[w] ||= { week: w, impressions: 0, link_clicks: 0, outcomes: 0 };
    trend[w].outcomes += 1;
  }

  const sources = await db.all('SELECT platform, enabled, last_success, last_error FROM integrations');
  const drill = contents.slice(0, 200).map(r => ({
    id: r.id, title: r.title, channel: r.channel, date: dayOf(r), impressions: r.impressions, link_clicks: r.link_clicks,
    ctr: ratio(r.link_clicks, r.impressions), metric_status: r.metric_status || '待回填', metric_source: r.metric_source, updated_at: r.updated_at,
  }));

  return { exposure, interaction, seo, outcomes: outcomeRows, efficiency, status, trend: Object.values(trend).sort((a, b) => a.week.localeCompare(b.week)), sources, drill, generated_at: new Date().toISOString() };
}

module.exports = { dashboard };
