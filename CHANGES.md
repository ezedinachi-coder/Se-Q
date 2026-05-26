# Se-Q App8 — Native Shake Detection Patch

## Summary
Replaces JS-only shake detection with a persistent native Android foreground
service that survives app death, screen-off, and device reboot. The phone now
acts as a dedicated safety device at the OS level.

---

## New Files

### `frontend/android/app/src/main/java/com/safeguard/app/ShakeDetectionService.kt`
Persistent native foreground service (START_STICKY) that:
- Registers a hardware SensorEventListener on the accelerometer at 50 Hz
- Detects triple-shake pattern: 3 events ≥ 2.5g within 1 500 ms window
- 300 ms debounce between individual shake counts
- 8 second cooldown after any trigger
- Shows a 2-second "PANIC ACTIVATING" heads-up notification with a Cancel button
- On countdown expiry: writes SharedPreferences flag + fires MainActivity intent
- Holds PARTIAL_WAKE_LOCK so CPU stays alive when screen is off
- android:stopWithTask="false" — survives the user swiping away the app

### `frontend/android/app/src/main/java/com/safeguard/app/SeqPanicModule.kt`
React Native NativeModule. Exposes one method to JS:
  NativeModules.SeqPanic.checkAndConsumePanic() → Promise<boolean>
Reads the SharedPreferences flag set by ShakeDetectionService and atomically
clears it (one-time consumption). Returns false on any error.

### `frontend/android/app/src/main/java/com/safeguard/app/SeqPanicPackage.kt`
ReactPackage wrapper that registers SeqPanicModule into the RN package list.

### `frontend/utils/nativePanicBridge.ts`
Thin TypeScript wrapper around NativeModules.SeqPanic. Returns false safely on
iOS (module is Android-only) and when the module is unavailable.

---

## Modified Files

### `frontend/android/app/src/main/java/com/safeguard/app/BootReceiver.kt`
Now starts TWO services on boot:
1. ShakeDetectionService (persistent) — protection from first boot
2. BootRestartService (one-shot) — notification restore (unchanged behaviour)

### `frontend/android/app/src/main/java/com/safeguard/app/MainActivity.kt`
Two additions:
1. onCreate: calls startShakeDetectionService() so protection is live from
   the very first app launch (before any reboot has occurred).
2. onCreate + onNewIntent: handlePanicIntent() reinforces the SharedPreferences
   flag if SEQ_ACTIVATE_PANIC extra is present, closing a narrow race condition
   where the service writes the flag and immediately crashes.

### `frontend/android/app/src/main/java/com/safeguard/app/MainApplication.kt`
Added `add(SeqPanicPackage())` inside getPackages() so SeqPanicModule is
registered and accessible via NativeModules.SeqPanic in JS.

### `frontend/android/app/src/main/AndroidManifest.xml`
- Added `android.permission.WAKE_LOCK`
- Added `android.permission.FOREGROUND_SERVICE_SENSOR` (API 34+)
- Removed duplicate `FOREGROUND_SERVICE` declaration
- Registered ShakeDetectionService with:
    android:stopWithTask="false"        ← survives app swipe
    android:foregroundServiceType="sensor"  ← correct type for accelerometer use

### `frontend/app/_layout.tsx`
Added native panic bridge polling:
- Imports checkAndConsumePanic from nativePanicBridge
- useEffect (empty deps) that:
    a) Calls checkAndConsumePanic() on mount (cold-start: app launched by intent)
    b) Calls it on every AppState → "active" transition (warm: app foregrounded)
    c) Reads user_role from AsyncStorage to gate navigation (civil only)
    d) Skips navigation if already on a panic screen

---

## Architecture: How It All Connects

```
Device boots / App first opens
        │
        ▼
BootReceiver / MainActivity.onCreate
        │
        ▼
ShakeDetectionService.onCreate()
  ├─ startForeground(NOTIF_SHIELD_ID)  ← "Se-Q Protection Active" notification
  ├─ PowerManager.PARTIAL_WAKE_LOCK    ← CPU stays alive
  └─ SensorManager.registerListener() ← native accelerometer at 50 Hz
        │
        │  [phone in pocket, screen off, app swiped — doesn't matter]
        │
        ▼  triple shake detected
ShakeDetectionService.beginCountdown()
  └─ showCountdownNotification()  ← heads-up: "PANIC IN 2s — tap to cancel"
        │
        │  [2 seconds pass, user does not tap Cancel]
        │
        ▼
ShakeDetectionService.firePanic()
  ├─ SharedPreferences.putBoolean("shake_panic_pending", true)  ← SYNC write
  └─ startActivity(MainActivity intent + SEQ_ACTIVATE_PANIC=true)
        │
        ▼
MainActivity.onNewIntent / onCreate
  └─ reinforces SharedPreferences flag (race-condition safety)
        │
        ▼  React Native JS runtime initialises (or was already running)
        │
_layout.tsx useEffect / AppState "active" handler
  └─ checkAndConsumePanic()  →  NativeModules.SeqPanic  →  SeqPanicModule.kt
        │  returns true, clears flag
        ▼
router.push('/civil/panic-shake')
        │
        ▼
panic-shake.tsx  (existing 5-second countdown + category selection + API call)
```

---

## Deployment Notes

### Build requirement
This patch introduces a new foreground service type. Run a full Gradle build:
  cd frontend/android && ./gradlew assembleRelease

### Android version behaviour
| API level | Behaviour |
|-----------|-----------|
| 26–32     | Foreground service with shortService type fallback |
| 33        | sensor type supported, FOREGROUND_SERVICE_SENSOR not required |
| 34+       | FOREGROUND_SERVICE_SENSOR permission required and declared |

### iOS
No changes affect iOS. checkAndConsumePanic() returns false on iOS silently.
The JS-layer shake detector in _layout.tsx continues to work on iOS as before.

### OEM battery optimisation (important for production)
Chinese OEMs (Xiaomi, Huawei, Oppo, Vivo) aggressively kill background services
despite START_STICKY. Users on these devices should be guided to:
  Settings → Battery → App battery usage → Se-Q → No restrictions (or Unrestricted)
Consider adding a one-time prompt in the app's onboarding flow.
