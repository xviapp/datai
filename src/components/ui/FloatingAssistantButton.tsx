import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Palette } from '@/constants/design-tokens';
import type { FeatherIconName } from '@/constants/schema-meta';

export interface FloatingAssistantButtonProps {
  id?: string;
  accessibilityLabel: string;
  onPress: () => void;
  onLongPress?: () => void;
  icon?: FeatherIconName;
  iconSize?: number;
  backgroundColor?: string;
  bottomOffset?: number;
}

export function FloatingAssistantButton({
  id,
  accessibilityLabel,
  onPress,
  onLongPress,
  icon = 'message-circle',
  iconSize = 24,
  backgroundColor = Palette.brand,
  bottomOffset = 20,
}: FloatingAssistantButtonProps) {
  return (
    <Pressable
      id={id}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.fab,
        { backgroundColor, bottom: bottomOffset },
        pressed && styles.fabPressed,
      ]}
    >
      <Feather name={icon} size={iconSize} color={Palette.inkInverse} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0F766E',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.24,
    shadowRadius: 14,
    elevation: 8,
  },
  fabPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.94 }],
  },
});
