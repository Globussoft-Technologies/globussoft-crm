package com.globussoft.wellness.feature.auth.di

import com.globussoft.wellness.feature.auth.data.repository.AuthRepository
import com.globussoft.wellness.feature.auth.data.repository.AuthRepositoryImpl
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module for the auth feature module.
 *
 * Binds the [AuthRepository] interface to its [AuthRepositoryImpl] production
 * implementation so that [LoginUseCase] and any future use cases in this module
 * receive the concrete class without hard-coding the dependency.
 *
 * Installed in [SingletonComponent] so the repository (and its DataStore state)
 * survives for the entire app lifetime — necessary for the token flow to keep
 * emitting across navigation destinations.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class AuthModule {

    @Binds
    @Singleton
    abstract fun bindAuthRepository(impl: AuthRepositoryImpl): AuthRepository
}
