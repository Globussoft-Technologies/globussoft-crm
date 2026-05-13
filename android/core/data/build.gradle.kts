plugins {
    alias(libs.plugins.wellness.android.library)
    alias(libs.plugins.wellness.android.hilt)
}
dependencies {
    implementation(project(":core:common"))
    implementation(project(":core:domain"))
    implementation(project(":core:network"))
    implementation(libs.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
}
