package com.globussoft.wellness.feature.crm.di

import com.globussoft.wellness.core.data.datastore.AuthDataStore
import com.globussoft.wellness.core.database.dao.CrmContactDao
import com.globussoft.wellness.core.database.dao.CrmDealDao
import com.globussoft.wellness.core.database.dao.CrmTaskDao
import com.globussoft.wellness.core.database.dao.CrmTicketDao
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.feature.crm.data.repository.CrmRepositoryImpl
import com.globussoft.wellness.feature.crm.domain.repository.CrmRepository
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object CrmModule {

    @Provides
    @Singleton
    fun provideCrmRepository(
        api:           WellnessApi,
        contactDao:    CrmContactDao,
        dealDao:       CrmDealDao,
        taskDao:       CrmTaskDao,
        ticketDao:     CrmTicketDao,
        authDataStore: AuthDataStore,
    ): CrmRepository = CrmRepositoryImpl(
        api           = api,
        contactDao    = contactDao,
        dealDao       = dealDao,
        taskDao       = taskDao,
        ticketDao     = ticketDao,
        authDataStore = authDataStore,
    )
}
