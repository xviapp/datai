import { Stack } from 'expo-router';
import Head from 'expo-router/head';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';
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
        <Text style={styles.errTitle}>数据加载失败</Text>
        <Text style={styles.errDesc}>{error}</Text>
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Palette.brand} />
        <Text style={styles.loadingText}>正在打开拾录...</Text>
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
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <Head>
        <title>拾录 · Folio</title>
        <meta
          name="description"
          content="离线可用的个人自定义记录本，支持自由定制字段、多视图浏览、自动统计与随手语音拍照记录"
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
