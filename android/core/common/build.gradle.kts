plugins {
    alias(libs.plugins.wellness.android.library)
}
android {
    namespace = "com.globussoft.wellness.core.common"
}
dependencies {
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.core.ktx)
}
