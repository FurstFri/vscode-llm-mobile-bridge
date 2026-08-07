package com.furstfri.llmmobilebridge

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Two channels: a quiet one for the always-on connection status, and an
 * alerting one for questions and approvals the machine is blocking on.
 */
object BridgeNotifications {
    const val STATUS_CHANNEL = "bridge_status"
    const val PROMPT_CHANNEL = "bridge_prompts"
    const val STATUS_NOTIFICATION_ID = 1

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(
                STATUS_CHANNEL,
                "Состояние моста",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Постоянное уведомление о подключении к VS Code." },
        )
        manager.createNotificationChannel(
            NotificationChannel(
                PROMPT_CHANNEL,
                "Вопросы и апрувы",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = "Агент ждёт ответа или подтверждения." },
        )
    }

    fun status(context: Context, connected: Int, total: Int, pending: Int): Notification {
        val text = when {
            total == 0 -> "Нет подключений"
            pending > 0 -> "Ожидают ответа: $pending"
            else -> "Подключено $connected из $total"
        }
        return NotificationCompat.Builder(context, STATUS_CHANNEL)
            .setSmallIcon(R.drawable.ic_bridge)
            .setContentTitle("LLM Mobile Bridge")
            .setContentText(text)
            .setContentIntent(openIntent(context, null))
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    fun prompt(context: Context, prompt: PendingPrompt): Notification =
        NotificationCompat.Builder(context, PROMPT_CHANNEL)
            .setSmallIcon(R.drawable.ic_bridge)
            .setContentTitle(
                if (prompt.kind == "question") "Нужен ответ · ${prompt.hostName}"
                else "Нужен апрув · ${prompt.hostName}",
            )
            .setContentText(prompt.title)
            .setStyle(NotificationCompat.BigTextStyle().bigText(prompt.title))
            .setContentIntent(openIntent(context, prompt))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

    fun notificationId(prompt: PendingPrompt): Int = prompt.approvalId.hashCode()

    /** Posting is best effort: the user may have denied the runtime permission. */
    @SuppressLint("MissingPermission")
    fun post(context: Context, id: Int, notification: Notification) {
        runCatching { NotificationManagerCompat.from(context).notify(id, notification) }
    }

    fun cancel(context: Context, id: Int) {
        runCatching { NotificationManagerCompat.from(context).cancel(id) }
    }

    private fun openIntent(context: Context, prompt: PendingPrompt?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (prompt != null) {
            intent.putExtra(MainActivity.EXTRA_HOST_ID, prompt.hostId)
            intent.putExtra(MainActivity.EXTRA_SESSION_REF, prompt.sessionRef)
        }
        return PendingIntent.getActivity(
            context,
            prompt?.let(::notificationId) ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
