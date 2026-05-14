plugins {
    alias(libs.plugins.wellness.android.feature)
}

android {
    namespace = "com.globussoft.wellness.feature.dashboard"
}
dependencies {
    implementation(libs.vico.compose)
    implementation(libs.vico.compose.m3)
}
