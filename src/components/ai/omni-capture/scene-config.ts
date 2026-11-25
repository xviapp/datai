import type { AssistantIntent, AssistantMode, AssistantScene, CaptureEntryContext } from '@/ai/agents';
import type { FeatherIconName } from '@/constants/schema-meta';
import type { LibraryRecord } from '@/db/models';

export const INTENT_LABELS: Record<AssistantIntent, string> = {
  capture: '记一笔',
  architect: '定制记录本',
  analyst: '问数据',
};

export interface ModeOption {
  mode: AssistantMode;
  label: string;
  icon: FeatherIconName;
}

export interface QuickExample {
  tag: string;
  mode?: AssistantMode;
  text: string;
}

const HOME_QUICK_EXAMPLES: QuickExample[] = [
  { tag: '记一笔', mode: 'capture', text: '《长安的荔枝》今晚读了 40 分钟到第 185 页，节奏太紧凑了' },
  { tag: '问数据', mode: 'analyst', text: '算一下每件数码装备加上后续配件账单，总共花了多少钱？' },
  { tag: '建记录本', mode: 'architect', text: '帮我建一套「宠物档案」和附属「疫苗医疗记录」，自动统计总花费' },
];

const STATS_OVERVIEW_EXAMPLES: QuickExample[] = [
  { tag: '跨表汇总', mode: 'analyst', text: '算一下每件数码装备加上关联配件账单的总花费，并画柱状图' },
  { tag: '分类占比', mode: 'analyst', text: '按消费分类统计日常账单支出占比，并生成饼图' },
  { tag: '进度统计', mode: 'analyst', text: '统计阅读书架中每本书的累计阅读时长和记录条数' },
];

export function getDefaultModeForScene(
  scene: AssistantScene,
  entryContext?: CaptureEntryContext
): AssistantMode {
  if (scene === 'stats') return 'analyst';
  if (scene === 'entry' && entryContext?.activeTab && entryContext.activeTab !== 'detail') {
    return 'capture';
  }
  return 'auto';
}

export function getModeOptionsForScene(
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

export function getSceneHeaderConfig(
  scene: AssistantScene,
  targetLib?: LibraryRecord,
  entryContext?: CaptureEntryContext
): { icon: FeatherIconName; title: string; roleBadge: string } {
  if (scene === 'stats') {
    return {
      icon: 'bar-chart-2',
      title: targetLib ? `问数据 · ${targetLib.name}` : '问数据 · 统计总览',
      roleBadge: '数据分析师',
    };
  }
  if (scene === 'entry' && entryContext) {
    return {
      icon: 'link-2',
      title: `${entryContext.libraryIcon} ${entryContext.title}`,
      roleBadge: '随行助理',
    };
  }
  if (scene === 'library' && targetLib) {
    return {
      icon: 'layers',
      title: `${targetLib.icon} ${targetLib.name}`,
      roleBadge: '本库助理',
    };
  }
  return {
    icon: 'message-circle',
    title: '随手说',
    roleBadge: '全能管家',
  };
}

export function getSceneInputPlaceholder(params: {
  scene: AssistantScene;
  mode: AssistantMode;
  targetLib?: LibraryRecord;
  entryContext?: CaptureEntryContext;
  childLibs: LibraryRecord[];
  reverseRelLibs: LibraryRecord[];
}): string {
  const { scene, mode, targetLib, entryContext, childLibs, reverseRelLibs } = params;

  if (mode === 'analyst') {
    if (scene === 'entry' && entryContext) {
      return `针对「${entryContext.title}」提问明细、累计数据或趋势分析...`;
    }
    if (targetLib) {
      return `向「${targetLib.name}」提问统计，或描述想画的图表（柱状图/折线图/占比/数字卡）...`;
    }
    return '问任何跨表统计、趋势对比，或直接说出你想定制的图表...';
  }
  if (mode === 'architect') {
    if (targetLib) {
      return `说明想给「${targetLib.name}」新增的字段、自动公式、预警高亮或附属子表...`;
    }
    return '描述你想新建的记录本、字段结构、跨表关联或自动汇总公式...';
  }
  if (scene === 'entry' && entryContext) {
    if (entryContext.activeChildName) {
      return `为「${entryContext.title}」快速记一条${entryContext.activeChildName}，支持文字、语音或拍照...`;
    }
    if (childLibs.length > 0) {
      return `围绕「${entryContext.title}」记录${childLibs[0].name}，或直接提问汇总数据...`;
    }
    if (reverseRelLibs.length > 0) {
      return `围绕「${entryContext.title}」记录关联${reverseRelLibs[0].name}，或提问明细统计...`;
    }
    return `围绕「${entryContext.title}」补充关联记录，或针对这条记录提问...`;
  }
  if (scene === 'library' && targetLib) {
    return mode === 'capture'
      ? `说一句话或拍张照，自动整理并存入「${targetLib.name}」...`
      : `在「${targetLib.name}」里记一条、调整字段样式，或统计本库数据...`;
  }
  return '记一笔、建记录本、查开销、画图表或拍张小票，直接说就行...';
}

export function getPrimarySendLabel(mode: AssistantMode): string {
  if (mode === 'analyst') return '开始分析';
  if (mode === 'architect') return '生成方案';
  if (mode === 'capture') return '整理草稿';
  return '发送';
}

export function buildContextualExamples(params: {
  scene: AssistantScene;
  mode: AssistantMode;
  targetLib?: LibraryRecord;
  entryContext?: CaptureEntryContext;
  childLibs: LibraryRecord[];
  reverseRelLibs: LibraryRecord[];
}): QuickExample[] {
  const { scene, mode, targetLib, entryContext, childLibs, reverseRelLibs } = params;

  if (scene === 'stats') {
    if (targetLib) {
      const numField = targetLib.fields.find(
        (f) => f.type === 'currency' || f.type === 'number'
      );
      const selectField = targetLib.fields.find((f) => f.type === 'select');
      const dateField = targetLib.fields.find((f) => f.type === 'date');
      const items: QuickExample[] = [];

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

    const items: QuickExample[] = [];
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
    const items: QuickExample[] = [];
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
