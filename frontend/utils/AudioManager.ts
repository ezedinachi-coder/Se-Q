/**
 * AudioManager.ts — Centralized audio session management
 *
 * Design contract:
 *   1. Single point of control for ALL expo-av Audio operations
 *   2. Priority-based audio mode management prevents sound clashes
 *   3. Automatic audio mode restoration when higher-priority tasks complete
 *   4. Safe cleanup on unmount and screen transitions
 *   5. Async mutex prevents zombie sounds from concurrent callers
 *
 * Priority levels:
 *   - RECORDING (100): Recording operations (highest priority)
 *   - ALERT (75): Panic alarms and message alerts
 *   - AMBIENT (50): Ambient sound playback
 *   - PLAYBACK (25): Video/audio report playback (lowest priority)
 *
 * FIX BUG-09: The four standalone mode helpers (setRecordingAudioMode,
 * restorePlaybackAudioMode, setPlaybackAudioMode, setAlertAudioMode) are now
 * INTERNAL to this module. External callers MUST go through requestFocus() /
 * releaseFocus() / playSound(). This prevents all bypass patterns that caused
 * concurrent setAudioModeAsync() races.
 *
 * Exports kept for backward-compat but now simply delegate to the manager:
 *   setRecordingAudioMode()   → AudioManager.requestFocus(RECORDING, tag)
 *   restorePlaybackAudioMode() → AudioManager.releaseFocus(tag)
 * These shims are intentionally thin so callers can be migrated gradually.
 */

import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';

// Priority enum
export enum AudioPriority {
  PLAYBACK = 25,    // Lowest - video/audio playback
  AMBIENT = 50,     // Ambient sound
  ALERT = 75,       // Panic alarms, message alerts
  RECORDING = 100,  // Highest - recording operations
}

// ── Audio mode configurations ─────────────────────────────────────────────────

const AUDIO_MODES: Record<AudioPriority, Audio.AudioMode> = {
  [AudioPriority.RECORDING]: {
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
    shouldDuckAndroid: false,
    playThroughEarpieceAndroid: false,
    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
  },
  [AudioPriority.ALERT]: {
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: false,
    playThroughEarpieceAndroid: false,
    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
  },
  [AudioPriority.AMBIENT]: {
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
  },
  [AudioPriority.PLAYBACK]: {
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
    interruptionModeIOS: InterruptionModeIOS.DoNotMix,
    interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
  },
};

// Neutral/standby mode for when nothing is active
const STANDBY_MODE: Audio.AudioMode = {
  allowsRecordingIOS: false,
  playsInSilentModeIOS: false,
  staysActiveInBackground: false,
  shouldDuckAndroid: true,
  playThroughEarpieceAndroid: false,
  // FIX BUG-05: use proper enum values, never raw integer 0
  interruptionModeIOS: InterruptionModeIOS.DoNotMix,
  interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
};

interface ActiveSound {
  sound: Audio.Sound;
  priority: AudioPriority;
  tag: string;
}

// ── AudioManager singleton ────────────────────────────────────────────────────

class AudioManagerClass {
  private activeSound: ActiveSound | null = null;
  private currentPriority: AudioPriority | null = null;
  private isInitialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  // FIX BUG-06: async mutex — prevents two concurrent playSound() calls from
  // both seeing activeSound===null, both calling createAsync(), and creating
  // a zombie (orphaned, unstoppable) Audio.Sound object.
  private _acquiring: boolean = false;
  private _acquireQueue: Array<() => void> = [];

  private async _acquireLock(): Promise<void> {
    if (!this._acquiring) {
      this._acquiring = true;
      return;
    }
    return new Promise<void>(resolve => {
      this._acquireQueue.push(resolve);
    });
  }

  private _releaseLock(): void {
    const next = this._acquireQueue.shift();
    if (next) {
      next();
    } else {
      this._acquiring = false;
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInitialize();
    return this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      await Audio.setAudioModeAsync(STANDBY_MODE);
      this.isInitialized = true;
      console.log('[AudioManager] Initialized successfully');
    } catch (error) {
      console.error('[AudioManager] Failed to initialize:', error);
      throw error;
    }
  }

  // ── Focus management ────────────────────────────────────────────────────────

  /**
   * Request audio focus for a specific priority.
   * Returns true if focus was granted.
   *
   * FIX BUG-04: force-stop now uses RECORDING (max priority) so that even a
   * RECORDING-priority occupant can be evicted by a higher-or-equal caller,
   * and releaseFocus() never gets stuck unable to clear its own sound.
   */
  async requestFocus(priority: AudioPriority, tag: string): Promise<boolean> {
    if (!this.isInitialized) await this.initialize();

    if (!this.activeSound) {
      await this._setAudioMode(priority);
      this.currentPriority = priority;
      console.log(`[AudioManager] Focus granted to ${tag} (priority: ${priority})`);
      return true;
    }

    if (this.activeSound.priority > priority) {
      console.log(
        `[AudioManager] Focus denied to ${tag} — active: ${this.activeSound.tag} ` +
        `(priority: ${this.activeSound.priority})`
      );
      return false;
    }

    // Equal or lower priority occupant — evict it
    console.log(
      `[AudioManager] Priority override: ${tag} (${priority}) ` +
      `over ${this.activeSound.tag} (${this.activeSound.priority})`
    );
    // FIX BUG-04: pass RECORDING so the priority check in stopCurrent always
    // allows the stop, regardless of what the occupant's priority is.
    await this.stopCurrent(AudioPriority.RECORDING);
    await this._setAudioMode(priority);
    this.currentPriority = priority;
    return true;
  }

