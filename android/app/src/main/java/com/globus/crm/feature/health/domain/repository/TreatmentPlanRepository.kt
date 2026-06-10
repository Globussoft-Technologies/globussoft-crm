package com.globus.crm.feature.health.domain.repository

import com.globus.crm.feature.health.domain.model.TreatmentPlan

interface TreatmentPlanRepository {
    suspend fun getTreatmentPlans(): List<TreatmentPlan>
}
