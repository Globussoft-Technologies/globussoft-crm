package com.globus.crm.feature.notifications.domain.usecase

import com.globus.crm.core.network.WellnessApiService
import com.globus.crm.core.util.Result
import com.globus.crm.feature.notifications.data.mapper.toDomain
import com.globus.crm.feature.notifications.data.mapper.toEntity
import com.globus.crm.feature.notifications.domain.repository.NotificationRepository
import java.io.IOException
import javax.inject.Inject

class SyncPortalNotificationsUseCase @Inject constructor(
    private val repository: NotificationRepository,
    private val apiService: WellnessApiService,
) {
    suspend operator fun invoke(): Result<Int> = try {
        val response = apiService.getPortalNotifications()
        if (response.isSuccessful) {
            val dtos = response.body()?.notifications ?: emptyList()
            dtos.forEach { dto -> repository.insert(dto.toDomain()) }
            Result.Success(dtos.size)
        } else {
            Result.Error("HTTP_${response.code()}", "Sync failed")
        }
    } catch (_: IOException) {
        Result.Error("NETWORK_ERROR", "Offline — showing cached notifications")
    } catch (_: Exception) {
        Result.Error("SYNC_ERROR", "Could not sync notifications")
    }
}
