pluginManagement {
    includeBuild("build-logic")
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven("https://jitpack.io")
    }
}

rootProject.name = "WellnessCRM"

enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")

include(":app")

// Core modules
include(":core:common")
include(":core:designsystem")
include(":core:network")
include(":core:data")
include(":core:domain")
include(":core:database")

// Feature modules
include(":feature:auth")
include(":feature:dashboard")
include(":feature:patients")
include(":feature:calendar")
include(":feature:services")
include(":feature:finance")
include(":feature:visits")
include(":feature:reports")
include(":feature:telecaller")
include(":feature:admin")
include(":feature:settings")
