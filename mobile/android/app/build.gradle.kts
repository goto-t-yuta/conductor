import org.gradle.api.GradleException
import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

fun resolveOptionalInput(propertyName: String, vararg envNames: String): String {
    val fromProp = providers.gradleProperty(propertyName).orNull?.trim().orEmpty()
    if (fromProp.isNotEmpty()) return fromProp
    for (envName in envNames) {
        val fromEnv = System.getenv(envName)?.trim().orEmpty()
        if (fromEnv.isNotEmpty()) return fromEnv
    }
    return ""
}

fun readRootPackageVersion(): String {
    val pkgFile = rootProject.projectDir.resolve("../../package.json")
    if (!pkgFile.isFile) return "0.1.0"
    val content = runCatching { pkgFile.readText() }.getOrNull().orEmpty()
    val match = Regex(""""version"\s*:\s*"([^"]+)"""").find(content)
    return match?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() } ?: "0.1.0"
}

fun resolveGitShortSha(): String {
    val envSha = resolveOptionalInput("conductorBuildSha", "GITHUB_SHA", "CONDUCTOR_BUILD_SHA")
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

fun extractRunNumberFromTag(tag: String): Int? {
    val match = Regex(
        """^v?\d+\.\d+\.\d+-(\d+)-[0-9a-f]{7,40}(?:\+.*)?$""",
        RegexOption.IGNORE_CASE,
    ).matchEntire(tag.trim())
    return match?.groupValues?.get(1)?.toIntOrNull()?.takeIf { it > 0 }
}

val conductorBaseVersion: String = resolveOptionalInput("conductorVersionName", "CONDUCTOR_BUILD_VERSION")
    .ifEmpty { readRootPackageVersion() }
    .removePrefix("v")
    .ifEmpty { "0.1.0" }

val explicitBuildTag: String = resolveOptionalInput("conductorBuildTag", "CONDUCTOR_BUILD_TAG")
val gitRefTag: String = if (System.getenv("GITHUB_REF_TYPE") == "tag") {
    System.getenv("GITHUB_REF_NAME")?.trim().orEmpty()
} else {
    ""
}

val conductorRunNumber: Int = resolveOptionalInput(
    "conductorBuildRunNumber",
    "GITHUB_RUN_NUMBER",
    "CONDUCTOR_BUILD_RUN_NUMBER",
).toIntOrNull()?.takeIf { it > 0 }
    ?: extractRunNumberFromTag(explicitBuildTag)
    ?: extractRunNumberFromTag(gitRefTag)
    ?: 0

val conductorCommitSha: String = resolveGitShortSha()

val conductorBuildTag: String = explicitBuildTag.ifEmpty {
    if (conductorRunNumber > 0 && conductorCommitSha.isNotEmpty()) {
        "v$conductorBaseVersion-$conductorRunNumber-$conductorCommitSha"
    } else {
        ""
    }
}

val explicitVersionCode: Int? = resolveOptionalInput("conductorVersionCode", "CONDUCTOR_VERSION_CODE")
    .toIntOrNull()
    ?.takeIf { it > 0 }

val computedVersionCode: Int = explicitVersionCode ?: if (conductorRunNumber > 0) conductorRunNumber else 1
val computedVersionName: String = if (conductorBuildTag.isNotEmpty()) {
    conductorBuildTag.removePrefix("v")
} else {
    conductorBaseVersion
}

val releaseStoreFilePath: String = resolveOptionalInput("androidSigningStoreFile", "ANDROID_SIGNING_STORE_FILE")
val releaseStoreFile: File? = releaseStoreFilePath.takeIf { it.isNotEmpty() }?.let { rawPath ->
    val candidate = File(rawPath)
    if (candidate.isAbsolute) candidate else rootProject.file(rawPath)
}
val releaseStorePassword: String = resolveOptionalInput("androidSigningStorePassword", "ANDROID_SIGNING_STORE_PASSWORD")
val releaseKeyAlias: String = resolveOptionalInput("androidSigningKeyAlias", "ANDROID_SIGNING_KEY_ALIAS")
val releaseKeyPassword: String = resolveOptionalInput("androidSigningKeyPassword", "ANDROID_SIGNING_KEY_PASSWORD")
val requireReleaseSigning: Boolean = resolveOptionalInput(
    "androidRequireReleaseSigning",
    "ANDROID_REQUIRE_RELEASE_SIGNING",
).equals("true", ignoreCase = true)

val hasReleaseSigning: Boolean =
    releaseStoreFile != null &&
        releaseStoreFile.isFile &&
        releaseStorePassword.isNotEmpty() &&
        releaseKeyAlias.isNotEmpty() &&
        releaseKeyPassword.isNotEmpty()

fun missingReleaseSigningItems(): List<String> = buildList {
    if (releaseStoreFilePath.isEmpty()) {
        add("ANDROID_SIGNING_STORE_FILE (-PandroidSigningStoreFile)")
    } else if (releaseStoreFile == null || !releaseStoreFile.isFile) {
        add("keystore file not found at '$releaseStoreFilePath'")
    }
    if (releaseStorePassword.isEmpty()) {
        add("ANDROID_SIGNING_STORE_PASSWORD (-PandroidSigningStorePassword)")
    }
    if (releaseKeyAlias.isEmpty()) {
        add("ANDROID_SIGNING_KEY_ALIAS (-PandroidSigningKeyAlias)")
    }
    if (releaseKeyPassword.isEmpty()) {
        add("ANDROID_SIGNING_KEY_PASSWORD (-PandroidSigningKeyPassword)")
    }
}

if (requireReleaseSigning && !hasReleaseSigning) {
    throw GradleException(
        "Android release signing is required but incomplete: ${missingReleaseSigningItems().joinToString(", ")}",
    )
}

gradle.taskGraph.whenReady {
    val buildsReleasePackage = allTasks.any { task ->
        task.project == project && task.name in setOf(
            "assembleRelease",
            "packageRelease",
            "bundleRelease",
            "signReleaseBundle",
        )
    }
    if (buildsReleasePackage && !hasReleaseSigning) {
        throw GradleException(
            "Refusing to build an unsigned release artifact. Configure fixed release signing via: " +
                missingReleaseSigningItems().joinToString(", "),
        )
    }
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

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = releaseStoreFile
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
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

    val media3Version = "1.4.1"
    implementation("androidx.media3:media3-exoplayer:$media3Version")
    implementation("androidx.media3:media3-ui:$media3Version")
    implementation("androidx.media3:media3-datasource-okhttp:$media3Version")

    testImplementation("junit:junit:4.13.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
