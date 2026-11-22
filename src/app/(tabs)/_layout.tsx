import { Feather } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Palette } from '@/constants/design-tokens';

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 8);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Palette.brand,
        tabBarInactiveTintColor: Palette.inkMuted,
        tabBarStyle: {
          backgroundColor: Palette.bgSurface,
          borderTopColor: Palette.borderHairline,
          borderTopWidth: 1,
          height: 54 + bottomInset,
          paddingBottom: bottomInset,
          paddingTop: 6,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '700',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '记录',
          tabBarIcon: ({ color, size }) => (
            <Feather name="grid" size={size - 2} color={String(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="ai-studio"
        options={{
          title: '助手',
          tabBarIcon: ({ color, size }) => (
            <Feather name="message-circle" size={size - 2} color={String(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '设置',
          tabBarIcon: ({ color, size }) => (
            <Feather name="sliders" size={size - 2} color={String(color)} />
          ),
        }}
      />
    </Tabs>
  );
}
