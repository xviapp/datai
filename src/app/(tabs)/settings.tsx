import Feather from '@expo/vector-icons/Feather';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { callDeepSeekChat } from '@/ai/deepseek-client';
import {
  getAiPreferences,
  getDeepSeekApiKey,
  saveAiPreferences,
  saveDeepSeekApiKey,
  type ReasoningEffort,
} from '@/ai/settings-store';
import { TabPageHeader } from '@/components/layout/TabPageHeader';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Palette } from '@/constants/design-tokens';
import { useRepository, useWidgetRevision } from '@/context/omni-context';
import type { SnapshotUndoImpact } from '@/db/models';
import {
  exportBackupBundleToDevice,
  getLastBackupAt,
  pickBackupBundleFromDevice,
  saveLastBackupAt,
} from '@/engine/backup-io';
import { cleanupOrphanedImages } from '@/engine/image-storage';

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: '快速',
  high: '均衡',
  max: '深度',
};

export default function SettingsScreen() {
  const { repo, libraries, revision, hasApiKey, refreshApiKeyState } = useRepository();
  const widgetRevision = useWidgetRevision();

  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com');
  const [effort, setEffort] = useState<ReasoningEffort>('high');
  const [enableWebEnrich, setEnableWebEnrich] = useState(true);

  const [aiExpanded, setAiExpanded] = useState(false);
  const [showAdvancedUrl, setShowAdvancedUrl] = useState(false);
  const [showAllSnapshots, setShowAllSnapshots] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());

  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [pendingUndo, setPendingUndo] = useState<{
    snapshotId: string;
    impact: SnapshotUndoImpact;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const [k, prefs, backupTs] = await Promise.all([
        getDeepSeekApiKey(),
        getAiPreferences(),
        getLastBackupAt(),
      ]);
      setApiKey(k);
      setBaseUrl(prefs.baseUrl);
      setEffort(prefs.architectEffort);
      setEnableWebEnrich(prefs.enableWebEnrich);
      setLastBackupAt(backupTs);
      setNowTs(Date.now());
      setAiExpanded(!k);
    })();
  }, []);

  const snapshots = useMemo(
    () => (!repo || revision < 0 ? [] : repo.listSnapshots()),
    [repo, revision]
  );
  const widgetCount = useMemo(
    () => (!repo || widgetRevision < 0 ? 0 : repo.listAllDashboardWidgets().length),
    [repo, widgetRevision]
  );
  const totalEntryCount = useMemo(
    () => libraries.reduce((sum, l) => sum + l.entryCount, 0),
    [libraries]
  );
  const visibleSnapshots = showAllSnapshots ? snapshots : snapshots.slice(0, 3);

  const handleSaveConfig = async () => {
    await saveDeepSeekApiKey(apiKey);
    await saveAiPreferences({
      baseUrl: baseUrl.trim() || 'https://api.deepseek.com',
      model: 'deepseek-flash',
      architectEffort: effort,
      enableWebEnrich,
    });
    await refreshApiKeyState();
    setFeedback({ type: 'ok', text: '设置已保存在本机' });
    if (apiKey.trim()) {
      setAiExpanded(false);
    }
  };

  const handleTestApi = async () => {
    try {
      setTesting(true);
      setFeedback(null);
      await saveDeepSeekApiKey(apiKey);
      await saveAiPreferences({
        baseUrl: baseUrl.trim() || 'https://api.deepseek.com',
        model: 'deepseek-flash',
        architectEffort: effort,
        enableWebEnrich,
      });
      await refreshApiKeyState();

      const { message } = await callDeepSeekChat({
        thinking: false,
        maxTokens: 32,
        messages: [{ role: 'user', content: '请回复：连接成功' }],
      });
      setFeedback({
        type: 'ok',
        text: `连接正常：${message.content?.trim() || 'OK'}`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleRequestUndo = (snapshotId: string) => {
    if (!repo) return;
    try {
      const impact = repo.describeSnapshotUndoImpact(snapshotId);
      setPendingUndo({ snapshotId, impact });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleConfirmUndo = () => {
    if (!repo || !pendingUndo) return;
    const { snapshotId } = pendingUndo;
    setPendingUndo(null);
    try {
      repo.undoSnapshot(snapshotId);
      setFeedback({ type: 'ok', text: '已撤销该操作' });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleExportJson = async () => {
    if (!repo) return;
    try {
      const bundle = repo.exportBackupBundle();
      const result = await exportBackupBundleToDevice(bundle);
      await saveLastBackupAt(result.exportedAt);
      setLastBackupAt(result.exportedAt);
      setNowTs(result.exportedAt);
      setFeedback({ type: 'ok', text: result.message });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleImportJson = async () => {
    if (!repo) return;
    try {
      const parsed = await pickBackupBundleFromDevice();
      if (!parsed) return;
      repo.importBackupBundle(parsed);
      cleanupOrphanedImages(repo.collectReferencedImagePaths());
      setFeedback({
        type: 'ok',
        text: `已恢复 ${parsed.libraries.length} 个记录本、${parsed.entries.length} 条记录`,
      });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const backupAgeDays = lastBackupAt
    ? Math.max(0, Math.floor((nowTs - lastBackupAt) / 86_400_000))
    : null;
  const needsBackupHint =
    totalEntryCount > 0 && (backupAgeDays === null || backupAgeDays >= 14);
  const backupStatusLabel =
    backupAgeDays === null
      ? '尚未备份'
      : backupAgeDays === 0
        ? '今天已备份'
        : `${backupAgeDays}天前`;

  return (
    <View style={styles.safeArea}>
      <TabPageHeader
        title="设置"
        subtitle={hasApiKey ? '数据仅存本机 · 助手已连接' : '数据仅存本机 · 离线可用'}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        {feedback ? (
          <View
            style={[
              styles.banner,
              {
                backgroundColor:
                  feedback.type === 'ok' ? Palette.successSoft : Palette.dangerSoft,
              },
            ]}
          >
            <Text
              style={{
                flex: 1,
                fontSize: 13,
                fontWeight: '700',
                color: feedback.type === 'ok' ? Palette.success : Palette.danger,
              }}
            >
              {feedback.text}
            </Text>
            <Pressable hitSlop={8} onPress={() => setFeedback(null)}>
              <Feather
                name="x"
                size={15}
                color={feedback.type === 'ok' ? Palette.success : Palette.danger}
              />
            </Pressable>
          </View>
        ) : null}

        {/* 1. 本地数据概览 */}
        <View style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <View style={styles.summaryCol}>
              <Text style={styles.summaryNum}>{libraries.length}</Text>
              <Text style={styles.summaryLabel}>记录本</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryCol}>
              <Text style={styles.summaryNum}>{totalEntryCount}</Text>
              <Text style={styles.summaryLabel}>记录条数</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryCol}>
              <Text style={styles.summaryNum}>{widgetCount}</Text>
              <Text style={styles.summaryLabel}>定制统计</Text>
            </View>
          </View>
          <View style={styles.localFootRow}>
            <Feather name="shield" size={12} color={Palette.brand} />
            <Text style={styles.localFootText}>全部数据均安全保存在你的手机本地，离线可用</Text>
          </View>
        </View>

        {/* 2. 智能助手连接 */}
        <Text style={styles.groupHeading}>智能助手</Text>
        <View style={styles.groupCard}>
          <Pressable
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setAiExpanded((v) => !v);
            }}
            style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.78 }]}
          >
            <View
              style={[
                styles.rowIconWrap,
                { backgroundColor: hasApiKey ? Palette.brandSoft : Palette.warningSoft },
              ]}
            >
              <Feather
                name="key"
                size={16}
                color={hasApiKey ? Palette.brand : Palette.warning}
              />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={styles.titleWithDot}>
                <Text style={styles.rowTitle}>DeepSeek 连接</Text>
                <View
                  style={[
                    styles.statusPill,
                    { backgroundColor: hasApiKey ? Palette.successSoft : Palette.warningSoft },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusPillText,
                      { color: hasApiKey ? Palette.success : Palette.warning },
                    ]}
                  >
                    {hasApiKey ? '已连接' : '未配置'}
                  </Text>
                </View>
              </View>
              <Text style={styles.rowSub}>
                {hasApiKey
                  ? `${EFFORT_LABELS[effort]}模式 · ${enableWebEnrich ? '已开联网补充' : '仅本地解析'}`
                  : '填入 API Key 开启语音记账、识图与定制'}
              </Text>
            </View>
            <Feather
              name={aiExpanded ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={Palette.inkMuted}
            />
          </Pressable>

          {aiExpanded ? (
            <View style={styles.expandedForm}>
              <Text style={styles.label}>API Key（仅存于本机）</Text>
              <View style={styles.keyInputRow}>
                <TextInput
                  value={apiKey}
                  onChangeText={setApiKey}
                  secureTextEntry={!showKey}
                  autoCapitalize="none"
                  placeholder="输入 sk-... 密钥"
                  placeholderTextColor={Palette.inkMuted}
                  style={[styles.input, { flex: 1 }]}
                />
                <Pressable onPress={() => setShowKey((s) => !s)} style={styles.eyeBtn}>
                  <Feather
                    name={showKey ? 'eye-off' : 'eye'}
                    size={17}
                    color={Palette.inkSecondary}
                  />
                </Pressable>
              </View>

              <Text style={styles.label}>回答模式</Text>
              <View style={styles.effortRow}>
                {(['low', 'high', 'max'] as ReasoningEffort[]).map((lv) => {
                  const active = effort === lv;
                  return (
                    <Pressable
                      key={lv}
                      onPress={() => setEffort(lv)}
                      style={[styles.effortChip, active && styles.effortChipActive]}
                    >
                      <Text style={[styles.effortText, active && styles.effortTextActive]}>
                        {lv === 'low' ? '快速' : lv === 'high' ? '均衡（推荐）' : '深度'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.switchRow}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.switchTitle}>自动读取链接与联网补充</Text>
                  <Text style={styles.rowSub}>粘贴网址或开启联网时自动补充简介信息</Text>
                </View>
                <Switch
                  value={enableWebEnrich}
                  onValueChange={setEnableWebEnrich}
                  trackColor={{ false: Palette.borderStrong, true: Palette.brand }}
                />
              </View>

              <Pressable
                onPress={() => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setShowAdvancedUrl((v) => !v);
                }}
                style={styles.advancedToggle}
              >
                <Text style={styles.advancedToggleText}>
                  {showAdvancedUrl ? '收起高级选项' : '自定义接口地址（高级）'}
                </Text>
                <Feather
                  name={showAdvancedUrl ? 'chevron-up' : 'chevron-down'}
                  size={14}
                  color={Palette.inkMuted}
                />
              </Pressable>

              {showAdvancedUrl ? (
                <TextInput
                  value={baseUrl}
                  onChangeText={setBaseUrl}
                  autoCapitalize="none"
                  placeholder="https://api.deepseek.com"
                  placeholderTextColor={Palette.inkMuted}
                  style={styles.input}
                />
              ) : null}

              <View style={styles.btnRow}>
                <Pressable onPress={handleSaveConfig} style={styles.saveBtn}>
                  <Text style={styles.saveBtnText}>保存</Text>
                </Pressable>
                <Pressable
                  disabled={testing}
                  onPress={handleTestApi}
                  style={[styles.testBtn, testing && { opacity: 0.5 }]}
                >
                  {testing ? (
                    <ActivityIndicator size="small" color={Palette.brand} />
                  ) : (
                    <Feather name="check-circle" size={14} color={Palette.brand} />
                  )}
                  <Text style={styles.testBtnText}>测试连接</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>

        {/* 3. 最近操作记录 */}
        <Text style={styles.groupHeading}>最近操作记录</Text>
        <View style={styles.groupCard}>
          {snapshots.length === 0 ? (
            <View style={styles.emptySnapRow}>
              <Feather name="rotate-ccw" size={15} color={Palette.inkMuted} />
              <Text style={styles.rowSub}>暂无操作记录</Text>
            </View>
          ) : (
            <>
              {visibleSnapshots.map((snap, idx) => (
                <View key={snap.id} style={[styles.snapRow, idx === 0 && { borderTopWidth: 0 }]}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.snapTitle} numberOfLines={1}>
                      {snap.actionSummary}
                    </Text>
                    <Text style={styles.snapTime}>
                      {new Date(snap.createdAt).toLocaleString('zh-CN')}
                    </Text>
                  </View>
                  {snap.undone ? (
                    <Text style={styles.undoneTag}>已撤销</Text>
                  ) : (
                    <Pressable onPress={() => handleRequestUndo(snap.id)} style={styles.undoBtn}>
                      <Text style={styles.undoBtnText}>撤销</Text>
                    </Pressable>
                  )}
                </View>
              ))}

              {snapshots.length > 3 ? (
                <Pressable
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setShowAllSnapshots((v) => !v);
                  }}
                  style={({ pressed }) => [styles.expandListBtn, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.expandListText}>
                    {showAllSnapshots ? '收起部分记录' : `查看全部 (${snapshots.length})`}
                  </Text>
                </Pressable>
              ) : null}
            </>
          )}
        </View>

        {/* 4. 数据与备份 */}
        <Text style={styles.groupHeading}>数据与备份</Text>
        <View style={styles.groupCard}>
          <Pressable
            onPress={handleExportJson}
            style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.78 }]}
          >
            <View style={[styles.rowIconWrap, { backgroundColor: Palette.brandSoft }]}>
              <Feather name="download" size={16} color={Palette.brand} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={styles.titleWithDot}>
                <Text style={styles.rowTitle}>导出完整备份</Text>
                <View
                  style={[
                    styles.statusPill,
                    {
                      backgroundColor: needsBackupHint
                        ? Palette.warningSoft
                        : Palette.successSoft,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusPillText,
                      { color: needsBackupHint ? Palette.warning : Palette.success },
                    ]}
                  >
                    {backupStatusLabel}
                  </Text>
                </View>
              </View>
              <Text style={styles.rowSub}>
                {needsBackupHint
                  ? '建议定期导出 JSON 备份，防止更换设备或卸载丢数据'
                  : '将所有记录本、内容和统计打包留存'}
              </Text>
            </View>
            <Feather name="chevron-right" size={18} color={Palette.inkMuted} />
          </Pressable>

          <View style={styles.rowDivider} />

          <Pressable
            onPress={handleImportJson}
            style={({ pressed }) => [styles.listRow, pressed && { opacity: 0.78 }]}
          >
            <View style={[styles.rowIconWrap, { backgroundColor: Palette.infoSoft }]}>
              <Feather name="upload" size={16} color={Palette.info} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.rowTitle}>从备份恢复</Text>
              <Text style={styles.rowSub}>选择之前导出的 JSON 备份文件恢复</Text>
            </View>
            <Feather name="chevron-right" size={18} color={Palette.inkMuted} />
          </Pressable>
        </View>

        <Text style={styles.versionFoot}>拾录 Folio v1.0 · 纯本地离线记录本</Text>
      </ScrollView>

      <ConfirmDialog
        visible={Boolean(pendingUndo)}
        title="确认撤销此操作？"
        summary={pendingUndo?.impact.summary}
        description={pendingUndo?.impact.warningText}
        descriptionTone="warning"
        confirmLabel="确认撤销"
        onCancel={() => setPendingUndo(null)}
        onConfirm={handleConfirmUndo}
      />
    </View>
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
    maxWidth: 880,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 4,
    paddingBottom: 40,
    gap: 12,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
  },
  summaryCard: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 14,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  summaryCol: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  summaryNum: {
    fontSize: 22,
    fontWeight: '800',
    color: Palette.inkPrimary,
    letterSpacing: -0.5,
  },
  summaryLabel: {
    fontSize: 12,
    color: Palette.inkMuted,
    fontWeight: '600',
  },
  summaryDivider: {
    width: 1,
    height: 28,
    backgroundColor: Palette.borderHairline,
  },
  localFootRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  localFootText: {
    fontSize: 12,
    color: Palette.inkSecondary,
  },
  groupHeading: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkMuted,
    marginTop: 6,
    marginLeft: 4,
  },
  groupCard: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    overflow: 'hidden',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 15,
    paddingVertical: 14,
  },
  rowDivider: {
    height: 1,
    backgroundColor: Palette.borderHairline,
    marginLeft: 63,
  },
  rowIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleWithDot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  rowSub: {
    fontSize: 12,
    color: Palette.inkMuted,
    lineHeight: 17,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  expandedForm: {
    paddingHorizontal: 15,
    paddingBottom: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
    gap: 11,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  keyInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 12,
    paddingHorizontal: 13,
    paddingVertical: 10,
    fontSize: 14,
    color: Palette.inkPrimary,
  },
  eyeBtn: {
    padding: 10,
    borderRadius: 12,
    backgroundColor: Palette.bgSubtle,
  },
  effortRow: {
    flexDirection: 'row',
    gap: 8,
  },
  effortChip: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    alignItems: 'center',
  },
  effortChipActive: {
    backgroundColor: Palette.brand,
    borderColor: Palette.brand,
  },
  effortText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  effortTextActive: {
    color: Palette.inkInverse,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 2,
  },
  switchTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.inkPrimary,
  },
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  advancedToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkMuted,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 2,
  },
  saveBtn: {
    flex: 1,
    backgroundColor: Palette.brand,
    paddingVertical: 11,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: {
    color: Palette.inkInverse,
    fontSize: 14,
    fontWeight: '700',
  },
  testBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Palette.brandSoft,
    paddingVertical: 11,
    borderRadius: 12,
  },
  testBtnText: {
    color: Palette.brand,
    fontSize: 14,
    fontWeight: '700',
  },
  emptySnapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 15,
  },
  snapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 15,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  snapTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.inkPrimary,
  },
  snapTime: {
    fontSize: 11,
    color: Palette.inkMuted,
  },
  undoBtn: {
    backgroundColor: Palette.warningSoft,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  undoBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.warning,
  },
  undoneTag: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  expandListBtn: {
    alignItems: 'center',
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  expandListText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  versionFoot: {
    textAlign: 'center',
    fontSize: 12,
    color: Palette.inkMuted,
    marginTop: 8,
  },
});
