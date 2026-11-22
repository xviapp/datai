import { Stack } from 'expo-router';
import Head from 'expo-router/head';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { OmniCaptureModal } from '@/components/ai/OmniCaptureModal';
import { Palette } from '@/constants/design-tokens';
import { OmniProvider, useOmni } from '@/context/omni-context';

SplashScreen.preventAutoHideAsync().catch(() => {});

function AppShell() {
  const { ready, error } = useOmni();

  useEffect(() => {
    if (ready || error) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [ready, error]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errTitle}>本地数据库初始化失败</Text>
        <Text style={styles.errDesc}>{error}</Text>
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Palette.brand} />
        <Text style={styles.loadingText}>正在加载本地 SQLite 引擎...</Text>
      </View>
    );
  }

  return (
    <>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: Palette.bgCanvas },
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="library/[slug]" />
        <Stack.Screen name="entry/[id]" />
      </Stack>
      <OmniCaptureModal />
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Head>
        <title>万象记 OmniVault · AI 原生个人全能记录库</title>
        <meta
          name="description"
          content="纯单机离线优先、自定义数据模型与显示样式、跨表双向引用统计、搭载 DeepSeek V4.1 Flash 的个人全能数据库应用"
        />
      </Head>
      <StatusBar style="dark" />
      <OmniProvider>
        <AppShell />
      </OmniProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: Palette.bgCanvas,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 10,
  },
  loadingText: {
    fontSize: 14,
    color: Palette.inkSecondary,
  },
  errTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: Palette.danger,
  },
  errDesc: {
    fontSize: 13,
    color: Palette.inkSecondary,
    textAlign: 'center',
  },
});