  /**
   * Release audio focus when done.
   * FIX BUG-04: uses RECORDING priority so the sound is always stoppable.
   */
  async releaseFocus(tag: string): Promise<void> {
    if (this.activeSound && this.activeSound.tag === tag) {
      console.log(`[AudioManager] Releasing focus from ${tag}`);
      // FIX BUG-04: was stopCurrent(ALERT=75) which refused to stop
      // RECORDING-priority (100) sounds — permanent deadlock.
      await this.stopCurrent(AudioPriority.RECORDING);
      this.currentPriority = null;
      await this._restoreToStandby();
    }
  }

  // ── Sound playback ──────────────────────────────────────────────────────────

  /**
   * Play a sound with specified priority.
   * Handles focus, session mode, and cleanup automatically.
   *
   * FIX BUG-06: mutex lock acquired before first await so two concurrent
   * callers cannot both see activeSound===null and both proceed to createAsync,
   * creating a zombie sound with no reference for cleanup.
   */
  async playSound(
    uri: string,
    priority: AudioPriority,
    tag: string,
    options?: {
      isLooping?: boolean;
      volume?: number;
      downloadFirst?: boolean;
      onFinish?: () => void;
    }
  ): Promise<Audio.Sound | null> {
    // Acquire mutex BEFORE any await — this is the critical section gate
    await this._acquireLock();

    try {
      if (this.activeSound) {
        await this.stopCurrent(priority);
      }

      const focusGranted = await this.requestFocus(priority, tag);
      if (!focusGranted) {
        // FIX BUG-07: removed misleading "queued" log — nothing was ever queued.
        // Caller receives null and can decide to retry or drop.
        console.log(`[AudioManager] Sound ${tag} denied (lower priority than active)`);
        return null;
      }

      try {
        const { sound } = await Audio.Sound.createAsync(
          { uri, downloadFirst: options?.downloadFirst ?? true },
          {
            isLooping: options?.isLooping ?? false,
            volume: options?.volume ?? 1.0,
            shouldPlay: true,
          }
        );

        this.activeSound = { sound, priority, tag };

        // Auto-cleanup when non-looping sound finishes naturally
        if (!options?.isLooping) {
          sound.setOnPlaybackStatusUpdate((status: any) => {
            if (status.isLoaded && status.didJustFinish) {
              // Only clean up if this sound is still the active one —
              // guards against a higher-priority sound having already evicted it.
              if (this.activeSound?.tag === tag) {
                sound.unloadAsync().catch(() => {});
                this.activeSound = null;
                this.currentPriority = null;
                this._restoreToStandby().catch(() => {});
              }
              options?.onFinish?.();
            }
          });
        }

        return sound;
      } catch (error) {
        console.error(`[AudioManager] Failed to play ${tag}:`, error);
        await this._restoreToStandby();
        this.currentPriority = null;
        return null;
      }
    } finally {
      this._releaseLock();
    }
  }

  // ── Stop ────────────────────────────────────────────────────────────────────

  /**
   * Stop the current active sound if minimumPriority is high enough.
   * FIX BUG-04: callers that need unconditional stop pass RECORDING (100).
   */
  async stopCurrent(minimumPriority: AudioPriority): Promise<void> {
    if (!this.activeSound) return;

    if (this.activeSound.priority > minimumPriority) {
      console.log(
        `[AudioManager] Cannot stop ${this.activeSound.tag} — ` +
        `active priority (${this.activeSound.priority}) > stop threshold (${minimumPriority})`
      );
      return;
    }

    const snapshot = this.activeSound;
    this.activeSound = null; // clear ref first so status callbacks see it gone

    try {
      await snapshot.sound.setStatusAsync({ shouldPlay: false }).catch(() => {});
      await snapshot.sound.stopAsync().catch(() => {});
      await snapshot.sound.unloadAsync().catch(() => {});
    } catch (error) {
      console.warn(`[AudioManager] Error stopping sound ${snapshot.tag}:`, error);
    }
  }

