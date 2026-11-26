import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  LayoutAnimation,
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
  type AssistantMode,
  type UnifiedAssistantResult,
} from '@/ai/agents';
import { isAbortError } from '@/ai/deepseek-client';
import { AnalystResultView } from '@/components/ai/omni-capture/AnalystResultView';
import { ArchitectPlanView } from '@/components/ai/omni-capture/ArchitectPlanView';
import { CaptureResultView } from '@/components/ai/omni-capture/CaptureResultView';
import {
  buildContextualExamples,
  getDefaultModeForScene,
  getModeOptionsForScene,
  getPrimarySendLabel,
  getSceneHeaderConfig,
  getSceneInputPlaceholder,
} from '@/components/ai/omni-capture/scene-config';
import { useVoiceRecorder } from '@/components/ai/omni-capture/useVoiceRecorder';
import { BottomSheetModal } from '@/components/ui/BottomSheetModal';
import { SlidingSegmentedBar } from '@/components/ui/SlidingSegmentedBar';
import { Palette } from '@/constants/design-tokens';
import {
  useOmniModalActions,
  useOmniModalState,
  useRepository,
} from '@/context/omni-context';
import type { ArchitectLibraryDiff } from '@/db/models';
import {
  findDanglingDraftRelations,
  normalizeCaptureDrafts,
  removeCaptureDraftById,
  updateDraftRelationTokens,
  type ManagedCaptureDraft,
} from '@/engine/capture-drafts';
import { createId } from '@/engine/id';
import { compressImageForAiVision, pickImageAsset } from '@/engine/image-storage';
import type { FieldType } from '@/schema/field-defs';
import type { DashboardWidget } from '@/schema/view-dsl';

export function OmniCaptureModal() {
  const { libraries } = useRepository();
  const { omniModalVisible, omniScene, omniTargetSlug, omniEntryContext, omniInitialAction } =
    useOmniModalState();
  const { closeOmniCapture } = useOmniModalActions();

  const targetLib = useMemo(
    () => (omniTargetSlug ? libraries.find((l) => l.slug === omniTargetSlug) : undefined),
    [libraries, omniTargetSlug]
  );

  const headerConfig = getSceneHeaderConfig(omniScene, targetLib, omniEntryContext);
  const sessionKey = `${omniScene}::${omniTargetSlug ?? ''}::${omniEntryContext?.entryId ?? ''}::${omniEntryContext?.activeTab ?? ''}::${omniInitialAction}`;

  return (
    <BottomSheetModal
      visible={omniModalVisible}
      onClose={closeOmniCapture}
      maxHeight="90%"
      maxWidth={680}
      header={
        <View style={styles.header}>
          <View style={styles.headerTitleRow}>
            <Feather name={headerConfig.icon} size={18} color={Palette.brand} />
            <Text style={styles.headerTitle} numberOfLines={1}>
              {headerConfig.title}
            </Text>
            <View style={styles.roleBadge}>
              <Text style={styles.roleBadgeText}>{headerConfig.roleBadge}</Text>
            </View>
          </View>
          <Pressable
            onPress={closeOmniCapture}
            hitSlop={8}
            style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}
          >
            <Feather name="x" size={20} color={Palette.inkSecondary} />
          </Pressable>
        </View>
      }
    >
      {omniModalVisible ? <OmniCaptureBody key={sessionKey} /> : null}
    </BottomSheetModal>
  );
}

