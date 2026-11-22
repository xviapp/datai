import Feather from '@expo/vector-icons/Feather';
import { AudioModule, useAudioStream } from 'expo-audio';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  runUnifiedAssistant,
  type AssistantIntent,
  type UnifiedAssistantResult,
} from '@/ai/agents';
import { transcribeAudioWithDeepSeek } from '@/ai/deepseek-client';
import { SqlWidgetCard } from '@/components/charts/SqlWidgetCard';
import { Palette } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { ArchitectLibraryDiff } from '@/db/repository';
import { createId } from '@/engine/id';
import { compressImageForAiVision } from '@/engine/image-storage';
import type { FieldType } from '@/schema/field-defs';
import type { DashboardWidget, DraftEntryItem } from '@/schema/view-dsl';

const FIELD_TYPE_NAMES: Record<FieldType, string> = {
  text: '文本',
  number: '数字',
  currency: '金额',
  date: '日期',
  select: '单选',
  multi_select: '多选',
  rating: '评分',
  checkbox: '开关',
  image: '图片',
  relation: '关联',
  rollup: '自动汇总',
  formula: '自动计算',
};

const INTENT_LABELS: Record<AssistantIntent, string> = {
  capture: '记一笔',
  architect: '定制记录本',
  analyst: '问数据',
};

