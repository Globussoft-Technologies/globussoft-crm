package com.globussoft.wellness.core.network.interceptor

import android.content.Context
import android.content.SharedPreferences
import com.globussoft.wellness.core.common.constants.AppConstants
import dagger.hilt.android.qualifiers.ApplicationContext
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * OkHttp interceptor that attaches the JWT bearer token to every outbound
 * request that requires authentication.
 *
 * The token is read from [SharedPreferences] using the key defined in
 * [AppConstants.KEY_ACCESS_TOKEN] under the prefs file [AppConstants.PREFS_AUTH].
 *
 * If no token is stored (e.g. the user is on the login screen), the request
 * proceeds without an Authorization header — the backend will respond with
 * HTTP 401 which [TokenRefreshInterceptor] handles.
 */
@Singleton
class AuthInterceptor @Inject constructor(
    @ApplicationContext private val context: Context,
) : Interceptor {

    private val prefs: SharedPreferences by lazy {
        context.getSharedPreferences(AppConstants.PREFS_AUTH, Context.MODE_PRIVATE)
    }

    override fun intercept(chain: Interceptor.Chain): Response {
        val token = prefs.getString(AppConstants.KEY_ACCESS_TOKEN, null)

        val request = if (!token.isNullOrBlank()) {
            chain.request()
                .newBuilder()
                .addHeader("Authorization", "Bearer $token")
                .build()
        } else {
            chain.request()
        }

        return chain.proceed(request)
    }
}
