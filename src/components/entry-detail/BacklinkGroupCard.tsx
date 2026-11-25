import Feather from '@expo/vector-icons/Feather';
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { DynamicEntryCard } from '@/components/dynamic-renderer/DynamicViews';
import { Palette, ToneMap } from '@/constants/design-tokens';
import type { BacklinkGroupSection, LibraryRecord } from '@/db/models';

export interface BacklinkGroupCardProps {
  group: BacklinkGroupSection;
  onOpenLibrary: (slug: string) => void;
  onOpenEntry: (entryId: string) => void;
  onAddLinkedEntry: (sourceLibrary: LibraryRecord, relationFieldKey: string) => void;
}

export function BacklinkGroupCard({
  group,
  onOpenLibrary,
  onOpenEntry,
  onAddLinkedEntry,
}: BacklinkGroupCardProps) {
  const { sourceLibrary, relationFieldKey, relationFieldLabel, entries: relEntries } = group;
  const srcTone = ToneMap[sourceLibrary.color] ?? ToneMap.teal;
  const fieldMap = useMemo(
    () => new Map(sourceLibrary.fields.map((f) => [f.key, f])),
    [sourceLibrary.fields]
  );

  return (
    <View style={styles.sectionCard}>
      <View style={styles.subSectionHeader}>
        <Pressable
          onPress={() => onOpenLibrary(sourceLibrary.slug)}
          style={({ pressed }) => [styles.backlinkHeaderLeft, pressed && { opacity: 0.72 }]}
        >
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>
              {sourceLibrary.icon} {sourceLibrary.name} ({relEntries.length})
            </Text>
            <Feather name="chevron-right" size={15} color={Palette.inkMuted} />
          </View>
          <Text style={styles.backlinkFieldHint}>关联字段：{relationFieldLabel}</Text>
        </Pressable>

        <Pressable
          onPress={() => onAddLinkedEntry(sourceLibrary, relationFieldKey)}
          style={[styles.subAddBtn, { backgroundColor: srcTone.soft }]}
        >
          <Feather name="plus" size={14} color={srcTone.ink} />
          <Text style={[styles.subAddBtnText, { color: srcTone.ink }]}>记关联记录</Text>
        </Pressable>
      </View>

      <View style={styles.backlinkList}>
        {relEntries.map((relEntry) => (
          <DynamicEntryCard
            key={relEntry.id}
            library={sourceLibrary}
            entry={relEntry}
            fieldMap={fieldMap}
            onSelectEntry={onOpenEntry}
            showRelationsStrip={false}
            embedded
          />
        ))}
      </View>
    </View>
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
  subSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  backlinkHeaderLeft: {
    flex: 1,
    gap: 2,
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
  backlinkFieldHint: {
    fontSize: 11,
    color: Palette.inkMuted,
  },
  subAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
  },
  subAddBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  backlinkList: {
    gap: 10,
  },
});
