package com.globussoft.wellness.feature.services.di

import com.globussoft.wellness.feature.services.data.repository.ServicesRepositoryImpl
import com.globussoft.wellness.feature.services.domain.repository.ServicesRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for the services feature module.
 *
 * Binds [ServicesRepository] to its [ServicesRepositoryImpl] production
 * implementation. Installed in [SingletonComponent] so the repository and its
 * [com.globussoft.wellness.core.network.api.WellnessApi] dependency are shared
 * for the lifetime of the application process.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class ServicesModule {

    @Binds
    @Singleton
    abstract fun bindServicesRepository(
        impl: ServicesRepositoryImpl,
    ): ServicesRepository
}
