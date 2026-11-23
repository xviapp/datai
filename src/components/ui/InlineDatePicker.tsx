import Feather from '@expo/vector-icons/Feather';
import React, { useMemo, useState } from 'react';
import {
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Palette } from '@/constants/design-tokens';
import { formatLocalDate, formatLocalDateOffset } from '@/engine/date';

interface InlineDatePickerProps {
  value: string;
  onChange: (nextDate: string) => void;
  accentColor?: string;
}

function parseIsoDate(raw: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  if (year < 1900 || year > 2150 || month < 0 || month > 11) return null;
  return { year, month };
}

export function InlineDatePicker({
  value,
  onChange,
  accentColor = Palette.brand,
}: InlineDatePickerProps) {
  const todayStr = formatLocalDate();
  const [calendarOpen, setCalendarOpen] = useState(false);

  const parsedInitial = parseIsoDate(value);
  const now = new Date();
  const [viewYear, setViewYear] = useState(parsedInitial?.year ?? now.getFullYear());
  const [viewMonth, setViewMonth] = useState(parsedInitial?.month ?? now.getMonth());

  const toggleCalendar = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (!calendarOpen) {
      const p = parseIsoDate(value);
      if (p) {
        setViewYear(p.year);
        setViewMonth(p.month);
      }
    }
    setCalendarOpen((v) => !v);
  };

  const shiftMonth = (delta: number) => {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const dayCells = useMemo(() => {
    const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const prefix = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}`;
    const cells: Array<string | null> = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(`${prefix}-${String(d).padStart(2, '0')}`);
    }
    return cells;
  }, [viewYear, viewMonth]);

  return (
    <View style={styles.wrap}>
      <View style={styles.inputRow}>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={Palette.inkMuted}
          style={styles.textInput}
        />
        <Pressable
          onPress={toggleCalendar}
          style={({ pressed }) => [
            styles.calToggleBtn,
            calendarOpen && { backgroundColor: `${accentColor}18`, borderColor: accentColor },
            pressed && { opacity: 0.75 },
          ]}
          accessibilityLabel="展开日期选择日历"
        >
          <Feather
            name="calendar"
            size={15}
            color={calendarOpen ? accentColor : Palette.inkSecondary}
          />
          <Text style={[styles.calToggleText, calendarOpen && { color: accentColor }]}>
            {calendarOpen ? '收起' : '选日期'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.quickChipsRow}>
        {[
          { label: '今天', offset: 0 },
          { label: '昨天', offset: -1 },
          { label: '+30天', offset: 30 },
          { label: '+1年', offset: 365 },
        ].map((q) => {
          const target = formatLocalDateOffset(q.offset);
          const active = value === target;
          return (
            <Pressable
              key={q.label}
              onPress={() => {
                onChange(target);
                const p = parseIsoDate(target);
                if (p) {
                  setViewYear(p.year);
                  setViewMonth(p.month);
                }
              }}
              style={({ pressed }) => [
                styles.quickChip,
                active && { backgroundColor: accentColor },
                pressed && { opacity: 0.75 },
              ]}
            >
              <Text style={[styles.quickChipText, active && { color: Palette.inkInverse }]}>
                {q.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {calendarOpen ? (
        <View style={styles.calBox}>
          <View style={styles.calHeader}>
            <Pressable
              hitSlop={8}
              onPress={() => shiftMonth(-1)}
              style={({ pressed }) => [styles.navBtn, pressed && { opacity: 0.65 }]}
            >
              <Feather name="chevron-left" size={16} color={Palette.inkPrimary} />
            </Pressable>
            <Text style={styles.monthTitle}>
              {viewYear} 年 {viewMonth + 1} 月
            </Text>
            <Pressable
              hitSlop={8}
              onPress={() => shiftMonth(1)}
              style={({ pressed }) => [styles.navBtn, pressed && { opacity: 0.65 }]}
            >
              <Feather name="chevron-right" size={16} color={Palette.inkPrimary} />
            </Pressable>
          </View>

          <View style={styles.weekRow}>
            {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
              <Text key={w} style={styles.weekLabel}>
                {w}
              </Text>
            ))}
          </View>

          <View style={styles.daysGrid}>
            {dayCells.map((dateStr, idx) => {
              if (!dateStr) return <View key={`pad-${idx}`} style={styles.dayCell} />;
              const selected = value === dateStr;
              const isToday = dateStr === todayStr;
              const dayNum = Number(dateStr.slice(-2));
              return (
                <Pressable
                  key={dateStr}
                  onPress={() => {
                    onChange(dateStr);
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setCalendarOpen(false);
                  }}
                  style={({ pressed }) => [
                    styles.dayCell,
                    isToday && !selected && { borderWidth: 1.5, borderColor: accentColor },
                    selected && { backgroundColor: accentColor },
                    pressed && { opacity: 0.75 },
                  ]}
                >
                  <Text
                    style={[
                      styles.dayText,
                      isToday && !selected && { color: accentColor, fontWeight: '800' },
                      selected && { color: Palette.inkInverse, fontWeight: '800' },
                    ]}
                  >
                    {dayNum}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: Palette.inkPrimary,
  },
  calToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 44,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  calToggleText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  quickChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  quickChip: {
    backgroundColor: Palette.bgSubtle,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 8,
  },
  quickChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  calBox: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 6,
  },
  calHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  navBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: Palette.bgSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  weekRow: {
    flexDirection: 'row',
  },
  weekLabel: {
    width: '14.28%',
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '600',
    color: Palette.inkMuted,
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: '14.28%',
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
  },
  dayText: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkPrimary,
  },
});
