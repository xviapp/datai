import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AssistantIntent } from '@/ai/agents';
import type { AnalystAnswer } from '@/ai/schemas';
import { SqlWidgetCard } from '@/components/charts/SqlWidgetCard';
import { Palette } from '@/constants/design-tokens';
import type { DashboardWidget } from '@/schema/view-dsl';
import { IntentFallbackBar } from './IntentFallbackBar';

export interface AnalystResultViewProps {
  answer: AnalystAnswer;
  loading: boolean;
  onPinWidget: (w: DashboardWidget) => void;
  onRetryAs: (intent: AssistantIntent) => void;
}

export function AnalystResultView({
  answer,
  loading,
  onPinWidget,
  onRetryAs,
}: AnalystResultViewProps) {
  return (
    <View style={styles.resultSection}>
      <View style={styles.resultCard}>
        <View style={styles.insightHeader}>
          <Feather name="check-circle" size={15} color={Palette.brand} />
          <Text style={styles.insightHeaderTitle}>统计结果</Text>
        </View>
        <Text style={styles.insightBody}>{answer.markdownInsight}</Text>
      </View>

      {answer.suggestedWidget ? (
        <SqlWidgetCard widget={answer.suggestedWidget} onPin={onPinWidget} />
      ) : null}

      <IntentFallbackBar currentIntent="analyst" disabled={loading} onRetryAs={onRetryAs} />
    </View>
  );
}

const styles = StyleSheet.create({
  resultSection: {
    gap: 10,
  },
  resultCard: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  insightHeaderTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Palette.brand,
  },
  insightBody: {
    fontSize: 14,
    lineHeight: 22,
    color: Palette.inkPrimary,
  },
});
