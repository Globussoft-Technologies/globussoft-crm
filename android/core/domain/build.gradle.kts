plugins {
    alias(libs.plugins.wellness.android.library)
}
android {
    namespace = "com.globussoft.wellness.core.domain"
}
dependencies {
    implementation(project(":core:common"))
    implementation(libs.kotlinx.coroutines.android)
}
