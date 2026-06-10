package com.globus.crm.feature.notifications.data.local.dao

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.globus.crm.core.database.AppDatabase
import com.globus.crm.feature.notifications.data.local.entity.CachedNotification
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NotificationDaoTest {

    private lateinit var db: AppDatabase
    private lateinit var dao: NotificationDao

    private val base = CachedNotification(
        id = "n1",
        type = "BOOKING_CONFIRMED",
        title = "Booking",
        body = "Your appointment is confirmed",
        screen = null,
        entityId = null,
        isRead = false,
        receivedAt = 2000L,
    )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            AppDatabase::class.java,
        ).allowMainThreadQueries().build()
        dao = db.notificationDao()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun insert_then_getAll_returns_inserted_notification() = runBlocking {
        dao.insert(base)

        val all = dao.getAll()

        assertEquals(1, all.size)
        assertEquals(base.id, all[0].id)
        assertEquals(base.type, all[0].type)
        assertFalse(all[0].isRead)
    }

    @Test
    fun markRead_sets_isRead_true_for_target_only() = runBlocking {
        val second = base.copy(id = "n2", receivedAt = 1000L)
        dao.insert(base)
        dao.insert(second)

        dao.markRead("n1")

        val all = dao.getAll() // ordered by receivedAt DESC: n1 first, n2 second
        val n1 = all.first { it.id == "n1" }
        val n2 = all.first { it.id == "n2" }
        assertTrue(n1.isRead)
        assertFalse(n2.isRead)
    }

    @Test
    fun markAllRead_sets_isRead_true_for_all_rows() = runBlocking {
        dao.insert(base)
        dao.insert(base.copy(id = "n2", receivedAt = 1000L))

        dao.markAllRead()

        val all = dao.getAll()
        assertTrue(all.all { it.isRead })
    }

    @Test
    fun deleteOlderThan_removes_stale_entries_keeps_recent() = runBlocking {
        val old = base.copy(id = "old", receivedAt = 100L)
        val recent = base.copy(id = "recent", receivedAt = 5000L)
        dao.insert(old)
        dao.insert(recent)

        dao.deleteOlderThan(1000L) // removes anything with receivedAt < 1000

        val all = dao.getAll()
        assertEquals(1, all.size)
        assertEquals("recent", all[0].id)
    }
}
