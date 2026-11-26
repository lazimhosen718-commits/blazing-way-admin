#!/usr/bin/env bash
set -euo pipefail

GRADLE_FILE="app/build.gradle"
MANIFEST_FILE="app/src/main/AndroidManifest.xml"
ACTIVITY_FILE="app/src/main/java/com/blazingway/customer/MainActivity.java"

grep -Eq "versionCode[[:space:]]+12" "$GRADLE_FILE"
grep -Eq "versionName[[:space:]]+'12\\.0'" "$GRADLE_FILE"
grep -q 'android:usesCleartextTraffic="false"' "$MANIFEST_FILE"
grep -q 'android.permission.INTERNET' "$MANIFEST_FILE"
grep -q 'android.permission.ACCESS_FINE_LOCATION' "$MANIFEST_FILE"
grep -q 'android.permission.ACCESS_COARSE_LOCATION' "$MANIFEST_FILE"
grep -q 'TRUSTED_HOST = "lazimhosen718-commits.github.io"' "$ACTIVITY_FILE"
grep -q 'handler.cancel()' "$ACTIVITY_FILE"
grep -q 'callback.invoke(origin, false, false)' "$ACTIVITY_FILE"

echo "Customer v12.0 release configuration smoke checks passed."
