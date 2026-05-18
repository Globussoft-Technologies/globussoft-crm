package com.globussoft.wellness.core.database

import androidx.room.Database
import androidx.room.RoomDatabase
import com.globussoft.wellness.core.database.dao.CrmContactDao
import com.globussoft.wellness.core.database.dao.CrmDealDao
import com.globussoft.wellness.core.database.dao.CrmTaskDao
import com.globussoft.wellness.core.database.dao.CrmTicketDao
import com.globussoft.wellness.core.database.dao.PatientDao
import com.globussoft.wellness.core.database.dao.VisitDao
import com.globussoft.wellness.core.database.entity.CrmContactEntity
import com.globussoft.wellness.core.database.entity.CrmDealEntity
import com.globussoft.wellness.core.database.entity.CrmTaskEntity
import com.globussoft.wellness.core.database.entity.CrmTicketEntity
import com.globussoft.wellness.core.database.entity.PatientEntity
import com.globussoft.wellness.core.database.entity.VisitEntity

/**
 * Room database for the Globussoft Wellness CRM Android app.
 *
 * [exportSchema] is false — this is a disposable server cache;
 * [fallbackToDestructiveMigration] in [DatabaseModule] rebuilds it on upgrade.
 *
 * Version history:
 * - v1: patients + visits tables (Wellness vertical cache)
 * - v2: crm_contacts, crm_deals, crm_tasks, crm_tickets (Generic CRM cache)
 */
@Database(
    entities = [
        PatientEntity::class,
        VisitEntity::class,
        CrmContactEntity::class,
        CrmDealEntity::class,
        CrmTaskEntity::class,
        CrmTicketEntity::class,
    ],
    version = 2,
    exportSchema = false,
)
abstract class WellnessDatabase : RoomDatabase() {

    abstract fun patientDao(): PatientDao
    abstract fun visitDao(): VisitDao

    abstract fun crmContactDao(): CrmContactDao
    abstract fun crmDealDao(): CrmDealDao
    abstract fun crmTaskDao(): CrmTaskDao
    abstract fun crmTicketDao(): CrmTicketDao
}