function OmniCaptureBody() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { repo, libraries, hasApiKey } = useRepository();
  const { omniScene, omniTargetSlug, omniEntryContext, omniInitialAction } = useOmniModalState();
  const { clearOmniEntryContext, closeOmniCapture } = useOmniModalActions();

  const [inputText, setInputText] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState<string | undefined>(undefined);
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [loadingStep, setLoadingStep] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [result, setResult] = useState<UnifiedAssistantResult | null>(null);
  const [drafts, setDrafts] = useState<ManagedCaptureDraft[]>([]);
  const [removedDraftTitles, setRemovedDraftTitles] = useState<Record<string, string>>({});
  const [composerExpanded, setComposerExpanded] = useState(true);
  const [selectedMode, setSelectedMode] = useState<AssistantMode>(() =>
    getDefaultModeForScene(omniScene, omniEntryContext)
  );

  const abortRef = useRef<AbortController | null>(null);
  const didTriggerActionRef = useRef(false);

  const handleVoiceTranscribed = useCallback((text: string) => {
    setInputText((prev) => (prev ? `${prev} ${text}` : text));
  }, []);

  const {
    isRecording,
    recordPulse,
    formattedRecordTime,
    startRecording,
    toggleRecording,
  } = useVoiceRecorder({
    onTranscribed: handleVoiceTranscribed,
    onLoadingChange: setLoadingStep,
    onError: setErrorMsg,
  });

  // 弹窗卸载或关闭时立即中止所有在途网络请求，避免竞态回写
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handlePickPhoto = useCallback(async (fromCamera: boolean) => {
    try {
      setErrorMsg(null);
      const asset = await pickImageAsset(fromCamera, '需要相机权限才能拍照识别小票或实物');
      if (asset) {
        const compressed = await compressImageForAiVision(asset);
        setImageDataUrl(compressed);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (didTriggerActionRef.current || omniInitialAction === 'text') return;
    didTriggerActionRef.current = true;

    const timer = setTimeout(() => {
      if (omniInitialAction === 'camera') {
        void handlePickPhoto(Platform.OS !== 'web');
      } else if (omniInitialAction === 'voice') {
        void startRecording();
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [omniInitialAction, handlePickPhoto, startRecording]);

  const libMap = useMemo(() => new Map(libraries.map((l) => [l.slug, l])), [libraries]);
  const existingSlugs = useMemo(() => new Set(libraries.map((l) => l.slug)), [libraries]);
  const targetLib = omniTargetSlug ? libMap.get(omniTargetSlug) : undefined;

  const entryParentSlug = omniEntryContext?.librarySlug;
  const childLibs = useMemo(
    () =>
      entryParentSlug ? libraries.filter((l) => l.parentLibrarySlug === entryParentSlug) : [],
    [libraries, entryParentSlug]
  );
  const reverseRelLibs = useMemo(() => {
    if (!entryParentSlug) return [];
    const childSlugSet = new Set(childLibs.map((c) => c.slug));
    return libraries.filter(
      (l) =>
        !childSlugSet.has(l.slug) &&
        l.fields.some(
          (f) => f.type === 'relation' && f.relationConfig?.targetLibrarySlug === entryParentSlug
        )
    );
  }, [libraries, entryParentSlug, childLibs]);

  const modeOptions = getModeOptionsForScene(omniScene, omniEntryContext);
  const activeMode: AssistantMode = modeOptions.some((o) => o.mode === selectedMode)
    ? selectedMode
    : (modeOptions[0]?.mode ?? 'auto');

  const showCaptureTools = activeMode === 'auto' || activeMode === 'capture';
  const showComposerBody = !result || composerExpanded;

  const updateDraftField = (
    draftId: string,
    fieldKey: string,
    nextRaw: string,
    fieldType?: FieldType
  ) => {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.draftId !== draftId) return d;
        let parsed: unknown = nextRaw;
        if (fieldType === 'number' || fieldType === 'currency' || fieldType === 'rating') {
          const num = Number(nextRaw);
          parsed = nextRaw.trim() === '' ? '' : Number.isFinite(num) ? num : nextRaw;
        }
        return { ...d, data: { ...d.data, [fieldKey]: parsed } };
      })
    );
  };

  const updateDraftRelation = (draftId: string, fieldKey: string, nextTokens: string[]) => {
    setErrorMsg(null);
    setDrafts((prev) => updateDraftRelationTokens(prev, draftId, fieldKey, nextTokens));
  };

  const handleToggleVoicePress = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void toggleRecording(controller.signal);
  };

  const handleSend = async (explicitForceIntent?: AssistantIntent) => {
    if (!repo) return;
    const effectiveForce =
      explicitForceIntent ?? (activeMode === 'auto' ? undefined : activeMode);
    if (!inputText.trim() && (!showCaptureTools || !imageDataUrl)) {
      setErrorMsg(
        effectiveForce === 'analyst'
          ? '请输入你想统计的问题或图表需求，也可以直接语音提问'
          : '请输入一句话，或先录音、拍张照片'
      );
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setErrorMsg(null);
      setSuccessMsg(null);
      setResult(null);
      setDrafts([]);
      setRemovedDraftTitles({});

      const outcome = await runUnifiedAssistant(
        repo,
        {
          text: inputText,
          imageBase64DataUrl: showCaptureTools ? imageDataUrl : undefined,
          useWebSearch: showCaptureTools ? useWebSearch : false,
          scene: omniScene,
          targetLibrarySlug: omniTargetSlug,
          entryContext: omniEntryContext,
          signal: controller.signal,
        },
        (msg) => {
          if (!controller.signal.aborted) {
            setLoadingStep(msg);
          }
        },
        effectiveForce
      );

      if (controller.signal.aborted) return;

      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setResult(outcome);
      setComposerExpanded(false);
      if (outcome.intent === 'capture') {
        setDrafts(normalizeCaptureDrafts(outcome.capture.drafts, libMap));
        setRemovedDraftTitles({});
      }
    } catch (err) {
      if (isAbortError(err)) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === controller) {
        setLoadingStep(null);
      }
    }
  };

  const danglingRelations = useMemo(
    () => findDanglingDraftRelations(drafts, libMap),
    [drafts, libMap]
  );

  const handleCommitDrafts = () => {
    if (!repo || drafts.length === 0) return;
    if (danglingRelations.length > 0) {
      setErrorMsg(
        `有 ${danglingRelations.length} 处关联指向已删除的草稿，请先重新选择或清除关联后再保存`
      );
      return;
    }
    try {
      setErrorMsg(null);
      repo.commitOmniDrafts(drafts, `随手记：${inputText.slice(0, 24) || '图片识别'}`);
      closeOmniCapture();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const architectDiffs: ArchitectLibraryDiff[] = useMemo(
    () => (repo && result?.intent === 'architect' ? repo.analyzeArchitectPlanDiff(result.plan) : []),
    [repo, result]
  );
  const hasDestructivePlanChanges = architectDiffs.some((d) => d.hasDestructiveChanges);

  const handleConfirmPlan = () => {
    if (!repo || result?.intent !== 'architect') return;
    try {
      const plan = result.plan;
      repo.applyArchitectPlan(plan, {
        allowDestructiveFieldChanges: hasDestructivePlanChanges,
      });
      const firstSlug = plan.libraries[0]?.slug;
      closeOmniCapture();
      if (firstSlug) {
        setTimeout(() => {
          router.push(`/library/${firstSlug}`);
        }, 210);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePinWidget = (w: DashboardWidget) => {
    if (!repo) return;
    try {
      const targetSlugForWidget = omniTargetSlug ?? null;
      repo.saveDashboardWidget({ ...w, id: createId('wdg') }, targetSlugForWidget);
      setSuccessMsg(
        targetSlugForWidget && targetLib
          ? `已将「${w.title}」固定到「${targetLib.name}」与统计总览！`
          : `已将「${w.title}」固定到统计总览！`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const removeDraftById = (draftId: string) => {
    setErrorMsg(null);
    setDrafts((prev) => {
      const { nextDrafts, removedLabel } = removeCaptureDraftById(prev, draftId, libMap);
      if (removedLabel) {
        setRemovedDraftTitles((titles) => ({ ...titles, [draftId]: removedLabel }));
      }
      return nextDrafts;
    });
  };

  const inputPlaceholder = getSceneInputPlaceholder({
    scene: omniScene,
    mode: activeMode,
    targetLib,
    entryContext: omniEntryContext,
    childLibs,
    reverseRelLibs,
  });

  const contextualExamples = buildContextualExamples({
    scene: omniScene,
    mode: activeMode,
    targetLib,
    entryContext: omniEntryContext,
    childLibs,
    reverseRelLibs,
  });

  return (
    <>
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
      >
        {!hasApiKey ? (
          <Pressable
            onPress={() => {
              closeOmniCapture();
              setTimeout(() => {
                router.navigate('/(tabs)/settings');
              }, 200);
            }}
            style={({ pressed }) => [styles.keyNotice, pressed && { opacity: 0.78 }]}
          >
            <Feather name="key" size={15} color={Palette.warning} />
            <Text style={styles.keyNoticeText}>
              还未填写 API Key，点这里去「设置」连接后即可使用 →
            </Text>
          </Pressable>
        ) : null}

        {result && !composerExpanded ? (
          <Pressable
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setComposerExpanded(true);
            }}
            style={({ pressed }) => [styles.collapsedPromptBar, pressed && { opacity: 0.78 }]}
          >
            <Feather name="message-square" size={14} color={Palette.brand} />
            <Text style={styles.collapsedPromptText} numberOfLines={1}>
              {inputText.trim() || (imageDataUrl ? '已附带照片识别' : '已发送请求')}
            </Text>
            <View style={styles.collapsedPromptAction}>
              <Text style={styles.collapsedPromptActionText}>修改</Text>
              <Feather name="chevron-down" size={13} color={Palette.brand} />
            </View>
          </Pressable>
        ) : null}

        {showComposerBody ? (
          <>
            <SlidingSegmentedBar
              compact
              items={modeOptions.map((opt) => ({
                key: opt.mode,
                label: opt.label,
                icon: opt.icon,
              }))}
              activeIndex={Math.max(
                0,
                modeOptions.findIndex((opt) => opt.mode === activeMode)
              )}
              onSelect={(idx) => {
                const picked = modeOptions[idx];
                if (picked) setSelectedMode(picked.mode);
              }}
              style={styles.modeBarWrap}
            />

            {omniEntryContext ? (
              <View style={styles.contextBanner}>
                <Feather name="link-2" size={14} color={Palette.brand} />
                <Text style={styles.contextBannerText} numberOfLines={1}>
                  当前聚焦：{omniEntryContext.libraryIcon} {omniEntryContext.title}
                  {omniEntryContext.activeChildName
                    ? ` · ${omniEntryContext.activeChildName}`
                    : ''}
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
              placeholder={inputPlaceholder}
              placeholderTextColor={Palette.inkMuted}
              style={styles.omniInput}
            />

            <View style={styles.toolsRow}>
              {showCaptureTools ? (
                <>
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
                </>
              ) : null}

              <Pressable
                onPress={handleToggleVoicePress}
                style={[styles.toolChip, isRecording && styles.toolChipRecording]}
              >
                {isRecording ? (
                  <Animated.View style={[styles.recordingPulseDot, { opacity: recordPulse }]} />
                ) : (
                  <Feather name="mic" size={15} color={Palette.brand} />
                )}
                <Text style={[styles.toolChipText, isRecording && { color: Palette.inkInverse }]}>
                  {isRecording ? `停止 ${formattedRecordTime}` : '语音'}
                </Text>
              </Pressable>

              {showCaptureTools ? (
                <View style={styles.webSwitchWrap}>
                  <Text style={styles.webSwitchLabel}>联网补充</Text>
                  <Switch
                    value={useWebSearch}
                    onValueChange={setUseWebSearch}
                    trackColor={{ false: Palette.borderStrong, true: Palette.brand }}
                  />
                </View>
              ) : (
                <Text style={styles.modeSafetyHint}>
                  {activeMode === 'analyst'
                    ? '仅只读查询本地记录，不会改动数据'
                    : '先预览字段变更差异，确认后再应用'}
                </Text>
              )}
            </View>

            {isRecording ? (
              <View style={styles.recordingBanner}>
                <Animated.View style={[styles.recordingBannerDot, { opacity: recordPulse }]} />
                <Text style={styles.recordingBannerText}>
                  正在录音 {formattedRecordTime} · 说完后点上方停止按钮自动转文字
                </Text>
              </View>
            ) : null}

            {showCaptureTools && imageDataUrl ? (
              <View style={styles.attachedImgRow}>
                <Image
                  source={{ uri: imageDataUrl }}
                  style={styles.attachedThumb}
                  contentFit="cover"
                />
                <View style={{ flex: 1 }} />
                <Pressable onPress={() => setImageDataUrl(undefined)}>
                  <Feather name="trash-2" size={16} color={Palette.danger} />
                </Pressable>
              </View>
            ) : null}

            {!result && !loadingStep && contextualExamples.length > 0 ? (
              <View style={styles.examplesBox}>
                {contextualExamples.map((ex, i) => (
                  <Pressable
                    key={i}
                    onPress={() => {
                      setInputText(ex.text);
                      if (ex.mode && modeOptions.some((o) => o.mode === ex.mode)) {
                        setSelectedMode(ex.mode);
                      }
                    }}
                    style={styles.examplePill}
                  >
                    <Text style={styles.exampleTag}>{ex.tag}</Text>
                    <Text style={styles.exampleText} numberOfLines={1}>
                      {ex.text}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
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

        {result?.intent === 'capture' ? (
          <CaptureResultView
            assistantNote={result.capture.assistantNote}
            drafts={drafts}
            libMap={libMap}
            danglingRelations={danglingRelations}
            removedDraftTitles={removedDraftTitles}
            loading={Boolean(loadingStep)}
            onUpdateField={updateDraftField}
            onUpdateRelation={updateDraftRelation}
            onRemoveDraft={removeDraftById}
            onRetryAs={(alt) => void handleSend(alt)}
          />
        ) : null}

        {result?.intent === 'architect' ? (
          <ArchitectPlanView
            plan={result.plan}
            diffs={architectDiffs}
            hasDestructiveChanges={hasDestructivePlanChanges}
            existingSlugs={existingSlugs}
            libMap={libMap}
            loading={Boolean(loadingStep)}
            onRetryAs={(alt) => void handleSend(alt)}
          />
        ) : null}

        {result?.intent === 'analyst' ? (
          <AnalystResultView
            answer={result.answer}
            loading={Boolean(loadingStep)}
            onPinWidget={handlePinWidget}
            onRetryAs={(alt) => void handleSend(alt)}
          />
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 14) }]}>
        {result?.intent === 'capture' && drafts.length > 0 ? (
          <>
            <Pressable
              onPress={() => {
                setResult(null);
                setComposerExpanded(true);
              }}
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryBtnText}>重新来</Text>
            </Pressable>
            <Pressable
              onPress={handleCommitDrafts}
              style={[
                styles.primaryBtn,
                danglingRelations.length > 0 && { backgroundColor: Palette.warning },
              ]}
            >
              <Feather
                name={danglingRelations.length > 0 ? 'alert-circle' : 'check'}
                size={16}
                color={Palette.inkInverse}
              />
              <Text style={styles.primaryBtnText}>
                {danglingRelations.length > 0
                  ? `待重选关联 (${danglingRelations.length})`
                  : `保存记录 (${drafts.length})`}
              </Text>
            </Pressable>
          </>
        ) : result?.intent === 'architect' ? (
          <>
            <Pressable
              onPress={() => {
                setResult(null);
                setComposerExpanded(true);
              }}
              style={styles.secondaryBtn}
            >
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
                setComposerExpanded(true);
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
            onPress={() => void handleSend()}
            style={[
              styles.primaryBtn,
              { flex: 1 },
              (Boolean(loadingStep) || isRecording) && { opacity: 0.5 },
            ]}
          >
            <Feather
              name={activeMode === 'analyst' ? 'bar-chart-2' : 'send'}
              size={15}
              color={Palette.inkInverse}
            />
            <Text style={styles.primaryBtnText}>{getPrimarySendLabel(activeMode)}</Text>
          </Pressable>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
  },
  headerTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginRight: 8,
  },
  headerTitle: {
    flexShrink: 1,
    fontSize: 16,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  roleBadge: {
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  roleBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.brand,
  },
  closeBtn: {
    padding: 4,
  },
  body: {
    paddingHorizontal: 20,
  },
  bodyContent: {
    paddingVertical: 14,
    gap: 12,
  },
  modeBarWrap: {
    backgroundColor: Palette.bgCanvas,
  },
  collapsedPromptBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  collapsedPromptText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkPrimary,
  },
  collapsedPromptAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  collapsedPromptActionText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  recordingPulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Palette.inkInverse,
  },
  recordingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Palette.dangerSoft,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  recordingBannerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Palette.danger,
  },
  recordingBannerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: Palette.danger,
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
  modeSafetyHint: {
    flex: 1,
    textAlign: 'right',
    fontSize: 11,
    fontWeight: '600',
    color: Palette.inkMuted,
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
  examplesBox: {
    gap: 7,
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
