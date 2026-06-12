package com.globus.crm.feature.membership.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "cached_memberships")
data class CachedMembership(
    @PrimaryKey val id: Int,
    val status: String,
    val startDate: Long,
    val endDate: Long,
    val daysLeft: Int,
    val planName: String,
    val planPrice: Double,
    val planCurrency: String,
    val creditsJson: String,
    val historyJson: String,
    val cachedAt: Long,
)
