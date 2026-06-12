package com.globus.crm.feature.dashboard.data.repository

import com.globus.crm.core.network.WellnessApiService
import com.globus.crm.core.storage.EncryptedPrefsManager
import com.globus.crm.feature.dashboard.domain.model.Dashboard
import com.globus.crm.feature.dashboard.domain.model.UpcomingVisit
import com.globus.crm.feature.dashboard.domain.repository.DashboardRepository
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class DashboardRepositoryImpl @Inject constructor(
    private val api: WellnessApiService,
    private val encryptedPrefs: EncryptedPrefsManager,
) : DashboardRepository {

    override suspend fun getDashboard(): Dashboard = coroutineScope {
        val visitsDeferred = async {
            runCatching { api.getVisits(upcoming = true).body() }.getOrNull()
        }
        val transactionsDeferred = async {
            runCatching { api.getMyTransactions().body() }.getOrNull()
        }
        val membershipsDeferred = async {
            runCatching { api.getMyMemberships().body() }.getOrNull()
        }
        val loyaltyDeferred = async {
            val patientId = encryptedPrefs.getPatientId() ?: return@async null
            runCatching { api.getLoyalty(patientId).body() }.getOrNull()
        }

        val visits = visitsDeferred.await()
        val txSummary = transactionsDeferred.await()
        val memberships = membershipsDeferred.await()
        val loyalty = loyaltyDeferred.await()

        val nextVisit = visits?.firstOrNull()?.let { v ->
            UpcomingVisit(
                id = v.id,
                visitDate = v.visitDate,
                serviceName = v.service?.name,
                doctorName = v.doctor?.name,
                status = v.status,
            )
        }

        Dashboard(
            patientName = encryptedPrefs.getUserName() ?: "Patient",
            nextVisit = nextVisit,
            walletBalance = txSummary?.summary?.walletBalance?.toLong(),
            walletCurrency = txSummary?.currency,
            activeMembershipCount = memberships?.count { it.status == "active" } ?: 0,
            loyaltyPoints = loyalty?.balance,
        )
    }
}
