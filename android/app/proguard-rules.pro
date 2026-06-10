# ──────────────────────────────────────────────────────────────────────────────
# WellnessCRM Patient App — ProGuard / R8 rules
# ──────────────────────────────────────────────────────────────────────────────

# Preserve source file names + line numbers for crash stack traces (Sentry)
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Keep Kotlin metadata (required by Hilt, Moshi reflection fallback, coroutines)
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# ── Kotlin ────────────────────────────────────────────────────────────────────
-keep class kotlin.Metadata { *; }
-dontwarn kotlin.**

# ── Moshi (codegen via KSP) ───────────────────────────────────────────────────
# KSP-generated JsonAdapter classes must survive R8 shrinking
-keep class **JsonAdapter { *; }
-keep class **JsonAdapter$* { *; }
# Keep all classes annotated with @JsonClass so Moshi can resolve adapters at runtime
-keep @com.squareup.moshi.JsonClass class * { *; }
# Keep Moshi's own annotation types
-keep class com.squareup.moshi.** { *; }
-dontwarn com.squareup.moshi.**
# Enum serialization — Moshi uses .name() which must not be obfuscated
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# ── Retrofit 2 ────────────────────────────────────────────────────────────────
# Keep all Retrofit annotations on interface methods so Retrofit can read them
-keepclassmembers,allowobfuscation interface * {
    @retrofit2.http.* <methods>;
}
-dontwarn retrofit2.**
-keep class retrofit2.** { *; }

# ── OkHttp 4 ──────────────────────────────────────────────────────────────────
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
# Required for OkHttp internal headers
-keepnames class okhttp3.internal.publicsuffix.PublicSuffixDatabase

# ── Room ──────────────────────────────────────────────────────────────────────
# Room ships its own rules; these are extras for safety
-keep class * extends androidx.room.RoomDatabase { *; }
-keep @androidx.room.Entity class * { *; }
-keep @androidx.room.Dao interface * { *; }
-keepclassmembers class * extends androidx.room.RoomDatabase {
    abstract *;
}

# ── Hilt ──────────────────────────────────────────────────────────────────────
# Hilt ships its own ProGuard rules via Gradle; these cover edge cases
-keep class dagger.hilt.** { *; }
-keep @dagger.hilt.android.HiltAndroidApp class * { *; }
-keep @dagger.hilt.android.AndroidEntryPoint class * { *; }
-dontwarn dagger.hilt.**

# ── Razorpay SDK ──────────────────────────────────────────────────────────────
-keep class com.razorpay.** { *; }
-keep interface com.razorpay.** { *; }
-dontwarn com.razorpay.**
-keepclassmembers class * {
    @com.razorpay.RazorpayPaymentActivityV2 *;
}

# ── Firebase ──────────────────────────────────────────────────────────────────
# Firebase ships its own rules; keep messaging data classes explicitly
-keep class com.google.firebase.messaging.** { *; }
-dontwarn com.google.firebase.**

# ── Sentry ────────────────────────────────────────────────────────────────────
-keep class io.sentry.** { *; }
-dontwarn io.sentry.**

# ── Coroutines ────────────────────────────────────────────────────────────────
-keepclassmembers class kotlinx.coroutines.** { *; }
-dontwarn kotlinx.coroutines.**

# ── Coil ──────────────────────────────────────────────────────────────────────
-dontwarn coil.**

# ── Security Crypto (EncryptedSharedPreferences) ──────────────────────────────
-keep class androidx.security.crypto.** { *; }

# ── BuildConfig ───────────────────────────────────────────────────────────────
-keep class com.globus.crm.BuildConfig { *; }
