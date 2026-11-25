import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Palette } from '@/constants/design-tokens';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  summary?: string;
  description?: string;
  descriptionTone?: 'secondary' | 'warning' | 'danger';
  cancelLabel?: string;
  confirmLabel?: string;
  confirmTone?: 'danger' | 'brand';
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  visible,
  title,
  summary,
  description,
  descriptionTone = 'secondary',
  cancelLabel = '取消',
  confirmLabel = '确认',
  confirmTone = 'danger',
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const descColor =
    descriptionTone === 'danger'
      ? Palette.danger
      : descriptionTone === 'warning'
        ? Palette.warning
        : Palette.inkSecondary;

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <Text style={styles.title}>{title}</Text>
          {summary ? (
            <Text style={styles.summary} numberOfLines={2}>
              {summary}
            </Text>
          ) : null}
          {description ? (
            <Text style={[styles.description, { color: descColor }]}>{description}</Text>
          ) : null}
          <View style={styles.btns}>
            <Pressable
              onPress={onCancel}
              style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.78 }]}
            >
              <Text style={styles.cancelText}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              style={({ pressed }) => [
                styles.okBtn,
                confirmTone === 'brand' && { backgroundColor: Palette.brand },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={styles.okText}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(18, 24, 23, 0.46)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dialog: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: Palette.bgSurface,
    borderRadius: 20,
    padding: 20,
    gap: 10,
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  summary: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  description: {
    fontSize: 13,
    lineHeight: 19,
  },
  btns: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: Palette.bgSubtle,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  okBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: Palette.danger,
    alignItems: 'center',
  },
  okText: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
});
