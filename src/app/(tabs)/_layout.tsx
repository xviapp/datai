import Feather from '@expo/vector-icons/Feather';
import { Tabs } from 'expo-router';
import React from 'react';
import { Easing, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Palette } from '@/constants/design-tokens';

function TabIconPill({
  name,
  color,
  focused,
}: {
  name: React.ComponentProps<typeof Feather>['name'];
  color: string;
  focused: boolean;
}) {
  return (
    <View style={[styles.iconPill, focused && styles.iconPillActive]}>
      <Feather name={name} size={20} color={color} />
    </View>
  );
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 8);

  return (
    <Tabs
      detachInactiveScreens={false}
      screenOptions={{
        headerShown: false,
        lazy: false,
        sceneStyle: { backgroundColor: Palette.bgCanvas },
        animation: 'shift',
        transitionSpec: {
          animation: 'timing',
          config: {
            duration: 170,
            easing: Easing.out(Easing.cubic),
          },
        },
        sceneStyleInterpolator: ({ current }) => ({
          sceneStyle: {
            opacity: current.progress.interpolate({
              inputRange: [-1, 0, 1],
              outputRange: [0, 1, 0],
            }),
            transform: [
              {
                translateX: current.progress.interpolate({
                  inputRange: [-1, 0, 1],
                  outputRange: [-14, 0, 14],
                }),
              },
            ],
          },
        }),
        tabBarActiveTintColor: Palette.brand,
        tabBarInactiveTintColor: Palette.inkMuted,
        tabBarButton: ({
          children,
          onPress,
          onLongPress,
          accessibilityState,
          accessibilityLabel,
          testID,
          style,
        }) => (
          <Pressable
            onPress={onPress}
            onLongPress={onLongPress ?? undefined}
            accessibilityRole="tab"
            accessibilityState={accessibilityState}
            accessibilityLabel={accessibilityLabel}
            testID={testID}
            android_ripple={{ color: 'rgba(13, 107, 99, 0.12)', borderless: false }}
            style={({ pressed }) => [
              style,
              styles.tabBtn,
              pressed && styles.tabBtnPressed,
            ]}
          >
            {children}
          </Pressable>
        ),
        tabBarStyle: {
          backgroundColor: Palette.bgSurface,
          borderTopColor: Palette.borderHairline,
          borderTopWidth: 1,
          height: 58 + bottomInset,
          paddingBottom: bottomInset,
          paddingTop: 6,
          elevation: 4,
          shadowColor: '#181A19',
          shadowOffset: { width: 0, height: -2 },
          shadowOpacity: 0.04,
          shadowRadius: 8,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '700',
          marginTop: 2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '记录',
          tabBarIcon: ({ color, focused }) => (
            <TabIconPill name="grid" color={String(color)} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="stats"
        options={{
          title: '统计',
          tabBarIcon: ({ color, focused }) => (
            <TabIconPill name="bar-chart-2" color={String(color)} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '设置',
          tabBarIcon: ({ color, focused }) => (
            <TabIconPill name="sliders" color={String(color)} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBtnPressed: {
    transform: [{ scale: 0.94 }],
  },
  iconPill: {
    width: 46,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconPillActive: {
    backgroundColor: Palette.brandSoft,
  },
});
