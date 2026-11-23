import Feather from '@expo/vector-icons/Feather';
import { AudioModule, useAudioStream } from 'expo-audio';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  type AssistantScene,
  type CaptureEntryContext,
  type UnifiedAssistantResult,
} from '@/ai/agents';
import { transcribeAudioWithDeepSeek } from '@/ai/deepseek-client';
import { SqlWidgetCard } from '@/components/charts/SqlWidgetCard';
import { BottomSheetModal } from '@/components/ui/BottomSheetModal';
import { SlidingSegmentedBar } from '@/components/ui/SlidingSegmentedBar';
import { Palette } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { ArchitectLibraryDiff, LibraryRecord } from '@/db/repository';
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

const HOME_QUICK_EXAMPLES: Array<{ tag: string; mode?: AssistantMode; text: string }> = [
  { tag: '记一笔', mode: 'capture', text: '《长安的荔枝》今晚读了 40 分钟到第 185 页，节奏太紧凑了' },
  { tag: '问数据', mode: 'analyst', text: '算一下每件数码装备加上后续配件账单，总共花了多少钱？' },
  { tag: '建记录本', mode: 'architect', text: '帮我建一套「宠物档案」和附属「疫苗医疗记录」，自动统计总花费' },
];

const STATS_OVERVIEW_EXAMPLES: Array<{ tag: string; mode?: AssistantMode; text: string }> = [
  { tag: '跨表汇总', mode: 'analyst', text: '算一下每件数码装备加上关联配件账单的总花费，并画柱状图' },
  { tag: '分类占比', mode: 'analyst', text: '按消费分类统计日常账单支出占比，并生成饼图' },
  { tag: '进度统计', mode: 'analyst', text: '统计阅读书架中每本书的累计阅读时长和记录条数' },
];

interface ModeOption {
  mode: AssistantMode;
  label: string;
  icon: React.ComponentProps<typeof Feather>['name'];
}

function getDefaultModeForScene(
  scene: AssistantScene,
  entryContext?: CaptureEntryContext
): AssistantMode {
  if (scene === 'stats') return 'analyst';
  if (scene === 'entry' && entryContext?.activeTab && entryContext.activeTab !== 'detail') {
    return 'capture';
  }
  return 'auto';
}

function getModeOptionsForScene(
  scene: AssistantScene,
  entryContext?: CaptureEntryContext
): ModeOption[] {
  if (scene === 'stats') {
    return [
      { mode: 'analyst', label: '问数据', icon: 'bar-chart-2' },
      { mode: 'capture', label: '记一笔', icon: 'edit-3' },
      { mode: 'architect', label: '改结构', icon: 'sliders' },
    ];
  }
  if (scene === 'library') {
    return [
      { mode: 'auto', label: '自动', icon: 'zap' },
      { mode: 'capture', label: '记一条', icon: 'edit-3' },
      { mode: 'analyst', label: '问本库', icon: 'bar-chart-2' },
      { mode: 'architect', label: '调结构', icon: 'sliders' },
    ];
  }
  if (scene === 'entry') {
    if (entryContext?.activeTab && entryContext.activeTab !== 'detail') {
      return [
        { mode: 'capture', label: '记关联', icon: 'plus-circle' },
        { mode: 'analyst', label: '问此记录', icon: 'bar-chart-2' },
      ];
    }
    return [
      { mode: 'auto', label: '自动', icon: 'zap' },
      { mode: 'capture', label: '记关联', icon: 'plus-circle' },
      { mode: 'analyst', label: '问此记录', icon: 'bar-chart-2' },
    ];
  }
  return [
    { mode: 'auto', label: '自动', icon: 'zap' },
    { mode: 'capture', label: '记一笔', icon: 'edit-3' },
    { mode: 'analyst', label: '问数据', icon: 'bar-chart-2' },
    { mode: 'architect', label: '建记录本', icon: 'sliders' },
  ];
}

