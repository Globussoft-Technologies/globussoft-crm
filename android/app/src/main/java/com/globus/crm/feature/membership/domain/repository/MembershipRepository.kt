package com.globus.crm.feature.membership.domain.repository

import com.globus.crm.feature.membership.domain.model.Membership
import com.globus.crm.feature.membership.domain.model.MembershipPlan

interface MembershipRepository {
    suspend fun getMyMemberships(): List<Membership>
    suspend fun getCachedMemberships(): List<Membership>
    suspend fun getMembershipPlans(): List<MembershipPlan>
}
