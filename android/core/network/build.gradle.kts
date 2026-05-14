plugins {
    alias(libs.plugins.wellness.android.library)
    alias(libs.plugins.wellness.android.hilt)
}

android {
    namespace = "com.globussoft.wellness.core.network"
    buildFeatures {
        buildConfig = true
    }
    buildTypes {
        debug {
            buildConfigField("String", "BASE_URL", "\"https://crm.globusdemos.com/api/\"")
        }
        release {
            buildConfigField("String", "BASE_URL", "\"https://crm.globusdemos.com/api/\"")
        }
    }
}

dependencies {
    implementation(project(":core:common"))
    implementation(project(":core:domain"))
    api(libs.retrofit)
    api(libs.retrofit.converter.gson)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.gson)
    implementation(libs.kotlinx.coroutines.android)
}
