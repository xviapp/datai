import { Feather } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import React, { useEffect, useMemo, useState } from 'react';
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

export default function SettingsScreen() {
  const { repo, revision, refreshApiKeyState } = useOmni();

  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com');
  const [effort, setEffort] = useState<ReasoningEffort>('high');
  const [enableWebEnrich, setEnableWebEnrich] = useState(true);

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
    })();
  }, []);

  const snapshots = useMemo(() => {
    void revision;
    if (!repo) return [];
    return repo.listSnapshots();
  }, [repo, revision]);

  const handleSaveConfig = async () => {
    await saveDeepSeekApiKey(apiKey);
    await saveAiPreferences({
      baseUrl: baseUrl.trim() || 'https://api.deepseek.com',
      model: 'deepseek-flash',
      architectEffort: effort,
      enableWebEnrich,
    });
    await refreshApiKeyState();
    setFeedback({ type: 'ok', text: 'DeepSeek 配置已加密保存至本机安全存储' });
  };

  const handleTestApi = async () => {
    try {
      setTesting(true);
      setFeedback(null);
      await handleSaveConfig();
      const { message } = await callDeepSeekChat({
        thinking: false,
        maxTokens: 32,
        messages: [{ role: 'user', content: '请回复：连接成功' }],
      });
      setFeedback({
        type: 'ok',
        text: `deepseek-flash (V4.1) 响应正常：${message.content?.trim() || 'OK'}`,
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
      setFeedback({ type: 'ok', text: '已无损回滚该次 AI 修改！' });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleExportJson = async () => {
    if (!repo) return;
    try {
      const bundle = repo.exportBackupBundle();
      const jsonStr = JSON.stringify(bundle, null, 2);
      const filename = `omnivault_backup_${new Date().toISOString().slice(0, 10)}.json`;

      if (Platform.OS === 'web') {
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setFeedback({ type: 'ok', text: `已下载离线数据包 ${filename}` });
        return;
      }

      const outFile = new File(Paths.cache, filename);
      outFile.write(jsonStr);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(outFile.uri, { mimeType: 'application/json' });
      }
      setFeedback({ type: 'ok', text: '已调起系统文件分享导出' });
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
        const resp = await fetch(asset.uri);
        content = await resp.text();
      }
      const parsed = JSON.parse(content) as FullBackupBundle;
      if (!Array.isArray(parsed.libraries) || !Array.isArray(parsed.entries)) {
        throw new Error('备份文件格式不合法');
      }
      repo.importBackupBundle(parsed);
      setFeedback({
        type: 'ok',
        text: `成功导入 ${parsed.libraries.length} 个库、${parsed.entries.length} 条记录`,
      });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
        <Text style={styles.pageTitle}>设置与时光机</Text>

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
                fontSize: 13,
                fontWeight: '700',
                color: feedback.type === 'ok' ? Palette.success : Palette.danger,
              }}
            >
              {feedback.text}
            </Text>
          </View>
        ) : null}

        {/* 1. DeepSeek BYOK 配置 */}
        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Feather name="key" size={16} color={Palette.brand} />
            <Text style={styles.cardTitle}>自填 DeepSeek API Key（纯单机直连）</Text>
          </View>
          <Text style={styles.cardHint}>
            使用最新统一模型 `deepseek-flash`（DeepSeek-V4.1-Flash-1017），原生涵盖多模态视觉、思考推理、ASR 语音与联网阅读。密钥仅加密存于本机，不经任何第三方服务器。
          </Text>

          <View style={styles.keyInputRow}>
            <TextInput
              value={apiKey}
              onChangeText={setApiKey}
              secureTextEntry={!showKey}
              autoCapitalize="none"
              placeholder="sk-..."
              placeholderTextColor={Palette.inkMuted}
              style={[styles.input, { flex: 1 }]}
            />
            <Pressable onPress={() => setShowKey((s) => !s)} style={styles.eyeBtn}>
              <Feather name={showKey ? 'eye-off' : 'eye'} size={17} color={Palette.inkSecondary} />
            </Pressable>
          </View>

          <Text style={styles.label}>API Base URL</Text>
          <TextInput
            value={baseUrl}
            onChangeText={setBaseUrl}
            autoCapitalize="none"
            style={styles.input}
          />

          <Text style={styles.label}>建表与统计思考强度（reasoning_effort）</Text>
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
                    {lv === 'low' ? 'Low (极速)' : lv === 'high' ? 'High (推荐)' : 'Max (深度)'}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchTitle}>启用全家桶联网与读链接补全</Text>
              <Text style={styles.cardHint}>
                快记粘贴 URL 或开启联网时自动调用 deepseek_read_url / deepseek_web_search
              </Text>
            </View>
            <Switch
              value={enableWebEnrich}
              onValueChange={setEnableWebEnrich}
              trackColor={{ false: Palette.borderStrong, true: Palette.brand }}
            />
          </View>

          <View style={styles.btnRow}>
            <Pressable onPress={handleSaveConfig} style={styles.saveBtn}>
              <Text style={styles.saveBtnText}>保存配置</Text>
            </Pressable>
            <Pressable
              disabled={testing}
              onPress={handleTestApi}
              style={[styles.testBtn, testing && { opacity: 0.5 }]}
            >
              {testing ? (
                <ActivityIndicator size="small" color={Palette.brand} />
              ) : (
                <Feather name="zap" size={14} color={Palette.brand} />
              )}
              <Text style={styles.testBtnText}>实测连通性</Text>
            </Pressable>
          </View>
        </View>

        {/* 2. AI 操作时光机（Undo） */}
        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Feather name="rotate-ccw" size={16} color={Palette.brand} />
            <Text style={styles.cardTitle}>AI 操作时光机（一键回滚护栏）</Text>
          </View>
          {snapshots.length === 0 ? (
            <Text style={styles.cardHint}>
              暂无 AI 变更记录。每次通过 AI 建表、改样式或批量入库前都会自动生成无损快照。
            </Text>
          ) : (
            snapshots.map((snap) => (
              <View key={snap.id} style={styles.snapRow}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.snapTitle} numberOfLines={1}>
                    {snap.actionSummary}
                  </Text>
                  <Text style={styles.snapTime}>
                    {new Date(snap.createdAt).toLocaleString('zh-CN')}
                  </Text>
                </View>
                {snap.undone ? (
                  <Text style={styles.undoneTag}>已回滚</Text>
                ) : (
                  <Pressable onPress={() => handleUndo(snap.id)} style={styles.undoBtn}>
                    <Text style={styles.undoBtnText}>一键撤销</Text>
                  </Pressable>
                )}
              </View>
            ))
          )}
        </View>

        {/* 3. 纯单机本地导入导出逃生舱 */}
        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <Feather name="hard-drive" size={16} color={Palette.brand} />
            <Text style={styles.cardTitle}>本地离线数据包导出 / 导入</Text>
          </View>
          <Text style={styles.cardHint}>
            虽为纯单机运行，你仍可随时将全库结构、记录、关联边与统计看板打包为单文件 JSON 留存到手机文件管理。
          </Text>
          <View style={styles.btnRow}>
            <Pressable onPress={handleExportJson} style={styles.outlineBtn}>
              <Feather name="download" size={15} color={Palette.inkPrimary} />
              <Text style={styles.outlineBtnText}>导出全库 JSON</Text>
            </Pressable>
            <Pressable onPress={handleImportJson} style={styles.outlineBtn}>
              <Feather name="upload" size={15} color={Palette.inkPrimary} />
              <Text style={styles.outlineBtnText}>导入恢复 JSON</Text>
            </Pressable>
          </View>
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
    maxWidth: 760,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 48,
    gap: 16,
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  banner: {
    padding: 13,
    borderRadius: 14,
  },
  card: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 12,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  cardHint: {
    fontSize: 12,
    color: Palette.inkMuted,
    lineHeight: 18,
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
    paddingTop: 4,
  },
  switchTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.inkPrimary,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 2,
  },
  saveBtn: {
    flex: 1,
    backgroundColor: Palette.brand,
    paddingVertical: 12,
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
    paddingVertical: 12,
    borderRadius: 12,
  },
  testBtnText: {
    color: Palette.brand,
    fontSize: 14,
    fontWeight: '700',
  },
  snapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
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
  outlineBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderStrong,
    paddingVertical: 11,
    borderRadius: 12,
  },
  outlineBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
});
