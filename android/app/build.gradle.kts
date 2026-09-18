plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.google.services)
}

// GITHUB_RUN_NUMBER is set automatically by every GitHub Actions run and
// strictly increases build over build - using it as versionCode means each
// CI-published APK is always considered newer than the last, which is
// exactly what the in-app update checker compares against. Falls back to 1
// for local/dev builds outside CI, where this doesn't matter.
val ciRunNumber = (System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1)

android {
    namespace = "com.smsclicksender.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.smsclicksender.app"
        minSdk = 26
        targetSdk = 35
        versionCode = ciRunNumber
        versionName = "1.0.$ciRunNumber"
    }

    // Every CI build otherwise gets AGP's auto-generated debug key at
    // ~/.android/debug.keystore - fine on one dev machine, but each
    // GitHub Actions run starts a brand-new VM with no such file, so AGP
    // would silently generate a DIFFERENT random key every single build.
    // Android refuses to install an update signed with a different key
    // than what's already on the device ("package conflicts with an
    // existing package") - a fixed, committed keystore is what makes
    // "every CI-published APK is really the previous one's update"
    // actually true. Same alias/passwords as Android's own default debug
    // keystore, so it's a drop-in replacement, not a new secret to manage.
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
        viewBinding = true
        buildConfig = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    testImplementation("junit:junit:4.13.2")
}
