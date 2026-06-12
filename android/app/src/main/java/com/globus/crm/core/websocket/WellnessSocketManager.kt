package com.globus.crm.core.websocket

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.globus.crm.BuildConfig
import com.globus.crm.MainActivity
import com.globus.crm.R
import com.globus.crm.core.network.TokenManager
import com.globus.crm.feature.notifications.domain.model.Notification
import com.globus.crm.feature.notifications.domain.repository.NotificationRepository
import dagger.hilt.android.qualifiers.ApplicationContext
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class WellnessSocketManager @Inject constructor(
    private val tokenManager: TokenManager,
    private val notificationRepository: NotificationRepository,
    @ApplicationContext private val context: Context,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var socket: Socket? = null

    init {
        scope.launch {
            tokenManager.tokenFlow()
                .distinctUntilChanged()
                .collect { token ->
                    if (!token.isNullOrBlank()) connect(token)
                    else if (socket?.connected() == true) disconnect()
                }
        }
    }

    private fun connect(token: String) {
        if (socket?.connected() == true) return
        try {
            val serverUrl = BuildConfig.BASE_URL.substringBefore("/api/")
            val options = IO.Options.builder()
                .setAuth(mapOf("token" to token))
                .setReconnection(true)
                .setReconnectionAttempts(Int.MAX_VALUE)
                .setReconnectionDelay(3000)
                .build()
            socket = IO.socket(serverUrl, options)
            socket?.on("notification_new") { args ->
                val data = args.getOrNull(0) as? JSONObject ?: return@on
                scope.launch { handleNotification(data) }
            }
            socket?.connect()
        } catch (_: Exception) {
            // Connection failure is non-fatal; REST sync catches up on next open.
        }
    }

    fun disconnect() {
        socket?.off()
        socket?.disconnect()
        socket = null
    }

    private suspend fun handleNotification(data: JSONObject) {
        val id = data.optInt("id", 0).toString()
        val notification = Notification(
            id = id,
            type = data.optString("type", "info"),
            title = data.optString("title", ""),
            body = data.optString("message", ""),
            screen = linkToScreen(data.optString("link", null)),
            entityId = data.optInt("entityId", -1).takeIf { it != -1 }?.toString(),
            isRead = false,
            receivedAt = parseDate(data.optString("createdAt", null)),
        )
        notificationRepository.insert(notification)
        showSystemNotification(
            notification = notification,
            entityType = data.optString("entityType", null),
            priority = data.optString("priority", "normal"),
        )
    }

    @SuppressLint("MissingPermission")
    private fun showSystemNotification(notification: Notification, entityType: String?, priority: String?) {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            notification.id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(context, channelForType(entityType, priority))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notification.title)
            .setContentText(notification.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notification.body))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
        NotificationManagerCompat.from(context).notify(notification.id.hashCode(), builder.build())
    }

    private fun linkToScreen(link: String?): String? = when {
        link == null -> null
        link.startsWith("/appointments") -> "appointments"
        link.startsWith("/prescriptions") -> "prescriptions"
        link.startsWith("/wallet") -> "wallet"
        link.startsWith("/memberships") -> "memberships"
        link.startsWith("/book") -> "book"
        else -> null
    }

    private fun channelForType(entityType: String?, priority: String?): String = when {
        entityType == "Appointment" -> "wellness_reminders"
        entityType == "Prescription" -> "wellness_health"
        entityType == "Wallet" || entityType == "Payment" -> "wellness_wallet"
        priority == "high" || priority == "urgent" -> "wellness_reminders"
        else -> "wellness_health"
    }

    private fun parseDate(dateStr: String?): Long = runCatching {
        if (!dateStr.isNullOrBlank()) Instant.parse(dateStr).toEpochMilli()
        else System.currentTimeMillis()
    }.getOrDefault(System.currentTimeMillis())
}
