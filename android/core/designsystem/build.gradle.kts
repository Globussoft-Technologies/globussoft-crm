plugins {
    alias(libs.plugins.wellness.android.library)
    alias(libs.plugins.wellness.android.compose)
}

dependencies {
    implementation(project(":core:common"))
    implementation(libs.navigation.compose)
    implementation(libs.shimmer)
    implementation(libs.window)
    implementation(libs.material3.adaptive)
    implementation(libs.material3.adaptive.layout)
    implementation(libs.material3.adaptive.navigation)
    api(libs.coil.compose)
    api(libs.coil.network.okhttp)
}
