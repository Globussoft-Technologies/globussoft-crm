plugins {
    alias(libs.plugins.wellness.android.application)
    alias(libs.plugins.wellness.android.compose)
    alias(libs.plugins.wellness.android.hilt)
}

android {
    namespace = "com.globussoft.wellness"

    defaultConfig {
        applicationId = "com.globussoft.wellness"
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            isDebuggable = true
            buildConfigField("String", "BASE_URL", "\"https://crm.globusdemos.com/api/\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            buildConfigField("String", "BASE_URL", "\"https://crm.globusdemos.com/api/\"")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    // Core
    implementation(project(":core:common"))
    implementation(project(":core:designsystem"))
    implementation(project(":core:data"))
    implementation(project(":core:domain"))
    implementation(project(":core:network"))
    implementation(project(":core:database"))

    // Features
    implementation(project(":feature:auth"))
    implementation(project(":feature:dashboard"))
    implementation(project(":feature:patients"))
    implementation(project(":feature:calendar"))
    implementation(project(":feature:services"))
    implementation(project(":feature:finance"))
    implementation(project(":feature:visits"))
    implementation(project(":feature:reports"))
    implementation(project(":feature:telecaller"))
    implementation(project(":feature:admin"))
    implementation(project(":feature:settings"))
    implementation(project(":feature:crm"))

    // App-level deps
    implementation(libs.core.ktx)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.ktx)
    implementation(libs.navigation.compose)
    implementation(libs.splash.screen)
    implementation(libs.window)
    implementation(libs.material3.adaptive)
    implementation(libs.material3.adaptive.navigation)
}
