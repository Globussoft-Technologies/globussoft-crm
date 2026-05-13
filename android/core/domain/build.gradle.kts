plugins {
    alias(libs.plugins.wellness.android.library)
}
dependencies {
    implementation(project(":core:common"))
    implementation(libs.kotlinx.coroutines.android)
}
