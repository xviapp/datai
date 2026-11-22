import { Feather } from '@expo/vector-icons';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { runOmniCaptureAgent } from '@/ai/agents';
import { transcribeAudioWithDeepSeek } from '@/ai/deepseek-client';
import { Palette } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { DraftEntryItem } from '@/schema/view-dsl';

const QUICK_EXAMPLES = [
  '刚用招商信用卡给 Sony 微单买了一块滤镜花了 328 元',
  '今天看完了电影《星际穿越》，评分 5 星，诺兰硬科幻神作',
  '鼻炎犯了刚吃了 1 片氯雷他定，今天状态 4 分',
];

export function OmniCaptureModal() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    repo,
    libraries,
    hasApiKey,
    omniModalVisible,
    omniTargetSlug,
    closeOmniCapture,
  } = useOmni();

  const [inputText, setInputText] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState<string | undefined>(undefined);
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [loadingStep, setLoadingStep] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [assistantNote, setAssistantNote] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftEntryItem[]>([]);
  const [isRecording, setIsRecording] = useState(false);

  // Native WAV 16kHz 16-bit PCM preset compliant with DeepSeek POST /v1/tools/asr
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    extension: '.wav',
    sampleRate: 16000,
    numberOfChannels: 1,
    ios: {
      ...RecordingPresets.HIGH_QUALITY.ios,
      extension: '.wav',
      outputFormat: 'lpcm',
      audioQuality: 127,
      sampleRate: 16000,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
  });

  useEffect(() => {
    if (!omniModalVisible) {
      setErrorMsg(null);
      setLoadingStep(null);
      setDrafts([]);
      setAssistantNote(null);
    }
  }, [omniModalVisible]);

  const handlePickPhoto = async (fromCamera: boolean) => {
    try {
      if (fromCamera) {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          setErrorMsg('需要相机权限才能拍照识别小票或实物');
          return;
        }
      }
      const fn = fromCamera
        ? ImagePicker.launchCameraAsync
        : ImagePicker.launchImageLibraryAsync;
      const res = await fn({
        mediaTypes: ['images'],
        quality: 0.75,
        base64: true,
      });
      if (!res.canceled && res.assets[0]?.base64) {
        const mime = res.assets[0].mimeType || 'image/jpeg';
        setImageDataUrl(`data:${mime};base64,${res.assets[0].base64}`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleVoice = async () => {
    if (Platform.OS === 'web') {
      setErrorMsg('网页预览暂不支持录音，请直接打字或选择图片（手机端支持语音输入）');
      return;
    }
    try {
      if (!isRecording) {
        const perm = await AudioModule.requestRecordingPermissionsAsync();
        if (!perm.granted) {
          setErrorMsg('需要麦克风权限才能使用语音记录');
          return;
        }
        await recorder.prepareToRecordAsync();
        recorder.record();
        setIsRecording(true);
      } else {
        await recorder.stop();
        setIsRecording(false);
        if (recorder.uri) {
          setLoadingStep('正在听写语音...');
          const text = await transcribeAudioWithDeepSeek(recorder.uri);
          setInputText((prev) => (prev ? `${prev} ${text}` : text));
          setLoadingStep(null);
        }
      }
    } catch (err) {
      setIsRecording(false);
      setLoadingStep(null);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleParseWithAi = async () => {
    if (!repo) return;
    if (!inputText.trim() && !imageDataUrl) {
      setErrorMsg('请输入一句话描述，或上传一张小票/封面照片');
      return;
    }
    try {
      setErrorMsg(null);
      setDrafts([]);
      const result = await runOmniCaptureAgent(
        repo,
        {
          text: inputText,
          imageBase64DataUrl: imageDataUrl,
          useWebSearch,
          targetLibrarySlug: omniTargetSlug,
        },
        (msg) => setLoadingStep(msg)
      );
      setAssistantNote(result.assistantNote);
      setDrafts(result.drafts);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingStep(null);
    }
  };

  const handleCommitDrafts = () => {
    if (!repo || drafts.length === 0) return;
    try {
      repo.commitOmniDrafts(drafts, `AI 快记：${inputText.slice(0, 24) || '图片识别入库'}`);
      setInputText('');
      setImageDataUrl(undefined);
      setDrafts([]);
      closeOmniCapture();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const removeDraftAt = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
  };

  const libMap = new Map(libraries.map((l) => [l.slug, l]));

  return (
    <Modal
      visible={omniModalVisible}
      animationType="slide"
      transparent
      onRequestClose={closeOmniCapture}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.backdrop}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerTitleRow}>
              <Feather name="edit-3" size={18} color={Palette.brand} />
              <Text style={styles.headerTitle}>
                随手记{omniTargetSlug ? ` · ${libMap.get(omniTargetSlug)?.name ?? ''}` : ''}
              </Text>
            </View>
            <Pressable onPress={closeOmniCapture} style={styles.closeBtn}>
              <Feather name="x" size={20} color={Palette.inkSecondary} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {!hasApiKey ? (
              <Pressable
                onPress={() => {
                  closeOmniCapture();
                  router.push('/(tabs)/settings');
                }}
                style={styles.keyNotice}
              >
                <Feather name="key" size={15} color={Palette.warning} />
                <Text style={styles.keyNoticeText}>
                  还未填写 API Key，点这里去「设置」连接后就能自动整理记录 →
                </Text>
              </Pressable>
            ) : null}

            <TextInput
              value={inputText}
              onChangeText={setInputText}
              multiline
              placeholder="随口记一句、粘贴链接，或拍张小票，会自动帮你归类整理..."
              placeholderTextColor={Palette.inkMuted}
              style={styles.omniInput}
            />

            {/* 工具条 */}
            <View style={styles.toolsRow}>
              <Pressable onPress={() => handlePickPhoto(false)} style={styles.toolChip}>
                <Feather name="image" size={15} color={Palette.brand} />
                <Text style={styles.toolChipText}>选照片</Text>
              </Pressable>
              {Platform.OS !== 'web' ? (
                <Pressable onPress={() => handlePickPhoto(true)} style={styles.toolChip}>
                  <Feather name="camera" size={15} color={Palette.brand} />
                  <Text style={styles.toolChipText}>拍照</Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={handleToggleVoice}
                style={[styles.toolChip, isRecording && styles.toolChipRecording]}
              >
                <Feather
                  name="mic"
                  size={15}
                  color={isRecording ? Palette.inkInverse : Palette.brand}
                />
                <Text style={[styles.toolChipText, isRecording && { color: Palette.inkInverse }]}>
                  {isRecording ? '停止录音' : '语音'}
                </Text>
              </Pressable>

              <View style={styles.webSwitchWrap}>
                <Text style={styles.webSwitchLabel}>联网补充</Text>
                <Switch
                  value={useWebSearch}
                  onValueChange={setUseWebSearch}
                  trackColor={{ false: Palette.borderStrong, true: Palette.brand }}
                />
              </View>
            </View>

            {imageDataUrl ? (
              <View style={styles.attachedImgRow}>
                <Image source={{ uri: imageDataUrl }} style={styles.attachedThumb} contentFit="cover" />
                <Text style={styles.attachedHint}>已选好图片，提交后会自动识别内容</Text>
                <Pressable onPress={() => setImageDataUrl(undefined)}>
                  <Feather name="trash-2" size={16} color={Palette.danger} />
                </Pressable>
              </View>
            ) : null}

            {/* 快捷示例 */}
            {drafts.length === 0 ? (
              <View style={styles.examplesBox}>
                <Text style={styles.examplesLabel}>试着记一句：</Text>
                {QUICK_EXAMPLES.map((ex, i) => (
                  <Pressable key={i} onPress={() => setInputText(ex)} style={styles.examplePill}>
                    <Text style={styles.exampleText} numberOfLines={1}>
                      “{ex}”
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {errorMsg ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            {loadingStep ? (
              <View style={styles.loadingCard}>
                <ActivityIndicator size="small" color={Palette.brand} />
                <Text style={styles.loadingText}>{loadingStep}</Text>
              </View>
            ) : null}

            {/* 草稿预览确认卡 */}
            {drafts.length > 0 ? (
              <View style={styles.draftsSection}>
                {assistantNote ? <Text style={styles.assistantNote}>{assistantNote}</Text> : null}
                {drafts.map((d, idx) => {
                  const targetLib = libMap.get(d.librarySlug);
                  return (
                    <View key={idx} style={styles.draftCard}>
                      <View style={styles.draftHeader}>
                        <Text style={styles.draftLibBadge}>
                          {targetLib ? `${targetLib.icon} ${targetLib.name}` : d.librarySlug}
                        </Text>
                        <Pressable onPress={() => removeDraftAt(idx)}>
                          <Feather name="x" size={16} color={Palette.inkMuted} />
                        </Pressable>
                      </View>
                      <Text style={styles.draftReason}>{d.reason}</Text>
                      <View style={styles.draftFieldsGrid}>
                        {Object.entries(d.data).map(([k, v]) => {
                          const fDef = targetLib?.fields.find((f) => f.key === k);
                          return (
                            <View key={k} style={styles.draftKvRow}>
                              <Text style={styles.draftKey}>{fDef?.label ?? k}:</Text>
                              <Text style={styles.draftVal} numberOfLines={2}>
                                {Array.isArray(v) ? v.join(', ') : String(v ?? '')}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </ScrollView>

          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 14) }]}>
            {drafts.length > 0 ? (
              <>
                <Pressable onPress={() => setDrafts([])} style={styles.secondaryBtn}>
                  <Text style={styles.secondaryBtnText}>重新整理</Text>
                </Pressable>
                <Pressable onPress={handleCommitDrafts} style={styles.primaryBtn}>
                  <Feather name="check" size={16} color={Palette.inkInverse} />
                  <Text style={styles.primaryBtnText}>保存记录 ({drafts.length})</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                disabled={Boolean(loadingStep)}
                onPress={handleParseWithAi}
                style={[styles.primaryBtn, { flex: 1 }, Boolean(loadingStep) && { opacity: 0.5 }]}
              >
                <Feather name="arrow-up-circle" size={16} color={Palette.inkInverse} />
                <Text style={styles.primaryBtnText}>帮我整理归类</Text>
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20, 26, 25, 0.48)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Palette.bgSurface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '88%',
    width: '100%',
    maxWidth: 680,
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  closeBtn: {
    padding: 4,
  },
  body: {
    paddingHorizontal: 20,
  },
  bodyContent: {
    paddingVertical: 16,
    gap: 14,
  },
  keyNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Palette.warningSoft,
    padding: 12,
    borderRadius: 12,
  },
  keyNoticeText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: Palette.warning,
  },
  omniInput: {
    minHeight: 92,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 14,
    padding: 14,
    fontSize: 15,
    color: Palette.inkPrimary,
    textAlignVertical: 'top',
  },
  toolsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  toolChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
  },
  toolChipRecording: {
    backgroundColor: Palette.danger,
  },
  toolChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  webSwitchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
  },
  webSwitchLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  attachedImgRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Palette.bgCanvas,
    padding: 10,
    borderRadius: 12,
  },
  attachedThumb: {
    width: 44,
    height: 44,
    borderRadius: 8,
  },
  attachedHint: {
    flex: 1,
    fontSize: 12,
    color: Palette.inkSecondary,
  },
  examplesBox: {
    gap: 6,
  },
  examplesLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkMuted,
  },
  examplePill: {
    backgroundColor: Palette.bgCanvas,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  exampleText: {
    fontSize: 12,
    color: Palette.inkSecondary,
  },
  errorBanner: {
    backgroundColor: Palette.dangerSoft,
    padding: 12,
    borderRadius: 12,
  },
  errorText: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.danger,
  },
  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Palette.brandSoft,
    padding: 14,
    borderRadius: 12,
  },
  loadingText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: Palette.brand,
  },
  draftsSection: {
    gap: 10,
  },
  assistantNote: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.brand,
  },
  draftCard: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: Palette.borderStrong,
    gap: 6,
  },
  draftHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  draftLibBadge: {
    fontSize: 14,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  draftReason: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  draftFieldsGrid: {
    gap: 4,
    marginTop: 4,
  },
  draftKvRow: {
    flexDirection: 'row',
    gap: 6,
  },
  draftKey: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  draftVal: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  secondaryBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: Palette.bgSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  primaryBtn: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: Palette.brand,
  },
  primaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
});