function buildContextualExamples(params: {
  scene: AssistantScene;
  mode: AssistantMode;
  targetLib?: LibraryRecord;
  entryContext?: CaptureEntryContext;
  childLibs: LibraryRecord[];
  reverseRelLibs: LibraryRecord[];
}): Array<{ tag: string; mode?: AssistantMode; text: string }> {
  const { scene, mode, targetLib, entryContext, childLibs, reverseRelLibs } = params;

  if (scene === 'stats') {
    if (targetLib) {
      const numField = targetLib.fields.find(
        (f) => f.type === 'currency' || f.type === 'number'
      );
      const selectField = targetLib.fields.find((f) => f.type === 'select');
      const dateField = targetLib.fields.find((f) => f.type === 'date');
      const items: Array<{ tag: string; mode?: AssistantMode; text: string }> = [];

      if (selectField && numField) {
        items.push({
          tag: '分类占比',
          mode: 'analyst',
          text: `按「${selectField.label}」汇总「${targetLib.name}」的${numField.label}，并画柱状图`,
        });
      } else if (selectField) {
        items.push({
          tag: '分布统计',
          mode: 'analyst',
          text: `统计「${targetLib.name}」各「${selectField.label}」的记录数量占比并画饼图`,
        });
      }
      if (dateField && numField) {
        items.push({
          tag: '时间趋势',
          mode: 'analyst',
          text: `按「${dateField.label}」统计「${targetLib.name}」的${numField.label}变化趋势`,
        });
      }
      items.push({
        tag: '核心指标',
        mode: 'analyst',
        text: `帮我汇总「${targetLib.name}」的关键统计指标并生成一张总览数字卡`,
      });
      return items.slice(0, 3);
    }
    return STATS_OVERVIEW_EXAMPLES;
  }

  if (scene === 'entry' && entryContext) {
    const primaryRelatedLib =
      (entryContext.activeChildSlug
        ? childLibs.find((c) => c.slug === entryContext.activeChildSlug)
        : undefined) ??
      childLibs[0] ??
      reverseRelLibs[0];

    const items: Array<{ tag: string; mode?: AssistantMode; text: string }> = [];
    if (mode !== 'analyst') {
      if (primaryRelatedLib) {
        items.push({
          tag: `记${primaryRelatedLib.name}`,
          mode: 'capture',
          text: `为「${entryContext.title}」记一条新的${primaryRelatedLib.name}`,
        });
      } else {
        items.push({
          tag: '记关联',
          mode: 'capture',
          text: `围绕「${entryContext.title}」补充一条新的关联记录`,
        });
      }
    }
    items.push({
      tag: '问此记录',
      mode: 'analyst',
      text: `汇总分析「${entryContext.title}」的全部关联明细与核心数据`,
    });
    return items;
  }

  if (scene === 'library' && targetLib) {
    const items: Array<{ tag: string; mode?: AssistantMode; text: string }> = [];
    if (mode === 'auto' || mode === 'capture') {
      items.push({
        tag: '记一条',
        mode: 'capture',
        text: `在「${targetLib.name}」中快速记录一条今天的新条目`,
      });
    }
    if (mode === 'auto' || mode === 'analyst') {
      items.push({
        tag: '问本库',
        mode: 'analyst',
        text: `帮我统计分析「${targetLib.name}」的数据分布并画一张图表`,
      });
    }
    if (mode === 'auto' || mode === 'architect') {
      items.push({
        tag: '调结构',
        mode: 'architect',
        text: `给「${targetLib.name}」新增实用字段、自动汇总或提醒高亮规则`,
      });
    }
    return items;
  }

  return HOME_QUICK_EXAMPLES;
}

