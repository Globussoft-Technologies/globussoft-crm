package com.globus.crm.feature.wallet.data.mapper

import com.globus.crm.feature.wallet.data.remote.dto.GiftCardDto
import com.globus.crm.feature.wallet.data.remote.dto.GiftCardOrderResponseDto
import com.globus.crm.feature.wallet.data.remote.dto.MyTransactionsResponseDto
import com.globus.crm.feature.wallet.data.remote.dto.PatientWalletResponseDto
import com.globus.crm.feature.wallet.data.remote.dto.TransactionDto
import com.globus.crm.feature.wallet.domain.model.GiftCard
import com.globus.crm.feature.wallet.domain.model.GiftCardOrder
import com.globus.crm.feature.wallet.domain.model.Transaction
import com.globus.crm.feature.wallet.domain.model.WalletSummary

fun TransactionDto.toDomain() = Transaction(
    id = id,
    type = type,
    category = category,
    title = title,
    description = description,
    amount = amount,
    direction = direction,
    status = status,
    reference = reference,
    date = date,
    paymentMethod = paymentMethod,
    balanceAfter = balanceAfter,
)

fun MyTransactionsResponseDto.toDomain() = WalletSummary(
    balance = summary.walletBalance,
    currency = currency,
    transactions = transactions.map { it.toDomain() },
)

fun PatientWalletResponseDto.toDomain() = WalletSummary(
    balance = wallet.balance,
    currency = wallet.currency,
    transactions = transactions.map { txn ->
        Transaction(
            id = txn.id.toString(),
            type = txn.type,
            category = "wallet",
            title = txn.reason ?: txn.type,
            description = null,
            amount = txn.amount,
            direction = if (txn.type.lowercase().contains("credit")) "credit" else "debit",
            status = "completed",
            reference = null,
            date = txn.createdAt,
            paymentMethod = null,
            balanceAfter = txn.balanceAfter,
        )
    },
)

fun GiftCardDto.toDomain() = GiftCard(
    id = id,
    name = name,
    amount = amount,
    price = price,
    color = color,
    validityDays = validityDays,
    currency = currency,
    expiresAt = expiresAt,
)

fun GiftCardOrderResponseDto.toDomain() = GiftCardOrder(
    orderId = orderId,
    paymentId = paymentId,
    razorpayKey = key,
    amount = amount,
    currency = currency,
    giftCardId = giftCardId,
    patientId = patientId,
    patientName = patientName,
)
