package com.seq.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log

/**
 * BootReceiver.kt
 *
 * Listens for BOOT_COMPLETED (and HTC/OEM QUICKBOOT_POWERON).
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return

        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != "android.intent.action.QUICKBOOT_POWERON") {
            return
        }

        Log.d("SeQ_BootReceiver", "Boot completed — starting Se-Q services")

        val shakeIntent = Intent(context, ShakeDetectionService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(shakeIntent)
        } else {
            context.startService(shakeIntent)
        }
        Log.d("SeQ_BootReceiver", "ShakeDetectionService started")

        val restoreIntent = Intent(context, BootRestartService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(restoreIntent)
        } else {
            context.startService(restoreIntent)
        }
        Log.d("SeQ_BootReceiver", "BootRestartService started")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val pendingIntent = PendingIntent.getService(
                context, 0, shakeIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            alarmManager.setExactAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + 60000,
                pendingIntent
            )
        }
    }
}
