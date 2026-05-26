package com.seq.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * PanicDismissReceiver
 *
 * Receives the "Cancel" action from the shake heads-up notification.
 * Clears PREFS_KEY_PENDING so the JS bridge doesn't route to panic-shake
 * when the user dismisses the alert.
 */
class PanicDismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Log.d("SeQ_PanicDismiss", "User dismissed panic notification — clearing pending flag")
        context.getSharedPreferences(ShakeDetectionService.PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(ShakeDetectionService.PREFS_KEY_PENDING)
            .apply()

        // Also cancel the notification in case it wasn't auto-cancelled
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        nm.cancel(ShakeDetectionService.NOTIFICATION_ID_PANIC)
    }
}
