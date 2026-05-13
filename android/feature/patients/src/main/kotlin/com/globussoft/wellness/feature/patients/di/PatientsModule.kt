package com.globussoft.wellness.feature.patients.di

import com.globussoft.wellness.feature.patients.data.repository.PatientsRepositoryImpl
import com.globussoft.wellness.feature.patients.domain.repository.PatientsRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for the patients feature module.
 *
 * Binds [PatientsRepository] to its [PatientsRepositoryImpl] production
 * implementation. Installed in [SingletonComponent] so the repository and its
 * Room + network dependencies are shared across all patients-related ViewModels
 * for the lifetime of the application process.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class PatientsModule {

    @Binds
    @Singleton
    abstract fun bindPatientsRepository(impl: PatientsRepositoryImpl): PatientsRepository
}
