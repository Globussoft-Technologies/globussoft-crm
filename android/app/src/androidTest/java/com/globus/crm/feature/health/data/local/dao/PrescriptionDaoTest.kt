package com.globus.crm.feature.health.data.local.dao

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.globus.crm.core.database.AppDatabase
import com.globus.crm.feature.health.data.local.entity.CachedPrescription
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrescriptionDaoTest {

    private lateinit var db: AppDatabase
    private lateinit var dao: PrescriptionDao

    private val baseRx = CachedPrescription(
        id = 1,
        visitId = 10,
        visitDate = 1_000L,
        doctorName = "Dr. Test",
        serviceName = null,
        drugCount = 2,
        pdfBytes = byteArrayOf(1, 2, 3),
        pdfCachedAt = 500L,
        cachedAt = 1_000L,
    )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            AppDatabase::class.java,
        ).allowMainThreadQueries().build()
        dao = db.prescriptionDao()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun insertAll_then_getAll_returns_all_prescriptions() = runBlocking {
        val second = baseRx.copy(id = 2, visitDate = 2_000L, cachedAt = 2_000L)
        dao.insertAll(listOf(baseRx, second))

        val all = dao.getAll() // ordered by visitDate DESC

        assertEquals(2, all.size)
        assertEquals(2, all[0].id) // newest first
        assertEquals(1, all[1].id)
    }

    @Test
    fun insert_then_getById_returns_correct_prescription() = runBlocking {
        dao.insert(baseRx)

        val result = dao.getById(1)

        assertNotNull(result)
        assertEquals(1, result!!.id)
        assertEquals("Dr. Test", result.doctorName)
        assertEquals(2, result.drugCount)
    }

    @Test
    fun evictStalePdfs_nulls_bytes_for_stale_keeps_fresh() = runBlocking {
        val fresh = baseRx.copy(id = 2, pdfCachedAt = 9_000L, visitDate = 2_000L, cachedAt = 2_000L)
        dao.insertAll(listOf(baseRx, fresh))

        // evict anything with pdfCachedAt < 1000 (baseRx.pdfCachedAt = 500 → stale; fresh.pdfCachedAt = 9000 → kept)
        dao.evictStalePdfs(1_000L)

        val stale = dao.getById(1)
        val kept = dao.getById(2)

        assertNull(stale!!.pdfBytes)
        assertNull(stale.pdfCachedAt)
        assertNotNull(kept!!.pdfBytes)
        assertEquals(9_000L, kept.pdfCachedAt)
    }
}
