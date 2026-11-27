# 拾录 · Folio — AI 原生个人全能记录本

纯单机离线优先（Local-First）的个人全能记录应用，采用 **Expo SDK 58 + TypeScript + `expo-sqlite` + `Zod v4` + `deepseek-flash`** 构建。

## 最新更新

### 2026-11-27

#### 修复与优化

- 强化增量撤销与快照恢复：支持非关联字段转为关联字段后的原值还原、已删记录本的结构恢复交接，以及多次删除后任意顺序撤销时的多选关联顺序保留。
- 全量备份导入自动隔离历史撤销快照，避免跨备份误操作。
- 统一数据库初始化为干净的 v1 核心结构（`initCoreSchema`），移除历史兼容迁移与旧快照回退路径，启动零快照扫描。

[完整更新记录](docs/releases/release-notes.md)

## 核心特性

1. **自定义数据模型与按需多视图（Schema & View DSL）**
   - 物理表采用 `SQLite (WAL + JSON1)` 存储，独立维护 `library_views` 与 `library_relations` 表；图片压缩落盘至本地文档目录，增删改字段零 `ALTER TABLE` 迁移风险。
   - 每次修改库结构自动同步生成原生逻辑 SQL 视图 `v_<slug>`（排除图片与运行时计算列）。
   - 支持按记录本按需增删、排序与定制 **列表卡片（槽位映射与条件预警高亮）、海报画廊、交互日历、离线统计看板** 4 类视图，并通过「基础 / 字段 / 视图」三标签页集中配置。
2. **跨表双向引用、主从附属子表、Rollup 汇总与零 `eval` 公式引擎**
   - 独立关系边表 `entry_relations` 与库关系表 `library_relations` 支持正向引用、反向反链（Backlinks）与 **1:N 附属子记录本（可选首页显隐、详情页多标签分栏、原位快记与时间轴流）**，提供必填关联删除保护、安全解绑与可逆增量撤销。
   - 支持正向与 `reverse:<slug>.<fieldKey>` 反向跨表 `SUM / AVG / COUNT / MIN / MAX` 汇总。
   - 内置递归下降安全公式解析器（如 `DAYS_SINCE`、`DAYS_UNTIL`、`TODAY`、`ROUND`、`IF`）。
3. **DeepSeek (`deepseek-flash`) 场景化 AI 助手（纯单机 BYOK）**
   - **场景感知角色**：按首页（全能管家）、记录本（本库助理）、记录详情（随行助理）与统计页（数据分析师）自动适配上下文与默认模式。
   - **AI 建筑师**：自然语言创建或增量修改主从多表结构、按需视图与统计图表，带破坏性字段变更 Diff 预警与增量撤销（支持字段类型转换原值还原且不误伤其他记录本）。
   - **AI 全局与上下文快记（随手说）**：支持文字、拍照小票/书页（压缩后原生视觉识别）、16kHz WAV 语音转写（`/v1/tools/asr`）、链接联网补全，支持详情页绑定主记录录入、实时关联校验及全局 `@prev:0` 跨库原子入库。
   - **AI 数据分析师**：挂载 `PRAGMA query_only = ON` 本地只读 SQLite 工具多轮验证真实结果，杜绝算术幻觉，支持将生成的图表一键固定到统计页。

## 本地运行与测试

```bash
# 1. 类型检查、代码规范检查与自动化测试（单元测试 + 核心引擎验证）
npm run typecheck
npm run lint
npm test

# 2. 启动 Web 实时预览（自动使用 WASM SQLite + IndexedDB 持久化驱动）
npm run web

# 3. 生成 Android APK，产物位于 android/app/build/outputs/apk/{release,debug}/
pnpm build:android:release
pnpm build:android:debug

# 4. 在设备或模拟器上运行
npx expo run:android
npx expo run:ios
```
