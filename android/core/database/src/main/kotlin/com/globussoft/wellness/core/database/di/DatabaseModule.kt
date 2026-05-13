package com.globussoft.wellness.core.database.di

import android.content.Context
import androidx.room.Room
import com.globussoft.wellness.core.database.WellnessDatabase
import com.globussoft.wellness.core.database.dao.PatientDao
import com.globussoft.wellness.core.database.dao.VisitDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt module that provides the Room database and its DAOs as singletons.
 *
 * [fallbackToDestructiveMigration] is intentional — the local database is a
 * cache of server data, so destroying and rebuilding it on a schema version
 * bump is safe and far simpler than maintaining migration SQL scripts.
 * The worst-case user experience is a slightly longer initial load time after
 * an app update while the cache is repopulated from the API.
 *
 * The database filename "wellness_crm.db" is stable across releases so that
 * Android Backup & Restore can include the cache in device backups if the app
 * opts into it in the future.
 */
@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideWellnessDatabase(
        @ApplicationContext context: Context,
    ): WellnessDatabase = Room.databaseBuilder(
        context,
        WellnessDatabase::class.java,
        "wellness_crm.db",
    )
        .fallbackToDestructiveMigration()
        .build()

    @Provides
    @Singleton
    fun providePatientDao(database: WellnessDatabase): PatientDao =
        database.patientDao()

    @Provides
    @Singleton
    fun provideVisitDao(database: WellnessDatabase): VisitDao =
        database.visitDao()
}
