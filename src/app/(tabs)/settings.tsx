import { Feather } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { callDeepSeekChat } from '@/ai/deepseek-client';
import {
  getAiPreferences,
  getDeepSeekApiKey,
  saveAiPreferences,
  saveDeepSeekApiKey,
  type ReasoningEffort,
} from '@/ai/settings-store';
import { Palette } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { FullBackupBundle } from '@/db/repository';

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: '快速',
  high: '均衡',
  max: '深度',
};

export default function SettingsScreen() {
  const { repo, libraries, revision, hasApiKey, refreshApiKeyState } = useOmni();

  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com');
  const [effort, setEffort] = useState<ReasoningEffort>('high');
  const [enableWebEnrich, setEnableWebEnrich] = useState(true);

  const [aiExpanded, setAiExpanded] = useState(false);
  const [showAdvancedUrl, setShowAdvancedUrl] = useState(false);
  const [showAllSnapshots, setShowAllSnapshots] = useState(false);

  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      const k = await getDeepSeekApiKey();
      const prefs = await getAiPreferences();
      setApiKey(k);
      setBaseUrl(prefs.baseUrl);
      setEffort(prefs.architectEffort);
      setEnableWebEnrich(prefs.enableWebEnrich);
      // 尚未配置 Key 时自动展开，已配置则默认保持收起清爽状态
      setAiExpanded(!k);
    })();
  }, []);

  const snapshots = !repo || revision < 0 ? [] : repo.listSnapshots();
  const widgetCount = !repo || revision < 0 ? 0 : repo.listAllDashboardWidgets().length;
  const totalEntryCount = libraries.reduce((sum, l) => sum + l.entryCount, 0);
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

  const handleUndo = (snapshotId: string) => {
    if (!repo) return;
    try {
      repo.undoSnapshot(snapshotId);
      setFeedback({ type: 'ok', text: '已恢复到变更前的状态' });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleExportJson = async () => {
    if (!repo) return;
    try {
      const bundle = repo.exportBackupBundle();
      const jsonStr = JSON.stringify(bundle, null, 2);
      const filename = `wanxiangji_backup_${new Date().toISOString().slice(0, 10)}.json`;

      if (Platform.OS === 'web') {
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setFeedback({ type: 'ok', text: `已下载备份文件 ${filename}` });
        return;
      }

      const outFile = new File(Paths.cache, filename);
      outFile.write(jsonStr);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(outFile.uri, { mimeType: 'application/json' });
      }
      setFeedback({ type: 'ok', text: '已打开系统分享导出备份' });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleImportJson = async () => {
    if (!repo) return;
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets[0]) return;
      const asset = res.assets[0];
      let content = '';
      if (Platform.OS === 'web' && asset.file) {
        content = await asset.file.text();
      } else {
        content = await new File(asset.uri).text();
      }
      const parsed = JSON.parse(content) as FullBackupBundle;
      if (!Array.isArray(parsed.libraries) || !Array.isArray(parsed.entries)) {
        throw new Error('备份文件格式不正确');
      }
      repo.importBackupBundle(parsed);
      setFeedback({
        type: 'ok',
        text: `已恢复 ${parsed.libraries.length} 个记录本、${parsed.entries.length} 条记录`,
      });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.pageTitle}>设置</Text>

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

        {/* 2. 智能助手连接（默认折叠态，点击展开） */}
        <Text style={styles.groupHeading}>智能助手</Text>
        <View style={styles.groupCard}>
          <Pressable
            onPress={() => setAiExpanded((v) => !v)}
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

              {/* 低频接口地址收入高级选项 */}
              <Pressable
                onPress={() => setShowAdvancedUrl((v) => !v)}
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

        {/* 3. 最近操作记录（默认最多 3 条） */}
        <Text style={styles.groupHeading}>最近操作记录</Text>
        <View style={styles.groupCard}>
          {snapshots.length === 0 ? (
            <View style={styles.emptySnapRow}>
              <Feather name="rotate-ccw" size={15} color={Palette.inkMuted} />
              <Text style={styles.rowSub}>
                暂无记录。通过助手改动记录本或删除记录本前都会自动留备份，可随时撤销。
              </Text>
            </View>
          ) : (
            <>
              {visibleSnapshots.map((snap, idx) => (
                <View
                  key={snap.id}
                  style={[styles.snapRow, idx === 0 && { borderTopWidth: 0 }]}
                >
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
                    <Pressable onPress={() => handleUndo(snap.id)} style={styles.undoBtn}>
                      <Text style={styles.undoBtnText}>撤销</Text>
                    </Pressable>
                  )}
                </View>
              ))}

              {snapshots.length > 3 ? (
                <Pressable
                  onPress={() => setShowAllSnapshots((v) => !v)}
                  style={styles.expandListBtn}
                >
                  <Text style={styles.expandListText}>
                    {showAllSnapshots ? '收起部分记录' : `查看全部 (${snapshots.length})`}
                  </Text>
                </Pressable>
              ) : null}
            </>
          )}
        </View>

        {/* 4. 数据与备份（原生列表项） */}
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
              <Text style={styles.rowTitle}>导出完整备份</Text>
              <Text style={styles.rowSub}>将所有记录本、内容和统计打包留存</Text>
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

        <Text style={styles.versionFoot}>万象记 v1.0 · 纯本地离线记录本</Text>
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
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 40,
    gap: 12,
  },
  pageTitle: {
    fontSize: 25,
    fontWeight: '800',
    color: Palette.inkPrimary,
    letterSpacing: -0.5,
    marginBottom: 2,
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
