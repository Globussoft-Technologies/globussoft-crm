package com.globus.crm.feature.dashboard.domain.repository

import com.globus.crm.feature.dashboard.domain.model.Dashboard

interface DashboardRepository {
    suspend fun getDashboard(): Dashboard
}
