package com.globussoft.wellness

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.globussoft.wellness.core.data.datastore.AuthDataStore
import com.globussoft.wellness.core.designsystem.theme.WellnessTheme
import com.globussoft.wellness.navigation.WellnessNavHost
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var authDataStore: AuthDataStore

    @OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        val splashScreen = installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            val windowSizeClass = calculateWindowSizeClass(this)
            val userSession by authDataStore.userFlow.collectAsState(initial = null)

            WellnessTheme {
                WellnessNavHost(
                    windowSizeClass = windowSizeClass,
                    isLoggedIn = userSession != null,
                    userSession = userSession
                )
            }
        }
    }
}
