package com.globussoft.wellness.core.database

import androidx.room.Database
import androidx.room.RoomDatabase
import com.globussoft.wellness.core.database.dao.PatientDao
import com.globussoft.wellness.core.database.dao.VisitDao
import com.globussoft.wellness.core.database.entity.PatientEntity
import com.globussoft.wellness.core.database.entity.VisitEntity

/**
 * Room database for the Globussoft Wellness CRM Android app.
 *
 * Registered entities:
 * - [PatientEntity] — offline patient cache (table: "patients")
 * - [VisitEntity]   — today's calendar visit cache (table: "visits")
 *
 * [exportSchema] is false because this database is a disposable local cache;
 * schema migrations between versions use [fallbackToDestructiveMigration] in
 * the [DatabaseModule] builder so the cache is simply rebuilt from the server
 * rather than running complex migration SQL.
 *
 * Version history:
 * - v1 (initial): patients + visits tables.
 */
@Database(
    entities = [
        PatientEntity::class,
        VisitEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class WellnessDatabase : RoomDatabase() {

    /** Returns the [PatientDao] for patient cache operations. */
    abstract fun patientDao(): PatientDao

    /** Returns the [VisitDao] for visit / appointment cache operations. */
    abstract fun visitDao(): VisitDao
}
