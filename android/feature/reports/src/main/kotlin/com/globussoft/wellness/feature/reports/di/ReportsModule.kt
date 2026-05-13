package com.globussoft.wellness.feature.reports.di

import com.globussoft.wellness.feature.reports.data.repository.ReportsRepositoryImpl
import com.globussoft.wellness.feature.reports.domain.repository.ReportsRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for the reports feature module.
 *
 * Binds the [ReportsRepository] interface to its [ReportsRepositoryImpl]
 * production implementation so that [ReportsViewModel] receives the concrete
 * class via constructor injection without hard-coding the dependency.
 *
 * Installed in [SingletonComponent] so the repository is a process-lifetime
 * singleton shared across any ViewModel that depends on it.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class ReportsModule {

    @Binds
    @Singleton
    abstract fun bindReportsRepository(impl: ReportsRepositoryImpl): ReportsRepository
}
