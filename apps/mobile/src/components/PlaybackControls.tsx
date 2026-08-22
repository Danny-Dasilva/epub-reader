import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/constants/theme';

interface PlaybackControlsProps {
  isPlaying: boolean;
  isLoading: boolean;
  speechRate: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onRateChange: (rate: number) => void;
}

const RATES = [0.8, 1, 1.2, 1.5] as const;

export const PlaybackControls = memo(function PlaybackControls({
  isPlaying,
  isLoading,
  speechRate,
  canGoPrevious,
  canGoNext,
  onToggle,
  onPrevious,
  onNext,
  onRateChange,
}: PlaybackControlsProps) {
  const nextRate = RATES[(RATES.findIndex((rate) => rate === speechRate) + 1) % RATES.length] ?? 1;
  return (
    <View style={styles.shell} accessibilityLabel="Narration controls">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Previous sentence"
        disabled={!canGoPrevious}
        onPress={onPrevious}
        style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, !canGoPrevious && styles.disabled]}
        testID="previous-button"
      >
        <Text style={styles.secondaryLabel}>−15</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause narration' : 'Play narration'}
        accessibilityState={{ busy: isLoading, selected: isPlaying }}
        onPress={onToggle}
        style={({ pressed }) => [styles.playButton, pressed && styles.playPressed]}
        testID="play-pause-button"
      >
        {isLoading ? (
          <ActivityIndicator color={colors.white} testID="playback-loading" />
        ) : (
          <Text style={styles.playLabel}>{isPlaying ? 'Ⅱ' : '▶'}</Text>
        )}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next sentence"
        disabled={!canGoNext}
        onPress={onNext}
        style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, !canGoNext && styles.disabled]}
        testID="next-button"
      >
        <Text style={styles.secondaryLabel}>+15</Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Narration speed ${speechRate.toFixed(1)} times`}
        onPress={() => onRateChange(nextRate)}
        style={({ pressed }) => [styles.rateButton, pressed && styles.pressed]}
        testID="rate-button"
      >
        <Text style={styles.rateLabel}>{speechRate.toFixed(1)}×</Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  shell: {
    alignItems: 'center',
    backgroundColor: colors.paper,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 18,
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  secondaryLabel: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  playButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 30,
    height: 60,
    justifyContent: 'center',
    width: 60,
  },
  playPressed: { backgroundColor: colors.accentPressed },
  playLabel: { color: colors.white, fontSize: 23, fontWeight: '800' },
  rateButton: { paddingHorizontal: 4, paddingVertical: 12 },
  rateLabel: { color: colors.accent, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.3 },
});
