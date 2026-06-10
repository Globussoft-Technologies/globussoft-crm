package com.globus.crm.core.di

import com.globus.crm.feature.catalog.data.repository.CatalogRepositoryImpl
import com.globus.crm.feature.catalog.domain.repository.CatalogRepository
import com.globus.crm.feature.finance.data.repository.FinanceRepositoryImpl
import com.globus.crm.feature.finance.domain.repository.FinanceRepository
import com.globus.crm.feature.auth.data.repository.AuthRepositoryImpl
import com.globus.crm.feature.auth.domain.repository.AuthRepository
import com.globus.crm.feature.health.data.repository.ConsentFormRepositoryImpl
import com.globus.crm.feature.health.data.repository.TreatmentPlanRepositoryImpl
import com.globus.crm.feature.health.domain.repository.ConsentFormRepository
import com.globus.crm.feature.health.domain.repository.TreatmentPlanRepository
import com.globus.crm.feature.loyalty.data.repository.LoyaltyRepositoryImpl
import com.globus.crm.feature.loyalty.domain.repository.LoyaltyRepository
import com.globus.crm.feature.booking.data.repository.AppointmentRepositoryImpl
import com.globus.crm.feature.booking.domain.repository.AppointmentRepository
import com.globus.crm.feature.dashboard.data.repository.DashboardRepositoryImpl
import com.globus.crm.feature.dashboard.domain.repository.DashboardRepository
import com.globus.crm.feature.health.data.repository.PrescriptionRepositoryImpl
import com.globus.crm.feature.health.domain.repository.PrescriptionRepository
import com.globus.crm.feature.membership.data.repository.MembershipRepositoryImpl
import com.globus.crm.feature.membership.domain.repository.MembershipRepository
import com.globus.crm.feature.notifications.data.repository.NotificationRepositoryImpl
import com.globus.crm.feature.notifications.domain.repository.NotificationRepository
import com.globus.crm.feature.profile.data.repository.ProfileRepositoryImpl
import com.globus.crm.feature.profile.domain.repository.ProfileRepository
import com.globus.crm.feature.wallet.data.repository.GiftCardRepositoryImpl
import com.globus.crm.feature.wallet.data.repository.WalletRepositoryImpl
import com.globus.crm.feature.wallet.domain.repository.GiftCardRepository
import com.globus.crm.feature.wallet.domain.repository.WalletRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
abstract class RepositoryModule {

    @Binds @Singleton
    abstract fun bindAuthRepository(impl: AuthRepositoryImpl): AuthRepository

    @Binds @Singleton
    abstract fun bindDashboardRepository(impl: DashboardRepositoryImpl): DashboardRepository

    @Binds @Singleton
    abstract fun bindAppointmentRepository(impl: AppointmentRepositoryImpl): AppointmentRepository

    @Binds @Singleton
    abstract fun bindPrescriptionRepository(impl: PrescriptionRepositoryImpl): PrescriptionRepository

    @Binds @Singleton
    abstract fun bindMembershipRepository(impl: MembershipRepositoryImpl): MembershipRepository

    @Binds @Singleton
    abstract fun bindWalletRepository(impl: WalletRepositoryImpl): WalletRepository

    @Binds @Singleton
    abstract fun bindGiftCardRepository(impl: GiftCardRepositoryImpl): GiftCardRepository

    @Binds @Singleton
    abstract fun bindProfileRepository(impl: ProfileRepositoryImpl): ProfileRepository

    @Binds @Singleton
    abstract fun bindNotificationRepository(impl: NotificationRepositoryImpl): NotificationRepository

    @Binds @Singleton
    abstract fun bindTreatmentPlanRepository(impl: TreatmentPlanRepositoryImpl): TreatmentPlanRepository

    @Binds @Singleton
    abstract fun bindConsentFormRepository(impl: ConsentFormRepositoryImpl): ConsentFormRepository

    @Binds @Singleton
    abstract fun bindLoyaltyRepository(impl: LoyaltyRepositoryImpl): LoyaltyRepository

    @Binds @Singleton
    abstract fun bindCatalogRepository(impl: CatalogRepositoryImpl): CatalogRepository

    @Binds @Singleton
    abstract fun bindFinanceRepository(impl: FinanceRepositoryImpl): FinanceRepository
}
