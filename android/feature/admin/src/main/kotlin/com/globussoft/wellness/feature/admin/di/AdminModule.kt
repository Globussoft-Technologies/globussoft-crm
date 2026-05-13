package com.globussoft.wellness.feature.admin.di

import com.globussoft.wellness.feature.admin.data.repository.AdminRepositoryImpl
import com.globussoft.wellness.feature.admin.domain.repository.AdminRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for the admin feature module.
 *
 * Binds [AdminRepository] to its [AdminRepositoryImpl] production implementation
 * so that both [LocationsViewModel] and [DrugsViewModel] receive the same
 * repository singleton via constructor injection.
 *
 * Installed in [SingletonComponent] so the binding outlives any configuration
 * change while the admin screens are active.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class AdminModule {

    @Binds
    @Singleton
    abstract fun bindAdminRepository(impl: AdminRepositoryImpl): AdminRepository
}
