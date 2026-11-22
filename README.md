# 万象记 OmniVault — AI 原生个人全能记录库

类似 Memento Database 的 **纯单机离线优先（Local-First）** 个人全能数据库手机应用，采用 **Expo SDK 58 + TypeScript + `expo-sqlite` + `Zod v4` + `deepseek-flash` (V4.1 全家桶 API)** 构建。

## 核心特性

1. **自定义数据模型与声明式显示样式（Schema & View DSL）**
   - 物理表采用 `SQLite (WAL + JSON1)` 存储，增删改字段零 `ALTER TABLE` 迁移风险。
   - 每次修改库结构自动同步生成原生逻辑 SQL 视图 `v_<slug>`。
   - 支持 **卡片流（含槽位映射与条件预警高亮）、海报画廊、交互日历、离线统计看板** 4 种视图。
2. **跨表双向引用、Rollup 汇总与零 `eval` 公式引擎**
   - 独立关系边表 `entry_relations` 支持正向引用与反向反链（Backlinks）穿梭。
   - 支持正向与 `reverse:<slug>.<fieldKey>` 反向跨表 `SUM / AVG / COUNT / MIN / MAX` 汇总。
   - 内置递归下降安全公式解析器（如 `DAYS_SINCE`、`DAYS_UNTIL`、`ROUND`、`IF`）。
3. **DeepSeek V4.1 (`deepseek-flash`) 全家桶赋能（纯单机 BYOK）**
   - **AI 建筑师**：自然语言创建或增量修改多表关联结构、视图槽位与统计图表，带 Diff 预览确认与一键时光机回滚（Snapshot Undo）。
   - **AI 全局万能快记（Omni-Bar）**：支持文字、拍照小票/封面（原生视觉）、16kHz WAV 语音转写（`/v1/tools/asr`）、链接联网补全（`deepseek_read_url` / `deepseek_web_search`），支持 `@prev:0` 跨库原子入库。
   - **AI 数据分析师**：挂载 `PRAGMA query_only = ON` 本地只读 SQLite 工具多轮验证真实结果，杜绝算术幻觉，支持将生成的图表一键钉到首页看板。

## 本地运行与测试

```bash
# 1. 运行核心 SQLite + 公式 + 双向关联引擎自动化测试与类型检查
npm run typecheck
npm run test:engine

# 2. 启动 Web 实时预览（自动使用 WASM SQLite 持久化驱动）
npm run web

# 3. 编译 Android / iOS 纯离线原生安装包（使用 expo-sqlite JSI 双连接引擎）
npx expo run:android
npx expo run:ios
```
