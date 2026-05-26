package com.seq.app

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * BootRestartService
 *
 * Short-lived service that runs on boot to kick off ShakeDetectionService.
 * Uses the same SILENT channel as ShakeDetectionService so it doesn't
 * conflict with or override the panic alert channel configuration.
 */
class BootRestartService : android.app.Service() {

    override fun onCreate() {
        super.onCreate()
        // Channel is already created by ShakeDetectionService; we just reference it.
        // If ShakeDetectionService hasn't run yet, create the silent channel here too.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(ShakeDetectionService.CHANNEL_ID_SILENT) == null) {
                val ch = android.app.NotificationChannel(
                    ShakeDetectionService.CHANNEL_ID_SILENT,
                    "Se-Q Background Service",
                    NotificationManager.IMPORTANCE_MIN
                ).apply {
                    enableVibration(false)
                    setSound(null, null)
                    setShowBadge(false)
                }
                nm.createNotificationChannel(ch)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = NotificationCompat.Builder(this, ShakeDetectionService.CHANNEL_ID_SILENT)
            .setContentTitle("Se-Q")
            .setContentText("Starting protection...")
            .setSmallIcon(R.drawable.notification_icon)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setSilent(true)
            .setOngoing(false)
            .build()

        startForeground(1001, notification)

        // Start the actual shake detection service
        val shakeIntent = Intent(this, ShakeDetectionService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(shakeIntent)
        } else {
            startService(shakeIntent)
        }

        stopSelf()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?) = null
}
