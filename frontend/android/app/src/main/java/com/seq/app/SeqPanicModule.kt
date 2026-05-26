package com.seq.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class SeqPanicModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "SeqPanicModule"
    }

    override fun getName(): String = "SeqPanic"

    // ── Check & consume the pending-panic flag written by ShakeDetectionService ─

    @ReactMethod
    fun checkAndConsumePanic(promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences(
                ShakeDetectionService.PREFS_NAME, Context.MODE_PRIVATE
            )
            val pending = prefs.getBoolean(ShakeDetectionService.PREFS_KEY_PENDING, false)
            if (pending) {
                prefs.edit().remove(ShakeDetectionService.PREFS_KEY_PENDING).apply()
                Log.d(TAG, "Consumed pending panic flag")
            }
            promise.resolve(pending)
        } catch (e: Exception) {
            Log.e(TAG, "checkAndConsumePanic error: ${e.message}")
            promise.resolve(false)
        }
    }

    // ── Let JS tell the native service whether a panic is already active ───────

    @ReactMethod
    fun setPanicActive(active: Boolean, promise: Promise?) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences(
                ShakeDetectionService.PREFS_NAME, Context.MODE_PRIVATE
            )
            prefs.edit()
                .putBoolean(ShakeDetectionService.PREFS_KEY_PANIC_ACTIVE, active)
                .apply()
            Log.d(TAG, "setPanicActive: $active")
            promise?.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "setPanicActive error: ${e.message}")
            promise?.resolve(false)
        }
    }

    // ── Start ShakeDetectionService ────────────────────────────────────────────

    @ReactMethod
    fun startShakeService(promise: Promise) {
        try {
            val ctx    = reactApplicationContext
            val intent = Intent(ctx, ShakeDetectionService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
            Log.d(TAG, "ShakeDetectionService started from JS")
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "startShakeService error: ${e.message}")
            promise.resolve(false)
        }
    }

    // ── Check if battery optimization is already disabled ─────────────────────

    @ReactMethod
    fun isIgnoringBatteryOptimizations(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val pm = reactApplicationContext
                    .getSystemService(Context.POWER_SERVICE) as PowerManager
                promise.resolve(pm.isIgnoringBatteryOptimizations(
                    reactApplicationContext.packageName
                ))
            } else {
                promise.resolve(true)
            }
        } catch (e: Exception) {
            Log.e(TAG, "isIgnoringBatteryOptimizations error: ${e.message}")
            promise.resolve(false)
        }
    }

    // ── Open the battery optimization exemption dialog directly ───────────────
    // This uses the correct Android intent. No Linking gymnastics needed.

    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val intent = Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:${reactApplicationContext.packageName}")
                ).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactApplicationContext.startActivity(intent)
                promise.resolve(true)
            } else {
                promise.resolve(true) // Not needed below API 23
            }
        } catch (e: Exception) {
            // Fallback: open the general battery optimization settings list
            try {
                val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactApplicationContext.startActivity(fallback)
                promise.resolve(true)
            } catch (e2: Exception) {
                Log.e(TAG, "requestIgnoreBatteryOptimizations error: ${e2.message}")
                promise.resolve(false)
            }
        }
    }
}
