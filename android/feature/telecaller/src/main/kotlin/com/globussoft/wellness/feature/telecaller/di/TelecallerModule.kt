package com.globussoft.wellness.feature.telecaller.di

import com.globussoft.wellness.feature.telecaller.data.repository.TelecallerRepositoryImpl
import com.globussoft.wellness.feature.telecaller.domain.repository.TelecallerRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for the telecaller feature module.
 *
 * Binds [TelecallerRepository] to its [TelecallerRepositoryImpl] production
 * implementation.  Installed in [SingletonComponent] so the repository and any
 * in-flight coroutines survive configuration changes.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class TelecallerModule {

    @Binds
    @Singleton
    abstract fun bindTelecallerRepository(impl: TelecallerRepositoryImpl): TelecallerRepository
}
