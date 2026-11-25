import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import React, { useState } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatFieldDisplay } from '@/components/dynamic-renderer/DynamicViews';
import { Palette } from '@/constants/design-tokens';
import type { HydratedEntry } from '@/db/models';
import { resolveImageUri } from '@/engine/image-storage';
import type { FieldDef } from '@/schema/field-defs';

export interface EntryDetailInfoCardProps {
  entry: HydratedEntry;
  baseFields: FieldDef[];
  relationFields: FieldDef[];
  onPreviewImage: (uri: string, caption?: string) => void;
  onOpenEntry: (entryId: string) => void;
}

export function EntryDetailInfoCard({
  entry,
  baseFields,
  relationFields,
  onPreviewImage,
  onOpenEntry,
}: EntryDetailInfoCardProps) {
  const [showEmptyFields, setShowEmptyFields] = useState(false);

  const isFieldFilled = (key: string) => {
    const v = entry.computedData[key];
    if (v === undefined || v === null || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  };

  const filledBaseFields = baseFields.filter((f) => isFieldFilled(f.key));
  const emptyBaseFields = baseFields.filter((f) => !isFieldFilled(f.key));
  const visibleBaseFields =
    filledBaseFields.length === 0 || showEmptyFields ? baseFields : filledBaseFields;

  return (
    <>
      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>详细信息</Text>
        {visibleBaseFields.map((f, idx) => {
          const val = entry.computedData[f.key];
          const isLast = idx === visibleBaseFields.length - 1;
          if (f.type === 'image' && val) {
            const fullUri = resolveImageUri(val);
            return (
              <View key={f.key} style={[styles.imageFieldBlock, !isLast && styles.blockDivider]}>
                <Text style={styles.fieldKeyLabel}>{f.label}</Text>
                <Pressable
                  onPress={() => onPreviewImage(fullUri, f.label)}
                  style={({ pressed }) => [styles.detailImgPressable, pressed && { opacity: 0.88 }]}
                >
                  <Image
                    source={{ uri: fullUri }}
                    style={styles.detailImage}
                    contentFit="cover"
                  />
                  <View style={styles.imgZoomBadge}>
                    <Feather name="maximize-2" size={12} color={Palette.inkInverse} />
                  </View>
                </Pressable>
              </View>
            );
          }
          if (f.type === 'text' && f.multiline) {
            return (
              <View
                key={f.key}
                style={[styles.multilineFieldBlock, !isLast && styles.blockDivider]}
              >
                <Text style={styles.fieldKeyLabel}>{f.label}</Text>
                <Text style={styles.multilineValText}>{val ? String(val) : '—'}</Text>
              </View>
            );
          }
          return (
            <View key={f.key} style={[styles.kvRow, isLast && { borderBottomWidth: 0 }]}>
              <Text style={styles.fieldKeyLabel}>{f.label}</Text>
              <Text style={styles.fieldValText}>{formatFieldDisplay(f, val)}</Text>
            </View>
          );
        })}

        {filledBaseFields.length > 0 && emptyBaseFields.length > 0 ? (
          <Pressable
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setShowEmptyFields((v) => !v);
            }}
            style={({ pressed }) => [styles.emptyFieldsToggle, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.emptyFieldsToggleText}>
              {showEmptyFields ? '收起未填字段' : `显示 ${emptyBaseFields.length} 项未填字段`}
            </Text>
            <Feather
              name={showEmptyFields ? 'chevron-up' : 'chevron-down'}
              size={13}
              color={Palette.inkMuted}
            />
          </Pressable>
        ) : null}
      </View>

      {relationFields.length > 0 ? (
        <View style={styles.sectionCard}>
          <View style={styles.sectionHeader}>
            <Feather name="link-2" size={15} color={Palette.brand} />
            <Text style={styles.sectionTitle}>关联内容</Text>
          </View>
          {relationFields.map((rf) => {
            const refs = entry.forwardLinks[rf.key] ?? [];
            return (
              <View key={rf.key} style={styles.relGroup}>
                <Text style={styles.fieldKeyLabel}>{rf.label}</Text>
                {refs.length === 0 ? (
                  <Text style={styles.mutedText}>暂未关联</Text>
                ) : (
                  refs.map((ref) => (
                    <Pressable
                      key={ref.id}
                      onPress={() => onOpenEntry(ref.id)}
                      style={({ pressed }) => [
                        styles.linkCard,
                        pressed && { opacity: 0.78, transform: [{ scale: 0.988 }] },
                      ]}
                    >
                      <Text style={styles.linkTitle}>
                        {ref.libraryIcon} {ref.title}
                      </Text>
                      <View style={styles.linkRight}>
                        <Text style={styles.linkLibName}>{ref.libraryName}</Text>
                        <Feather name="chevron-right" size={15} color={Palette.inkMuted} />
                      </View>
                    </Pressable>
                  ))
                )}
              </View>
            );
          })}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  sectionCard: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
    gap: 12,
  },
  blockDivider: {
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
    paddingBottom: 12,
  },
  multilineFieldBlock: {
    gap: 6,
    paddingVertical: 4,
  },
  multilineValText: {
    fontSize: 14,
    lineHeight: 22,
    color: Palette.inkPrimary,
  },
  fieldKeyLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  fieldValText: {
    flex: 1,
    textAlign: 'right',
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  imageFieldBlock: {
    gap: 8,
    paddingVertical: 6,
  },
  detailImgPressable: {
    position: 'relative',
    borderRadius: 12,
    overflow: 'hidden',
  },
  detailImage: {
    width: '100%',
    height: 220,
    borderRadius: 14,
    backgroundColor: Palette.bgSubtle,
  },
  imgZoomBadge: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(18, 24, 23, 0.56)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyFieldsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingTop: 10,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  emptyFieldsToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkMuted,
  },
  relGroup: {
    gap: 8,
  },
  mutedText: {
    fontSize: 13,
    color: Palette.inkMuted,
    lineHeight: 19,
  },
  linkCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Palette.bgCanvas,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  linkTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  linkRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  linkLibName: {
    fontSize: 12,
    color: Palette.inkSecondary,
    fontWeight: '600',
  },
});
