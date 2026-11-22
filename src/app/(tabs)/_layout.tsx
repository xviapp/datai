import { Feather } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { Palette } from '@/constants/design-tokens';

export default function TabsLayout() {
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
          height: 62,
          paddingBottom: 8,
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
          title: '全能库与看板',
          tabBarIcon: ({ color, size }) => (
            <Feather name="grid" size={size - 2} color={String(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="ai-studio"
        options={{
          title: 'AI 建模与统计',
          tabBarIcon: ({ color, size }) => (
            <Feather name="cpu" size={size - 2} color={String(color)} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '设置与时光机',
          tabBarIcon: ({ color, size }) => (
            <Feather name="sliders" size={size - 2} color={String(color)} />
          ),
        }}
      />
    </Tabs>
  );
}
