// 資料模型定義（schema-driven）：資料表、欄位、權限屬性都在這裡集中定義。
// 欄位屬性：
//   finance: true  → 財務欄位（小編/客服看不到、不能寫）
//   private: true  → 寄送地址、私人聯絡（僅管理員與該筆負責人）
//   external: true → 對外文案/素材/CTA，核准後修改須重新送審
//   list: true     → 列表顯示

const CHANNELS = ['Facebook', 'Instagram', 'Threads', 'LINE OA', 'SHOPLINE Blog'];
const CONTENT_STATUS = [
  ['draft', '草稿'], ['assigned', '指派製作中'], ['review', '待審核'], ['revise', '退修'],
  ['approved', '已核准'], ['scheduled', '已排程'], ['published', '已發布'], ['reported', '已回填成效'],
];
const METRIC_STATUS = ['待回填', '已回填', '平台未提供', '同步失敗'];
const OUTCOME_TYPES = ['完成報名', '有效諮詢', '到店核銷', 'B端有效洽談'];

const entities = {
  projects: {
    label: '專案', title: 'name',
    fields: [
      { key: 'name', label: '專案名稱', type: 'text', required: true, list: true },
      { key: 'status', label: '狀態', type: 'select', options: ['規劃中', '進行中', '已結束'], list: true },
      { key: 'start_date', label: '開始日', type: 'date', list: true },
      { key: 'end_date', label: '結束日', type: 'date', list: true },
      { key: 'owner_id', label: '負責人', type: 'user', list: true },
      { key: 'goal', label: '目標', type: 'textarea' },
      { key: 'budget', label: '專案預算', type: 'money', finance: true, list: true },
      { key: 'doc_url', label: '企劃文件連結（Google Docs／Word）', type: 'url' },
    ],
  },
  milestones: {
    label: '里程碑', title: 'title', parent: 'project_id',
    fields: [
      { key: 'project_id', label: '專案', type: 'project', required: true, list: true },
      { key: 'title', label: '里程碑', type: 'text', required: true, list: true },
      { key: 'due_date', label: '日期', type: 'date', list: true },
      { key: 'done', label: '完成', type: 'bool', list: true },
    ],
  },
  contents: {
    label: '內容', title: 'title', workflow: true,
    fields: [
      { key: 'title', label: '標題／主題', type: 'text', required: true, list: true },
      { key: 'channel', label: '渠道', type: 'select', options: CHANNELS, required: true, list: true },
      { key: 'project_id', label: '主專案（空白＝日常）', type: 'project', list: true },
      { key: 'status', label: '狀態', type: 'status', options: CONTENT_STATUS, list: true, readonly: true },
      { key: 'assignee_id', label: '負責人', type: 'user', list: true },
      { key: 'audience', label: '受眾', type: 'text' },
      { key: 'topic_group', label: '同主題群組（跨渠道關聯）', type: 'text' },
      { key: 'tags', label: '標籤', type: 'text' },
      { key: 'copy', label: '文案', type: 'textarea', external: true },
      { key: 'asset_url', label: '素材連結', type: 'url', external: true },
      { key: 'cta', label: 'CTA', type: 'text', external: true },
      { key: 'asset_due', label: '素材交期', type: 'date' },
      { key: 'review_date', label: '核稿日', type: 'date' },
      { key: 'planned_at', label: '預計上線', type: 'datetime', list: true },
      { key: 'published_at', label: '實際上線', type: 'datetime' },
      { key: 'publish_url', label: '發布網址', type: 'url' },
      { key: 'paid', label: '有付費推廣', type: 'bool' },
      { key: 'ad_id', label: '後續廣告', type: 'ref', ref: 'ads' },
      { key: 'right_id', label: '使用合作素材（需有效授權）', type: 'ref', ref: 'rights' },
      // LINE OA
      { key: 'line_type', label: 'LINE 訊息類型', type: 'select', options: ['圖文訊息', '多頁訊息', '推播'], showIf: { channel: ['LINE OA'] } },
      { key: 'line_cards', label: '卡片／按鈕明細', type: 'textarea', showIf: { channel: ['LINE OA'] } },
      { key: 'send_count', label: '發送量', type: 'number', metric: true, showIf: { channel: ['LINE OA'] } },
      // Blog SEO
      { key: 'keyword', label: '目標關鍵字', type: 'text', showIf: { channel: ['SHOPLINE Blog'] } },
      { key: 'seo_title', label: 'SEO 標題', type: 'text', external: true, showIf: { channel: ['SHOPLINE Blog'] } },
      { key: 'meta_desc', label: 'Meta 描述', type: 'textarea', external: true, showIf: { channel: ['SHOPLINE Blog'] } },
      { key: 'sources', label: '官方來源', type: 'textarea', showIf: { channel: ['SHOPLINE Blog'] } },
      { key: 'last_checked', label: '最後查核日期', type: 'date', showIf: { channel: ['SHOPLINE Blog'] } },
      { key: 'search_impressions', label: '搜尋曝光', type: 'number', metric: true, showIf: { channel: ['SHOPLINE Blog'] } },
      { key: 'search_clicks', label: '搜尋點擊', type: 'number', metric: true, showIf: { channel: ['SHOPLINE Blog'] } },
      { key: 'organic_sessions', label: '自然搜尋流量', type: 'number', metric: true, showIf: { channel: ['SHOPLINE Blog'] } },
      { key: 'cta_clicks', label: '文章 CTA 點擊', type: 'number', metric: true, showIf: { channel: ['SHOPLINE Blog'] } },
      // 成效
      { key: 'impressions', label: '曝光', type: 'number', metric: true },
      { key: 'reach', label: '觸及', type: 'number', metric: true },
      { key: 'video_views', label: '影片觀看', type: 'number', metric: true },
      { key: 'video_view_def', label: '影片觀看口徑', type: 'text', metric: true },
      { key: 'saves', label: '收藏', type: 'number', metric: true },
      { key: 'shares', label: '分享', type: 'number', metric: true },
      { key: 'link_clicks', label: '連結點擊', type: 'number', metric: true },
      { key: 'metric_status', label: '成效資料狀態', type: 'select', options: METRIC_STATUS, metric: true },
      { key: 'metric_source', label: '成效來源', type: 'text', metric: true },
      { key: 'metric_period', label: '成效期間', type: 'text', metric: true },
    ],
  },
  assets: {
    label: '素材交付', title: 'brief',
    fields: [
      { key: 'brief', label: 'Brief', type: 'text', required: true, list: true },
      { key: 'content_id', label: '對應內容', type: 'ref', ref: 'contents', list: true },
      { key: 'project_id', label: '專案', type: 'project' },
      { key: 'size', label: '尺寸', type: 'text', list: true },
      { key: 'due_date', label: '交期', type: 'date', list: true },
      { key: 'owner_id', label: '回填人', type: 'user', list: true },
      { key: 'designer', label: '設計師', type: 'text' },
      { key: 'canva_url', label: 'Canva／交件連結', type: 'url' },
      { key: 'final_version', label: '定稿版本', type: 'text' },
      { key: 'status', label: '狀態', type: 'select', options: ['待製作', '製作中', '待確認', '已定稿'], list: true },
    ],
  },
  ads: {
    label: '廣告', title: 'name',
    fields: [
      { key: 'name', label: '名稱', type: 'text', required: true, list: true },
      { key: 'level', label: '層級', type: 'select', options: ['廣告活動', '廣告組合', '廣告'], required: true, list: true },
      { key: 'parent_id', label: '上層', type: 'ref', ref: 'ads' },
      { key: 'project_id', label: '專案', type: 'project', list: true },
      { key: 'ext_id', label: '平台 ID', type: 'text' },
      { key: 'status', label: '投放狀態', type: 'select', options: ['草稿', '投放中', '暫停', '已結束'], list: true },
      { key: 'start_date', label: '開始', type: 'date' },
      { key: 'end_date', label: '結束', type: 'date' },
      { key: 'daily_budget', label: '日預算', type: 'money', finance: true, list: true },
      { key: 'spend', label: '累積花費', type: 'money', finance: true, list: true },
      { key: 'impressions', label: '曝光', type: 'number', metric: true },
      { key: 'link_clicks', label: '連結點擊', type: 'number', metric: true, list: true },
      { key: 'format', label: '素材形式', type: 'select', options: ['單圖', '輪播', '影片', '限動', 'Reels'] },
      { key: 'source', label: '素材來源', type: 'select', options: ['既有貼文', '廣告專用素材'] },
      { key: 'content_id', label: '對應既有貼文', type: 'ref', ref: 'contents' },
      { key: 'right_id', label: '使用合作素材（需廣告授權）', type: 'ref', ref: 'rights' },
      { key: 'metric_status', label: '成效資料狀態', type: 'select', options: METRIC_STATUS, metric: true },
    ],
  },
  abtests: {
    label: 'A/B 測試', title: 'name',
    fields: [
      { key: 'name', label: '測試名稱', type: 'text', required: true, list: true },
      { key: 'project_id', label: '專案', type: 'project', list: true },
      { key: 'method', label: '測試方式', type: 'text' },
      { key: 'versions', label: '版本', type: 'textarea' },
      { key: 'start_date', label: '開始', type: 'date', list: true },
      { key: 'end_date', label: '結束', type: 'date' },
      { key: 'metric', label: '主要指標', type: 'text', list: true },
      { key: 'progress', label: '進度', type: 'select', options: ['規劃中', '測試中', '已完成'], list: true },
      { key: 'conclusion', label: '結論', type: 'textarea' },
    ],
  },
  partners: {
    label: '創作者與品牌合作', title: 'name',
    fields: [
      { key: 'name', label: '合作對象', type: 'text', required: true, list: true },
      { key: 'partner_type', label: '類型', type: 'select', options: ['品牌夥伴', 'KOL', 'KOC', 'UGC'], list: true },
      { key: 'coop_type', label: '合作方式', type: 'select', options: ['單純贈品', '商品互惠', '付費', '混合合作', '品牌交換曝光'], list: true },
      { key: 'project_id', label: '專案', type: 'project' },
      { key: 'owner_id', label: '負責人', type: 'user', list: true },
      { key: 'status', label: '狀態', type: 'select', options: ['洽談中', '已確認', '已寄送', '製作中', '已上線', '已結案'], list: true },
      { key: 'product', label: '合作商品', type: 'text' },
      { key: 'ship_address', label: '寄送地址', type: 'textarea', private: true },
      { key: 'contact', label: '私人聯絡方式', type: 'text', private: true },
      { key: 'shipped_at', label: '寄送日', type: 'date' },
      { key: 'product_cost', label: '商品成本', type: 'money', finance: true },
      { key: 'shipping_fee', label: '運費', type: 'money', finance: true },
      { key: 'fee', label: '合作費', type: 'money', finance: true, list: true },
      { key: 'live_at', label: '上線時間', type: 'date' },
      { key: 'tracking_code', label: '追蹤碼', type: 'text' },
      { key: 'ugc_only', label: '僅交 UGC 原檔', type: 'bool' },
      { key: 'impressions', label: '曝光', type: 'number', metric: true },
      { key: 'link_clicks', label: '連結點擊', type: 'number', metric: true },
    ],
  },
  deliverables: {
    label: '合作交付', title: 'title', parent: 'partner_id',
    fields: [
      { key: 'partner_id', label: '合作對象', type: 'ref', ref: 'partners', required: true, list: true },
      { key: 'title', label: '交付項目', type: 'text', required: true, list: true },
      { key: 'due_date', label: '交期', type: 'date', list: true },
      { key: 'live_at', label: '上線時間', type: 'date' },
      { key: 'url', label: '交付／上線網址', type: 'url' },
      { key: 'accepted', label: '素材已驗收', type: 'bool', list: true },
    ],
  },
  rights: {
    label: '素材使用權', title: 'asset_desc', parent: 'partner_id',
    fields: [
      { key: 'partner_id', label: '合作對象', type: 'ref', ref: 'partners', required: true, list: true },
      { key: 'asset_desc', label: '素材', type: 'text', required: true, list: true },
      { key: 'confirmed', label: '用途已確認', type: 'bool', list: true },
      { key: 'r_repost', label: '轉發', type: 'bool' },
      { key: 'r_edit', label: '剪輯', type: 'bool' },
      { key: 'r_web_line', label: '官網／LINE OA', type: 'bool' },
      { key: 'r_ads', label: '廣告', type: 'bool' },
      { key: 'r_creator_ads', label: '創作者身分投放', type: 'bool' },
      { key: 'start_date', label: '起', type: 'date', list: true },
      { key: 'end_date', label: '訖', type: 'date', list: true },
      { key: 'doc_url', label: '授權文件', type: 'url' },
    ],
  },
  outcomes: {
    label: '業務成果', title: 'ref_no',
    fields: [
      { key: 'ref_no', label: '參照編號', type: 'text', required: true, list: true },
      { key: 'outcome_type', label: '成果類型', type: 'select', options: OUTCOME_TYPES, required: true, list: true },
      { key: 'project_id', label: '專案', type: 'project', list: true },
      { key: 'occurred_on', label: '日期', type: 'date', list: true },
      { key: 'assignee_id', label: '回填人', type: 'user', list: true },
      { key: 'content_id', label: '歸因內容', type: 'ref', ref: 'contents' },
      { key: 'ad_id', label: '歸因廣告', type: 'ref', ref: 'ads' },
      { key: 'partner_id', label: '歸因合作', type: 'ref', ref: 'partners' },
      { key: 'filled', label: '已回填', type: 'bool', list: true },
      { key: 'note', label: '備註', type: 'textarea' },
    ],
  },
  faqs: {
    label: 'FAQ 與話術', title: 'question',
    fields: [
      { key: 'category', label: '分類', type: 'text', list: true },
      { key: 'question', label: '問題', type: 'text', required: true, list: true },
      { key: 'answer', label: '話術', type: 'textarea' },
    ],
  },
};

