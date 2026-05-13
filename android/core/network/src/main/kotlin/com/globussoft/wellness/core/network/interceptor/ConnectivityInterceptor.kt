package com.globussoft.wellness.core.network.interceptor

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import dagger.hilt.android.qualifiers.ApplicationContext
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Exception thrown by [ConnectivityInterceptor] when the device has no active
 * internet connection at the time a network call is attempted.
 *
 * Extends [IOException] so OkHttp's internal error handling treats it as a
 * network-layer failure rather than a programming error.
 */
class NoConnectivityException : IOException("No internet connection")

/**
 * OkHttp interceptor that short-circuits outbound requests when the device
 * has no active network with internet capability.
 *
 * Uses [ConnectivityManager.activeNetwork] + [NetworkCapabilities] rather than
 * the deprecated [ConnectivityManager.activeNetworkInfo] for API 23+ compat.
 *
 * Throws [NoConnectivityException] (a subclass of [IOException]) on no
 * connectivity — [safeApiCall] maps this to [DomainError.NetworkError].
 */
@Singleton
class ConnectivityInterceptor @Inject constructor(
    @ApplicationContext private val context: Context,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        if (!isConnected()) throw NoConnectivityException()
        return chain.proceed(chain.request())
    }

    private fun isConnected(): Boolean {
        val connectivityManager =
            context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
}
