/* 鄰近健康 行銷社群系統 — 前端（無建置步驟，原生 JS） */
(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = v => (v == null || v === '' ? '<span class="placeholder">待回填</span>' : Number(v).toLocaleString('zh-TW'));
const fmtM = v => (v == null || v === '' ? '<span class="placeholder">待回填</span>' : 'NT$ ' + Math.round(Number(v)).toLocaleString('zh-TW'));
const fmtR = v => (v == null ? '—' : (v * 100).toFixed(2) + '%'); // 分母為零 → 破折號
const fmtC = v => (v == null ? '—' : 'NT$ ' + Number(v).toFixed(1));
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('sv-SE'); };

const S = { me: null, schema: null, roles: {}, users: [], cache: {} };
const STATUS = { draft: '草稿', assigned: '指派製作中', review: '待審核', revise: '退修', approved: '已核准', scheduled: '已排程', published: '已發布', reported: '已回填成效' };
const STATUS_CLASS = { draft: 'hint', assigned: '', review: 'warn', revise: 'err', approved: 'green', scheduled: 'green', published: 'deep', reported: 'deep' };
const FLOW = ['draft', 'assigned', 'review', 'approved', 'scheduled', 'published', 'reported'];
const ACTIONS = { assign: '指派', submit: '送審', approve: '核准', reject: '退修', schedule: '排程', publish: '標記已發布', report: '成效已回填' };
const ACTION_FROM = { assign: ['draft'], submit: ['draft', 'assigned', 'revise'], approve: ['review'], reject: ['review'], schedule: ['approved'], publish: ['approved', 'scheduled'], report: ['published'] };
const ADMIN_ACTIONS = ['assign', 'approve', 'reject'];

// ── API ──
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'nth' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (r.status === 401) { S.me = null; renderLogin(); throw new Error('請重新登入'); }
  if (r.status === 428) { renderChangePw(true); throw new Error('請先更改密碼'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || '發生錯誤');
  return data;
}
function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(t._t); t._t = setTimeout(() => (t.className = ''), 2600); }
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { if (!/重新登入|更改密碼/.test(e.message)) toast(e.message, true); } };

const isAdmin = () => S.me?.role === 'admin';
const userName = id => S.users.find(u => u.id === id)?.name || (id ? `#${id}` : '');
async function opts(entity) {
  if (!S.schema[entity]) return [];
  if (!S.cache[entity]) S.cache[entity] = await api('GET', '/api/' + entity);
  return S.cache[entity];
}
const titleOf = (entity, r) => r ? (r[S.schema[entity]?.title] || `#${r.id}`) : '';
const invalidate = () => { S.cache = {}; };

// ── 登入 ──
function renderLogin() {
  $('#app').innerHTML = `<div class="login"><form class="card" id="loginForm">
    <div class="logo"><div class="dot">鄰</div><div><b>鄰近健康</b><div class="hint">行銷社群系統</div></div></div>
    <label class="f"><span>Email</span><input name="email" type="email" autocomplete="username" required></label><br>
    <label class="f"><span>密碼</span><input name="password" type="password" autocomplete="current-password" required></label><br>
    <button class="btn primary" style="width:100%;justify-content:center">登入</button>
    <p class="hint" style="margin-top:14px">帳號由管理員建立。忘記密碼請聯絡管理員重設。</p></form></div><div class="footer-band"></div>`;
  $('#loginForm').addEventListener('submit', guard(async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const r = await api('POST', '/api/login', f);
    if (r.must_change) renderChangePw(true); else boot();
  }));
}
function renderChangePw(forced) {
  $('#app').innerHTML = `<div class="login"><form class="card" id="pwForm">
    <h2>${forced ? '首次登入，請設定新密碼' : '更改密碼'}</h2>
    <label class="f"><span>目前（臨時）密碼</span><input name="old" type="password" required autocomplete="current-password"></label><br>
    <label class="f"><span>新密碼（至少 10 碼，含英文與數字）</span><input name="new" type="password" required minlength="10" autocomplete="new-password"></label><br>
    <label class="f"><span>再輸入一次</span><input name="new2" type="password" required autocomplete="new-password"></label><br>
    <div class="btns"><button class="btn primary">儲存</button>${forced ? '' : '<a class="btn" href="#/home">取消</a>'}</div></form></div>`;
  $('#pwForm').addEventListener('submit', guard(async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.new !== f.new2) throw new Error('兩次輸入的新密碼不同');
    await api('POST', '/api/change-password', f); toast('密碼已更新'); location.hash = '#/home'; boot();
  }));
}

// ── 外框與導覽 ──
function navItems() {
  const s = S.schema, r = S.me.role;
  const g = [];
  g.push(['工作', [['#/home', '首頁'], s.contents && ['#/calendar', '行事曆'], s.contents && ['#/list/contents', '內容與排程'], s.assets && ['#/list/assets', '素材交付'], s.projects && ['#/list/projects', '專案']]]);
  g.push(['渠道與合作', [s.ads && ['#/ads', '廣告與 A/B'], s.partners && ['#/list/partners', '創作者與品牌合作'], s.rights && ['#/list/rights', '素材使用權'], s.faqs && ['#/list/faqs', 'FAQ 與話術']]]);
  g.push(['成果', [s.outcomes && ['#/list/outcomes', '業務成果'], r !== 'cs' && ['#/dashboard', '儀表板']]]);
  if (r === 'admin' || r === 'boss') g.push(['管理', [isAdmin() && ['#/import', '資料匯入'], ['#/integrations', '平台串接'], isAdmin() && ['#/users', '帳號與權限'], isAdmin() && ['#/audit', '操作紀錄']]]);
  return g.map(([t, items]) => [t, items.filter(Boolean)]).filter(([, i]) => i.length);
}
function shell(html) {
  const h = location.hash || '#/home';
  $('#app').innerHTML = `<div class="shell" id="shell">
    <aside class="side"><div class="brandmark"><div class="dot">鄰</div><div><b>鄰近健康</b><small>行銷社群系統</small></div></div>
      <nav class="nav">${navItems().map(([t, items]) => `<div class="nav-group">${t}</div>` + items.map(([href, label]) => `<a href="${href}" class="${h.startsWith(href) ? 'on' : ''}">${label}</a>`).join('')).join('')}</nav>
      <div class="userbox"><div><b>${esc(S.me.name)}</b>｜${esc(S.me.role_label)}</div><div style="margin-top:6px"><a href="#/password">更改密碼</a><a href="#" data-act="logout">登出</a></div></div>
    </aside>
    <div><div class="topbar"><button data-act="menu" aria-label="選單">☰</button><b>鄰近健康</b><span style="margin-left:auto;font-size:13px;opacity:.85">${esc(S.me.name)}</span></div>
    <main class="main" id="main">${html}</main></div></div>`;
}
const pageHead = (title, sub, actions = '') => `<div class="pagehead"><div><h1>${title}</h1>${sub ? `<div class="hint">${sub}</div>` : ''}</div><div class="btns">${actions}</div></div>`;