// 角色：admin 管理員 / boss 老闆級 / pitcher 外部投手 / editor 小編 / cs 客服
const ROLES = { admin: '管理員', boss: '老闆級', pitcher: '外部投手', editor: '小編', cs: '客服' };

// 實體層級權限：r=讀、c=建立、u=編輯（u 對 editor/cs 僅限指派給自己的項目）
const ACCESS = {
  admin:   { '*': 'rcud' },
  boss:    { '*': 'r' },
  pitcher: { projects: 'r', contents: 'r', ads: 'r', abtests: 'r', partners: 'r', deliverables: 'r', rights: 'r', outcomes: 'r', milestones: 'r' },
  editor:  { projects: 'r', milestones: 'r', contents: 'rcu', assets: 'rcu', ads: 'r', abtests: 'r', partners: 'r', deliverables: 'rcu', rights: 'r', outcomes: 'ru', faqs: 'r' },
  cs:      { faqs: 'r', contents: 'rcu', outcomes: 'ru', projects: 'r' },
};
// 客服只看 Blog 與 LINE OA 內容
const CS_CHANNELS = ['LINE OA', 'SHOPLINE Blog'];
// 外部投手只看核准後素材
const APPROVED_STATES = ['approved', 'scheduled', 'published', 'reported'];
// 各實體「負責人」欄位：editor/cs 只能修改自己負責的
const OWNER_FIELD = { contents: 'assignee_id', assets: 'owner_id', outcomes: 'assignee_id', partners: 'owner_id', projects: 'owner_id' };

module.exports = { entities, ROLES, ACCESS, CHANNELS, CONTENT_STATUS, METRIC_STATUS, OUTCOME_TYPES, CS_CHANNELS, APPROVED_STATES, OWNER_FIELD };
