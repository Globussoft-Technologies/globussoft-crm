package com.globus.crm.feature.loyalty.domain.repository

import com.globus.crm.feature.loyalty.domain.model.LoyaltyData

interface LoyaltyRepository {
    suspend fun getLoyalty(): LoyaltyData
}
