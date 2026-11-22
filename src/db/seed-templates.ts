import type { DashboardWidget, LibraryBlueprint } from '@/schema/view-dsl';

function offsetDateStr(daysOffset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function makePosterSvgDataUri(title: string, subtitle: string, bgStart: string, bgEnd: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${bgStart}"/>
        <stop offset="100%" stop-color="${bgEnd}"/>
      </linearGradient>
    </defs>
    <rect width="360" height="480" rx="24" fill="url(#g)"/>
    <circle cx="290" cy="90" r="85" fill="rgba(255,255,255,0.08)"/>
    <circle cx="60" cy="390" r="110" fill="rgba(255,255,255,0.06)"/>
    <text x="32" y="340" fill="#ffffff" font-size="30" font-weight="700" font-family="sans-serif">${title}</text>
    <text x="32" y="382" fill="rgba(255,255,255,0.78)" font-size="17" font-family="sans-serif">${subtitle}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export interface SeedBundle {
  libraries: LibraryBlueprint[];
  entriesBySlug: Record<
    string,
    Array<{
      tempRef?: string;
      data: Record<string, unknown>;
    }>
  >;
  widgets: DashboardWidget[];
}

export function buildDefaultSeedBundle(): SeedBundle {
  const libraries: LibraryBlueprint[] = [
    {
      slug: 'my_assets',
      name: '数码与好物装备',
      description: '追踪长期持有物品购入价、配件累计投入、二手残值与真实日均持有成本',
      icon: '💻',
      color: 'teal',
      fields: [
        { key: 'item_name', label: '装备名称', type: 'text', required: true },
        {
          key: 'category',
          label: '品类',
          type: 'select',
          required: true,
          options: [
            { value: '影像器材', color: '#0d9488' },
            { value: '生产力电脑', color: '#2563eb' },
            { value: '居家健康', color: '#059669' },
            { value: '掌机娱乐', color: '#d97706' },
          ],
        },
        { key: 'buy_price', label: '购入价格', type: 'currency', required: true, unit: '元' },
        { key: 'resale_value', label: '预估残值', type: 'currency', required: false, unit: '元' },
        { key: 'buy_date', label: '购入日期', type: 'date', required: true },
        {
          key: 'status',
          label: '服役状态',
          type: 'select',
          required: true,
          options: [
            { value: '主力服役', color: '#059669' },
            { value: '偶尔使用', color: '#d97706' },
            { value: '吃灰待出', color: '#e11d48' },
          ],
        },
        {
          key: 'extra_spend',
          label: '关联账单投入',
          type: 'rollup',
          required: false,
          unit: '元',
          rollupConfig: {
            relationFieldKey: 'reverse:daily_bills.related_asset',
            targetFieldKey: 'amount',
            fn: 'SUM',
          },
        },
        {
          key: 'holding_days',
          label: '持有天数',
          type: 'formula',
          required: false,
          unit: '天',
          formulaExpr: 'MAX(1, DAYS_SINCE(buy_date))',
        },
        {
          key: 'daily_cost',
          label: '真实日均成本',
          type: 'formula',
          required: false,
          unit: '元/天',
          formulaExpr: 'ROUND((buy_price + extra_spend - resale_value) / MAX(1, DAYS_SINCE(buy_date)), 2)',
        },
      ],
      views: {
        card: {
          titleFieldKey: 'item_name',
          subtitleFieldKey: 'category',
          rightBadgeFieldKey: 'status',
          footerMetricKeys: ['buy_price', 'extra_spend', 'daily_cost'],
          sortFieldKey: 'buy_date',
          sortDir: 'desc',
          highlightRules: [
            {
              fieldKey: 'status',
              operator: 'eq',
              value: '吃灰待出',
              tone: 'warning',
              badgeText: '建议回血',
            },
          ],
        },
        calendar: {
          dateFieldKey: 'buy_date',
          titleFieldKey: 'item_name',
          metricFieldKey: 'buy_price',
          tagFieldKey: 'category',
        },
      },
    },
    {
      slug: 'daily_bills',
      name: '日常账单',
      description: '个人日常开销流水，支持关联到具体装备资产自动计入持有总成本',
      icon: '🧾',
      color: 'amber',
      fields: [
        { key: 'title', label: '消费事项', type: 'text', required: true },
        { key: 'amount', label: '金额', type: 'currency', required: true, unit: '元' },
        {
          key: 'category',
          label: '消费分类',
          type: 'select',
          required: true,
          options: [
            { value: '餐饮美食', color: '#ea580c' },
            { value: '数码配件', color: '#0d9488' },
            { value: '居家日用', color: '#2563eb' },
            { value: '医疗健康', color: '#e11d48' },
            { value: '文化订阅', color: '#059669' },
          ],
        },
        {
          key: 'pay_account',
          label: '支付方式',
          type: 'select',
          required: false,
          options: [
            { value: '招商信用卡', color: '#dc2626' },
            { value: '微信零钱', color: '#16a34a' },
            { value: '支付宝', color: '#2563eb' },
          ],
        },
        { key: 'spent_at', label: '消费日期', type: 'date', required: true },
        {
          key: 'related_asset',
          label: '关联装备资产',
          type: 'relation',
          required: false,
          relationConfig: {
            targetLibrarySlug: 'my_assets',
            allowMultiple: false,
          },
        },
        { key: 'note', label: '备注', type: 'text', required: false },
      ],
      views: {
        card: {
          titleFieldKey: 'title',
          subtitleFieldKey: 'pay_account',
          rightBadgeFieldKey: 'category',
          footerMetricKeys: ['amount', 'spent_at'],
          sortFieldKey: 'spent_at',
          sortDir: 'desc',
          highlightRules: [
            {
              fieldKey: 'amount',
              operator: 'gte',
              value: 1000,
              tone: 'info',
              badgeText: '大额支出',
            },
          ],
        },
        calendar: {
          dateFieldKey: 'spent_at',
          titleFieldKey: 'title',
          metricFieldKey: 'amount',
          tagFieldKey: 'category',
        },
      },
    },
    {
      slug: 'med_cabinet',
      name: '家庭常备药箱',
      description: '药品库存与保质期预警，自动统计关联用药打卡次数',
      icon: '💊',
      color: 'rose',
      fields: [
        { key: 'med_name', label: '药品名称', type: 'text', required: true },
        {
          key: 'purpose',
          label: '主治分类',
          type: 'select',
          required: true,
          options: [
            { value: '退烧止痛', color: '#e11d48' },
            { value: '抗敏鼻炎', color: '#2563eb' },
            { value: '眼部护理', color: '#0d9488' },
            { value: '日常营养', color: '#059669' },
          ],
        },
        { key: 'stock_count', label: '剩余数量', type: 'number', required: true, unit: '粒/支' },
        { key: 'expiry_date', label: '有效期至', type: 'date', required: true },
        { key: 'dosage_tip', label: '用法用量备注', type: 'text', required: false },
        {
          key: 'days_to_expiry',
          label: '距过期天数',
          type: 'formula',
          required: false,
          unit: '天',
          formulaExpr: 'DAYS_UNTIL(expiry_date)',
        },
        {
          key: 'taken_count',
          label: '累计服用次数',
          type: 'rollup',
          required: false,
          unit: '次',
          rollupConfig: {
            relationFieldKey: 'reverse:health_logs.medicines',
            targetFieldKey: 'dose_units',
            fn: 'COUNT',
          },
        },
      ],
      views: {
        card: {
          titleFieldKey: 'med_name',
          subtitleFieldKey: 'dosage_tip',
          rightBadgeFieldKey: 'purpose',
          footerMetricKeys: ['stock_count', 'days_to_expiry', 'taken_count'],
          sortFieldKey: 'expiry_date',
          sortDir: 'asc',
          highlightRules: [
            {
              fieldKey: 'expiry_date',
              operator: 'days_until_lt',
              value: 30,
              tone: 'danger',
              badgeText: '30天内临期',
            },
            {
              fieldKey: 'stock_count',
              operator: 'lte',
              value: 4,
              tone: 'warning',
              badgeText: '库存偏低',
            },
          ],
        },
        calendar: {
          dateFieldKey: 'expiry_date',
          titleFieldKey: 'med_name',
          metricFieldKey: 'stock_count',
          tagFieldKey: 'purpose',
        },
      },
    },
    {
      slug: 'health_logs',
      name: '健康与用药打卡',
      description: '记录身体不适症状、睡眠精力与关联服药流水',
      icon: '🩺',
      color: 'emerald',
      fields: [
        { key: 'log_title', label: '记录摘要', type: 'text', required: true },
        { key: 'log_date', label: '日期', type: 'date', required: true },
        {
          key: 'medicines',
          label: '服用药品',
          type: 'relation',
          required: false,
          relationConfig: {
            targetLibrarySlug: 'med_cabinet',
            allowMultiple: true,
          },
        },
        { key: 'dose_units', label: '单次剂量', type: 'number', required: false, unit: '粒/滴' },
        { key: 'feeling_score', label: '体感状态分', type: 'rating', required: false },
      ],
      views: {
        card: {
          titleFieldKey: 'log_title',
          subtitleFieldKey: 'log_date',
          footerMetricKeys: ['dose_units', 'feeling_score'],
          sortFieldKey: 'log_date',
          sortDir: 'desc',
          highlightRules: [],
        },
        calendar: {
          dateFieldKey: 'log_date',
          titleFieldKey: 'log_title',
          metricFieldKey: 'feeling_score',
        },
      },
    },
    {
      slug: 'media_vault',
      name: '书影音灵感库',
      description: '阅读、观影与播客进度海报墙，支持一句话联网补全简介',
      icon: '🎬',
      color: 'blue',
      fields: [
        { key: 'work_title', label: '作品名称', type: 'text', required: true },
        { key: 'creator', label: '作者 / 导演', type: 'text', required: false },
        {
          key: 'media_type',
          label: '媒介类型',
          type: 'select',
          required: true,
          options: [
            { value: '图书', color: '#0d9488' },
            { value: '电影', color: '#2563eb' },
            { value: '剧集', color: '#d97706' },
            { value: '游戏', color: '#059669' },
          ],
        },
        { key: 'rating', label: '个人评分', type: 'rating', required: false },
        { key: 'finished_date', label: '完成日期', type: 'date', required: false },
        { key: 'cover_image', label: '海报封面', type: 'image', required: false },
        { key: 'review_note', label: '短评随笔', type: 'text', required: false },
      ],
      views: {
        card: {
          titleFieldKey: 'work_title',
          subtitleFieldKey: 'creator',
          coverImageFieldKey: 'cover_image',
          rightBadgeFieldKey: 'media_type',
          footerMetricKeys: ['rating', 'finished_date'],
          sortFieldKey: 'finished_date',
          sortDir: 'desc',
          highlightRules: [],
        },
        gallery: {
          titleFieldKey: 'work_title',
          subtitleFieldKey: 'creator',
          coverImageFieldKey: 'cover_image',
          badgeFieldKey: 'media_type',
          ratingFieldKey: 'rating',
        },
        calendar: {
          dateFieldKey: 'finished_date',
          titleFieldKey: 'work_title',
          metricFieldKey: 'rating',
          tagFieldKey: 'media_type',
        },
      },
    },
  ];

  const entriesBySlug: SeedBundle['entriesBySlug'] = {
    my_assets: [
      {
        tempRef: 'asset_camera',
        data: {
          item_name: 'Sony A7C2 微单机身',
          category: '影像器材',
          buy_price: 13499,
          resale_value: 10800,
          buy_date: offsetDateStr(-240),
          status: '主力服役',
        },
      },
      {
        tempRef: 'asset_mac',
        data: {
          item_name: 'MacBook Pro 14 M4',
          category: '生产力电脑',
          buy_price: 14999,
          resale_value: 11200,
          buy_date: offsetDateStr(-185),
          status: '主力服役',
        },
      },
      {
        tempRef: 'asset_chair',
        data: {
          item_name: 'Aeron 人体工学椅',
          category: '居家健康',
          buy_price: 6800,
          resale_value: 4200,
          buy_date: offsetDateStr(-420),
          status: '主力服役',
        },
      },
      {
        tempRef: 'asset_handheld',
        data: {
          item_name: '复古开源掌机 OLED',
          category: '掌机娱乐',
          buy_price: 1699,
          resale_value: 1150,
          buy_date: offsetDateStr(-95),
          status: '吃灰待出',
        },
      },
    ],
    daily_bills: [
      {
        data: {
          title: '腾龙 28-75mm G2 挂机镜头',
          amount: 4580,
          category: '数码配件',
          pay_account: '招商信用卡',
          spent_at: offsetDateStr(-12),
          related_asset: ['@ref:asset_camera'],
          note: '旅行主力变焦头，计入相机系统总投入',
        },
      },
      {
        data: {
          title: 'UHS-II 高速存储卡 + 备用电池',
          amount: 640,
          category: '数码配件',
          pay_account: '微信零钱',
          spent_at: offsetDateStr(-6),
          related_asset: ['@ref:asset_camera'],
          note: '4K 视频拍摄扩容配件',
        },
      },
      {
        data: {
          title: '雷电 4 扩展坞与氮化镓充电器',
          amount: 799,
          category: '数码配件',
          pay_account: '招商信用卡',
          spent_at: offsetDateStr(-4),
          related_asset: ['@ref:asset_mac'],
          note: '桌面一线连改造',
        },
      },
      {
        data: {
          title: '周末山姆超市生鲜采购',
          amount: 368.5,
          category: '餐饮美食',
          pay_account: '微信零钱',
          spent_at: offsetDateStr(-2),
          related_asset: [],
          note: '牛排、蓝莓、鲜奶补货',
        },
      },
      {
        data: {
          title: '精品手冲咖啡豆两袋',
          amount: 128,
          category: '餐饮美食',
          pay_account: '支付宝',
          spent_at: offsetDateStr(-1),
          related_asset: [],
          note: '埃塞水洗耶加雪菲',
        },
      },
      {
        data: {
          title: '年度云盘与阅读会员续费',
          amount: 198,
          category: '文化订阅',
          pay_account: '支付宝',
          spent_at: offsetDateStr(0),
          related_asset: [],
          note: '个人知识工具固定开支',
        },
      },
    ],
    med_cabinet: [
      {
        tempRef: 'med_eyedrops',
        data: {
          med_name: '玻璃酸钠人工泪液（单支装）',
          purpose: '眼部护理',
          stock_count: 3,
          expiry_date: offsetDateStr(16),
          dosage_tip: '每次 1 滴，开封后当日用完',
        },
      },
      {
        tempRef: 'med_d3',
        data: {
          med_name: '维生素 D3 软胶囊 2000IU',
          purpose: '日常营养',
          stock_count: 48,
          expiry_date: offsetDateStr(310),
          dosage_tip: '随早餐每日 1 粒',
        },
      },
      {
        tempRef: 'med_allergy',
        data: {
          med_name: '氯雷他定片 10mg',
          purpose: '抗敏鼻炎',
          stock_count: 8,
          expiry_date: offsetDateStr(190),
          dosage_tip: '换季鼻炎发作睡前 1 片',
        },
      },
    ],
    health_logs: [
      {
        data: {
          log_title: '熬夜写方案眼睛干涩滴眼药水 + 补 D3',
          log_date: offsetDateStr(-2),
          medicines: ['@ref:med_eyedrops', '@ref:med_d3'],
          dose_units: 2,
          feeling_score: 4,
        },
      },
      {
        data: {
          log_title: '晨起补充维生素 D3',
          log_date: offsetDateStr(0),
          medicines: ['@ref:med_d3'],
          dose_units: 1,
          feeling_score: 5,
        },
      },
    ],
    media_vault: [
      {
        data: {
          work_title: '食南之徒',
          creator: '马伯庸',
          media_type: '图书',
          rating: 5,
          finished_date: offsetDateStr(-9),
          cover_image: makePosterSvgDataUri('食南之徒', '马伯庸 · 历史饮食奇旅', '#0f766e', '#115e59'),
          review_note: '从一罐枸酱串起南越与汉廷的风物人情，极适合睡前慢读。',
        },
      },
      {
        data: {
          work_title: '机器人之梦 Robot Dreams',
          creator: '巴勃罗·贝赫尔',
          media_type: '电影',
          rating: 5,
          finished_date: offsetDateStr(-3),
          cover_image: makePosterSvgDataUri('Robot Dreams', 'September · 无对白动画长片', '#1d4ed8', '#1e3a8a'),
          review_note: '哪怕没有一句台词，重逢时隔窗共舞那段依然后劲十足。',
        },
      },
      {
        data: {
          work_title: '小丑牌 Balatro',
          creator: 'LocalThunk',
          media_type: '游戏',
          rating: 4,
          finished_date: offsetDateStr(-1),
          cover_image: makePosterSvgDataUri('Balatro', '策略构筑 · 时间黑洞', '#b45309', '#78350f'),
          review_note: '简洁数值乘区设计教科书，非常适合通勤碎片时间来一局。',
        },
      },
    ],
  };

  const widgets: DashboardWidget[] = [
    {
      id: 'w_total_bills',
      title: '账单累计支出',
      subtitle: '全部账单合计',
      chartType: 'kpi_number',
      readonlySql: 'SELECT ROUND(COALESCE(SUM(amount), 0), 2) AS total_spent FROM v_daily_bills',
      yKey: 'total_spent',
      unitPrefix: '¥',
      accentTone: 'amber',
    },
    {
      id: 'w_asset_net',
      title: '装备净投入',
      subtitle: '购入价减去预估残值',
      chartType: 'kpi_number',
      readonlySql: 'SELECT ROUND(COALESCE(SUM(buy_price - resale_value), 0), 0) AS net_cost FROM v_my_assets',
      yKey: 'net_cost',
      unitPrefix: '¥',
      accentTone: 'teal',
    },
    {
      id: 'w_bills_by_cat',
      title: '消费分类构成',
      subtitle: '按分类查看支出占比',
      chartType: 'pie',
      readonlySql:
        'SELECT category AS label, ROUND(SUM(amount), 2) AS total FROM v_daily_bills GROUP BY category ORDER BY total DESC',
      xKey: 'label',
      yKey: 'total',
      unitPrefix: '¥',
      accentTone: 'amber',
    },
    {
      id: 'w_asset_compare',
      title: '装备总投入排行',
      subtitle: '含本体购入价与相关配件账单',
      chartType: 'bar',
      readonlySql: `SELECT
          a.item_name AS asset,
          ROUND(a.buy_price + COALESCE(SUM(b.amount), 0), 0) AS full_cost
        FROM v_my_assets a
        LEFT JOIN entry_relations r ON r.target_entry_id = a._id AND r.field_key = 'related_asset'
        LEFT JOIN v_daily_bills b ON b._id = r.source_entry_id
        GROUP BY a._id, a.item_name, a.buy_price
        ORDER BY full_cost DESC`,
      xKey: 'asset',
      yKey: 'full_cost',
      unitPrefix: '¥',
      accentTone: 'teal',
    },
  ];

  return { libraries, entriesBySlug, widgets };
}