// ── 欄位顯示 ──
function show(f, v, row) {
  if (v === undefined) return '<span class="placeholder">（無權限）</span>';
  if (v === null || v === '') return f.metric ? '<span class="placeholder">待回填</span>' : '<span class="placeholder">—</span>';
  switch (f.type) {
    case 'status': return `<span class="pill ${STATUS_CLASS[v]}">${STATUS[v] || esc(v)}</span>`;
    case 'bool': return v ? '<span class="pill green">是</span>' : '<span class="pill hint">否</span>';
    case 'money': return fmtM(v);
    case 'number': return Number(v).toLocaleString('zh-TW');
    case 'user': return esc(userName(v));
    case 'project': { const p = (S.cache.projects || []).find(p => p.id === v); return p ? `<a href="#/project/${v}">${esc(p.name)}</a>` : `#${v}`; }
    case 'ref': { const r = (S.cache[f.ref] || []).find(x => x.id === v); return `<a href="#/view/${f.ref}/${v}">${esc(r ? titleOf(f.ref, r) : '#' + v)}</a>`; }
    case 'url': return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(String(v).replace(/^https?:\/\//, '').slice(0, 40))}↗</a>`;
    case 'datetime': return esc(String(v).replace('T', ' '));
    default: return esc(v);
  }
}
function visibleIf(f, row) { return !f.showIf || Object.entries(f.showIf).every(([k, vals]) => vals.includes(row[k])); }
async function preloadRefs(entity) {
  const keys = new Set(['projects']);
  for (const f of S.schema[entity].fields) if (f.type === 'ref') keys.add(f.ref);
  await Promise.all([...keys].map(k => opts(k).catch(() => [])));
}

// ── 通用列表 ──
const LIST_TABS = {
  contents: [['', '全部'], ['social', '社群與短影音'], ['LINE OA', 'LINE OA'], ['SHOPLINE Blog', 'SEO Blog']],
};
async function pageList(entity, q) {
  const def = S.schema[entity];
  if (!def) return shell('<div class="empty">沒有權限</div>');
  await preloadRefs(entity);
  const tab = q.get('tab') || '';
  let rows = await api('GET', `/api/${entity}`);
  if (entity === 'contents' && tab) rows = rows.filter(r => tab === 'social' ? ['Facebook', 'Instagram', 'Threads'].includes(r.channel) : r.channel === tab);
  const cols = def.fields.filter(f => f.list);
  const filterable = cols.filter(f => ['select', 'status', 'user', 'project'].includes(f.type));
  const fq = Object.fromEntries([...q.entries()]);
  for (const f of filterable) if (fq[f.key]) rows = rows.filter(r => fq[f.key] === 'none' ? r[f.key] == null : String(r[f.key] ?? '') === fq[f.key]);
  if (fq.q) rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(fq.q.toLowerCase()));
  const filterHtml = filterable.map(f => {
    let o = f.type === 'status' ? f.options : f.type === 'user' ? S.users.map(u => [u.id, u.name]) : f.type === 'project' ? [['none', '（日常）'], ...(S.cache.projects || []).map(p => [p.id, p.name])] : f.options.map(x => [x, x]);
    return `<select data-filter="${f.key}"><option value="">${esc(f.label)}：全部</option>${o.map(([v, l]) => `<option value="${esc(v)}" ${String(fq[f.key] ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }).join('');
  const tabs = LIST_TABS[entity] ? `<div class="tabs">${LIST_TABS[entity].map(([v, l]) => `<a href="#/list/${entity}${v ? '?tab=' + encodeURIComponent(v) : ''}" class="${tab === v ? 'on' : ''}">${l}</a>`).join('')}</div>` : '';
  const actions = (def.perms.create ? `<a class="btn primary" href="#/edit/${entity}/new${tab && tab !== 'social' ? '?channel=' + encodeURIComponent(tab) : ''}">＋ 新增</a>` : '') + (S.me.role !== 'cs' ? `<a class="btn" href="/api/export/${entity}">匯出 CSV</a>` : '');
  shell(pageHead(def.label, `${rows.length} 筆`, actions) + tabs +
    `<div class="filters"><input type="search" placeholder="搜尋…" data-filter="q" value="${esc(fq.q || '')}">${filterHtml}</div>` +
    tableHtml(entity, cols, rows));
}
function tableHtml(entity, cols, rows, extraCols = []) {
  if (!rows.length) return '<div class="card empty">目前沒有資料</div>';
  return `<div class="tablewrap"><table class="t cards"><thead><tr>${cols.map(f => `<th class="${['number', 'money'].includes(f.type) ? 'num' : ''}">${esc(f.label)}</th>`).join('')}${extraCols.map(c => `<th>${c[0]}</th>`).join('')}${entity === 'rights' ? '<th>授權狀態</th>' : ''}</tr></thead><tbody>
    ${rows.map(r => `<tr class="click" data-go="#/view/${entity}/${r.id}">${cols.map(f => `<td data-l="${esc(f.label)}" class="${['number', 'money'].includes(f.type) ? 'num' : ''}">${show(f, r[f.key], r)}</td>`).join('')}${extraCols.map(c => `<td data-l="${c[0]}">${c[1](r)}</td>`).join('')}${entity === 'rights' ? `<td data-l="授權狀態">${rightPill(r._status)}</td>` : ''}</tr>`).join('')}
  </tbody></table></div>`;
}
const rightPill = s => `<span class="pill ${s === '有效' ? 'green' : s === '已到期' ? 'err' : 'warn'}">${esc(s)}</span>`;

// ── 檢視 ──
async function pageView(entity, id) {
  const def = S.schema[entity];
  if (!def) return shell('<div class="empty">沒有權限</div>');
  await preloadRefs(entity);
  const d = await api('GET', `/api/${entity}/${id}`);
  const r = d.row;
  const fields = def.fields.filter(f => visibleIf(f, r));
  const info = fields.filter(f => !f.metric), metrics = fields.filter(f => f.metric);
  let actions = r._can_edit ? `<a class="btn primary" href="#/edit/${entity}/${id}">編輯</a>` : '';
  if (isAdmin()) actions += `<button class="btn danger" data-act="delete" data-entity="${entity}" data-id="${id}">刪除</button>`;
  let flow = '';
  if (entity === 'contents') {
    const idx = FLOW.indexOf(r.status === 'revise' ? 'assigned' : r.status);
    flow = `<div class="flow">${FLOW.map((s, i) => `<span class="${s === r.status ? 'cur' : i < idx ? 'done' : ''}">${STATUS[s]}</span>`).join('')}${r.status === 'revise' ? '<span class="cur" style="background:var(--err)">退修中</span>' : ''}</div>`;
    const avail = Object.keys(ACTIONS).filter(a => ACTION_FROM[a].includes(r.status) && (ADMIN_ACTIONS.includes(a) ? isAdmin() : r._can_edit));
    actions = avail.map(a => `<button class="btn ${a === 'approve' ? 'primary' : ''}" data-act="flow" data-flow="${a}" data-id="${id}">${ACTIONS[a]}</button>`).join('') + actions;
  }
  const rel = [];
  if (d.related.same_topic?.length) rel.push(`<div class="card"><h3>同主題其他渠道版本</h3><ul class="list-plain">${d.related.same_topic.map(x => `<li><span class="chip">${esc(x.channel)}</span><a href="#/view/contents/${x.id}">${esc(x.title)}</a><span class="pill ${STATUS_CLASS[x.status]}">${STATUS[x.status]}</span></li>`).join('')}</ul></div>`);
  if (d.related.milestones) rel.push(subTable('milestones', d.related.milestones, `project_id=${id}`, '里程碑'));
  if (d.related.deliverables) rel.push(subTable('deliverables', d.related.deliverables, `partner_id=${id}`, '交付項目'));
  if (d.related.rights) rel.push(subTable('rights', d.related.rights, `partner_id=${id}`, '素材使用權'));
  if (d.related.children?.length) rel.push(`<div class="card"><h3>下層</h3>${tableHtml('ads', S.schema.ads.fields.filter(f => f.list), d.related.children)}</div>`);
  const canComment = !['boss', 'pitcher'].includes(S.me.role);
  const extra = entity === 'ads' ? `<dt>連結 CPC</dt><dd>${'_cpc' in r ? fmtC(r._cpc) : '<span class="placeholder">（無權限）</span>'}</dd><dt>連結 CTR</dt><dd>${fmtR(r._ctr)}</dd>`
    : entity === 'rights' ? `<dt>授權狀態</dt><dd>${rightPill(r._status)}</dd>` : '';
  shell(pageHead(esc(titleOf(entity, r)), `${def.label}${entity === 'contents' ? '｜' + (r.project_id ? '專案檔期' : '日常營運') : ''}`, actions + (entity === 'projects' ? `<a class="btn" href="#/project/${id}">專案總覽</a>` : '')) + flow +
    `<div class="grid g2"><div class="card"><h3>基本資料</h3><dl class="kv">${info.map(f => `<dt>${esc(f.label)}</dt><dd>${show(f, r[f.key], r)}</dd>`).join('')}${extra}</dl></div>
     <div class="grid">${metrics.length ? `<div class="card"><h3>成效</h3><dl class="kv">${metrics.map(f => `<dt>${esc(f.label)}</dt><dd>${show(f, r[f.key], r)}</dd>`).join('')}${entity === 'contents' ? `<dt>連結 CTR</dt><dd>${fmtR(r.impressions ? (r.link_clicks ?? 0) / r.impressions : null)}</dd>` : ''}</dl><p class="hint">更新時間：${esc(r.updated_at)}</p></div>` : ''}
     ${rel.join('')}
     <div class="card"><h3>附件</h3>${d.attachments.length ? `<ul class="list-plain">${d.attachments.map(a => `<li><a href="/api/attachments/${a.id}">${esc(a.filename)}</a><span class="date">${(a.size / 1024).toFixed(0)} KB</span></li>`).join('')}</ul>` : '<div class="empty">沒有附件</div>'}
       ${r._can_edit ? `<label class="btn sm" style="margin-top:8px">上傳附件<input type="file" hidden data-upload="${entity}:${id}"></label>` : ''}</div>
     <div class="card"><h3>留言</h3>${d.comments.map(c => `<div class="comment"><b>${esc(c.user_name)}</b> <span class="hint">${esc(c.created_at)}</span><div>${esc(c.body)}</div></div>`).join('') || '<div class="empty">尚無留言</div>'}
       ${canComment ? `<form id="cmtForm" style="margin-top:10px"><textarea name="body" placeholder="留言…" required style="min-height:64px"></textarea><button class="btn sm primary" style="margin-top:6px">送出</button></form>` : ''}</div>
     ${d.versions.length ? `<div class="card"><h3>版本紀錄</h3>${d.versions.map(v => `<div class="comment"><b>${esc(v.user_name)}</b> <span class="hint">${esc(v.created_at)}｜${esc(v.note)}</span><div class="hint">${Object.entries(v.snapshot).map(([k, c]) => `${esc(def.fields.find(f => f.key === k)?.label || k)}：${esc(String(c.from ?? '—').slice(0, 40))} → ${esc(String(c.to ?? '—').slice(0, 40))}`).join('<br>')}</div></div>`).join('')}</div>` : ''}
     </div></div>`);
  const cf = $('#cmtForm');
  if (cf) cf.addEventListener('submit', guard(async e => { e.preventDefault(); await api('POST', '/api/comments', { entity, entity_id: id, body: e.target.body.value }); route(); }));
}
function subTable(entity, rows, preset, title) {
  const def = S.schema[entity]; if (!def) return '';
  return `<div class="card"><div class="pagehead" style="margin:0 0 8px"><h3 style="margin:0">${title}</h3>${def.perms.create ? `<a class="btn sm" href="#/edit/${entity}/new?${preset}">＋ 新增</a>` : ''}</div>${tableHtml(entity, def.fields.filter(f => f.list && !f.key.endsWith('_id') || f.key === 'title'), rows)}</div>`;
}

// ── 編輯表單 ──
async function pageEdit(entity, id, q) {
  const def = S.schema[entity];
  if (!def) return shell('<div class="empty">沒有權限</div>');
  await preloadRefs(entity);
  const isNew = id === 'new';
  const row = isNew ? Object.fromEntries([...q.entries()]) : (await api('GET', `/api/${entity}/${id}`)).row;
  const ownerKey = { contents: 'assignee_id', assets: 'owner_id', outcomes: 'assignee_id', partners: 'owner_id', projects: 'owner_id' }[entity];
  const editable = f => !f.readonly && !(f.finance && !isAdmin()) && !(f.key === ownerKey && !isAdmin()) && !(f.private && !isNew && !(f.key in row));
  const input = async f => {
    const v = row[f.key] ?? '';
    const name = `name="${f.key}" ${f.required ? 'required' : ''}`;
    if (f.type === 'textarea') return `<textarea ${name}>${esc(v)}</textarea>`;
    if (f.type === 'bool') return `<div class="check"><input type="checkbox" ${name} ${Number(v) ? 'checked' : ''}><span class="hint">是</span></div>`;
    if (f.type === 'select' || f.type === 'status') return `<select ${name}><option value="">—</option>${f.options.map(o => { const [val, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
    if (f.type === 'user') return `<select ${name}><option value="">—</option>${S.users.map(u => `<option value="${u.id}" ${String(v) === String(u.id) ? 'selected' : ''}>${esc(u.name)}（${esc(S.roles[u.role])}）</option>`).join('')}</select>`;
    if (f.type === 'project') return `<select ${name}><option value="">${entity === 'contents' ? '（日常營運）' : '—'}</option>${(S.cache.projects || []).map(p => `<option value="${p.id}" ${String(v) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
    if (f.type === 'ref') {
      let list = S.cache[f.ref] || [];
      if (f.ref === 'rights') list = list.filter(x => x._status === '有效' || String(x.id) === String(v));
      if (f.ref === entity) list = list.filter(x => String(x.id) !== String(id));
      return `<select ${name}><option value="">—</option>${list.map(x => `<option value="${x.id}" ${String(v) === String(x.id) ? 'selected' : ''}>${esc(titleOf(f.ref, x))}${f.ref === 'contents' ? '｜' + esc(x.channel) : ''}</option>`).join('')}</select>${f.ref === 'rights' ? '<div class="hint">用途未確認或已到期的素材不會出現在選單</div>' : ''}`;
    }
    const t = { number: 'number', money: 'number', date: 'date', datetime: 'datetime-local', url: 'url' }[f.type] || 'text';
    return `<input type="${t}" ${name} value="${esc(f.type === 'datetime' ? String(v).replace(' ', 'T').slice(0, 16) : v)}" ${['number', 'money'].includes(f.type) ? 'step="any" min="0"' : ''}>`;
  };
  const fields = def.fields.filter(editable);
  const info = fields.filter(f => !f.metric), metric = fields.filter(f => f.metric);
  const html = async list => (await Promise.all(list.map(async f => `<label class="f ${f.type === 'textarea' ? 'wide' : ''}" data-key="${f.key}" ${f.showIf ? `data-showif='${esc(JSON.stringify(f.showIf))}'` : ''}><span>${esc(f.label)}${f.required ? ' <em>*</em>' : ''}${f.external ? ' <span class="chip">對外</span>' : ''}</span>${await input(f)}</label>`))).join('');
  const reapprove = entity === 'contents' && !isNew && ['approved', 'scheduled', 'published', 'reported'].includes(row.status);
  shell(pageHead(isNew ? `新增${def.label}` : `編輯：${esc(titleOf(entity, row))}`, isNew && entity === 'contents' ? '新內容會以「草稿」建立，之後在內容頁送審' : '') +
    (reapprove ? '<div class="alert warn">此內容已核准。修改標示「對外」的欄位（文案、素材、CTA、SEO 標題／描述）會自動退回「待審核」。</div>' : '') +
    `<form class="card" id="editForm"><div class="formgrid">${await html(info)}${metric.length ? '<div class="section-t">成效回填（空白＝待回填，0＝實際為零）</div>' + await html(metric) : ''}</div>
     <div class="btns" style="margin-top:16px"><button class="btn primary">儲存</button><a class="btn" href="${isNew ? '#/list/' + entity : '#/view/' + entity + '/' + id}">取消</a></div></form>`);
  const form = $('#editForm');
  const applyShowIf = () => $$('[data-showif]', form).forEach(el => {
    const cond = JSON.parse(el.dataset.showif);
    el.hidden = !Object.entries(cond).every(([k, vals]) => vals.includes(form.elements[k]?.value));
  });
  form.addEventListener('change', applyShowIf); applyShowIf();
  form.addEventListener('submit', guard(async e => {
    e.preventDefault();
    const data = {};
    for (const f of fields) {
      const el = form.elements[f.key]; if (!el) continue;
      if (el.closest('[hidden]')) continue;
      data[f.key] = f.type === 'bool' ? el.checked : el.value;
    }
    if (isNew) {
      const r = await api('POST', `/api/${entity}`, data); invalidate(); toast('已建立');
      const parent = def.parent && data[def.parent];
      location.hash = parent ? `#/view/${def.parent === 'project_id' ? 'projects' : 'partners'}/${parent}` : `#/view/${entity}/${r.id}`;
    } else {
      const r = await api('PUT', `/api/${entity}/${id}`, data); invalidate();
      toast(r.re_review ? '已儲存，內容已退回待審核' : '已儲存'); location.hash = `#/view/${entity}/${id}`;
    }
  }));
}

// ── 首頁 ──
async function pageHome() {
  const d = await api('GET', '/api/home');
  const li = x => `<li>${x.kind ? `<span class="pill hint">${esc(x.kind)}</span>` : ''}${x.channel ? `<span class="chip">${esc(x.channel)}</span>` : ''}<a href="#/view/${x.entity}/${x.id}">${esc(x.title)}</a>${x.status && STATUS[x.status] ? `<span class="pill ${STATUS_CLASS[x.status]}">${STATUS[x.status]}</span>` : ''}<span class="date">${esc(String(x.date || '').replace('T', ' ').slice(0, 16))}</span></li>`;
  const box = (t, list, emptyMsg) => `<div class="card"><h2>${t} <span class="pill ${list.length ? 'green' : 'hint'}">${list.length}</span></h2>${list.length ? `<ul class="list-plain">${list.slice(0, 12).map(li).join('')}</ul>` : `<div class="empty">${emptyMsg}</div>`}</div>`;
  shell(pageHead(`你好，${esc(S.me.name)}`, `${today()}｜${esc(S.me.role_label)}`, S.schema.contents?.perms.create ? '<a class="btn primary" href="#/edit/contents/new">＋ 新增內容</a>' : '') +
    `<div class="grid g2">${box('待我處理', d.mine, '沒有待處理項目')}${box('待核准', d.review, '沒有待核准內容')}${box('近期交件（7 天內）', d.due, '近期沒有交件')}${box('未來七天上線', d.upcoming, '未來七天沒有排程')}</div>`);
}

// ── 行事曆 ──
async function pageCalendar(q) {
  await opts('projects');
  const m = q.get('m') || today().slice(0, 7);
  const first = new Date(m + '-01T00:00:00');
  const start = addDays(m + '-01', -((first.getDay() + 6) % 7));
  const end = addDays(start, 41);
  const fq = Object.fromEntries([...q.entries()]);
  const params = new URLSearchParams({ ...fq, from: start, to: end }); params.delete('m');
  const evs = await api('GET', '/api/calendar?' + params);
  const byDay = {}; evs.forEach(e => (byDay[e.date] ||= []).push(e));
  const prev = new Date(first); prev.setMonth(prev.getMonth() - 1);
  const next = new Date(first); next.setMonth(next.getMonth() + 1);
  const mk = d => d.toLocaleDateString('sv-SE').slice(0, 7);
  const qs = o => '#/calendar?' + new URLSearchParams({ ...fq, ...o });
  const sel = (key, label, options) => `<select data-filter="${key}"><option value="">${label}：全部</option>${options.map(([v, l]) => `<option value="${esc(v)}" ${fq[key] === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const chans = S.schema.contents.fields.find(f => f.key === 'channel').options;
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    cells += `<div class="day ${d.slice(0, 7) !== m ? 'out' : ''} ${d === today() ? 'today' : ''}"><span class="n">${Number(d.slice(8))}</span>${(byDay[d] || []).map(e => `<a class="ev st-${e.status}" href="#/view/contents/${e.id}" title="${esc(e.channel + '｜' + e.title + '｜' + STATUS[e.status])}">${esc(e.time ? e.time + ' ' : '')}${esc(e.title)}</a>`).join('')}</div>`;
  }
  const agenda = Object.keys(byDay).filter(d => d.slice(0, 7) === m).sort().map(d => `<div class="card" style="margin-bottom:8px"><h3>${d}</h3><ul class="list-plain">${byDay[d].map(e => `<li><span class="chip">${esc(e.channel)}</span><a href="#/view/contents/${e.id}">${esc(e.title)}</a><span class="pill ${STATUS_CLASS[e.status]}">${STATUS[e.status]}</span></li>`).join('')}</ul></div>`).join('') || '<div class="card empty">本月沒有排程</div>';
  shell(pageHead('行事曆', '日常營運與專案檔期共用', `<a class="btn" href="${qs({ m: mk(prev) })}">‹</a><span class="btn ghost">${m.replace('-', ' 年 ')} 月</span><a class="btn" href="${qs({ m: mk(next) })}">›</a><a class="btn" href="${qs({ m: today().slice(0, 7) })}">本月</a>`) +
    `<div class="filters">${sel('scope', '類型', [['daily', '日常'], ['project', '專案檔期']])}${sel('channel', '渠道', chans.map(c => [c, c]))}${sel('status', '狀態', Object.entries(STATUS))}${sel('assignee_id', '負責人', S.users.map(u => [u.id, u.name]))}
      <input type="search" data-filter="audience" placeholder="受眾" value="${esc(fq.audience || '')}"><input type="search" data-filter="tag" placeholder="標籤" value="${esc(fq.tag || '')}"><input type="search" data-filter="topic" placeholder="主題" value="${esc(fq.topic || '')}"></div>
    <div class="cal">${['一', '二', '三', '四', '五', '六', '日'].map(d => `<div class="dow">${d}</div>`).join('')}${cells}</div><div class="agenda">${agenda}</div>`);
}

// ── 廣告與 A/B ──
async function pageAds(q) {
  await opts('projects');
  const tab = q.get('tab') || 'ads';
  const tabs = `<div class="tabs"><a href="#/ads" class="${tab === 'ads' ? 'on' : ''}">廣告（活動／組合／廣告）</a>${S.schema.abtests ? `<a href="#/ads?tab=ab" class="${tab === 'ab' ? 'on' : ''}">A/B 測試</a>` : ''}</div>`;
  if (tab === 'ab') {
    const rows = await api('GET', '/api/abtests');
    return shell(pageHead('廣告與 A/B 測試', '', S.schema.abtests.perms.create ? '<a class="btn primary" href="#/edit/abtests/new">＋ 新增測試</a>' : '') + tabs + tableHtml('abtests', S.schema.abtests.fields.filter(f => f.list), rows));
  }
  const rows = await api('GET', '/api/ads');
  // 階層排序：活動 → 組合 → 廣告
  const kids = id => rows.filter(r => r.parent_id === id);
  const ordered = []; const walk = (r, d) => { ordered.push({ ...r, _d: d }); kids(r.id).forEach(k => walk(k, d + 1)); };
  rows.filter(r => !r.parent_id || !rows.some(x => x.id === r.parent_id)).forEach(r => walk(r, 0));
  const fin = S.me.role !== 'editor';
  const cols = S.schema.ads.fields.filter(f => f.list && f.key !== 'name');
  shell(pageHead('廣告與 A/B 測試', '日預算依設定層級顯示；儀表板加總時不重複計算', (S.schema.ads.perms.create ? '<a class="btn primary" href="#/edit/ads/new">＋ 新增</a>' : '') + '<a class="btn" href="/api/export/ads">匯出 CSV</a>') + tabs +
    (ordered.length ? `<div class="tablewrap"><table class="t cards"><thead><tr><th>名稱</th>${cols.map(f => `<th class="${['money', 'number'].includes(f.type) ? 'num' : ''}">${esc(f.label)}</th>`).join('')}<th class="num">連結 CTR</th>${fin ? '<th class="num">連結 CPC</th>' : ''}</tr></thead><tbody>
    ${ordered.map(r => `<tr class="click" data-go="#/view/ads/${r.id}"><td style="padding-left:${10 + r._d * 18}px">${r._d ? '└ ' : ''}${esc(r.name)}</td>${cols.map(f => `<td data-l="${esc(f.label)}" class="${['money', 'number'].includes(f.type) ? 'num' : ''}">${show(f, r[f.key], r)}</td>`).join('')}<td data-l="連結 CTR" class="num">${fmtR(r._ctr)}</td>${fin ? `<td data-l="連結 CPC" class="num">${fmtC(r._cpc)}</td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<div class="card empty">尚無廣告資料。可手動新增、CSV 匯入，或於平台串接啟用 Meta 同步。</div>'));
}

// ── 專案總覽 ──
async function pageProject(id) {
  const d = await api('GET', `/api/projects/${id}/summary`);
  const p = d.project, db = d.dashboard;
  const c = d.counts;
  shell(pageHead(esc(p.name), `${esc(p.start_date || '')} ～ ${esc(p.end_date || '')}｜${esc(p.status || '')}`, `<a class="btn" href="#/view/projects/${id}">專案資料與里程碑</a><a class="btn" href="#/calendar?scope=project">行事曆</a>`) +
    (p.goal ? `<div class="card" style="margin-bottom:14px"><h3>目標</h3><div style="white-space:pre-wrap">${esc(p.goal)}</div></div>` : '') +
    `<div class="grid g4 stats">${[['內容', c.contents, `#/list/contents?project_id=${id}`], ['廣告', c.ads, '#/ads'], ['合作', c.partners, `#/list/partners?project_id=${id}`], ['成果', c.outcomes, `#/list/outcomes?project_id=${id}`]].filter(x => x[1] != null).map(([l, n, h]) => `<a class="card stat" href="${h}"><div class="label">${l}</div><div class="val">${n}</div></a>`).join('')}</div><br>` +
    dashboardBody(db));
}

// ── 儀表板 ──
async function pageDashboard(q) {
  await opts('projects');
  const fq = Object.fromEntries([...q.entries()]);
  const d = await api('GET', '/api/dashboard?' + new URLSearchParams(fq));
  const sel = (key, label, options) => `<select data-filter="${key}"><option value="">${label}：全部</option>${options.map(([v, l]) => `<option value="${esc(v)}" ${fq[key] === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  shell(pageHead('儀表板', `資料產生於 ${new Date(d.generated_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`, '') +
    `<div class="filters"><input type="date" data-filter="from" value="${esc(fq.from || '')}" title="起"><input type="date" data-filter="to" value="${esc(fq.to || '')}" title="訖">
      ${sel('scope', '日常／專案', [['daily', '日常'], ['project', '專案']])}${sel('project_id', '專案', (S.cache.projects || []).map(p => [p.id, p.name]))}${sel('channel', '渠道', S.schema.contents.fields.find(f => f.key === 'channel').options.map(c => [c, c]))}${sel('paid', '自然／付費', [['organic', '自然'], ['paid', '付費']])}
      <input type="search" data-filter="audience" placeholder="受眾" value="${esc(fq.audience || '')}"></div>` + dashboardBody(d));
  bindChartTips();
}
function dashboardBody(d) {
  const stat = (l, v, sub = '') => `<div class="card stat"><div class="label">${l}</div><div class="val">${v}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  const e = d.efficiency;
  const statusPills = Object.entries(d.status).map(([k, n]) => `<span class="pill ${k === '已回填' ? 'green' : k === '同步失敗' ? 'err' : k === '待回填' ? 'warn' : 'hint'}">${esc(k)} ${n}</span>`).join(' ') || '<span class="hint">此範圍沒有已發布內容</span>';
  return `<div class="card" style="margin-bottom:14px"><b>成效資料狀態</b>　${statusPills}
      <div class="hint" style="margin-top:6px">「待回填」＝尚未填寫；「0」＝實際為零；比率分母為零顯示「—」。${d.sources.map(s => `${s.platform === 'line' ? 'LINE OA' : 'Meta'}：${s.enabled ? (s.last_success ? '最後同步 ' + esc(s.last_success) : '尚未成功同步') : '未啟用'}${s.last_error ? '（失敗：' + esc(s.last_error) + '）' : ''}`).join('｜')}</div></div>
    <h2>內容互動</h2><div class="grid g4 stats">${stat('連結點擊', fmtN(d.interaction.link_clicks))}${stat('連結 CTR', fmtR(d.interaction.ctr), '同口徑點擊 ÷ 曝光')}${stat('收藏', fmtN(d.interaction.saves))}${stat('分享', fmtN(d.interaction.shares))}</div><br>
    ${e ? `<h2>廣告與合作效率</h2><div class="grid g4 stats">${stat('廣告實際花費', fmtM(e.spend))}${stat('連結 CPC', fmtC(e.cpc), '花費 ÷ 連結點擊')}${stat('已歸因成果', e.outcome_count + ' 筆')}${stat('每筆有效成果成本', fmtC(e.cost_per_outcome), '花費 ÷ 已歸因成果')}</div>
      <div class="grid g4 stats" style="margin-top:14px">${stat('日預算（不重複加總）', fmtM(e.daily_budget))}${stat('合作費', fmtM(e.partner_fee))}${stat('商品成本', fmtM(e.partner_product_cost))}${stat('運費', fmtM(e.partner_shipping))}</div><br>` : ''}
    <div class="grid g2"><div class="card"><h2>品牌曝光（分平台）</h2><div class="tablewrap"><table class="t cards"><thead><tr><th>平台</th><th class="num">曝光</th><th class="num">觸及</th><th class="num">影片觀看</th></tr></thead><tbody>
      ${d.exposure.map(x => `<tr><td>${esc(x.channel)}</td><td data-l="曝光" class="num">${fmtN(x.impressions)}</td><td data-l="觸及" class="num">${x.reach == null && x.channel.includes('廣告') ? '<span class="hint">—</span>' : fmtN(x.reach)}</td><td data-l="影片觀看" class="num">${x.video_views == null && x.channel.includes('廣告') ? '<span class="hint">—</span>' : fmtN(x.video_views)}${x.video_def ? `<div class="hint">${esc(x.video_def)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div><p class="hint">觸及僅分平台呈現，不跨平台加總。</p></div>
     <div class="card"><h2>官網 SEO</h2><dl class="kv"><dt>搜尋曝光</dt><dd>${fmtN(d.seo.search_impressions)}</dd><dt>搜尋點擊</dt><dd>${fmtN(d.seo.search_clicks)}</dd><dt>搜尋 CTR</dt><dd>${fmtR(d.seo.search_ctr)}</dd><dt>自然搜尋流量</dt><dd>${fmtN(d.seo.organic_sessions)}</dd><dt>文章 CTA 點擊</dt><dd>${fmtN(d.seo.cta_clicks)}</dd></dl></div></div><br>
    <div class="card"><h2>業務成果</h2><div class="tablewrap"><table class="t cards"><thead><tr><th>類型</th><th class="num">總數</th><th class="num">已歸因</th><th class="num">未歸因（仍計入總數）</th><th class="num">待回填</th></tr></thead><tbody>
      ${d.outcomes.map(o => `<tr><td>${o.type}</td><td data-l="總數" class="num">${o.total}</td><td data-l="已歸因" class="num">${o.attributed}</td><td data-l="未歸因" class="num">${o.unattributed}</td><td data-l="待回填" class="num">${o.pending}</td></tr>`).join('')}</tbody></table></div></div><br>
    <div class="card"><h2>時間趨勢（每週）</h2>${d.trend.length ? `<div class="grid g3">${barChart(d.trend, 'impressions', '曝光')}${barChart(d.trend, 'link_clicks', '連結點擊')}${barChart(d.trend, 'outcomes', '業務成果')}</div>` : '<div class="empty">此範圍沒有資料</div>'}</div><br>
    <div class="card"><h2>單筆內容</h2>${d.drill.length ? `<div class="tablewrap"><table class="t cards"><thead><tr><th>內容</th><th>渠道</th><th>日期</th><th class="num">曝光</th><th class="num">連結點擊</th><th class="num">CTR</th><th>資料狀態</th><th>來源／更新</th></tr></thead><tbody>
      ${d.drill.map(r => `<tr class="click" data-go="#/view/contents/${r.id}"><td>${esc(r.title)}</td><td data-l="渠道">${esc(r.channel)}</td><td data-l="日期">${esc(r.date)}</td><td data-l="曝光" class="num">${fmtN(r.impressions)}</td><td data-l="連結點擊" class="num">${fmtN(r.link_clicks)}</td><td data-l="CTR" class="num">${fmtR(r.ctr)}</td><td data-l="資料狀態"><span class="pill ${r.metric_status === '已回填' ? 'green' : r.metric_status === '同步失敗' ? 'err' : 'warn'}">${esc(r.metric_status)}</span></td><td data-l="來源" class="hint">${esc(r.metric_source || '手動')}｜${esc(r.updated_at)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">此範圍沒有已發布內容</div>'}</div>`;
}
// 單一指標長條圖（小倍數，不用雙軸）
function barChart(data, key, label) {
  const W = 320, H = 170, pl = 40, pb = 22, pt = 10;
  const max = Math.max(1, ...data.map(d => d[key]));
  const nice = (() => { const p = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / p) * p; })();
  const bw = (W - pl - 6) / data.length;
  const y = v => pt + (H - pt - pb) * (1 - v / nice);
  const grid = [0, .5, 1].map(t => `<line class="gridl" x1="${pl}" x2="${W}" y1="${y(nice * t)}" y2="${y(nice * t)}"/><text class="axis" x="${pl - 4}" y="${y(nice * t) + 4}" text-anchor="end">${(nice * t).toLocaleString('zh-TW')}</text>`).join('');
  const bars = data.map((d, i) => { const h = Math.max(0, H - pb - y(d[key])); const x = pl + i * bw + 1; const w = Math.max(2, bw - 2);
    return `<rect class="bar" x="${x}" y="${H - pb - h}" width="${w}" height="${h}" rx="${Math.min(4, w / 2)}" data-tip="${esc(d.week)} 當週｜${esc(label)}：${d[key].toLocaleString('zh-TW')}"/><rect x="${pl + i * bw}" y="${pt}" width="${bw}" height="${H - pt - pb}" fill="transparent" data-tip="${esc(d.week)} 當週｜${esc(label)}：${d[key].toLocaleString('zh-TW')}"/>`; }).join('');
  const labels = [0, data.length - 1].filter((v, i, a) => a.indexOf(v) === i).map(i => `<text class="axis" x="${pl + i * bw + bw / 2}" y="${H - 6}" text-anchor="${i ? 'end' : 'start'}">${data[i].week.slice(5)}</text>`).join('');
  return `<div><h3>${label}</h3><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}每週趨勢">${grid}${bars}${labels}</svg></div>`;
}
function bindChartTips() {
  const tip = $('#tip');
  $$('[data-tip]').forEach(el => {
    el.addEventListener('mousemove', e => { tip.hidden = false; tip.textContent = el.dataset.tip; tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY - 30 + 'px'; });
    el.addEventListener('mouseleave', () => (tip.hidden = true));
  });
}

// ── 匯入 ──
async function pageImport() {
  shell(pageHead('資料匯入', 'CSV 匯入 → 預覽 → 只寫入無錯誤的列；重複匯入會以去重鍵更新既有資料') +
    `<div class="card"><div class="formgrid"><label class="f"><span>資料類型</span><select id="impEntity"><option value="outcomes">業務成果（去重：參照編號）</option><option value="ads">廣告（去重：平台 ID 或 名稱＋層級）</option><option value="contents">內容成效回填（去重：id 或 標題＋渠道）</option><option value="partners">創作者與品牌合作（去重：合作對象）</option><option value="faqs">FAQ（去重：問題）</option></select></label>
      <label class="f"><span>CSV 檔（第一列為欄位名稱，可用中文欄名）</span><input type="file" id="impFile" accept=".csv,text/csv"></label>
      <div class="wide hint" id="impHelp"></div></div>
      <p class="hint">Google Sheets：檔案 → 下載 → 逗號分隔值 (.csv) 後上傳。</p>
      <div class="btns"><button class="btn primary" data-act="imp-preview">預覽</button><button class="btn" data-act="imp-template">下載範本</button></div></div><br><div id="impResult"></div>`);
  const help = () => { const e = $('#impEntity').value; $('#impHelp').textContent = '可用欄位：' + S.schema[e].fields.map(f => f.label).join('、'); };
  $('#impEntity').addEventListener('change', help); help();
}
let lastCsv = '';
async function importPreview() {
  const file = $('#impFile').files[0]; if (!file) throw new Error('請選擇 CSV 檔');
  lastCsv = await file.text();
  const entity = $('#impEntity').value;
  const r = await api('POST', '/api/import/preview', { entity, csv: lastCsv });
  const cnt = a => r.items.filter(i => i.action === a).length;
  $('#impResult').innerHTML = `<div class="card"><h2>預覽</h2>${r.unknown.length ? `<div class="alert warn">以下欄位無法對應，將被忽略：${r.unknown.map(esc).join('、')}</div>` : ''}
    <p><span class="pill green">新增 ${cnt('create')}</span> <span class="pill">更新 ${cnt('update')}</span> <span class="pill err">錯誤 ${cnt('error')}</span></p>
    <div class="tablewrap"><table class="t cards"><thead><tr><th>列</th><th>動作</th><th>內容</th><th>錯誤</th></tr></thead><tbody>${r.items.map(i => `<tr><td>第 ${i.line} 列</td><td data-l="動作"><span class="pill ${i.action === 'error' ? 'err' : i.action === 'create' ? 'green' : ''}">${{ create: '新增', update: '更新 #' + i.existing_id, error: '略過' }[i.action]}</span></td><td data-l="內容" class="hint">${esc(Object.values(i.data).filter(v => v != null).slice(0, 4).join('｜'))}</td><td data-l="錯誤" style="color:var(--err)">${esc(i.errors.join('；'))}</td></tr>`).join('')}</tbody></table></div>
    <div class="btns" style="margin-top:12px"><button class="btn primary" data-act="imp-commit" ${cnt('create') + cnt('update') ? '' : 'disabled'}>確認匯入 ${cnt('create') + cnt('update')} 筆</button></div></div>`;
}

// ── 平台串接 ──
async function pageIntegrations(q) {
  const d = await api('GET', '/api/integrations');
  const L = d.integrations.find(i => i.platform === 'line'), M = d.integrations.find(i => i.platform === 'meta');
  const state = i => i.enabled ? '<span class="pill green">同步中</span>' : i.token_masked ? '<span class="pill warn">已授權・未啟用</span>' : '<span class="pill hint">未連結</span>';
  const admin = isAdmin();
  const block = (i, title, body) => `<div class="card"><div class="pagehead" style="margin:0 0 8px"><h2 style="margin:0">${title}</h2>${state(i)}</div>
    <dl class="kv"><dt>已連結帳號</dt><dd>${esc(i.account_name || i.account_id || '—')}</dd><dt>憑證</dt><dd>${esc(i.token_masked || '—')}</dd><dt>最後成功同步</dt><dd>${esc(i.last_success || '—')}</dd><dt>失敗原因</dt><dd>${i.last_error ? `<span style="color:var(--err)">${esc(i.last_error)}</span>` : '—'}</dd></dl>
    ${admin ? `<div style="margin-top:12px">${body}</div>` : ''}</div>`;
  const toggles = p => { const i = d.integrations.find(x => x.platform === p); return `${i.token_masked ? `<button class="btn ${i.enabled ? '' : 'primary'}" data-act="int-enable" data-p="${p}" data-on="${i.enabled ? 0 : 1}">${i.enabled ? '暫停同步' : '啟用同步'}</button><button class="btn danger" data-act="int-revoke" data-p="${p}">撤銷授權</button>` : ''}`; };
  const msg = q.get('meta_error') ? `<div class="alert err">Meta 授權失敗：${esc(q.get('meta_error'))}</div>` : q.get('meta') === 'ok' ? '<div class="alert ok">Meta 授權成功，請選擇廣告帳號後啟用。</div>' : '';
  shell(pageHead('平台串接與每日同步', '後台讀取已存資料，瀏覽與篩選不呼叫平台 API；例行同步不使用 AI（token 用量 0）', admin ? '<button class="btn primary" data-act="sync-now">立即補同步</button>' : '') + msg +
    `<div class="grid g2">${block(L, 'LINE OA', `<label class="f"><span>Channel Access Token（長期）</span><input type="password" id="lineToken" placeholder="${L.token_masked ? '已設定，輸入新值可更換' : '貼上 LINE Developers 的 Channel Access Token'}" autocomplete="off"></label>
      <div class="btns" style="margin-top:8px"><button class="btn" data-act="line-test">測試並確認官方帳號</button>${toggles('line')}</div>
      <p class="hint">OA Manager 發送而無法讀取單則成效時，請到內容頁手動回填或用 CSV 匯入。</p>`)}
    ${block(M, 'Meta 廣告', `${d.meta_app_configured ? '' : '<div class="alert warn">伺服器尚未設定 META_APP_ID / META_APP_SECRET。正式上線前需建立 Meta App 並完成資產驗證。</div>'}
      <div class="btns"><button class="btn" data-act="meta-connect">${M.token_masked ? '重新授權' : '透過 Meta 官方授權頁連接'}</button>${M.token_masked ? '<button class="btn" data-act="meta-accounts">選擇廣告帳號</button>' : ''}${toggles('meta')}</div><div id="metaAccounts"></div>
      <p class="hint">FB、IG、Threads 自然成效另行驗證後開放。</p>`)}</div><br>
    <div class="card"><h2>排程設定</h2>${admin ? `<form id="syncSet" class="filters">${d.on_vercel ? `<div class="hint" style="flex-basis:100%">部署在 Vercel：每日同步由 Vercel Cron 在台灣時間 06:00 前後執行（設定在 vercel.json）。</div><input type="hidden" name="sync_hour" value="${d.settings.sync_hour}">` : `<label class="f"><span>每日執行時刻（台灣時間，時）</span><input type="number" name="sync_hour" min="0" max="23" value="${d.settings.sync_hour}"></label>`}<label class="f"><span>重抓近期天數</span><input type="number" name="refetch_days" min="1" max="60" value="${d.settings.refetch_days}"></label><button class="btn" style="align-self:flex-end">儲存</button></form>` : `<p>每日 ${d.on_vercel ? '06:00 前後' : d.settings.sync_hour + ':00'} 執行，重抓近 ${d.settings.refetch_days} 天</p>`}
      <h3 style="margin-top:12px">同步紀錄</h3>${d.runs.length ? `<div class="tablewrap"><table class="t cards"><thead><tr><th>開始</th><th>平台</th><th>觸發</th><th>結果</th><th class="num">API 請求</th><th class="num">寫入筆數</th><th>錯誤</th></tr></thead><tbody>${d.runs.map(r => `<tr><td>${esc(r.started_at)}</td><td data-l="平台">${r.platform === 'line' ? 'LINE OA' : 'Meta'}</td><td data-l="觸發">${r.trigger === 'manual' ? '手動' : '排程'}</td><td data-l="結果"><span class="pill ${r.status === 'success' ? 'green' : r.status === 'failed' ? 'err' : 'warn'}">${{ success: '成功', failed: '失敗', running: '執行中' }[r.status]}</span></td><td data-l="API 請求" class="num">${r.requests ?? '—'}</td><td data-l="寫入" class="num">${r.rows ?? '—'}</td><td data-l="錯誤" class="hint">${esc(r.error || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">尚無同步紀錄</div>'}</div>`);
  const ss = $('#syncSet'); if (ss) ss.addEventListener('submit', guard(async e => { e.preventDefault(); await api('POST', '/api/integrations/settings', Object.fromEntries(new FormData(e.target))); toast('已儲存'); }));
}

// ── 帳號與權限 ──
async function pageUsers() {
  const [users, projects] = await Promise.all([api('GET', '/api/users'), opts('projects')]);
  const roleSel = (v, name = 'role') => `<select name="${name}">${Object.entries(S.roles).map(([k, l]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const scopeSel = (sel = []) => `<select name="scope" multiple size="${Math.min(5, Math.max(2, projects.length))}">${projects.map(p => `<option value="${p.id}" ${sel.includes(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`;
  shell(pageHead('帳號與權限', '停用、改角色或改專案範圍後，該帳號既有登入立即失效') +
    `<div class="card"><h2>新增帳號</h2><form id="newUser" class="formgrid"><label class="f"><span>姓名 <em>*</em></span><input name="name" required></label><label class="f"><span>Email <em>*</em></span><input name="email" type="email" required></label>
      <label class="f"><span>角色</span>${roleSel('editor')}</label><label class="f"><span>專案範圍（外部投手必填；小編／客服留空＝不限）</span>${projects.length ? scopeSel() : '<div class="hint">尚無專案</div>'}</label>
      <div class="wide"><button class="btn primary">建立並產生臨時密碼</button></div></form><div id="newPw"></div></div><br>
    <div class="tablewrap"><table class="t cards"><thead><tr><th>姓名</th><th>Email</th><th>角色</th><th>專案範圍</th><th>狀態</th><th>操作</th></tr></thead><tbody>
    ${users.map(u => `<tr data-uid="${u.id}"><td>${esc(u.name)}</td><td data-l="Email">${esc(u.email)}</td><td data-l="角色">${u.id === S.me.id ? esc(S.roles[u.role]) : roleSel(u.role, 'urole')}</td>
      <td data-l="專案範圍">${u.id === S.me.id ? '全部' : projects.length ? scopeSel(u.scope).replace('name="scope"', 'name="uscope"') : '—'}</td>
      <td data-l="狀態">${u.active ? (u.must_change ? '<span class="pill warn">待改密碼</span>' : '<span class="pill green">啟用</span>') : '<span class="pill err">停用</span>'}</td>
      <td data-l="操作"><div class="btns">${u.id === S.me.id ? '<span class="hint">本人</span>' : `<button class="btn sm" data-act="user-save">儲存</button><button class="btn sm" data-act="user-reset">重設密碼</button><button class="btn sm ${u.active ? 'danger' : ''}" data-act="user-active" data-on="${u.active ? 0 : 1}">${u.active ? '停用' : '啟用'}</button>`}</div></td></tr>`).join('')}
    </tbody></table></div>
    <p class="hint">權限摘要：管理員＝全部；老闆級＝全部唯讀（不含寄送地址、私人聯絡）；外部投手＝指定專案的核准素材、廣告、成效、財務與合作唯讀；小編＝建立草稿、編輯被指派項目、送審，看不到財務欄位；客服＝FAQ 話術、Blog 與 LINE OA 草稿、被指派的成果回填。</p>`);
  $('#newUser').addEventListener('submit', guard(async e => {
    e.preventDefault(); const f = e.target;
    const r = await api('POST', '/api/users', { name: f.name.value, email: f.email.value, role: f.role.value, scope: f.scope ? [...f.scope.selectedOptions].map(o => o.value) : [] });
    S.users = await api('GET', '/api/user-options');
    await pageUsers(); $('#newPw').innerHTML = `<div class="alert ok" style="margin-top:12px">帳號已建立。請以私訊提供臨時密碼（只顯示這一次）：<br><span class="codebox">${esc(r.temp_password)}</span></div>`;
  }));
}
async function pageAudit() {
  const rows = await api('GET', '/api/audit');
  const L = { login: '登入', login_fail: '登入失敗', create: '新增', update: '修改', delete: '刪除', export: '匯出', import: '匯入', user_create: '建立帳號', user_update: '修改帳號', user_disable: '停用帳號', user_reset_password: '重設密碼', change_password: '更改密碼', content_approve: '核准', content_reject: '退修', content_submit: '送審', content_assign: '指派', content_schedule: '排程', content_publish: '發布', content_report: '回填成效', outcome_assign: '成果指派', attachment_download: '下載附件', attachment_upload: '上傳附件', sync_manual: '手動同步' };
  shell(pageHead('操作紀錄', '帳號、權限、核准、匯出等操作（最近 500 筆）') + `<div class="tablewrap"><table class="t cards"><thead><tr><th>時間</th><th>人員</th><th>動作</th><th>對象</th><th>內容</th><th>IP</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.created_at)}</td><td data-l="人員">${esc(r.user_name || '—')}</td><td data-l="動作">${esc(L[r.action] || r.action)}</td><td data-l="對象">${r.entity && r.entity_id && S.schema[r.entity] ? `<a href="#/view/${r.entity}/${r.entity_id}">${esc(S.schema[r.entity].label)} #${r.entity_id}</a>` : esc(r.entity || '')}</td><td data-l="內容" class="hint" style="max-width:340px;word-break:break-all">${esc((r.detail || '').slice(0, 200))}</td><td data-l="IP" class="hint">${esc(r.ip || '')}</td></tr>`).join('')}</tbody></table></div>`);
}

// ── 路由 ──
async function route() {
  if (!S.me) return;
  const [p, qs] = (location.hash.slice(1) || '/home').split('?');
  const q = new URLSearchParams(qs || '');
  const parts = p.split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    switch (parts[0]) {
      case 'calendar': return await pageCalendar(q);
      case 'list': return await pageList(parts[1], q);
      case 'view': return await pageView(parts[1], parts[2]);
      case 'edit': return await pageEdit(parts[1], parts[2], q);
      case 'ads': return await pageAds(q);
      case 'project': return await pageProject(parts[1]);
      case 'dashboard': return await pageDashboard(q);
      case 'import': return await pageImport();
      case 'integrations': return await pageIntegrations(q);
      case 'users': return await pageUsers();
      case 'audit': return await pageAudit();
      case 'password': return renderChangePw(false);
      default: return await pageHome();
    }
  } catch (e) { if (!/重新登入|更改密碼/.test(e.message)) shell(`<div class="alert err">${esc(e.message)}</div><a class="btn" href="#/home">回首頁</a>`); }
}

// ── 事件（不使用 inline handler，符合 CSP）──
document.addEventListener('click', guard(async e => {
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('a,button,input,select')) { location.hash = go.dataset.go; return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act;
  if (act === 'menu') return $('#shell').classList.toggle('open');
  e.preventDefault();
  if (act === 'logout') { await api('POST', '/api/logout'); S.me = null; renderLogin(); return; }
  if (act === 'delete') { if (!confirm('確定刪除？此動作無法復原。')) return; await api('DELETE', `/api/${el.dataset.entity}/${el.dataset.id}`); invalidate(); toast('已刪除'); location.hash = '#/list/' + el.dataset.entity; return; }
  if (act === 'flow') {
    const a = el.dataset.flow; let note;
    if (a === 'reject') { note = prompt('退修原因：'); if (!note) return; }
    await api('POST', `/api/contents/${el.dataset.id}/action`, { action: a, note }); invalidate(); toast(ACTIONS[a] + '完成'); return route();
  }
  if (act === 'imp-preview') return importPreview();
  if (act === 'imp-commit') { const r = await api('POST', '/api/import/commit', { entity: $('#impEntity').value, csv: lastCsv }); invalidate(); $('#impResult').innerHTML = `<div class="alert ok">匯入完成：新增 ${r.created} 筆、更新 ${r.updated} 筆、略過錯誤 ${r.errors.length} 筆。</div>`; return; }
  if (act === 'imp-template') {
    const ent = $('#impEntity').value; const csv = '﻿' + S.schema[ent].fields.filter(f => !f.readonly).map(f => f.label).join(',') + '\n';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${ent}-範本.csv`; a.click(); return;
  }
  if (act === 'sync-now') { el.disabled = true; const r = await api('POST', '/api/sync/run'); toast(r.length ? r.map(x => `${x.platform}：${x.status === 'success' ? '成功' : '失敗'}`).join('｜') : '沒有已啟用的平台', r.some(x => x.status === 'failed')); return route(); }
  if (act === 'line-test') { const r = await api('POST', '/api/integrations/line/test', { token: $('#lineToken').value }); toast(`已確認官方帳號：${r.account_name}（${r.account_id}）`); return route(); }
  if (act === 'int-enable') { await api('POST', `/api/integrations/${el.dataset.p}/enable`, { enabled: el.dataset.on === '1' }); return route(); }
  if (act === 'int-revoke') { if (!confirm('撤銷後需重新授權才能同步，確定？')) return; await api('POST', `/api/integrations/${el.dataset.p}/revoke`); return route(); }
  if (act === 'meta-connect') { const r = await api('GET', '/api/integrations/meta/connect'); location.href = r.url; return; }
  if (act === 'meta-accounts') {
    const list = await api('GET', '/api/integrations/meta/accounts');
    $('#metaAccounts').innerHTML = `<ul class="list-plain">${list.map(a => `<li>${esc(a.name)} <span class="hint">${esc(a.id)}</span><button class="btn sm" data-act="meta-pick" data-id="${esc(a.id)}" data-name="${esc(a.name)}">選擇</button></li>`).join('') || '<li class="empty">此授權沒有可用的廣告帳號</li>'}</ul>`; return;
  }
  if (act === 'meta-pick') { await api('POST', '/api/integrations/meta/account', { id: el.dataset.id, name: el.dataset.name }); toast('已選擇廣告帳號'); return route(); }
  const tr = el.closest('tr[data-uid]');
  if (tr) {
    const id = tr.dataset.uid;
    if (act === 'user-save') { const sc = tr.querySelector('[name=uscope]'); await api('PUT', `/api/users/${id}`, { role: tr.querySelector('[name=urole]').value, scope: sc ? [...sc.selectedOptions].map(o => o.value) : [] }); toast('已更新，該帳號需重新登入'); return; }
    if (act === 'user-reset') { if (!confirm('重設後原密碼與登入立即失效，確定？')) return; const r = await api('POST', `/api/users/${id}/reset`); alert('新的臨時密碼（只顯示這一次）：\n\n' + r.temp_password); return pageUsers(); }
    if (act === 'user-active') { await api('PUT', `/api/users/${id}`, { active: el.dataset.on === '1' }); S.users = await api('GET', '/api/user-options'); return pageUsers(); }
  }
}));
document.addEventListener('change', guard(async e => {
  const f = e.target.closest('[data-filter]');
  if (f && !f.closest('form')) {
    const [p, qs] = location.hash.split('?'); const q = new URLSearchParams(qs || '');
    if (f.value) q.set(f.dataset.filter, f.value); else q.delete(f.dataset.filter);
    location.hash = p + (q.toString() ? '?' + q : ''); return;
  }
  const up = e.target.closest('[data-upload]');
  if (up && up.files[0]) {
    const [entity, id] = up.dataset.upload.split(':'); const file = up.files[0];
    if (file.size > 3 * 1024 * 1024) throw new Error('附件需小於 3MB；較大的檔案請貼雲端連結');
    const data = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(file); });
    await api('POST', '/api/attachments', { entity, entity_id: id, filename: file.name, data }); toast('已上傳'); route();
  }
}));
window.addEventListener('hashchange', route);

async function boot() {
  try {
    S.me = await api('GET', '/api/me');
    if (S.me.must_change) return renderChangePw(true);
    const sc = await api('GET', '/api/schema'); S.schema = sc.entities; S.roles = sc.roles;
    S.users = await api('GET', '/api/user-options');
    invalidate(); route();
  } catch (e) { if (!S.me) renderLogin(); }
}
boot();
})();
