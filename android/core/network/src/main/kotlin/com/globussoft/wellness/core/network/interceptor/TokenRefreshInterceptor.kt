package com.globussoft.wellness.core.network.interceptor

import android.content.Context
import android.content.SharedPreferences
import com.globussoft.wellness.core.common.constants.AppConstants
import dagger.hilt.android.qualifiers.ApplicationContext
import okhttp3.Interceptor
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import javax.inject.Inject
import javax.inject.Singleton

/**
 * OkHttp interceptor that handles HTTP 401 Unauthorized responses.
 *
 * This backend has no refresh-token endpoint, so on a 401 the app must:
 * 1. Remove the stale token from [SharedPreferences] so [AuthInterceptor]
 *    stops attaching it.
 * 2. Return a synthetic response containing the header `X-Logout-Required: true`
 *    which the app-layer network observer uses to navigate back to the
 *    login screen.
 *
 * The interceptor does NOT retry the original request — the session is
 * definitively expired and the user must re-authenticate.
 */
@Singleton
class TokenRefreshInterceptor @Inject constructor(
    @ApplicationContext private val context: Context,
) : Interceptor {

    private val prefs: SharedPreferences by lazy {
        context.getSharedPreferences(AppConstants.PREFS_AUTH, Context.MODE_PRIVATE)
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val originalRequest = chain.request()
        val response = chain.proceed(originalRequest)

        if (response.code == 401) {
            // Clear the stale token so subsequent calls don't repeat the 401.
            prefs.edit().remove(AppConstants.KEY_ACCESS_TOKEN).apply()

            // Return a synthetic empty response with the logout signal header.
            // The real response body is closed to prevent resource leaks.
            response.close()

            return Response.Builder()
                .request(originalRequest)
                .protocol(Protocol.HTTP_1_1)
                .code(401)
                .message("Unauthorized")
                .header("X-Logout-Required", "true")
                .body("".toResponseBody(null))
                .build()
        }

        return response
    }
}
