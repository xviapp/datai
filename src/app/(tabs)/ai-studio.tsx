import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { runAnalystAgent, runArchitectAgent } from '@/ai/agents';
import { SqlWidgetCard } from '@/components/charts/SqlWidgetCard';
import { Palette } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import { createId } from '@/engine/id';
import type { AnalystAnswer, ArchitectPlan, DashboardWidget } from '@/schema/view-dsl';

const ARCHITECT_PROMPTS = [
  '帮我建一套「宠物档案」关联「疫苗驱虫与开销记录」，支持在宠物页自动汇总累计医疗花费，并配置下次驱虫临期 7 天标红提醒',
  '建一个「精品咖啡豆品鉴库」，包含产地、处理法、豆重、购买价、开封日期、风味评分，并用公式自动算出每杯（15克）成本',
  '给现有的「日常账单」增加一个「是否可报销」开关字段，并配一张按支付方式汇总金额的柱状图',
];

const ANALYST_PROMPTS = [
  '帮我统计一下目前每件数码装备加上关联配件账单后的总投入排名，谁最贵？',
  '分析一下日常账单里各消费分类的花销占比，生成饼图',
  '检查家庭药箱里有哪些药快过期或库存不足？累计服用过几次？',
];

export default function AiStudioScreen() {
  const router = useRouter();
  const { repo, libraries, hasApiKey } = useOmni();

  const [mode, setMode] = useState<'architect' | 'analyst'>('architect');
  const [prompt, setPrompt] = useState('');
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);

  const [pendingPlan, setPendingPlan] = useState<ArchitectPlan | null>(null);
  const [analystResult, setAnalystResult] = useState<AnalystAnswer | null>(null);

  const existingSlugs = new Set(libraries.map((l) => l.slug));

  const handleRun = async () => {
    if (!repo || !prompt.trim()) return;
    setErrorMsg(null);
    setSuccessBanner(null);

    try {
      if (mode === 'architect') {
        setPendingPlan(null);
        const plan = await runArchitectAgent(repo, prompt, (s) => setStatusText(s));
        setPendingPlan(plan);
      } else {
        setAnalystResult(null);
        const answer = await runAnalystAgent(repo, prompt, (s) => setStatusText(s));
        setAnalystResult(answer);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusText(null);
    }
  };

  const handleConfirmPlan = () => {
    if (!repo || !pendingPlan) return;
    try {
      repo.applyArchitectPlan(pendingPlan);
      const firstSlug = pendingPlan.libraries[0]?.slug;
      setSuccessBanner(`已应用模型变更并自动创建时光机快照！共涉及 ${pendingPlan.libraries.length} 个库。`);
      setPendingPlan(null);
      setPrompt('');
      if (firstSlug) {
        router.push(`/library/${firstSlug}`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePinWidget = (w: DashboardWidget) => {
    if (!repo) return;
    try {
      repo.saveDashboardWidget({ ...w, id: createId('wdg') }, null);
      setSuccessBanner(`已将「${w.title}」固定到首页统计看板（断网也可实时重算）！`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Text style={styles.pageTitle}>AI 建模与数据分析工作台</Text>
          <Text style={styles.pageSubtitle}>
            由 deepseek-flash (V4.1) 驱动 · Zod v4 强类型校验 · 只读 SQL 零算术幻觉
          </Text>
        </View>

        {!hasApiKey ? (
          <Pressable
            onPress={() => router.push('/(tabs)/settings')}
            style={styles.keyNotice}
          >
            <Feather name="alert-circle" size={16} color={Palette.warning} />
            <Text style={styles.keyNoticeText}>
              当前尚未配置 DeepSeek API Key，点此前往「设置」填入后即可体验一句话建表与对话统计 →
            </Text>
          </Pressable>
        ) : null}

        {/* 模式切换器 */}
        <View style={styles.segmentedBar}>
          <Pressable
            onPress={() => {
              setMode('architect');
              setErrorMsg(null);
              setSuccessBanner(null);
            }}
            style={[styles.segmentBtn, mode === 'architect' && styles.segmentBtnActive]}
          >
            <Feather
              name="layers"
              size={15}
              color={mode === 'architect' ? Palette.inkInverse : Palette.inkSecondary}
            />
            <Text
              style={[styles.segmentText, mode === 'architect' && styles.segmentTextActive]}
            >
              AI 建筑师（建模型/改样式）
            </Text>
          </Pressable>

          <Pressable
            onPress={() => {
              setMode('analyst');
              setErrorMsg(null);
              setSuccessBanner(null);
            }}
            style={[styles.segmentBtn, mode === 'analyst' && styles.segmentBtnActive]}
          >
            <Feather
              name="bar-chart-2"
              size={15}
              color={mode === 'analyst' ? Palette.inkInverse : Palette.inkSecondary}
            />
            <Text
              style={[styles.segmentText, mode === 'analyst' && styles.segmentTextActive]}
            >
              AI 分析师（跨表统计/图表）
            </Text>
          </Pressable>
        </View>

        {/* 输入框 */}
        <View style={styles.composerCard}>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            multiline
            placeholder={
              mode === 'architect'
                ? '描述你想记录的数据结构、多表引用关系、计算公式或卡片高亮样式...'
                : '用自然语言提问跨库开销、趋势、排行或库存预警，AI 将先跑本地 SQLite 验证真实数据...'
            }
            placeholderTextColor={Palette.inkMuted}
            style={styles.promptInput}
          />

          <Pressable
            disabled={Boolean(statusText) || !prompt.trim()}
            onPress={handleRun}
            style={[
              styles.runBtn,
              (Boolean(statusText) || !prompt.trim()) && { opacity: 0.48 },
            ]}
          >
            {statusText ? (
              <ActivityIndicator size="small" color={Palette.inkInverse} />
            ) : (
              <Feather name="send" size={15} color={Palette.inkInverse} />
            )}
            <Text style={styles.runBtnText}>
              {mode === 'architect' ? '生成数据模型与视图方案' : '执行只读 SQL 统计分析'}
            </Text>
          </Pressable>
        </View>

        {statusText ? (
          <View style={styles.statusBanner}>
            <ActivityIndicator size="small" color={Palette.brand} />
            <Text style={styles.statusText}>{statusText}</Text>
          </View>
        ) : null}

        {errorMsg ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        ) : null}

        {successBanner ? (
          <View style={styles.successBanner}>
            <Feather name="check-circle" size={16} color={Palette.success} />
            <Text style={styles.successText}>{successBanner}</Text>
          </View>
        ) : null}

        {/* 建筑师 Diff 预览确认面板 */}
        {mode === 'architect' && pendingPlan ? (
          <View style={styles.diffBox}>
            <Text style={styles.diffHeading}>模型与样式变更预览（确认前不会改动本地库）</Text>
            <Text style={styles.diffSummary}>{pendingPlan.summary}</Text>

            {pendingPlan.libraries.map((bp) => {
              const isUpdate = existingSlugs.has(bp.slug);
              return (
                <View key={bp.slug} style={styles.bpCard}>
                  <View style={styles.bpTitleRow}>
                    <Text style={styles.bpName}>
                      {bp.icon} {bp.name} ({bp.slug})
                    </Text>
                    <View
                      style={[
                        styles.opBadge,
                        {
                          backgroundColor: isUpdate ? Palette.infoSoft : Palette.successSoft,
                        },
                      ]}
                    >
                      <Text
                        style={{
                          fontSize: 11,
                          fontWeight: '700',
                          color: isUpdate ? Palette.info : Palette.success,
                        }}
                      >
                        {isUpdate ? '增量演进' : '新建表'}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.bpFieldsWrap}>
                    {bp.fields.map((f) => (
                      <View key={f.key} style={styles.bpFieldChip}>
                        <Text style={styles.bpFieldText}>
                          {f.label} · {f.type}
                          {f.relationConfig ? ` → ${f.relationConfig.targetLibrarySlug}` : ''}
                          {f.rollupConfig ? ` (${f.rollupConfig.fn})` : ''}
                        </Text>
                      </View>
                    ))}
                  </View>
                </View>
              );
            })}

            {pendingPlan.dashboardWidgets.length > 0 ? (
              <Text style={styles.widgetHint}>
                同时包含 {pendingPlan.dashboardWidgets.length} 张配套离线统计看板图表
              </Text>
            ) : null}

            <View style={styles.diffActionsRow}>
              <Pressable onPress={() => setPendingPlan(null)} style={styles.discardBtn}>
                <Text style={styles.discardText}>放弃方案</Text>
              </Pressable>
              <Pressable onPress={handleConfirmPlan} style={styles.applyBtn}>
                <Feather name="shield" size={15} color={Palette.inkInverse} />
                <Text style={styles.applyText}>创建快照并应用模型</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* 分析师结果与一键钉看板 */}
        {mode === 'analyst' && analystResult ? (
          <View style={styles.analystBox}>
            <View style={styles.insightCard}>
              <View style={styles.insightHeader}>
                <Feather name="check-circle" size={15} color={Palette.brand} />
                <Text style={styles.insightHeaderTitle}>基于本地 SQLite 实测结果</Text>
              </View>
              <Text style={styles.insightBody}>{analystResult.markdownInsight}</Text>
            </View>

            {analystResult.suggestedWidget ? (
              <SqlWidgetCard
                widget={analystResult.suggestedWidget}
                onPin={handlePinWidget}
              />
            ) : null}
          </View>
        ) : null}

        {/* 灵感提示词库 */}
        <View style={styles.examplesSection}>
          <Text style={styles.examplesTitle}>
            {mode === 'architect' ? '一键填入建模灵感：' : '一键填入跨库分析问题：'}
          </Text>
          {(mode === 'architect' ? ARCHITECT_PROMPTS : ANALYST_PROMPTS).map((item, idx) => (
            <Pressable
              key={idx}
              onPress={() => setPrompt(item)}
              style={styles.exampleCard}
            >
              <Text style={styles.exampleItemText}>{item}</Text>
              <Feather name="arrow-up-left" size={15} color={Palette.brand} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Palette.bgCanvas,
  },
  scroll: {
    flex: 1,
  },
  container: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 48,
    gap: 16,
  },
  header: {
    gap: 4,
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: Palette.inkPrimary,
    letterSpacing: -0.3,
  },
  pageSubtitle: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  keyNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Palette.warningSoft,
    padding: 12,
    borderRadius: 14,
  },
  keyNoticeText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: Palette.warning,
  },
  segmentedBar: {
    flexDirection: 'row',
    backgroundColor: Palette.bgSubtle,
    padding: 4,
    borderRadius: 14,
    gap: 4,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 11,
  },
  segmentBtnActive: {
    backgroundColor: Palette.brand,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  segmentTextActive: {
    color: Palette.inkInverse,
  },
  composerCard: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    padding: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 12,
  },
  promptInput: {
    minHeight: 96,
    fontSize: 15,
    color: Palette.inkPrimary,
    textAlignVertical: 'top',
    lineHeight: 22,
  },
  runBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Palette.brand,
    paddingVertical: 13,
    borderRadius: 12,
  },
  runBtnText: {
    color: Palette.inkInverse,
    fontSize: 14,
    fontWeight: '700',
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Palette.brandSoft,
    padding: 13,
    borderRadius: 14,
  },
  statusText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: Palette.brand,
  },
  errorBanner: {
    backgroundColor: Palette.dangerSoft,
    padding: 13,
    borderRadius: 14,
  },
  errorText: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.danger,
  },
  successBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Palette.successSoft,
    padding: 13,
    borderRadius: 14,
  },
  successText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: Palette.success,
  },
  diffBox: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Palette.borderStrong,
    gap: 12,
  },
  diffHeading: {
    fontSize: 15,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  diffSummary: {
    fontSize: 13,
    color: Palette.inkSecondary,
    lineHeight: 20,
  },
  bpCard: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 12,
    gap: 8,
  },
  bpTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bpName: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  opBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  bpFieldsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  bpFieldChip: {
    backgroundColor: Palette.bgSurface,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  bpFieldText: {
    fontSize: 12,
    color: Palette.inkSecondary,
  },
  widgetHint: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.brand,
  },
  diffActionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  discardBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: Palette.bgSubtle,
    alignItems: 'center',
  },
  discardText: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  applyBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: Palette.brand,
  },
  applyText: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
  analystBox: {
    gap: 12,
  },
  insightCard: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  insightHeaderTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.brand,
  },
  insightBody: {
    fontSize: 14,
    lineHeight: 22,
    color: Palette.inkPrimary,
  },
  examplesSection: {
    gap: 8,
    marginTop: 4,
  },
  examplesTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  exampleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: Palette.bgSurface,
    padding: 13,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  exampleItemText: {
    flex: 1,
    fontSize: 13,
    color: Palette.inkSecondary,
    lineHeight: 19,
  },
});
