package com.globus.crm.core.util

sealed class Result<out T> {
    data class Success<T>(val data: T) : Result<T>()
    data class Error(
        val code: String,
        val message: String,
        val httpStatus: Int? = null,
    ) : Result<Nothing>()
    object Loading : Result<Nothing>()
}
