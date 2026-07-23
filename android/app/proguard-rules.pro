# ── Capacitor core ─────────────────────────────────────────────────────────
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class * extends com.getcapacitor.Plugin { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.PluginMethod public *;
}

# ── WebView JS interface ────────────────────────────────────────────────────
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ── App classes ─────────────────────────────────────────────────────────────
-keep class com.zeeh.africa.** { *; }

# ── AndroidX / Kotlin support ────────────────────────────────────────────────
-keep class androidx.activity.** { *; }
-dontwarn androidx.activity.**

# ── Debugging: preserve line numbers in stack traces ────────────────────────
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
