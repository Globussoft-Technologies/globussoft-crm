plugins {
    alias(libs.plugins.wellness.android.library)
    alias(libs.plugins.wellness.android.hilt)
    alias(libs.plugins.ksp)
}
android {
    namespace = "com.globussoft.wellness.core.database"
}
dependencies {
    implementation(project(":core:common"))
    implementation(project(":core:domain"))
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.kotlinx.coroutines.android)
}
