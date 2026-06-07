export type { SentenceAudio, PlaybackEvent, PlaybackEventHandler, PlaybackEventType, PlaybackState, ScheduledSentence } from './types';
export { AudioSyncService, getSharedAudioSyncService, initializeAudioSyncService, disposeAudioSyncService } from './AudioSyncService';
export type { AudioSyncConfig, SyncProgressCallback } from './AudioSyncService';
