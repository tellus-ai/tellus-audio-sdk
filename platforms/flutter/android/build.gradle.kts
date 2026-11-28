group = "ai.tellus.audio.flutter"
version = "1.0"

buildscript {
    repositories {
        google()
        mavenCentral()
    }

    dependencies {
        classpath("com.android.tools.build:gradle:9.3.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.20")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

plugins {
    id("com.android.library")
}

val engineDir = file("vendor/android")
if (!File(engineDir, "include/tellus_audio_engine.h").exists()) {
    throw GradleException("[tellus-audio-sdk] Missing Android engine in $engineDir. Run install:binary with TELLUS_AUDIO_ENGINE_PLATFORM=android.")
}

// The Kotlin sources of the React Native package. They are compiled unchanged, except the two files
// that are tied to React Native: src/main/kotlin has the Flutter MicrophonePermission.kt.
val reactNativeSources = file("../../mobile/android/src/main/java")
val reactNativeOnly = setOf("MicrophonePermission.kt", "TellusAudioSdkPackage.kt")

// The same assets as platforms/mobile/android/model-assets.gradle. AndroidAudioDevice.kt reads them from tellus-audio-sdk/.
// A File, not a Provider: the Android Gradle plugin 9 does not accept a Provider as a source folder.
val modelAssets = layout.buildDirectory.dir("generated/tellus-model-assets").get().asFile
val syncTellusModelAssets = tasks.register<Sync>("syncTellusModelAssets") {
    from(File(engineDir, "models")) { include("*.temc") }
    from(File(engineDir, "speech-detection")) { include("silero_vad_v6.2.onnx") }
    from(File(engineDir, "licenses")) { include("silero-vad.txt", "onnxruntime.txt", "onnxruntime-third-party.txt") }
    into(File(modelAssets, "tellus-audio-sdk"))
}

android {
    namespace = "ai.tellus.audio.flutter"

    compileSdk = 36

    // The NDK that built the engine kit.
    ndkVersion = "27.1.12297006"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        minSdk = 24

        externalNativeBuild {
            cmake {
                cppFlags("-frtti -fexceptions -Wall -Wextra -fstack-protector-all")
                arguments("-DANDROID_STL=c++_shared")
                // The engine kit has these two ABIs only.
                abiFilters("arm64-v8a", "x86_64")
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("CMakeLists.txt")
        }
    }

    buildFeatures {
        prefab = true
    }

    // The fbjni AAR brings libfbjni.so and libc++_shared.so to the app. The copies that the native build
    // of this module produces would be duplicates and fail the app's native library merge.
    packaging {
        jniLibs {
            excludes += listOf("**/libfbjni.so", "**/libc++_shared.so")
        }
    }

    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin", reactNativeSources)
            assets.srcDir(modelAssets)
            // The engine jniLibs carry libonnxruntime.so next to the engine, so no onnxruntime-android AAR is added (it would duplicate that path).
            jniLibs.srcDir(File(engineDir, "jniLibs"))
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    exclude { it.name in reactNativeOnly && it.file.startsWith(reactNativeSources) }
}

tasks.named("preBuild") { dependsOn(syncTellusModelAssets) }

dependencies {
    // The fbjni that React Native 0.83 uses, here without React Native. AndroidAudioDevice.cpp needs it.
    implementation("com.facebook.fbjni:fbjni:0.7.0")
    // fbjni brings this at runtime only. The plugin class initialises it.
    implementation("com.facebook.soloader:nativeloader:0.10.5")
}
