package com.globussoft.wellness.feature.settings.di

import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

/**
 * Hilt module for the settings feature module.
 *
 * [SettingsViewModel] uses [AuthDataStore] directly (bound in [core:data]'s
 * [DataModule] as a [SingletonComponent] singleton) rather than introducing a
 * separate repository interface.  This module is therefore intentionally empty —
 * it exists as a placeholder so the feature can add its own bindings in future
 * (e.g. a NotificationPreferencesRepository, ThemeRepository, etc.) without
 * restructuring the module graph.
 *
 * Installed in [SingletonComponent] to match the component where [AuthDataStore]
 * is already bound.
 */
@Module
@InstallIn(SingletonComponent::class)
object SettingsModule
