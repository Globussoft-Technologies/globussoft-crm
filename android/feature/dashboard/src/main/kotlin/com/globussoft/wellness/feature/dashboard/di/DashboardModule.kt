package com.globussoft.wellness.feature.dashboard.di

import com.globussoft.wellness.feature.dashboard.data.repository.DashboardRepositoryImpl
import com.globussoft.wellness.feature.dashboard.domain.repository.DashboardRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for the dashboard feature module.
 *
 * Binds [DashboardRepository] to its [DashboardRepositoryImpl] production
 * implementation so that ViewModels in the presentation layer (and any future
 * use cases) receive the concrete class via constructor injection without
 * hard-coding the dependency.
 *
 * Installed in [SingletonComponent] so the repository is shared across all
 * dashboard-related ViewModels for the lifetime of the application process.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class DashboardModule {

    @Binds
    @Singleton
    abstract fun bindDashboardRepository(impl: DashboardRepositoryImpl): DashboardRepository
}
