import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Palette } from '@/constants/design-tokens';

export interface TabPageHeaderProps {
  title: string;
  subtitle: string;
  right?: React.ReactNode;
}

export function TabPageHeader({ title, subtitle, right }: TabPageHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.outer, { paddingTop: insets.top }]}>
      <View style={styles.inner}>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {right ? <View style={styles.actions}>{right}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    width: '100%',
    backgroundColor: Palette.bgCanvas,
  },
  inner: {
    width: '100%',
    maxWidth: 880,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 12,
    height: 78,
    gap: 12,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  title: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '800',
    color: Palette.inkPrimary,
    letterSpacing: -0.5,
    includeFontPadding: false,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    color: Palette.inkMuted,
    includeFontPadding: false,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 8,
  },
});
