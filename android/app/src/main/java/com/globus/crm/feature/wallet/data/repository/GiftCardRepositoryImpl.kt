package com.globus.crm.feature.wallet.data.repository

import com.globus.crm.core.network.WellnessApiService
import com.globus.crm.feature.wallet.data.mapper.toDomain
import com.globus.crm.feature.wallet.data.remote.dto.GiftCardConfirmDto
import com.globus.crm.feature.wallet.data.remote.dto.GiftCardOrderDto
import com.globus.crm.feature.wallet.domain.model.GiftCard
import com.globus.crm.feature.wallet.domain.model.GiftCardOrder
import com.globus.crm.feature.wallet.domain.repository.GiftCardRepository
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class GiftCardRepositoryImpl @Inject constructor(
    private val api: WellnessApiService,
) : GiftCardRepository {

    override suspend fun getStorefront(): List<GiftCard> {
        val response = api.getGiftCardStorefront()
        if (!response.isSuccessful) throw HttpException(response)
        return response.body()!!.giftCards.map { it.toDomain() }
    }

    override suspend fun initiateOrder(giftCardId: Int, patientId: Int): GiftCardOrder {
        val response = api.initiateGiftCardPurchase(giftCardId, GiftCardOrderDto(patientId = patientId))
        if (!response.isSuccessful) throw HttpException(response)
        return response.body()!!.toDomain()
    }

    override suspend fun confirmOrder(
        giftCardId: Int,
        paymentId: String,
        razorpayOrderId: String,
        razorpayPaymentId: String,
        razorpaySignature: String,
    ): GiftCard {
        val response = api.confirmGiftCardPurchase(
            giftCardId,
            GiftCardConfirmDto(
                paymentId = paymentId,
                razorpay_order_id = razorpayOrderId,
                razorpay_payment_id = razorpayPaymentId,
                razorpay_signature = razorpaySignature,
            )
        )
        if (!response.isSuccessful) throw HttpException(response)
        return response.body()!!.giftCard.toDomain()
    }
}
