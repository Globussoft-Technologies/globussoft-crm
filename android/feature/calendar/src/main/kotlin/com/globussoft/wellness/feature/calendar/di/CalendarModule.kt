package com.globussoft.wellness.feature.calendar.di

import com.globussoft.wellness.feature.calendar.data.repository.CalendarRepositoryImpl
import com.globussoft.wellness.feature.calendar.domain.repository.CalendarRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for the calendar feature module.
 *
 * Binds [CalendarRepository] to its [CalendarRepositoryImpl] production
 * implementation. Installed in [SingletonComponent] so the repository and its
 * [com.globussoft.wellness.core.network.api.WellnessApi] dependency are shared
 * for the lifetime of the application process — consistent with how the patients
 * and dashboard modules wire their repositories.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class CalendarModule {

    @Binds
    @Singleton
    abstract fun bindCalendarRepository(
        impl: CalendarRepositoryImpl,
    ): CalendarRepository
}
