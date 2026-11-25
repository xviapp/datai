import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AssistantIntent } from '@/ai/agents';
import { Palette } from '@/constants/design-tokens';
import { INTENT_LABELS } from './scene-config';

export interface IntentFallbackBarProps {
  currentIntent: AssistantIntent;
  disabled: boolean;
  onRetryAs: (intent: AssistantIntent) => void;
}

export function IntentFallbackBar({
  currentIntent,
  disabled,
  onRetryAs,
}: IntentFallbackBarProps) {
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
            disabled={disabled}
            onPress={() => onRetryAs(alt)}
            style={styles.fallbackChip}
          >
            <Text style={styles.fallbackChipText}>改「{INTENT_LABELS[alt]}」</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
});