export function OmniCaptureModal() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    repo,
    libraries,
    hasApiKey,
    omniModalVisible,
    omniScene,
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
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordPulse] = useState(() => new Animated.Value(1));
  const [composerExpanded, setComposerExpanded] = useState(true);
  const [editingDraftKey, setEditingDraftKey] = useState<string | null>(null);

  const sessionSignature = `${omniModalVisible ? 'open' : 'closed'}::${omniScene}::${omniTargetSlug ?? ''}::${omniEntryContext?.entryId ?? ''}::${omniEntryContext?.activeTab ?? ''}`;
  const [selectedMode, setSelectedMode] = useState<AssistantMode>(() =>
    getDefaultModeForScene(omniScene, omniEntryContext)
  );
  const [prevSessionSig, setPrevSessionSig] = useState(sessionSignature);
  const didTriggerActionRef = useRef(false);

  // 原生 PCM 音频流直录标准 16kHz 16-bit 单声道 WAV，兼容 DeepSeek /v1/tools/asr
  const { stream: audioStream } = useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: 'int16',
  });

  if (prevSessionSig !== sessionSignature) {
    setPrevSessionSig(sessionSignature);
    setSelectedMode(getDefaultModeForScene(omniScene, omniEntryContext));
    if (!omniModalVisible) {
      setErrorMsg(null);
      setSuccessMsg(null);
      setLoadingStep(null);
      setResult(null);
      setDrafts([]);
      setComposerExpanded(true);
      setEditingDraftKey(null);
      setRecordSeconds(0);
      if (isRecording) {
        setIsRecording(false);
      }
    } else {
      setErrorMsg(null);
      setSuccessMsg(null);
      setResult(null);
      setDrafts([]);
      setComposerExpanded(true);
      setEditingDraftKey(null);
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
      setRecordSeconds(0);
      setIsRecording(true);
    } catch (err) {
      audioStream.stop();
      setIsRecording(false);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [audioStream]);

  useEffect(() => {
    if (!isRecording) {
      recordPulse.stopAnimation();
      recordPulse.setValue(1);
      return;
    }
    const timer = setInterval(() => {
      setRecordSeconds((s) => s + 1);
    }, 1000);
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(recordPulse, {
          toValue: 0.3,
          duration: 550,
          useNativeDriver: true,
        }),
        Animated.timing(recordPulse, {
          toValue: 1,
          duration: 550,
          useNativeDriver: true,
        }),
      ])
    );
    pulse.start();
    return () => {
      clearInterval(timer);
      pulse.stop();
    };
  }, [isRecording, recordPulse]);

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

  const libMap = new Map(libraries.map((l) => [l.slug, l]));
  const existingSlugs = new Set(libraries.map((l) => l.slug));
  const targetLib = omniTargetSlug ? libMap.get(omniTargetSlug) : undefined;

  const entryParentSlug = omniEntryContext?.librarySlug;
  const childLibs = entryParentSlug
    ? libraries.filter((l) => l.parentLibrarySlug === entryParentSlug)
    : [];
  const childSlugSet = new Set(childLibs.map((c) => c.slug));
  const reverseRelLibs = entryParentSlug
    ? libraries.filter(
        (l) =>
          !childSlugSet.has(l.slug) &&
          l.fields.some(
            (f) =>
              f.type === 'relation' && f.relationConfig?.targetLibrarySlug === entryParentSlug
          )
      )
    : [];

  const modeOptions = getModeOptionsForScene(omniScene, omniEntryContext);
  const activeMode: AssistantMode = modeOptions.some((o) => o.mode === selectedMode)
    ? selectedMode
    : (modeOptions[0]?.mode ?? 'auto');

  const showCaptureTools = activeMode === 'auto' || activeMode === 'capture';
  const updateDraftField = (draftIdx: number, fieldKey: string, nextRaw: string, fieldType?: FieldType) => {
    setDrafts((prev) =>
      prev.map((d, i) => {
        if (i !== draftIdx) return d;
        let parsed: unknown = nextRaw;
        if (fieldType === 'number' || fieldType === 'currency' || fieldType === 'rating') {
          const num = Number(nextRaw);
          parsed = nextRaw.trim() === '' ? '' : Number.isFinite(num) ? num : nextRaw;
        }
        return { ...d, data: { ...d.data, [fieldKey]: parsed } };
      })
    );
  };

  const formattedRecordTime = `${String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:${String(
    recordSeconds % 60
  ).padStart(2, '0')}`;

  const showComposerBody = !result || composerExpanded;

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
    try {
      setErrorMsg(null);
      setSuccessMsg(null);
      setResult(null);
      setDrafts([]);

      const outcome = await runUnifiedAssistant(
        repo,
        {
          text: inputText,
          imageBase64DataUrl: showCaptureTools ? imageDataUrl : undefined,
          useWebSearch: showCaptureTools ? useWebSearch : false,
          scene: omniScene,
          targetLibrarySlug: omniTargetSlug,
          entryContext: omniEntryContext,
        },
        (msg) => setLoadingStep(msg),
        effectiveForce
      );

      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setResult(outcome);
      setComposerExpanded(false);
      setEditingDraftKey(null);
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

  const removeDraftAt = (idx: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== idx));
  };

  const headerConfig = (() => {
    if (omniScene === 'stats') {
      return {
        icon: 'bar-chart-2' as const,
        title: targetLib ? `问数据 · ${targetLib.name}` : '问数据 · 统计总览',
        roleBadge: '数据分析师',
      };
    }
    if (omniScene === 'entry' && omniEntryContext) {
      return {
        icon: 'link-2' as const,
        title: `${omniEntryContext.libraryIcon} ${omniEntryContext.title}`,
        roleBadge: '随行助理',
      };
    }
    if (omniScene === 'library' && targetLib) {
      return {
        icon: 'layers' as const,
        title: `${targetLib.icon} ${targetLib.name}`,
        roleBadge: '本库助理',
      };
    }
    return {
      icon: 'message-circle' as const,
      title: '随手说',
      roleBadge: '全能管家',
    };
  })();

  const inputPlaceholder = (() => {
    if (activeMode === 'analyst') {
      if (omniScene === 'entry' && omniEntryContext) {
        return `针对「${omniEntryContext.title}」提问明细、累计数据或趋势分析...`;
      }
      if (targetLib) {
        return `向「${targetLib.name}」提问统计，或描述想画的图表（柱状图/折线图/占比/数字卡）...`;
      }
      return '问任何跨表统计、趋势对比，或直接说出你想定制的图表...';
    }
    if (activeMode === 'architect') {
      if (targetLib) {
        return `说明想给「${targetLib.name}」新增的字段、自动公式、预警高亮或附属子表...`;
      }
      return '描述你想新建的记录本、字段结构、跨表关联或自动汇总公式...';
    }
    if (omniScene === 'entry' && omniEntryContext) {
      if (omniEntryContext.activeChildName) {
        return `为「${omniEntryContext.title}」快速记一条${omniEntryContext.activeChildName}，支持文字、语音或拍照...`;
      }
      if (childLibs.length > 0) {
        return `围绕「${omniEntryContext.title}」记录${childLibs[0].name}，或直接提问汇总数据...`;
      }
      if (reverseRelLibs.length > 0) {
        return `围绕「${omniEntryContext.title}」记录关联${reverseRelLibs[0].name}，或提问明细统计...`;
      }
      return `围绕「${omniEntryContext.title}」补充关联记录，或针对这条记录提问...`;
    }
    if (omniScene === 'library' && targetLib) {
      return activeMode === 'capture'
        ? `说一句话或拍张照，自动整理并存入「${targetLib.name}」...`
        : `在「${targetLib.name}」里记一条、调整字段样式，或统计本库数据...`;
    }
    return '记一笔、建记录本、查开销、画图表或拍张小票，直接说就行...';
  })();

  const contextualExamples = buildContextualExamples({
    scene: omniScene,
    mode: activeMode,
    targetLib,
    entryContext: omniEntryContext,
    childLibs,
    reverseRelLibs,
  });

  const primarySendLabel =
    activeMode === 'analyst'
      ? '开始分析'
      : activeMode === 'architect'
        ? '生成方案'
        : activeMode === 'capture'
          ? '整理草稿'
          : '发送';

  const renderFallbackBar = (currentIntent: AssistantIntent) => {
    const others = (['capture', 'analyst', 'architect'] as AssistantIntent[]).filter(
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

        {/* 有结果时默认收起输入区，把视野完整留给结果预览 */}
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
            {/* 场景模式切换条（带顺滑弹簧滑块，随时可切换） */}
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

            {/* 按角色裁剪的工具条（分析师/改结构聚焦语音与文字，不展示拍照与联网杂项） */}
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
                onPress={handleToggleVoice}
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
                <Image source={{ uri: imageDataUrl }} style={styles.attachedThumb} contentFit="cover" />
                <View style={{ flex: 1 }} />
                <Pressable onPress={() => setImageDataUrl(undefined)}>
                  <Feather name="trash-2" size={16} color={Palette.danger} />
                </Pressable>
              </View>
            ) : null}

            {/* 场景化快捷示例（无结果时展示） */}
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

            {/* 结果 1：记一笔草稿 */}
            {result?.intent === 'capture' ? (
              <View style={styles.resultSection}>
                {result.capture.assistantNote ? (
                  <Text style={styles.assistantNote}>{result.capture.assistantNote}</Text>
                ) : null}
                {drafts.map((d, idx) => {
                  const draftLib = libMap.get(d.librarySlug);
                  return (
                    <View key={idx} style={styles.resultCard}>
                      <View style={styles.draftHeader}>
                        <Text style={styles.draftLibBadge}>
                          {draftLib ? `${draftLib.icon} ${draftLib.name}` : d.librarySlug}
                        </Text>
                        <Pressable onPress={() => removeDraftAt(idx)}>
                          <Feather name="x" size={16} color={Palette.inkMuted} />
                        </Pressable>
                      </View>
                      {d.reason ? <Text style={styles.draftReason}>{d.reason}</Text> : null}
                      <View style={styles.draftFieldsGrid}>
                        {Object.entries(d.data).map(([k, v]) => {
                          const fDef = draftLib?.fields.find((f) => f.key === k);
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
                          const fieldSig = `${idx}::${k}`;
                          const isScalarEditable =
                            !Array.isArray(v) && typeof v !== 'boolean' && fDef?.type !== 'relation';
                          const isEditingThis = editingDraftKey === fieldSig;

                          return (
                            <View key={k} style={styles.draftKvRow}>
                              <Text style={styles.draftKey}>{fDef?.label ?? k}:</Text>
                              {isEditingThis ? (
                                <TextInput
                                  value={String(v ?? '')}
                                  autoFocus
                                  onChangeText={(txt) =>
                                    updateDraftField(idx, k, txt, fDef?.type)
                                  }
                                  onBlur={() => setEditingDraftKey(null)}
                                  onSubmitEditing={() => setEditingDraftKey(null)}
                                  keyboardType={
                                    fDef?.type === 'number' || fDef?.type === 'currency'
                                      ? 'decimal-pad'
                                      : 'default'
                                  }
                                  style={styles.draftInlineInput}
                                />
                              ) : isScalarEditable ? (
                                <Pressable
                                  onPress={() => setEditingDraftKey(fieldSig)}
                                  style={({ pressed }) => [
                                    styles.draftValEditable,
                                    pressed && { opacity: 0.7 },
                                  ]}
                                >
                                  <Text style={styles.draftVal} numberOfLines={3}>
                                    {formatDraftVal(v) || '点击填写'}
                                  </Text>
                                  <Feather name="edit-3" size={11} color={Palette.inkMuted} />
                                </Pressable>
                              ) : (
                                <Text style={styles.draftVal} numberOfLines={3}>
                                  {formatDraftVal(v)}
                                </Text>
                              )}
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
                <Feather
                  name={activeMode === 'analyst' ? 'bar-chart-2' : 'send'}
                  size={15}
                  color={Palette.inkInverse}
                />
                <Text style={styles.primaryBtnText}>{primarySendLabel}</Text>
              </Pressable>
            )}
          </View>
    </BottomSheetModal>
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
  draftValEditable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  draftInlineInput: {
    flex: 1,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.brand,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 13,
    color: Palette.inkPrimary,
  },
  modeBar: {
    flexDirection: 'row',
    backgroundColor: Palette.bgCanvas,
    borderRadius: 12,
    padding: 3,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 3,
  },
  modePill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 7,
    paddingHorizontal: 6,
    borderRadius: 9,
  },
  modePillActive: {
    backgroundColor: Palette.brand,
  },
  modePillText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  modePillTextActive: {
    color: Palette.inkInverse,
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
