import Feather from '@expo/vector-icons/Feather';
import React, { useState } from 'react';
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
import { Palette, ToneMap } from '@/constants/design-tokens';
import { ACCENT_TONES, CURATED_EMOJIS } from '@/constants/schema-meta';
import type { LibraryRecord } from '@/db/models';
import type { AccentTone } from '@/schema/view-dsl';

export interface BasicSettingsTabProps {
  width: number;
  existingLibrary?: LibraryRecord | null;
  name: string;
  icon: string;
  color: AccentTone;
  parentLibrarySlug: string;
  showOnHome: boolean;
  parentCandidates: LibraryRecord[];
  aiPrompt: string;
  aiLoading: boolean;
  onChangeAiPrompt: (text: string) => void;
  onAiAssist: () => void;
  onChangeName: (name: string) => void;
  onChangeIcon: (icon: string) => void;
  onChangeColor: (color: AccentTone) => void;
  onSelectParent: (slug: string) => void;
  onChangeShowOnHome: (show: boolean) => void;
  onCreateSubLibrary?: (parentSlug: string) => void;
  onDeleteLibrary: () => void;
}

export function BasicSettingsTab({
  width,
  existingLibrary,
  name,
  icon,
  color,
  parentLibrarySlug,
  showOnHome,
  parentCandidates,
  aiPrompt,
  aiLoading,
  onChangeAiPrompt,
  onAiAssist,
  onChangeName,
  onChangeIcon,
  onChangeColor,
  onSelectParent,
  onChangeShowOnHome,
  onCreateSubLibrary,
  onDeleteLibrary,
}: BasicSettingsTabProps) {
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const tone = ToneMap[color] ?? ToneMap.teal;

  return (
    <ScrollView
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      style={{ width }}
      contentContainerStyle={styles.scrollContent}
    >
      {/* 一句话智能调整 */}
      <View style={styles.aiBox}>
        <View style={styles.aiTitleRow}>
          <Feather name="message-circle" size={14} color={Palette.brand} />
          <Text style={styles.aiBoxTitle}>一句话帮你调整</Text>
        </View>
        <View style={styles.aiInputRow}>
          <TextInput
            value={aiPrompt}
            onChangeText={onChangeAiPrompt}
            placeholder={
              existingLibrary
                ? '如：加一个报销状态选项，或关闭日历、新增「封面墙」画廊视图'
                : '如：做一个咖啡豆记录本（带画廊和冲煮记录附属表）'
            }
            placeholderTextColor={Palette.inkMuted}
            style={styles.aiInput}
          />
          <Pressable
            disabled={aiLoading || !aiPrompt.trim()}
            onPress={onAiAssist}
            style={[styles.aiGoBtn, (aiLoading || !aiPrompt.trim()) && styles.btnDisabled]}
          >
            {aiLoading ? (
              <ActivityIndicator size="small" color={Palette.inkInverse} />
            ) : (
              <Text style={styles.aiGoText}>生成</Text>
            )}
          </Pressable>
        </View>
      </View>

      {/* 名称与样式 */}
      <Text style={styles.sectionTitle}>名称与样式</Text>
      <View style={styles.rowGap}>
        <Pressable
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setEmojiPickerOpen((v) => !v);
          }}
          style={({ pressed }) => [
            styles.emojiTriggerBtn,
            emojiPickerOpen && styles.emojiTriggerBtnOpen,
            pressed && { opacity: 0.78 },
          ]}
          accessibilityLabel="选择记录本图标"
        >
          <Text style={styles.emojiTriggerText}>{icon || '📒'}</Text>
        </Pressable>
        <TextInput
          value={name}
          onChangeText={onChangeName}
          placeholder="记录本名称（如 阅读记录）"
          placeholderTextColor={Palette.inkMuted}
          style={[styles.input, { flex: 1 }]}
        />
      </View>

      {emojiPickerOpen ? (
        <View style={styles.emojiPanel}>
          <View style={styles.emojiGrid}>
            {CURATED_EMOJIS.map((em) => {
              const active = icon === em;
              return (
                <Pressable
                  key={em}
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    onChangeIcon(em);
                    setEmojiPickerOpen(false);
                  }}
                  style={({ pressed }) => [
                    styles.emojiCell,
                    active && styles.emojiCellActive,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={styles.emojiCellText}>{em}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.customEmojiRow}>
            <Text style={styles.subFieldHint}>自定义图标：</Text>
            <TextInput
              value={icon}
              onChangeText={onChangeIcon}
              maxLength={2}
              placeholder="输入 Emoji"
              placeholderTextColor={Palette.inkMuted}
              style={[styles.smallInput, { width: 96, textAlign: 'center' }]}
            />
          </View>
        </View>
      ) : null}

      <View style={styles.tonesRow}>
        {ACCENT_TONES.map((t) => {
          const active = color === t;
          return (
            <Pressable
              key={t}
              onPress={() => onChangeColor(t)}
              style={[
                styles.toneCircle,
                { backgroundColor: ToneMap[t].solid },
                active && styles.toneCircleActive,
              ]}
            />
          );
        })}
      </View>

      {/* 归属与首页显示 */}
      {parentCandidates.length > 0 ? (
        <View style={styles.hierarchyBox}>
          <Text style={styles.sectionTitle}>归属与首页显示</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.typeChipsRow}>
              <Pressable
                onPress={() => onSelectParent('')}
                style={[styles.typeChip, !parentLibrarySlug && styles.typeChipActive]}
              >
                <Text
                  style={[
                    styles.typeChipText,
                    !parentLibrarySlug && styles.typeChipTextActive,
                  ]}
                >
                  独立主记录本
                </Text>
              </Pressable>
              {parentCandidates.map((cand) => {
                const active = parentLibrarySlug === cand.slug;
                return (
                  <Pressable
                    key={cand.slug}
                    onPress={() => onSelectParent(cand.slug)}
                    style={[styles.typeChip, active && styles.typeChipActive]}
                  >
                    <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                      附属：{cand.icon} {cand.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>

          <View style={styles.homeSwitchRow}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.homeSwitchTitle}>在首页独立显示卡片</Text>
              <Text style={styles.homeSwitchDesc}>
                {parentLibrarySlug
                  ? '关闭后将收纳进主记录本内部切换栏与记录详情时间轴中'
                  : '关闭后可从全局搜索查看，不在首页网格展示'}
              </Text>
            </View>
            <Switch
              value={showOnHome}
              onValueChange={onChangeShowOnHome}
              trackColor={{ false: Palette.borderStrong, true: tone.solid }}
            />
          </View>

          {existingLibrary && !parentLibrarySlug && onCreateSubLibrary ? (
            <Pressable
              onPress={() => onCreateSubLibrary(existingLibrary.slug)}
              style={styles.spawnSubBtn}
            >
              <Feather name="corner-down-right" size={14} color={Palette.brand} />
              <Text style={styles.spawnSubText}>
                为「{existingLibrary.name}」新建附属子记录本（如阅读记录 / 跟进流水）
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* 删除整个记录本 */}
      {existingLibrary ? (
        <View style={styles.dangerBox}>
          <Text style={styles.dangerTitle}>删除记录本</Text>
          <Text style={styles.dangerHint}>
            将删除「{existingLibrary.name}」及里面的全部 {existingLibrary.entryCount}{' '}
            条记录。删除前会自动留存一份备份，可在「设置 → 最近操作记录」里随时撤销。
          </Text>
          {confirmDelete ? (
            <View style={styles.dangerActionsRow}>
              <Pressable onPress={() => setConfirmDelete(false)} style={styles.dangerCancelBtn}>
                <Text style={styles.dangerCancelText}>先不删</Text>
              </Pressable>
              <Pressable onPress={onDeleteLibrary} style={styles.dangerConfirmBtn}>
                <Feather name="trash-2" size={14} color={Palette.inkInverse} />
                <Text style={styles.dangerConfirmText}>确认删除</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => setConfirmDelete(true)} style={styles.dangerTriggerBtn}>
              <Feather name="trash-2" size={14} color={Palette.danger} />
              <Text style={styles.dangerTriggerText}>删除整个记录本</Text>
            </Pressable>
          )}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    gap: 12,
  },
  aiBox: {
    backgroundColor: Palette.brandSoft,
    padding: 14,
    borderRadius: 14,
    gap: 8,
  },
  aiTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  aiBoxTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.brand,
  },
  aiInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  aiInput: {
    flex: 1,
    backgroundColor: Palette.bgSurface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
    color: Palette.inkPrimary,
  },
  aiGoBtn: {
    backgroundColor: Palette.brand,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiGoText: {
    color: Palette.inkInverse,
    fontSize: 13,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.45,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Palette.inkPrimary,
    marginTop: 4,
  },
  rowGap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: Palette.inkPrimary,
  },
  smallInput: {
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: Palette.inkPrimary,
  },
  emojiTriggerBtn: {
    width: 52,
    height: 44,
    borderRadius: 12,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiTriggerBtnOpen: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  emojiTriggerText: {
    fontSize: 22,
  },
  emojiPanel: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 10,
  },
  emojiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  emojiCell: {
    width: '15%',
    flexGrow: 1,
    height: 38,
    borderRadius: 10,
    backgroundColor: Palette.bgSurface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  emojiCellActive: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  emojiCellText: {
    fontSize: 19,
  },
  customEmojiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  subFieldHint: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  tonesRow: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 4,
  },
  toneCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  toneCircleActive: {
    borderWidth: 3,
    borderColor: Palette.inkPrimary,
  },
  hierarchyBox: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 10,
  },
  typeChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  typeChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  typeChipActive: {
    backgroundColor: Palette.brand,
    borderColor: Palette.brand,
  },
  typeChipText: {
    fontSize: 12,
    color: Palette.inkSecondary,
    fontWeight: '600',
  },
  typeChipTextActive: {
    color: Palette.inkInverse,
  },
  homeSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  homeSwitchTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  homeSwitchDesc: {
    fontSize: 11,
    color: Palette.inkMuted,
    lineHeight: 16,
  },
  spawnSubBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 10,
  },
  spawnSubText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  dangerBox: {
    marginTop: 8,
    backgroundColor: Palette.dangerSoft,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  dangerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.danger,
  },
  dangerHint: {
    fontSize: 12,
    color: Palette.inkSecondary,
    lineHeight: 18,
  },
  dangerTriggerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.danger,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 2,
  },
  dangerTriggerText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.danger,
  },
  dangerActionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 2,
  },
  dangerCancelBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Palette.bgSurface,
  },
  dangerCancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  dangerConfirmBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Palette.danger,
  },
  dangerConfirmText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
});
