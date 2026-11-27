plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

fun readRootPackageVersion(): String {
    val pkgFile = rootProject.projectDir.resolve("../../package.json")
    if (!pkgFile.isFile) return "0.1.0"
    val content = runCatching { pkgFile.readText() }.getOrNull().orEmpty()
    val match = Regex(""""version"\s*:\s*"([^"]+)"""").find(content)
    return match?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() } ?: "0.1.0"
}

fun resolveGitShortSha(): String {
    val envSha = (
        providers.gradleProperty("conductorBuildSha").orNull
            ?: System.getenv("GITHUB_SHA")
            ?: System.getenv("CONDUCTOR_BUILD_SHA")
            ?: ""
        ).trim()
    if (Regex("^[0-9a-fA-F]{7,40}$").matches(envSha)) {
        return envSha.take(7).lowercase()
    }
    return runCatching {
        val process = ProcessBuilder("git", "rev-parse", "--short=7", "HEAD")
            .directory(rootProject.projectDir)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().readText().trim()
        val exitCode = process.waitFor()
        if (exitCode == 0 && Regex("^[0-9a-fA-F]{7,40}$").matches(output)) {
            output.take(7).lowercase()
        } else {
            ""
        }
    }.getOrDefault("")
}

val conductorBaseVersion: String = (
    providers.gradleProperty("conductorVersionName").orNull
        ?: System.getenv("CONDUCTOR_BUILD_VERSION")
        ?: readRootPackageVersion()
    ).trim().removePrefix("v").ifEmpty { "0.1.0" }

val conductorRunNumber: Int = (
    providers.gradleProperty("conductorBuildRunNumber").orNull
        ?: System.getenv("GITHUB_RUN_NUMBER")
        ?: System.getenv("CONDUCTOR_BUILD_RUN_NUMBER")
        ?: ""
    ).trim().toIntOrNull()?.takeIf { it > 0 } ?: 0

val conductorCommitSha: String = resolveGitShortSha()

val conductorBuildTag: String = (
    providers.gradleProperty("conductorBuildTag").orNull
        ?: System.getenv("CONDUCTOR_BUILD_TAG")
        ?: if (conductorRunNumber > 0 && conductorCommitSha.isNotEmpty()) {
            "v$conductorBaseVersion-$conductorRunNumber-$conductorCommitSha"
        } else {
            ""
        }
    ).trim()

val computedVersionCode: Int = if (conductorRunNumber > 0) conductorRunNumber else 1
val computedVersionName: String = if (conductorBuildTag.isNotEmpty()) {
    conductorBuildTag.removePrefix("v")
} else {
    conductorBaseVersion
}

fun String.asBuildConfigString(): String =
    "\"" + replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "dev.conductor.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.conductor.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = computedVersionCode
        versionName = computedVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "BUILD_BASE_VERSION", conductorBaseVersion.asBuildConfigString())
        buildConfigField("String", "BUILD_TAG", conductorBuildTag.asBuildConfigString())
        buildConfigField("String", "BUILD_COMMIT_SHA", conductorCommitSha.asBuildConfigString())
        buildConfigField("int", "BUILD_RUN_NUMBER", conductorRunNumber.toString())
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("androidx.activity:activity-compose:1.9.3")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")

    val cameraxVersion = "1.4.0"
    implementation("androidx.camera:camera-core:$cameraxVersion")
    implementation("androidx.camera:camera-camera2:$cameraxVersion")
    implementation("androidx.camera:camera-lifecycle:$cameraxVersion")
    implementation("androidx.camera:camera-view:$cameraxVersion")
    implementation("com.google.zxing:core:3.5.3")

    testImplementation("junit:junit:4.13.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
