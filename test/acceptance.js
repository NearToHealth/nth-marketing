// 驗收測試：權限隔離 + PRD 三條首輪驗收流程
// 用法：先啟動伺服器（空白資料庫，ADMIN_EMAIL=admin@nth.tw ADMIN_PASSWORD=Admin12345a），再執行 BASE=http://localhost:3100 node test/acceptance.js
const BASE = process.env.BASE || 'http://localhost:3100';
let pass = 0, failN = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓', name); } else { failN++; console.log('  ✗', name); } };

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nth', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { call, get: p => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}
async function login(email, pw, newPw) {
  const c = client();
  const r = await c.post('/api/login', { email, password: pw });
  if (r.data.must_change && newPw) await c.post('/api/change-password', { old: pw, new: newPw });
  return c;
}

(async () => {
  console.log('\n[帳號]');
  const anon = client();
  ok((await anon.get('/api/contents')).status === 401, '匿名無法讀取 API');
  ok((await anon.get('/api/export/contents')).status === 401, '匿名無法匯出');
  const adm0 = client(); await adm0.post('/api/login', { email: 'admin@nth.tw', password: 'Admin12345a' });
  ok((await adm0.get('/api/contents')).status === 428, '首次登入未改密碼前不能使用');
  ok((await adm0.post('/api/change-password', { old: 'Admin12345a', new: 'short' })).status === 400, '弱密碼被拒');
  await adm0.post('/api/change-password', { old: 'Admin12345a', new: 'NewAdmin2026x' });
  const A = adm0;
  ok((await A.get('/api/contents')).status === 200, '管理員改密碼後可使用');
  ok((await client().post('/api/login', { email: 'admin@nth.tw', password: 'x' })).status === 401, '錯誤密碼拒絕');

  const expo = (await A.post('/api/projects', { name: '台灣醫療科技展', status: '進行中', start_date: '2026-12-03', end_date: '2026-12-06', budget: 50000, goal: '展會報名與到店核銷' })).data.id;
  const other = (await A.post('/api/projects', { name: '其他專案', budget: 9999 })).data.id;
  const mk = async (name, email, role, scope = []) => { const r = await A.post('/api/users', { name, email, role, scope }); const c = await login(email, r.data.temp_password, 'Passw0rd' + role + 'x'); return { c, id: r.data.id, pw: 'Passw0rd' + role + 'x' }; };
  const ed = await mk('June', 'june@nth.tw', 'editor');
  const cs = await mk('Flora', 'flora@nth.tw', 'cs');
  const boss = await mk('老闆', 'boss@nth.tw', 'boss');
  const pit = await mk('投手', 'pitcher@ext.tw', 'pitcher', [expo]);

  console.log('\n[流程 1] 日常長照文章：客服撰稿 → 官網 Blog 與 LINE 排程');
  const blog = (await cs.c.post('/api/contents', { title: '長照 2.0 申請流程', channel: 'SHOPLINE Blog', keyword: '長照申請', topic_group: '長照申請', copy: '初稿', cta: '預約諮詢' })).data.id;
  ok(!!blog, '客服可建立 Blog 草稿');
  ok((await cs.c.post('/api/contents', { title: 'x', channel: 'Facebook' })).status === 403, '客服不能建立 FB 內容');
  const line = (await cs.c.post('/api/contents', { title: '長照申請 LINE 推播', channel: 'LINE OA', line_type: '推播', topic_group: '長照申請' })).data.id;
  ok((await cs.c.get('/api/contents')).data.every(r => ['LINE OA', 'SHOPLINE Blog'].includes(r.channel)), '客服只看到 Blog/LINE 內容');
  ok((await cs.c.post(`/api/contents/${blog}/action`, { action: 'approve' })).status === 403, '客服不能核准');
  ok((await cs.c.post(`/api/contents/${blog}/action`, { action: 'submit' })).data.status === 'review', '客服送審');
  ok((await A.post(`/api/contents/${blog}/action`, { action: 'reject' })).status === 400, '退修需填原因');
  await A.post(`/api/contents/${blog}/action`, { action: 'reject', note: '請補官方來源' });
  await cs.c.put(`/api/contents/${blog}`, { sources: 'https://1966.gov.tw', last_checked: '2026-11-22' });
  await cs.c.post(`/api/contents/${blog}/action`, { action: 'submit' });
  ok((await A.post(`/api/contents/${blog}/action`, { action: 'approve' })).data.status === 'approved', '管理員核准');
  const re = await cs.c.put(`/api/contents/${blog}`, { cta: '立即預約' });
  ok(re.data.re_review === true, '核准後修改 CTA → 自動重新送審');
  await A.post(`/api/contents/${blog}/action`, { action: 'approve' });
  await cs.c.put(`/api/contents/${blog}`, { planned_at: '2026-11-25T10:00' });
  ok((await cs.c.post(`/api/contents/${blog}/action`, { action: 'schedule' })).data.status === 'scheduled', 'Blog 排程');
  await cs.c.put(`/api/contents/${line}`, { planned_at: '2026-11-25T12:00', copy: '推播文案' });
  await cs.c.post(`/api/contents/${line}/action`, { action: 'submit' }); await A.post(`/api/contents/${line}/action`, { action: 'approve' });
  ok((await cs.c.post(`/api/contents/${line}/action`, { action: 'schedule' })).data.status === 'scheduled', 'LINE 排程');
  ok((await A.get(`/api/contents/${blog}`)).data.related.same_topic.some(x => x.id === line), '同主題 Blog 與 LINE 互相關聯');
  ok((await A.get(`/api/contents/${blog}`)).data.versions.length >= 2, '保留版本紀錄');

  console.log('\n[流程 2] 展會專案：廣告 A/B → 報名與核銷回填');
  const camp = (await A.post('/api/ads', { name: '醫療科技展-活動', level: '廣告活動', project_id: expo, daily_budget: 1000 })).data.id;
  const set = (await A.post('/api/ads', { name: '組合A', level: '廣告組合', parent_id: camp, project_id: expo, daily_budget: 500 })).data.id;
  const adA = (await A.post('/api/ads', { name: '素材A', level: '廣告', parent_id: set, project_id: expo, spend: 3000, link_clicks: 150, impressions: 10000, status: '投放中' })).data.id;
  const adB = (await A.post('/api/ads', { name: '素材B', level: '廣告', parent_id: set, project_id: expo, spend: 2000, link_clicks: 0, impressions: 8000, status: '投放中' })).data.id;
  await A.post('/api/abtests', { name: '素材A vs B', project_id: expo, method: '同受眾分流', versions: 'A 圖片 / B 影片', metric: '連結 CTR', progress: '測試中' });
  const imp = await A.post('/api/import/preview', { entity: 'outcomes', csv: `參照編號,成果類型,專案,日期,回填人,歸因廣告\nR001,完成報名,台灣醫療科技展,2026/12/3,June,${adA}\nR002,完成報名,台灣醫療科技展,2026-12-03,June,\nR003,錯誤類型,台灣醫療科技展,2026-12-03,June,\nR001,完成報名,台灣醫療科技展,2026-12-03,June,` });
  ok(imp.data.items.filter(i => i.action === 'error').length === 2, 'CSV 預覽標出錯誤列與檔內重複');
  const cm = await A.post('/api/import/commit', { entity: 'outcomes', csv: `參照編號,成果類型,專案,日期,回填人,歸因廣告\nR001,完成報名,台灣醫療科技展,2026-12-03,June,${adA}\nR002,完成報名,台灣醫療科技展,2026-12-03,June,` });
  ok(cm.data.created === 2, '匯入 2 筆');
  const cm2 = await A.post('/api/import/commit', { entity: 'outcomes', csv: `參照編號,成果類型,專案,日期,回填人,歸因廣告\nR001,到店核銷,台灣醫療科技展,2026-12-04,June,${adA}` });
  ok(cm2.data.created === 0 && cm2.data.updated === 1, '重匯以參照編號去重（更新不重複）');
  ok((await A.post('/api/outcomes', { ref_no: 'R002', outcome_type: '完成報名' })).status === 409, '手動新增重複參照編號被擋');
  const outs = (await ed.c.get('/api/outcomes')).data;
  const r2 = outs.find(o => o.ref_no === 'R002');
  ok((await ed.c.put(`/api/outcomes/${r2.id}`, { filled: true, note: '已確認報名' })).status === 200, '被指派的小編可回填成果');
  ok((await ed.c.put(`/api/outcomes/${r2.id}`, { assignee_id: ed.id + 99 })).data.changed?.length === 0, '小編不能改指派人');
  const dash = (await A.get(`/api/dashboard?project_id=${expo}`)).data;
  ok(dash.efficiency.spend === 5000, '花費加總 5000');
  ok(Math.abs(dash.efficiency.cpc - 5000 / 150) < 1e-9, '連結 CPC = 花費 ÷ 連結點擊');
  ok(dash.efficiency.outcome_count === 1 && dash.efficiency.cost_per_outcome === 5000, '每筆成果成本 = 花費 ÷ 已歸因成果');
  ok(dash.efficiency.daily_budget === 1000, '日預算不重複加總（活動層 1000，不含下層 500）');
  ok(dash.outcomes.find(o => o.type === '完成報名').unattributed === 1, '未歸因成果仍計入總數');
  const adBrow = (await A.get(`/api/ads/${adB}`)).data.row;
  ok(adBrow._cpc === null, '連結點擊為 0 → CPC 為 null（前端顯示「—」）');
  const edDash = (await ed.c.get(`/api/dashboard?project_id=${expo}`)).data;
  ok(edDash.efficiency === null, '小編儀表板看不到財務');

  console.log('\n[流程 3] 商品互惠：寄送 → 交付 → 素材使用權');
  const kol = (await A.post('/api/partners', { name: '照護媽媽 KOC', partner_type: 'KOC', coop_type: '商品互惠', project_id: expo, owner_id: ed.id, product: '居家照護包', ship_address: '台北市某路 1 號', contact: '0912-000-000', product_cost: 800, shipping_fee: 100, ugc_only: true })).data.id;
  const edView = (await ed.c.get(`/api/partners/${kol}`)).data.row;
  ok(edView.ship_address && !('product_cost' in edView), '負責小編看得到寄送地址、看不到成本');
  const bossView = (await boss.c.get(`/api/partners/${kol}`)).data.row;
  ok(!('ship_address' in bossView) && bossView.product_cost === 800, '老闆看得到成本、看不到寄送地址');
  await ed.c.put(`/api/partners/${kol}`, { status: '已寄送', shipped_at: '2026-11-22' });
  const del = (await ed.c.post('/api/deliverables', { partner_id: kol, title: '開箱影片原檔', due_date: '2026-11-30' })).data.id;
  ok(!!del, '負責小編可新增交付');
  ok((await A.put(`/api/partners/${kol}`, { status: '已結案' })).status === 400, '交付未驗收不能結案');
  const right = (await A.post('/api/rights', { partner_id: kol, asset_desc: '開箱影片', confirmed: false, r_ads: true })).data.id;
  ok((await A.post('/api/ads', { name: '用 KOC 素材', level: '廣告', right_id: right })).status === 400, '用途未確認的素材不能選用於廣告');
  await A.put(`/api/rights/${right}`, { confirmed: true, start_date: '2026-11-01', end_date: '2026-11-10' });
  ok((await A.post('/api/ads', { name: '用 KOC 素材', level: '廣告', right_id: right })).status === 400, '已到期素材不能選用');
  await A.put(`/api/rights/${right}`, { end_date: '2027-05-31' });
  ok((await A.post('/api/ads', { name: '用 KOC 素材', level: '廣告', right_id: right })).status === 200, '有效授權可選用');
  await ed.c.put(`/api/deliverables/${del}`, { accepted: true, url: 'https://drive.google.com/x' });
  ok((await A.get(`/api/partners/${kol}`)).data.row.status === '已結案', 'UGC 原檔驗收後自動完成交付');

  console.log('\n[權限隔離]');
  ok((await ed.c.get(`/api/projects/${expo}`)).data.row.budget === undefined, '小編讀不到專案預算');
  ok((await ed.c.put(`/api/contents/${blog}`, { copy: 'hack' })).status === 403, '小編不能改未指派給自己的內容');
  ok((await boss.c.post('/api/contents', { title: 'x', channel: 'Facebook' })).status === 403, '老闆級唯讀');
  const pc = (await pit.c.get('/api/contents')).data;
  ok(pc.every(r => r.project_id === expo && ['approved', 'scheduled', 'published', 'reported'].includes(r.status)), '投手只看到指定專案的核准內容');
  ok((await pit.c.get(`/api/projects/${other}`)).status === 404, '投手讀不到非指定專案');
  ok((await pit.c.get('/api/faqs')).status === 403, '投手不能讀 FAQ');
  ok((await cs.c.get('/api/ads')).status === 403, '客服不能讀廣告');
  ok(!(await ed.c.get('/api/export/ads')).data.includes('累積花費'), '小編匯出不含財務欄位');
  ok((await cs.c.get('/api/export/faqs')).status === 403, '客服不能匯出');
  ok((await ed.c.post('/api/import/preview', { entity: 'outcomes', csv: 'a' })).status === 403, '非管理員不能匯入');
  ok((await ed.c.get('/api/integrations')).status === 403, '小編看不到平台串接');
  const xsrf = await fetch(BASE + '/api/contents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(xsrf.status === 401 || xsrf.status === 403, '無自訂標頭的寫入被擋（CSRF）');

  console.log('\n[停用與撤權]');
  await A.put(`/api/users/${pit.id}`, { scope: [other] });
  ok((await pit.c.get('/api/contents')).status === 401, '改專案範圍後既有登入立即失效');
  const pit2 = await login('pitcher@ext.tw', pit.pw);
  ok((await pit2.get(`/api/projects/${expo}`)).status === 404, '重新登入後只剩新範圍');
  await A.put(`/api/users/${ed.id}`, { active: false });
  ok((await ed.c.get('/api/contents')).status === 401, '停用後既有登入立即失效');
  ok((await client().post('/api/login', { email: 'june@nth.tw', password: ed.pw })).status === 401, '停用後無法登入');

  console.log('\n[平台串接]');
  const lt = await A.post('/api/integrations/line/test', { token: 'fake-token-1234' });
  ok(lt.status === 400, 'LINE 無效 Token 測試失敗並回報');
  const ig = (await A.get('/api/integrations')).data;
  ok(!JSON.stringify(ig).includes('fake-token'), '憑證不回顯');
  ok((await A.post('/api/integrations/line/enable', { enabled: true })).status === 400, '未確認帳號不能啟用同步');

  const au = (await A.get('/api/audit')).data.map(a => a.action);
  ok(['user_create', 'content_approve', 'export', 'import', 'user_disable', 'login'].every(x => au.includes(x)), '帳號、核准、匯出、匯入、停用皆有紀錄');

  console.log(`\n結果：${pass} 通過，${failN} 失敗\n`);
  process.exit(failN ? 1 : 0);
})();
