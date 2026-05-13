package com.globussoft.wellness.feature.finance.di

import com.globussoft.wellness.feature.finance.data.repository.FinanceRepositoryImpl
import com.globussoft.wellness.feature.finance.domain.repository.FinanceRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for the finance feature module.
 *
 * Binds [FinanceRepository] to its [FinanceRepositoryImpl] production
 * implementation.  Installed in [SingletonComponent] so the repository and its
 * [WellnessApi] dependency are shared across all finance ViewModels for the
 * lifetime of the application process.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class FinanceModule {

    @Binds
    @Singleton
    abstract fun bindFinanceRepository(impl: FinanceRepositoryImpl): FinanceRepository
}
