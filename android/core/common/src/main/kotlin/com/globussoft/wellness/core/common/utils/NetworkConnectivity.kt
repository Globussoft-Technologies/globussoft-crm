package com.globussoft.wellness.core.common.utils

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * Observes device network connectivity and exposes it as a [Flow]<[Boolean]>.
 *
 * `true`  — at least one network is available and has internet capability.
 * `false` — no usable network is connected.
 *
 * The flow:
 *  - emits the current connectivity state immediately on collection,
 *  - emits `false` when the last valid network is lost,
 *  - emits `true` when a new network with internet capability becomes available,
 *  - is [conflate]d so a slow collector never blocks the callback,
 *  - de-duplicates consecutive identical values via [distinctUntilChanged].
 *
 * Usage:
 * ```kotlin
 * val observer = NetworkConnectivityObserver(context)
 * observer.observe().collect { isConnected ->
 *     if (isConnected) retryPendingRequests()
 * }
 * ```
 */
class NetworkConnectivityObserver(context: Context) {

    private val connectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE)
                as ConnectivityManager

    /**
     * Returns a cold [Flow] that emits connectivity updates.
     * Collecting this flow registers a [ConnectivityManager.NetworkCallback]
     * and cancelling collection (or the enclosing scope) unregisters it cleanly.
     */
    fun observe(): Flow<Boolean> = callbackFlow {
        // Emit current state synchronously before any callback fires.
        trySend(isCurrentlyConnected())

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                trySend(true)
            }

            override fun onLost(network: Network) {
                // Re-check: another network may still be active.
                trySend(isCurrentlyConnected())
            }

            override fun onCapabilitiesChanged(
                network: Network,
                networkCapabilities: NetworkCapabilities,
            ) {
                val hasInternet = networkCapabilities.hasCapability(
                    NetworkCapabilities.NET_CAPABILITY_INTERNET
                ) && networkCapabilities.hasCapability(
                    NetworkCapabilities.NET_CAPABILITY_VALIDATED
                )
                trySend(hasInternet)
            }

            override fun onUnavailable() {
                trySend(false)
            }
        }

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        connectivityManager.registerNetworkCallback(request, callback)

        awaitClose {
            connectivityManager.unregisterNetworkCallback(callback)
        }
    }
        .conflate()
        .distinctUntilChanged()

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    /**
     * Synchronous snapshot of current connectivity — used for the initial
     * emission and for re-evaluation after [onLost].
     */
    private fun isCurrentlyConnected(): Boolean {
        val activeNetwork = connectivityManager.activeNetwork ?: return false
        val caps = connectivityManager.getNetworkCapabilities(activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
}
