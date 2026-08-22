export interface InflectVoice {
  id: string;
  name: string;
  modelPath: string;
  downloadSize: string;
}

export const DEFAULT_INFLECT_VOICE_ID = 'sky-v3';

export const INFLECT_VOICES: readonly InflectVoice[] = [
  {
    id: DEFAULT_INFLECT_VOICE_ID,
    name: 'Sky v3',
    modelPath: `/models/inflect/${DEFAULT_INFLECT_VOICE_ID}`,
    downloadSize: '36 MB',
  },
];

const VOICES_BY_ID = new Map(INFLECT_VOICES.map((voice) => [voice.id, voice]));

export function getInflectVoice(voiceId: string): InflectVoice {
  return VOICES_BY_ID.get(voiceId) ?? INFLECT_VOICES[0];
}
