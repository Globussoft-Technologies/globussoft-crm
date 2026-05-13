import com.android.build.gradle.LibraryExtension

plugins {
    alias(libs.plugins.wellness.android.library)
    alias(libs.plugins.wellness.android.hilt)
}

// Enable BuildConfig generation so interceptors and the DI module can reference
// BuildConfig.DEBUG and BuildConfig.BASE_URL at compile time.
android {
    buildFeatures {
        buildConfig = true
    }
    buildTypes {
        debug {
            buildConfigField(
                "String",
                "BASE_URL",
                "\"https://10.0.2.2:5000/api/\"",
            )
        }
        release {
            buildConfigField(
                "String",
                "BASE_URL",
                "\"https://crm.globusdemos.com/api/\"",
            )
        }
    }
}

dependencies {
    implementation(project(":core:common"))
    implementation(project(":core:domain"))
    implementation(libs.retrofit)
    implementation(libs.retrofit.converter.gson)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.gson)
    implementation(libs.kotlinx.coroutines.android)
}
