/**
 * ambientRecorder.ts — Discrete 30-second ambient threat recorder
 *
 * Design contract:
 *   1. beginAmbientCapture() — call the INSTANT a panic category is chosen.
 *      Recording starts immediately in background. Returns { attachToPanic }.
 *
 *   2. attachToPanic(panicId, token) — call once the backend returns panic_id.
 *      Waits for recording to finish then uploads silently. Fire-and-forget.
 *
 * Robustness guarantees:
 *   - Never throws — panic activation is unaffected by any recording failure.
 *   - staysActiveInBackground: true — survives the app being minimised
 *     immediately after category selection (the normal civil user flow).
 *   - Requests microphone permission (not just checks) so first-time use works
 *     without having previously opened the audio report screen.
 *   - Uses a custom 16kHz mono preset — LOW_QUALITY on Android uses 8kHz
 *     which is barely intelligible. 16kHz is phone-call quality at ~300KB/30s.
 *
 * FIX BUG-08: Audio mode is now managed exclusively through AudioManager
 * focus system using a named tag ('ambient_recorder'). The previous pattern
 * called setRecordingAudioMode() / restorePlaybackAudioMode() as raw
 * setAudioModeAsync() wrappers, which raced with the message-alert poller
 * (15-second interval in civil/home.tsx) and could set allowsRecordingIOS:
 * false while recording was in progress, silently killing the capture on iOS.
 *
 * Now:
 *   - requestFocus(RECORDING, 'ambient_recorder') acquires the session with
 *     the highest priority — the message-alert poller will be denied focus
 *     (ALERT=75 < RECORDING=100) and will not touch the session.
 *   - releaseFocus('ambient_recorder') restores the session atomically through
 *     the manager's standby path, so the restore is coordinated rather than
 *     racing with any other caller.
 */

import { Audio } from 'expo-av';
import axios from 'axios';
import BACKEND_URL from './config';
import { AudioManager, AudioPriority } from './AudioManager';

const CAPTURE_DURATION_MS = 30_000;
const HARD_TIMEOUT_MS     = 35_000;

// 16kHz mono — phone-call quality, ~300KB for 30 seconds
const AMBIENT_RECORDING_OPTIONS: Audio.RecordingOptions = {
  android: {
    extension: '.m4a',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 32000,
  },
  ios: {
    extension: '.m4a',
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.LOW,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 32000,
  },
  web: {},
};

// Stable tag used for both requestFocus and releaseFocus so the manager can
// match them correctly.
const RECORDER_TAG = 'ambient_recorder';

export interface AmbientCapture {
  attachToPanic: (panicId: string, authToken: string) => void;
}

export function beginAmbientCapture(): AmbientCapture {
  let resolveUri: (uri: string | null) => void;
  const uriPromise = new Promise<string | null>(res => { resolveUri = res; });

  _record().then(uri => resolveUri(uri)).catch(() => resolveUri(null));

  return {
    attachToPanic(panicId: string, authToken: string): void {
      _uploadWhenReady(uriPromise, panicId, authToken);
    },
  };
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _record(): Promise<string | null> {
  let recording: Audio.Recording | null = null;

  try {
    // ── Permission ──────────────────────────────────────────────────────────
    const { status } = await Audio.requestPermissionsAsync();
    if (status !== 'granted') {
      console.log('[AmbientRecorder] Mic permission not granted — skipping capture');
      return null;
    }

    // FIX BUG-08: requestFocus(RECORDING) sets allowsRecordingIOS:true and
    // staysActiveInBackground:true with the highest priority (100). Any
    // concurrent caller at ALERT (75) or lower will be denied focus and
    // cannot change the session mode while recording is in progress.
    const focusGranted = await AudioManager.requestFocus(AudioPriority.RECORDING, RECORDER_TAG);
    if (!focusGranted) {
      // Another RECORDING-priority operation is already running — skip capture
      // rather than fighting over the microphone.
      console.log('[AmbientRecorder] Focus denied — another recording is active');
      return null;
    }

    // ── Start recording ─────────────────────────────────────────────────────
    const { recording: rec } = await Audio.Recording.createAsync(
      AMBIENT_RECORDING_OPTIONS,
      undefined,
      100
    );
    recording = rec;

    // ── Wait 30 s with hard timeout safety net ───────────────────────────────
    await Promise.race([
      new Promise<void>(resolve => setTimeout(resolve, CAPTURE_DURATION_MS)),
      new Promise<void>(resolve => setTimeout(resolve, HARD_TIMEOUT_MS)),
    ]);

    // ── Stop and get URI ────────────────────────────────────────────────────
    await recording.stopAndUnloadAsync();
    const uri = recording.getURI() ?? null;
    recording = null;

    // FIX BUG-08: releaseFocus restores the session through the manager's
    // coordinated standby path — no bare setAudioModeAsync() call that could
    // race with a message-alert restore happening concurrently.
    await AudioManager.releaseFocus(RECORDER_TAG);

    return uri;

  } catch (_) {
    if (recording) {
      try { await recording.stopAndUnloadAsync(); } catch (__) {}
      recording = null;
    }
    // Always release focus on error so the session is never left stuck in
    // RECORDING mode (which would deny focus to all subsequent callers).
    await AudioManager.releaseFocus(RECORDER_TAG);
    return null;
  }
}

async function _uploadWhenReady(
  uriPromise: Promise<string | null>,
  panicId: string,
  authToken: string,
): Promise<void> {
  try {
    const uri = await uriPromise;
    if (!uri || !panicId || panicId === 'unknown') return;

    const formData = new FormData();
    formData.append('audio', {
      uri,
      type: 'audio/m4a',
      name: `ambient_${panicId}_${Date.now()}.m4a`,
    } as any);

    await axios.post(
      `${BACKEND_URL}/api/panic/${panicId}/ambient-audio`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'multipart/form-data',
        },
        timeout: 30_000,
      }
    );
  } catch (_) {
    // Completely silent — panic is unaffected by upload failure
  }
}
