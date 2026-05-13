plugins {
    `kotlin-dsl`
}

group = "com.globussoft.wellness.buildlogic"

kotlin {
    jvmToolchain(21)
}

dependencies {
    compileOnly(libs.agp.gradlePlugin)
    compileOnly(libs.kotlin.gradlePlugin)
    compileOnly(libs.compose.gradlePlugin)
    compileOnly(libs.ksp.gradlePlugin)
}

tasks {
    validatePlugins {
        enableStricterValidation = true
        failOnWarning = true
    }
}

gradlePlugin {
    plugins {
        register("androidApplication") {
            id = "wellness.android.application"
            implementationClass = "AndroidApplicationConventionPlugin"
        }
        register("androidLibrary") {
            id = "wellness.android.library"
            implementationClass = "AndroidLibraryConventionPlugin"
        }
        register("androidFeature") {
            id = "wellness.android.feature"
            implementationClass = "AndroidFeatureConventionPlugin"
        }
        register("androidCompose") {
            id = "wellness.android.compose"
            implementationClass = "ComposeConventionPlugin"
        }
        register("androidHilt") {
            id = "wellness.android.hilt"
            implementationClass = "HiltConventionPlugin"
        }
    }
}
