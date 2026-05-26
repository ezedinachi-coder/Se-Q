package com.seq.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * ShakeDetectionService
 *
 * Foreground service that detects shakes while the app is backgrounded or killed.
 * On trigger it:
 *  1. Writes PREFS_KEY_PENDING = true (consumed by JS via SeqPanicModule)
 *  2. Posts a HIGH-IMPORTANCE heads-up notification the user can tap to activate panic
 *     or swipe away to cancel. Auto-dismissed after NOTIFICATION_TIMEOUT_MS.
 *
 * This replaces the old approach of directly calling startActivity() from the service,
 * which is blocked by Android 10+ background activity restrictions.
 */
class ShakeDetectionService : android.app.Service(), SensorEventListener {

    companion object {
        // ── Channels ────────────────────────────────────────────────────────────
        const val CHANNEL_ID_SILENT   = "seq_service_channel"   // silent — ongoing service notif
        const val CHANNEL_ID_PANIC    = "seq_panic_channel"     // high-importance — shake alert

        const val NOTIFICATION_ID_SERVICE = 1002  // persistent silent notif (keeps service alive)
        const val NOTIFICATION_ID_PANIC   = 1003  // heads-up panic prompt

        // ── SharedPrefs keys ────────────────────────────────────────────────────
        const val PREFS_NAME             = "seq_panic_prefs"
        const val PREFS_KEY_PENDING      = "panic_pending"
        const val PREFS_KEY_PANIC_ACTIVE = "panic_active"

        // ── Shake algorithm ─────────────────────────────────────────────────────
        private const val REQUIRED_SHAKES = 5
        private const val WINDOW_MS       = 3000L
        private const val DEBOUNCE_MS     = 300L
        private const val THRESHOLD_MS2   = 12.0f   // net m/s² above gravity
        private const val COOLDOWN_MS     = 8000L

        // Auto-dismiss the panic heads-up notification after this many ms
        private const val NOTIFICATION_TIMEOUT_MS = 5000L

        private const val TAG = "SeQ_ShakeSvc"
    }

    private var sensorManager: SensorManager? = null
    private var accelerometer: Sensor? = null

    private val shakeTimestamps = mutableListOf<Long>()
    private var lastShakeMs     = 0L
    private var lastTriggerMs   = 0L

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        Log.d(TAG, "Service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "onStartCommand — starting foreground")
        startForeground(NOTIFICATION_ID_SERVICE, buildServiceNotification())
        accelerometer?.let {
            sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_UI)
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?) = null

    override fun onDestroy() {
        super.onDestroy()
        sensorManager?.unregisterListener(this)
        Log.d(TAG, "Service destroyed")
    }

    // ── Sensor callbacks ───────────────────────────────────────────────────────

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    override fun onSensorChanged(event: SensorEvent?) {
        event?.takeIf { it.sensor.type == Sensor.TYPE_ACCELEROMETER } ?: return

        val x = event.values[0]; val y = event.values[1]; val z = event.values[2]
        val netAcc = Math.sqrt((x*x + y*y + z*z).toDouble()).toFloat() - SensorManager.GRAVITY_EARTH

        if (netAcc < THRESHOLD_MS2) return

        val now = System.currentTimeMillis()
        if (now - lastTriggerMs < COOLDOWN_MS) return
        if (now - lastShakeMs   < DEBOUNCE_MS) return
        lastShakeMs = now

        shakeTimestamps.removeAll { now - it > WINDOW_MS }
        shakeTimestamps.add(now)

        Log.d(TAG, "Shake #${shakeTimestamps.size} (net=${String.format("%.1f", netAcc)} m/s²)")

        if (shakeTimestamps.size >= REQUIRED_SHAKES) {
            shakeTimestamps.clear()
            lastTriggerMs = now
            triggerPanic()
        }
    }

    // ── Panic trigger ──────────────────────────────────────────────────────────

    private fun triggerPanic() {
        // Skip if a panic is already active
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (prefs.getBoolean(PREFS_KEY_PANIC_ACTIVE, false)) {
            Log.d(TAG, "Panic already active — ignoring shake")
            return
        }

        Log.d(TAG, "PANIC TRIGGERED — writing prefs and posting heads-up notification")
        prefs.edit().putBoolean(PREFS_KEY_PENDING, true).apply()

        postPanicNotification()
    }

    /**
     * Post a full-screen / heads-up notification.
     * Tapping it opens MainActivity with seq_action=panic (reads flag → routes to panic-shake).
     * The notification auto-cancels after NOTIFICATION_TIMEOUT_MS via a delayed handler.
     */
    private fun postPanicNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // TAP intent — opens app and triggers panic-shake screen
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            putExtra("seq_action", "panic")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val tapPi = PendingIntent.getActivity(
            this, 0, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // DISMISS intent — clears the pending flag so panic is cancelled
        val dismissIntent = Intent(this, PanicDismissReceiver::class.java)
        val dismissPi = PendingIntent.getBroadcast(
            this, 0, dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID_PANIC)
            .setContentTitle("🚨 Emergency Detected")
            .setContentText("Tap to activate — swipe away to cancel")
            .setSmallIcon(R.drawable.notification_icon)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setTimeoutAfter(NOTIFICATION_TIMEOUT_MS)
            .setContentIntent(tapPi)
            .addAction(0, "Cancel", dismissPi)
            .setFullScreenIntent(tapPi, true)   // shows as heads-up even when screen is off
            .setVibrate(longArrayOf(0, 300, 100, 300))
            .build()

        nm.notify(NOTIFICATION_ID_PANIC, notification)

        // Auto-dismiss + clear pending flag after timeout
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            nm.cancel(NOTIFICATION_ID_PANIC)
            // Only clear pending if app hasn't consumed it yet
            val p = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            if (p.getBoolean(PREFS_KEY_PENDING, false)) {
                Log.d(TAG, "Notification timed out — clearing pending flag")
                p.edit().remove(PREFS_KEY_PENDING).apply()
            }
        }, NOTIFICATION_TIMEOUT_MS)
    }

    // ── Notification channels ──────────────────────────────────────────────────

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // 1. Silent channel — for the persistent "service running" notification
        if (nm.getNotificationChannel(CHANNEL_ID_SILENT) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID_SILENT,
                    "Se-Q Background Service",
                    NotificationManager.IMPORTANCE_MIN
                ).apply {
                    description = "Shake detection running"
                    enableVibration(false)
                    setSound(null, null)
                    setShowBadge(false)
                }
            )
        }

        // 2. High-importance channel — for the shake-triggered heads-up alert
        if (nm.getNotificationChannel(CHANNEL_ID_PANIC) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID_PANIC,
                    "Se-Q Emergency Alerts",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Shake-triggered emergency prompts"
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 300, 100, 300)
                    setBypassDnd(true)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                }
            )
        }
    }

    private fun buildServiceNotification() = NotificationCompat.Builder(this, CHANNEL_ID_SILENT)
        .setContentTitle("Se-Q")
        .setContentText("Protection active")
        .setSmallIcon(R.drawable.notification_icon)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .setSilent(true)
        .setOngoing(true)
        .build()
}
