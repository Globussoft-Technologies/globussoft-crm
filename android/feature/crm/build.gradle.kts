plugins {
    alias(libs.plugins.wellness.android.feature)
}

android {
    namespace = "com.globussoft.wellness.feature.crm"
}

dependencies {
    implementation(project(":core:database"))
    implementation(libs.vico.compose)
    implementation(libs.vico.compose.m3)
}
