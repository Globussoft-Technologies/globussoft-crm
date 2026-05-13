package com.globussoft.wellness.core.network.di

import com.globussoft.wellness.core.common.constants.AppConstants
import com.globussoft.wellness.core.network.BuildConfig
import com.globussoft.wellness.core.network.api.WellnessApi
import com.globussoft.wellness.core.network.interceptor.AuthInterceptor
import com.globussoft.wellness.core.network.interceptor.ConnectivityInterceptor
import com.globussoft.wellness.core.network.interceptor.TokenRefreshInterceptor
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

/**
 * Hilt module that provides all network-layer singletons:
 * [Gson], [OkHttpClient], [Retrofit], and [WellnessApi].
 *
 * The [OkHttpClient] chains interceptors in the following order:
 * 1. [ConnectivityInterceptor] — fails fast before opening a socket.
 * 2. [AuthInterceptor]         — attaches the JWT bearer token.
 * 3. [TokenRefreshInterceptor] — handles 401 by clearing the stale token.
 * 4. [HttpLoggingInterceptor]  — logs request/response bodies in DEBUG builds;
 *                                disabled in RELEASE builds to avoid leaking PII.
 *
 * The base URL is driven by [BuildConfig.BASE_URL] which is set to
 * [AppConstants.BASE_URL_DEBUG] in debug builds and
 * [AppConstants.BASE_URL_PROD] in release builds via build.gradle.
 */
@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideGson(): Gson = GsonBuilder()
        .serializeNulls()
        .setLenient()
        .create()

    @Provides
    @Singleton
    fun provideLoggingInterceptor(): HttpLoggingInterceptor =
        HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BODY
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }

    @Provides
    @Singleton
    fun provideOkHttpClient(
        authInterceptor: AuthInterceptor,
        connectivityInterceptor: ConnectivityInterceptor,
        tokenRefreshInterceptor: TokenRefreshInterceptor,
        loggingInterceptor: HttpLoggingInterceptor,
    ): OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(connectivityInterceptor)
        .addInterceptor(authInterceptor)
        .addInterceptor(tokenRefreshInterceptor)
        .addInterceptor(loggingInterceptor)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    @Provides
    @Singleton
    fun provideRetrofit(
        okHttpClient: OkHttpClient,
        gson: Gson,
    ): Retrofit = Retrofit.Builder()
        .baseUrl(BuildConfig.BASE_URL)
        .client(okHttpClient)
        .addConverterFactory(GsonConverterFactory.create(gson))
        .build()

    @Provides
    @Singleton
    fun provideWellnessApi(retrofit: Retrofit): WellnessApi =
        retrofit.create(WellnessApi::class.java)
}
