package com.globus.crm.feature.membership.data.repository

import com.globus.crm.core.network.WellnessApiService
import com.globus.crm.feature.membership.data.local.dao.MembershipDao
import com.globus.crm.feature.membership.data.mapper.toDomain
import com.globus.crm.feature.membership.data.mapper.toEntity
import com.globus.crm.feature.membership.domain.model.Membership
import com.globus.crm.feature.membership.domain.model.MembershipPlan
import com.globus.crm.feature.membership.domain.repository.MembershipRepository
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class MembershipRepositoryImpl @Inject constructor(
    private val api: WellnessApiService,
    private val dao: MembershipDao,
) : MembershipRepository {

    override suspend fun getMyMemberships(): List<Membership> {
        val response = api.getMyMemberships()
        if (!response.isSuccessful) throw HttpException(response)
        val memberships = response.body()!!.map { it.toDomain() }
        dao.insertAll(memberships.map { it.toEntity() })
        return memberships
    }

    override suspend fun getCachedMemberships(): List<Membership> =
        dao.getAll().map { it.toDomain() }

    override suspend fun getMembershipPlans(): List<MembershipPlan> {
        val response = api.getMembershipPlans()
        if (!response.isSuccessful) throw HttpException(response)
        return response.body()!!.map { it.toDomain() }
    }
}
