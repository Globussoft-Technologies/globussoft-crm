plugins {
    alias(libs.plugins.wellness.android.feature)
}
android {
    namespace = "com.globussoft.wellness.feature.patients"
}
dependencies {
    implementation(project(":core:database"))
}