  /**
   * Emergency stop — stops everything regardless of priority.
   */
  async stopAll(): Promise<void> {
    if (this.activeSound) {
      const snapshot = this.activeSound;
      this.activeSound = null;
      this.currentPriority = null;
      try {
        await snapshot.sound.setStatusAsync({ shouldPlay: false }).catch(() => {});
        await snapshot.sound.stopAsync().catch(() => {});
        await snapshot.sound.unloadAsync().catch(() => {});
      } catch (error) {
        console.warn('[AudioManager] Error during emergency stop:', error);
      }
    }
    await this._restoreToStandby();
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async _setAudioMode(priority: AudioPriority): Promise<void> {
    try {
      const mode = AUDIO_MODES[priority];
      if (mode) await Audio.setAudioModeAsync(mode);
    } catch (error) {
      console.error(`[AudioManager] Failed to set audio mode for priority ${priority}:`, error);
    }
  }

  async _restoreToStandby(): Promise<void> {
    try {
      await Audio.setAudioModeAsync(STANDBY_MODE);
    } catch (error) {
      console.warn('[AudioManager] Failed to restore standby mode:', error);
    }
  }

  // ── Inspection ──────────────────────────────────────────────────────────────

  getActiveInfo(): { tag: string; priority: AudioPriority } | null {
    if (!this.activeSound) return null;
    return { tag: this.activeSound.tag, priority: this.activeSound.priority };
  }

  isActive(): boolean {
    return this.activeSound !== null;
  }

  isRecording(): boolean {
    return this.activeSound?.priority === AudioPriority.RECORDING;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    await this.stopAll();
    this.isInitialized = false;
    this.initPromise = null;
  }
}

// Singleton
export const AudioManager = new AudioManagerClass();

// ── Convenience focus helpers ─────────────────────────────────────────────────

export const AudioFocus = {
  forRecording: (tag: string) => AudioManager.requestFocus(AudioPriority.RECORDING, tag),
  forAlert: (tag: string) => AudioManager.requestFocus(AudioPriority.ALERT, tag),
  forAmbient: (tag: string) => AudioManager.requestFocus(AudioPriority.AMBIENT, tag),
  forPlayback: (tag: string) => AudioManager.requestFocus(AudioPriority.PLAYBACK, tag),
  release: (tag: string) => AudioManager.releaseFocus(tag),
};

// ── Convenience playback helpers ──────────────────────────────────────────────

export const AudioPlayback = {
  playPanicAlarm: async () => {
    try {
      return await AudioManager.playSound(
        'https://assets.mixkit.co/active_storage/sfx/212/212-preview.mp3',
        AudioPriority.ALERT,
        'panic_alarm',
        { isLooping: true, volume: 1.0, downloadFirst: true }
      );
    } catch (error) {
      console.error('[AudioManager] Failed to play panic alarm:', error);
      return null;
    }
  },

  playMessageAlert: async (onFinish?: () => void) => {
    try {
      return await AudioManager.playSound(
        'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3',
        AudioPriority.ALERT,
        'message_alert',
        { isLooping: false, volume: 0.85, downloadFirst: true, onFinish }
      );
    } catch (error) {
      console.error('[AudioManager] Failed to play message alert:', error);
      return null;
    }
  },

  playAmbientSound: async (uri: string) => {
    try {
      return await AudioManager.playSound(
        uri,
        AudioPriority.AMBIENT,
        'ambient_sound',
        { isLooping: true, volume: 0.7, downloadFirst: true }
      );
    } catch (error) {
      console.error('[AudioManager] Failed to play ambient sound:', error);
      return null;
    }
  },

  stopAll: () => AudioManager.stopAll(),

  stopIfLowerPriority: (minimumPriority: AudioPriority) =>
    AudioManager.stopCurrent(minimumPriority),
};

// ── Backward-compat shims (thin delegation — do NOT call setAudioModeAsync directly) ──
//
// FIX BUG-09: These used to call Audio.setAudioModeAsync() directly, bypassing
// the manager's state tracking entirely. They now delegate through requestFocus /
// releaseFocus so all mode changes are coordinated. Callers should eventually
// migrate to AudioFocus / AudioPlayback directly.

/**
 * @deprecated Use AudioManager.requestFocus(AudioPriority.RECORDING, tag)
 * Kept for ambientRecorder.ts compatibility — will be removed in next refactor.
 */
export async function setRecordingAudioMode(): Promise<void> {
  await AudioManager.requestFocus(AudioPriority.RECORDING, 'recording_shim');
}

/**
 * @deprecated Use AudioManager.releaseFocus(tag)
 * Kept for ambientRecorder.ts / audio.tsx compatibility.
 */
export async function restorePlaybackAudioMode(): Promise<void> {
  await AudioManager.releaseFocus('recording_shim');
}

/**
 * @deprecated Use AudioManager.requestFocus(AudioPriority.PLAYBACK, tag)
 */
export async function setPlaybackAudioMode(): Promise<void> {
  await AudioManager.requestFocus(AudioPriority.PLAYBACK, 'playback_shim');
}

/**
 * @deprecated Use AudioManager.requestFocus(AudioPriority.ALERT, tag)
 */
export async function setAlertAudioMode(): Promise<void> {
  await AudioManager.requestFocus(AudioPriority.ALERT, 'alert_shim');
}