const QUICK_EXAMPLES = [
  { tag: '记一笔', text: '《长安的荔枝》今晚读了 40 分钟到第 185 页，节奏太紧凑了' },
  { tag: '问数据', text: '算一下每件数码装备加上后续配件账单，总共花了多少钱？' },
  { tag: '建记录本', text: '帮我建一套「宠物档案」和附属「疫苗医疗记录」，自动统计总花费' },
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
    omniEntryContext,
    clearOmniEntryContext,
    omniInitialAction,
    closeOmniCapture,
  } = useOmni();

  const [inputText, setInputText] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState<string | undefined>(undefined);
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [loadingStep, setLoadingStep] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [result, setResult] = useState<UnifiedAssistantResult | null>(null);
  const [drafts, setDrafts] = useState<DraftEntryItem[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [prevModalVisible, setPrevModalVisible] = useState(omniModalVisible);
  const didTriggerActionRef = useRef(false);

  // 原生 PCM 音频流直录标准 16kHz 16-bit 单声道 WAV，兼容 DeepSeek /v1/tools/asr
  const { stream: audioStream } = useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: 'int16',
  });

  if (prevModalVisible !== omniModalVisible) {
    setPrevModalVisible(omniModalVisible);
    if (!omniModalVisible) {
      setErrorMsg(null);
      setSuccessMsg(null);
      setLoadingStep(null);
      setResult(null);
      setDrafts([]);
      if (isRecording) {
        setIsRecording(false);
      }
    }
  }

  const handlePickPhoto = useCallback(async (fromCamera: boolean) => {
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
        quality: 0.85,
        base64: Platform.OS === 'web',
      });
      if (!res.canceled && res.assets[0]) {
        const compressed = await compressImageForAiVision(res.assets[0]);
        setImageDataUrl(compressed);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleStartVoice = useCallback(async () => {
    if (Platform.OS === 'web' || !audioStream) {
      setErrorMsg('网页预览暂不支持录音，请直接打字或选择图片（手机端支持语音输入）');
      return;
    }
    try {
      setErrorMsg(null);
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setErrorMsg('需要麦克风权限才能使用语音记录');
        return;
      }
      await audioStream.start();
      await audioStream.startFileRecordingAsync({ format: 'wav', directory: 'cache' });
      setIsRecording(true);
    } catch (err) {
      audioStream.stop();
      setIsRecording(false);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [audioStream]);

  useEffect(() => {
    if (!omniModalVisible) {
      didTriggerActionRef.current = false;
      audioStream?.stop();
      return;
    }

    if (didTriggerActionRef.current || omniInitialAction === 'text') return;
    didTriggerActionRef.current = true;

    const timer = setTimeout(() => {
      if (omniInitialAction === 'camera') {
        void handlePickPhoto(Platform.OS !== 'web');
      } else if (omniInitialAction === 'voice') {
        void handleStartVoice();
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [omniModalVisible, omniInitialAction, audioStream, handlePickPhoto, handleStartVoice]);

  const handleToggleVoice = async () => {
    if (!isRecording) {
      await handleStartVoice();
      return;
    }
    if (!audioStream) return;
    try {
      const rec = await audioStream.stopFileRecordingAsync();
      audioStream.stop();
      setIsRecording(false);

      if (!rec.uri || rec.size <= 44) {
        setErrorMsg('录音时间太短，请说完后再点停止');
        return;
      }

      setLoadingStep('正在听写语音...');
      const text = await transcribeAudioWithDeepSeek(rec.uri, 'speech.wav');
      setInputText((prev) => (prev ? `${prev} ${text}` : text));
      setLoadingStep(null);
    } catch (err) {
      audioStream.stop();
      setIsRecording(false);
      setLoadingStep(null);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSend = async (forceIntent?: AssistantIntent) => {
    if (!repo) return;
    if (!inputText.trim() && !imageDataUrl) {
      setErrorMsg('请输入一句话，或先录音、拍张照片');
      return;
    }
    try {
      setErrorMsg(null);
      setSuccessMsg(null);
      setResult(null);
      setDrafts([]);

      const outcome = await runUnifiedAssistant(
        repo,
        {
          text: inputText,
          imageBase64DataUrl: imageDataUrl,
          useWebSearch,
          targetLibrarySlug: omniTargetSlug,
          entryContext: omniEntryContext,
        },
        (msg) => setLoadingStep(msg),
        forceIntent
      );

      setResult(outcome);
      if (outcome.intent === 'capture') {
        setDrafts(outcome.capture.drafts);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingStep(null);
    }
  };

  const handleCommitDrafts = () => {
    if (!repo || drafts.length === 0) return;
    try {
      repo.commitOmniDrafts(drafts, `随手记：${inputText.slice(0, 24) || '图片识别'}`);
      setInputText('');
      setImageDataUrl(undefined);
      setDrafts([]);
      setResult(null);
      closeOmniCapture();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const architectDiffs: ArchitectLibraryDiff[] =
    repo && result?.intent === 'architect' ? repo.analyzeArchitectPlanDiff(result.plan) : [];
  const hasDestructivePlanChanges = architectDiffs.some((d) => d.hasDestructiveChanges);

  const handleConfirmPlan = () => {
    if (!repo || result?.intent !== 'architect') return;
    try {
      const plan = result.plan;
      repo.applyArchitectPlan(plan, {
        allowDestructiveFieldChanges: hasDestructivePlanChanges,
      });
      const firstSlug = plan.libraries[0]?.slug;
      setInputText('');
      setImageDataUrl(undefined);
      setResult(null);
      closeOmniCapture();
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
      setSuccessMsg(`已将「${w.title}」固定到统计总览！`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const removeDraftAt = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
  };

  const libMap = new Map(libraries.map((l) => [l.slug, l]));
  const existingSlugs = new Set(libraries.map((l) => l.slug));

  const renderFallbackBar = (currentIntent: AssistantIntent) => {
    const others = (['capture', 'architect', 'analyst'] as AssistantIntent[]).filter(
      (i) => i !== currentIntent
    );
    return (
      <View style={styles.fallbackBar}>
        <Text style={styles.fallbackHint}>按「{INTENT_LABELS[currentIntent]}」处理</Text>
        <View style={styles.fallbackBtns}>
          {others.map((alt) => (
            <Pressable
              key={alt}
              disabled={Boolean(loadingStep)}
              onPress={() => handleSend(alt)}
              style={styles.fallbackChip}
            >
              <Text style={styles.fallbackChipText}>改「{INTENT_LABELS[alt]}」</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  };

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
              <Feather name="message-circle" size={18} color={Palette.brand} />
              <Text style={styles.headerTitle} numberOfLines={1}>
                随手说
                {omniEntryContext
                  ? ` · ${omniEntryContext.title}`
                  : omniTargetSlug
                    ? ` · ${libMap.get(omniTargetSlug)?.name ?? ''}`
                    : ''}
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
                  还未填写 API Key，点这里去「设置」连接后即可使用 →
                </Text>
              </Pressable>
            ) : null}

            {omniEntryContext ? (
              <View style={styles.contextBanner}>
                <Feather name="link-2" size={14} color={Palette.brand} />
                <Text style={styles.contextBannerText} numberOfLines={1}>
                  当前关联：{omniEntryContext.libraryIcon} {omniEntryContext.title}
                </Text>
                <Pressable hitSlop={8} onPress={clearOmniEntryContext}>
                  <Feather name="x" size={15} color={Palette.inkMuted} />
                </Pressable>
              </View>
            ) : null}

            <TextInput
              value={inputText}
              onChangeText={setInputText}
              multiline
              placeholder={
                omniEntryContext
                  ? `针对「${omniEntryContext.title}」记一笔进度、书摘随感或拍张书页照...`
                  : '记一笔、建记录本、查开销、画图表或拍张小票，直接说就行...'
              }
              placeholderTextColor={Palette.inkMuted}
              style={styles.omniInput}
            />

            {/* 多模态工具条 */}
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
                <View style={{ flex: 1 }} />
                <Pressable onPress={() => setImageDataUrl(undefined)}>
                  <Feather name="trash-2" size={16} color={Palette.danger} />
                </Pressable>
              </View>
            ) : null}

            {/* 快捷示例（无结果时展示） */}
            {!result && !loadingStep && !omniEntryContext ? (
              <View style={styles.examplesBox}>
                {QUICK_EXAMPLES.map((ex, i) => (
                  <Pressable key={i} onPress={() => setInputText(ex.text)} style={styles.examplePill}>
                    <Text style={styles.exampleTag}>{ex.tag}</Text>
                    <Text style={styles.exampleText} numberOfLines={1}>
                      {ex.text}
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

            {successMsg ? (
              <View style={styles.successBanner}>
                <Feather name="check-circle" size={15} color={Palette.success} />
                <Text style={styles.successText}>{successMsg}</Text>
              </View>
            ) : null}

            {loadingStep ? (
              <View style={styles.loadingCard}>
                <ActivityIndicator size="small" color={Palette.brand} />
                <Text style={styles.loadingText}>{loadingStep}</Text>
              </View>
            ) : null}

            {/* 结果 1：记一笔草稿 */}
            {result?.intent === 'capture' ? (
              <View style={styles.resultSection}>
                {result.capture.assistantNote ? (
                  <Text style={styles.assistantNote}>{result.capture.assistantNote}</Text>
                ) : null}
                {drafts.map((d, idx) => {
                  const targetLib = libMap.get(d.librarySlug);
                  return (
                    <View key={idx} style={styles.resultCard}>
                      <View style={styles.draftHeader}>
                        <Text style={styles.draftLibBadge}>
                          {targetLib ? `${targetLib.icon} ${targetLib.name}` : d.librarySlug}
                        </Text>
                        <Pressable onPress={() => removeDraftAt(idx)}>
                          <Feather name="x" size={16} color={Palette.inkMuted} />
                        </Pressable>
                      </View>
                      {d.reason ? <Text style={styles.draftReason}>{d.reason}</Text> : null}
                      <View style={styles.draftFieldsGrid}>
                        {Object.entries(d.data).map(([k, v]) => {
                          const fDef = targetLib?.fields.find((f) => f.key === k);
                          const formatDraftVal = (rawVal: unknown): string => {
                            if (Array.isArray(rawVal)) {
                              return rawVal
                                .map((item) => {
                                  const token = String(item);
                                  if (token.startsWith('@prev:')) {
                                    const pIdx = Number(token.slice(6));
                                    return `同批新建记录 #${pIdx + 1}`;
                                  }
                                  if (fDef?.type === 'relation' && repo) {
                                    const hydrated = repo.getHydratedEntryById(token);
                                    if (hydrated) return hydrated.entry.titleSummary;
                                  }
                                  return token;
                                })
                                .join('、');
                            }
                            return String(rawVal ?? '');
                          };
                          return (
                            <View key={k} style={styles.draftKvRow}>
                              <Text style={styles.draftKey}>{fDef?.label ?? k}:</Text>
                              <Text style={styles.draftVal} numberOfLines={3}>
                                {formatDraftVal(v)}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  );
                })}
                {renderFallbackBar('capture')}
              </View>
            ) : null}

            {/* 结果 2：定制记录本方案预览 */}
            {result?.intent === 'architect' ? (
              <View style={styles.resultSection}>
                <Text style={styles.sectionTitle}>方案预览（确认前不会改动数据）</Text>
                <Text style={styles.summaryText}>{result.plan.summary}</Text>
                {architectDiffs.length > 0 ? (
                  <View
                    style={[
                      styles.diffWarnBanner,
                      hasDestructivePlanChanges && styles.diffDangerBanner,
                    ]}
                  >
                    <Feather
                      name="alert-triangle"
                      size={15}
                      color={hasDestructivePlanChanges ? Palette.danger : Palette.warning}
                    />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text
                        style={[
                          styles.diffWarnTitle,
                          hasDestructivePlanChanges && { color: Palette.danger },
                        ]}
                      >
                        {hasDestructivePlanChanges
                          ? '注意：此方案会移除或改动已有字段类型，旧记录中对应值可能无法显示或保存'
                          : '存量字段变更提示'}
                      </Text>
                      {architectDiffs.map((d) => (
                        <Text key={d.slug} style={styles.diffWarnLine}>
                          • {d.name}（{d.entryCount} 条记录）：
                          {[
                            d.removedFields.length > 0
                              ? `移除 ${d.removedFields.map((f) => f.label).join('、')}`
                              : '',
                            d.typeChangedFields.length > 0
                              ? `类型变更 ${d.typeChangedFields
                                  .map(
                                    (f) =>
                                      `${f.label}(${FIELD_TYPE_NAMES[f.fromType]}→${FIELD_TYPE_NAMES[f.toType]})`
                                  )
                                  .join('、')}`
                              : '',
                            d.newlyRequiredFields.length > 0
                              ? `新增必填 ${d.newlyRequiredFields.map((f) => f.label).join('、')}`
                              : '',
                          ]
                            .filter(Boolean)
                            .join('；')}
                        </Text>
                      ))}
                    </View>
                  </View>
                ) : null}
                {result.plan.libraries.map((bp) => {
                  const isUpdate = existingSlugs.has(bp.slug);
                  const parentLibName = bp.parentLibrarySlug
                    ? result.plan.libraries.find((x) => x.slug === bp.parentLibrarySlug)?.name ??
                      libMap.get(bp.parentLibrarySlug)?.name ??
                      bp.parentLibrarySlug
                    : null;
                  return (
                    <View key={bp.slug} style={styles.resultCard}>
                      <View style={styles.draftHeader}>
                        <View style={styles.planLibTitleRow}>
                          <Text style={styles.draftLibBadge}>
                            {bp.icon} {bp.name}
                          </Text>
                          {parentLibName ? (
                            <View style={styles.subLibBadge}>
                              <Text style={styles.subLibBadgeText}>
                                附属 · {parentLibName}
                                {bp.showOnHome === false ? '（收纳）' : ''}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        <View
                          style={[
                            styles.opBadge,
                            { backgroundColor: isUpdate ? Palette.infoSoft : Palette.successSoft },
                          ]}
                        >
                          <Text
                            style={{
                              fontSize: 11,
                              fontWeight: '700',
                              color: isUpdate ? Palette.info : Palette.success,
                            }}
                          >
                            {isUpdate ? '更新' : '新建'}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.fieldsWrap}>
                        {bp.fields.map((f) => (
                          <View key={f.key} style={styles.fieldChip}>
                            <Text style={styles.fieldChipText}>
                              {f.label} · {f.multiline ? '多行文本' : FIELD_TYPE_NAMES[f.type] ?? f.type}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  );
                })}
                {result.plan.dashboardWidgets.length > 0 ? (
                  <Text style={styles.assistantNote}>
                    同时会在统计页添加 {result.plan.dashboardWidgets.length} 张配套图表
                  </Text>
                ) : null}
                {renderFallbackBar('architect')}
              </View>
            ) : null}

            {/* 结果 3：问数据统计结论与图表 */}
            {result?.intent === 'analyst' ? (
              <View style={styles.resultSection}>
                <View style={styles.resultCard}>
                  <View style={styles.insightHeader}>
                    <Feather name="check-circle" size={15} color={Palette.brand} />
                    <Text style={styles.insightHeaderTitle}>统计结果</Text>
                  </View>
                  <Text style={styles.insightBody}>{result.answer.markdownInsight}</Text>
                </View>

                {result.answer.suggestedWidget ? (
                  <SqlWidgetCard
                    widget={result.answer.suggestedWidget}
                    onPin={handlePinWidget}
                  />
                ) : null}
                {renderFallbackBar('analyst')}
              </View>
            ) : null}
          </ScrollView>

          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 14) }]}>
            {result?.intent === 'capture' && drafts.length > 0 ? (
              <>
                <Pressable onPress={() => setResult(null)} style={styles.secondaryBtn}>
                  <Text style={styles.secondaryBtnText}>重新来</Text>
                </Pressable>
                <Pressable onPress={handleCommitDrafts} style={styles.primaryBtn}>
                  <Feather name="check" size={16} color={Palette.inkInverse} />
                  <Text style={styles.primaryBtnText}>保存记录 ({drafts.length})</Text>
                </Pressable>
              </>
            ) : result?.intent === 'architect' ? (
              <>
                <Pressable onPress={() => setResult(null)} style={styles.secondaryBtn}>
                  <Text style={styles.secondaryBtnText}>取消</Text>
                </Pressable>
                <Pressable
                  onPress={handleConfirmPlan}
                  style={[
                    styles.primaryBtn,
                    hasDestructivePlanChanges && { backgroundColor: Palette.danger },
                  ]}
                >
                  <Feather name="check" size={16} color={Palette.inkInverse} />
                  <Text style={styles.primaryBtnText}>
                    {hasDestructivePlanChanges ? '已知晓风险，仍要应用' : '确认应用'}
                  </Text>
                </Pressable>
              </>
            ) : result?.intent === 'analyst' ? (
              <>
                <Pressable
                  onPress={() => {
                    setResult(null);
                    setSuccessMsg(null);
                  }}
                  style={styles.secondaryBtn}
                >
                  <Text style={styles.secondaryBtnText}>继续问</Text>
                </Pressable>
                <Pressable onPress={closeOmniCapture} style={styles.primaryBtn}>
                  <Text style={styles.primaryBtnText}>完成</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                disabled={Boolean(loadingStep) || isRecording}
                onPress={() => handleSend()}
                style={[
                  styles.primaryBtn,
                  { flex: 1 },
                  (Boolean(loadingStep) || isRecording) && { opacity: 0.5 },
                ]}
              >
                <Feather name="send" size={15} color={Palette.inkInverse} />
                <Text style={styles.primaryBtnText}>发送</Text>
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
    maxHeight: '90%',
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
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    flex: 1,
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
    gap: 13,
  },
  contextBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 11,
  },
  contextBannerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
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
    minHeight: 88,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 14,
    padding: 14,
    fontSize: 15,
    color: Palette.inkPrimary,
    textAlignVertical: 'top',
    lineHeight: 22,
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
    gap: 7,
  },
  examplesLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkMuted,
  },
  examplePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Palette.bgCanvas,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  exampleTag: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.brand,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  exampleText: {
    flex: 1,
    fontSize: 12,
    color: Palette.inkSecondary,
  },
  errorBanner: {
    backgroundColor: Palette.dangerSoft,
    padding: 12,
    borderRadius: 12,
  },
  diffWarnBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: Palette.warningSoft,
    padding: 12,
    borderRadius: 12,
  },
  diffDangerBanner: {
    backgroundColor: Palette.dangerSoft,
  },
  diffWarnTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.warning,
    lineHeight: 17,
  },
  diffWarnLine: {
    fontSize: 12,
    color: Palette.inkSecondary,
    lineHeight: 17,
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
    padding: 12,
    borderRadius: 12,
  },
  successText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: Palette.success,
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
  resultSection: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  summaryText: {
    fontSize: 13,
    color: Palette.inkSecondary,
    lineHeight: 20,
  },
  assistantNote: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.brand,
  },
  resultCard: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  draftHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  planLibTitleRow: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  subLibBadge: {
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  subLibBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.brand,
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
    marginTop: 2,
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
  opBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  fieldsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  fieldChip: {
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  fieldChipText: {
    fontSize: 11,
    color: Palette.inkSecondary,
    fontWeight: '600',
  },
  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  insightHeaderTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Palette.brand,
  },
  insightBody: {
    fontSize: 14,
    lineHeight: 22,
    color: Palette.inkPrimary,
  },
  fallbackBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
    paddingTop: 4,
  },
  fallbackHint: {
    fontSize: 11,
    color: Palette.inkMuted,
    fontWeight: '600',
  },
  fallbackBtns: {
    flexDirection: 'row',
    gap: 6,
  },
  fallbackChip: {
    backgroundColor: Palette.bgSubtle,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  fallbackChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 12,
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
