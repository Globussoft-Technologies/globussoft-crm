package com.globus.crm.feature.finance.data.mapper

import com.globus.crm.feature.finance.data.remote.dto.PaymentConfigDto
import com.globus.crm.feature.finance.data.remote.dto.PaymentDto
import com.globus.crm.feature.finance.domain.model.Payment
import com.globus.crm.feature.finance.domain.model.PaymentConfig

fun PaymentDto.toDomain(): Payment = Payment(
    id = id,
    amount = amount ?: 0L,
    currency = currency ?: "INR",
    status = status ?: "unknown",
    gateway = gateway,
    description = description,
    createdAt = createdAt ?: "",
)

fun PaymentConfigDto.toDomain(): PaymentConfig? {
    val gw = gateway ?: return null
    return PaymentConfig(
        gateway = gw,
        razorpayKeyId = razorpayKeyId,
        stripePublishableKey = stripePublishableKey,
    )
}
