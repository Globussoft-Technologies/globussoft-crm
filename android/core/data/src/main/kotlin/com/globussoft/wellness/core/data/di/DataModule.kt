package com.globussoft.wellness.core.data.di

import com.globussoft.wellness.core.data.datastore.AuthDataStore
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/**
 * Hilt module for data-layer singletons.
 *
 * [AuthDataStore] is annotated with [@Singleton][javax.inject.Singleton] and
 * uses constructor injection, so Hilt resolves it automatically without an
 * explicit [@Provides][dagger.Provides] binding. This module is retained as
 * the canonical installation point for future data-layer providers (e.g.
 * repository bindings when interface/implementation pairs are introduced).
 */
@Module
@InstallIn(SingletonComponent::class)
object DataModule
