package com.globussoft.wellness.feature.visits.di

import com.globussoft.wellness.feature.visits.data.repository.VisitsRepositoryImpl
import com.globussoft.wellness.feature.visits.domain.repository.VisitsRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for the visits feature module.
 *
 * Binds [VisitsRepository] to its [VisitsRepositoryImpl] production
 * implementation.  Installed in [SingletonComponent] so the repository and its
 * [WellnessApi] dependency are shared across all visits ViewModels (Visits,
 * Attendance, Leave) for the lifetime of the application process.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class VisitsModule {

    @Binds
    @Singleton
    abstract fun bindVisitsRepository(impl: VisitsRepositoryImpl): VisitsRepository
}
