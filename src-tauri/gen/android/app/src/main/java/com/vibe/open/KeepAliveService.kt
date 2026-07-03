package com.vibe.open

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class KeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }

    val channelId = ensureChannel()
    val notification = buildNotification(channelId)
    startForeground(NOTIFICATION_ID, notification)
    return START_STICKY
  }

  private fun ensureChannel(): String {
    val channelId = CHANNEL_ID
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      val channel =
          NotificationChannel(
              channelId,
              "Vibe connection",
              NotificationManager.IMPORTANCE_LOW,
          )
      manager.createNotificationChannel(channel)
    }
    return channelId
  }

  private fun buildNotification(channelId: String): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pendingIntent =
        PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    return NotificationCompat.Builder(this, channelId)
        .setContentTitle("Vibe")
        .setContentText("Staying connected for your chats")
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentIntent(pendingIntent)
        .setOngoing(true)
        .build()
  }

  companion object {
    private const val CHANNEL_ID = "vibe_keep_alive"
    private const val NOTIFICATION_ID = 42
    private const val ACTION_STOP = "com.vibe.open.KEEP_ALIVE_STOP"

    fun start(context: Context) {
      val intent = Intent(context, KeepAliveService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      val intent = Intent(context, KeepAliveService::class.java).apply { action = ACTION_STOP }
      context.startService(intent)
    }
  }
}
