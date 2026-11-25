import { AudioModule, useAudioStream } from 'expo-audio';
import { useCallback, useEffect, useState } from 'react';
import { Animated, Platform } from 'react-native';
import { isAbortError, transcribeAudioWithDeepSeek } from '@/ai/deepseek-client';

export interface UseVoiceRecorderOptions {
  onTranscribed: (text: string) => void;
  onLoadingChange: (msg: string | null) => void;
  onError: (msg: string | null) => void;
}

/**
 * 封装 16kHz 16-bit 单声道 WAV 录音、脉冲指示动画与 DeepSeek ASR 转写
 */
export function useVoiceRecorder({
  onTranscribed,
  onLoadingChange,
  onError,
}: UseVoiceRecorderOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordPulse] = useState(() => new Animated.Value(1));

  const { stream: audioStream } = useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: 'int16',
  });

  useEffect(() => {
    if (!isRecording) {
      recordPulse.stopAnimation();
      recordPulse.setValue(1);
      return;
    }
    const timer = setInterval(() => {
      setRecordSeconds((s) => s + 1);
    }, 1000);
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(recordPulse, {
          toValue: 0.3,
          duration: 550,
          useNativeDriver: true,
        }),
        Animated.timing(recordPulse, {
          toValue: 1,
          duration: 550,
          useNativeDriver: true,
        }),
      ])
    );
    pulse.start();
    return () => {
      clearInterval(timer);
      pulse.stop();
    };
  }, [isRecording, recordPulse]);

  useEffect(() => {
    return () => {
      audioStream?.stop();
    };
  }, [audioStream]);

  const startRecording = useCallback(async () => {
    if (Platform.OS === 'web' || !audioStream) {
      onError('网页预览暂不支持录音，请直接打字或选择图片（手机端支持语音输入）');
      return;
    }
    try {
      onError(null);
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        onError('需要麦克风权限才能使用语音记录');
        return;
      }
      await audioStream.start();
      await audioStream.startFileRecordingAsync({ format: 'wav', directory: 'cache' });
      setRecordSeconds(0);
      setIsRecording(true);
    } catch (err) {
      audioStream.stop();
      setIsRecording(false);
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [audioStream, onError]);

  const toggleRecording = useCallback(
    async (signal?: AbortSignal) => {
      if (!isRecording) {
        await startRecording();
        return;
      }
      if (!audioStream) return;
      try {
        const rec = await audioStream.stopFileRecordingAsync();
        audioStream.stop();
        setIsRecording(false);

        if (!rec.uri || rec.size <= 44) {
          onError('录音时间太短，请说完后再点停止');
          return;
        }

        onLoadingChange('正在听写语音...');
        const text = await transcribeAudioWithDeepSeek(rec.uri, 'speech.wav', signal);
        if (signal?.aborted) return;
        onTranscribed(text);
        onLoadingChange(null);
      } catch (err) {
        audioStream.stop();
        setIsRecording(false);
        onLoadingChange(null);
        if (isAbortError(err)) return;
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [isRecording, startRecording, audioStream, onError, onLoadingChange, onTranscribed]
  );

  const formattedRecordTime = `${String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:${String(
    recordSeconds % 60
  ).padStart(2, '0')}`;

  return {
    isRecording,
    recordPulse,
    formattedRecordTime,
    startRecording,
    toggleRecording,
  };
}
