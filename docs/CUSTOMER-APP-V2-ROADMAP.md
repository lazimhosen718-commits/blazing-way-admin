# BLAZING-WAY Customer App — Version Roadmap

## Working branch
`customer-app-v2.0`

This branch remains isolated from `main`. The existing production pages and Firestore rules are not changed by this release-candidate work.

## Version sequence

| Version | Scope |
|---|---|
| 2.0 | Core app, stronger login, baseline security |
| 3.0 | App/device attestation, abuse controls |
| 4.0 | Bike/Car booking |
| 5.0 | Food Delivery |
| 6.0 | Parcel |
| 7.0 | Customer Wallet & payments |
| 8.0 | Live GPS tracking |
| 9.0 | Notifications & support |
| 10.0 | Performance, accessibility, weak-network handling |
| 11.0 | Fraud protection, account/session security |
| 12.0 | Consolidated release candidate, end-to-end testing, signed Android build, release documentation |

## Version 12.0 release-candidate work committed

- Android package version is set to `versionCode 12` and `versionName 12.0`.
- Android WebView navigation is restricted to the exact HTTPS GitHub Pages host used by the Customer page. Other hosts, non-HTTPS URLs, alternate ports, and user-info URLs are blocked.
- Geolocation prompts are accepted only from that trusted HTTPS host and only after Android location permission is granted. Pending geolocation callbacks are denied if the activity is destroyed.
- WebView file access and content access are disabled; JavaScript-created windows and multiple windows are disabled; Safe Browsing is enabled on Android 8.0+.
- SSL certificate errors are cancelled; there is no proceed-through-certificate-error path.
- Added `android-apk/verify-release-config.sh` for release configuration smoke checks. The GitHub Actions workflow runs these checks before building.
- Release workflow validates the Android project and compiles the debug variant first. The signed-release job proceeds only when all four repository signing secrets are configured; otherwise signed publishing is safely skipped. When enabled, it builds `assembleRelease`, verifies the APK signature, and publishes only the signed release APK.
- No keystore or signing password is stored in the repository.

## Important existing application review findings

- The Android APK is a WebView wrapper that loads the hosted `customer-app.html`; this version does not convert the web app into a fully native Android app.
- The Customer page uses Firebase Authentication email/password and Firestore. Email verification and Firebase App Check were not enabled in the reviewed page at the time of the initial review.
- Registration previously created both `passengerProfiles` and `foodCustomerProfiles` from the client. Any changes to profile creation, roles, payments, or wallet behavior must be implemented with trusted server-side authorization.
- Ride, Food, Parcel, and Business Delivery entry points are present in the page, but presence of an entry point does not prove that each end-to-end service flow is complete.
- Food ordering uses the `placeFoodOrder` callable function. Financial calculations and fee rules must remain server-authoritative.
- Existing Firestore rules include role-specific controls and a default-deny fallback. Do not replace them with permissive rules or merge Ride and Food financial administration.

## Release signing requirements

- Configure these repository Actions secrets before running the release workflow: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`.
- `ANDROID_KEYSTORE_BASE64` must contain the base64 encoding of the correct release keystore. Keep an offline, secure backup of the keystore and passwords. Never share them in chat or commit them.
- If an earlier APK was distributed, use its original signing key. A different key may prevent Android from installing the new APK as an update.
- Do not publish an unsigned or debug-signed production release.

## Remaining release gates — not yet verified

- Confirm the release keystore matches the signing certificate of any previously distributed Customer APK.
- Configure the four GitHub Actions secrets securely; until then, only the compile/smoke-check validation job can complete.
- Run the v12.0 GitHub Actions workflow and confirm the release build succeeds.
- Install the resulting APK on supported Android devices and test login, logout, back navigation, location permission grant/deny, denied navigation to untrusted hosts, and weak-network/error behavior.
- Run end-to-end tests for actual Ride, Food, Parcel, Business Delivery, authentication, and payment flows. These flows are not certified complete by the WebView smoke checks.
- Review Firebase Authentication, App Check, Firestore rules, Cloud Functions, privacy, and financial logic before public production release.
- Investigate any Play Protect warning by reviewing the actual APK, signing certificate, permissions, dependencies, and build provenance. Never advise users to bypass Play Protect.

A version is not considered complete until code review, required tests, a successful signed build, and installation/runtime checks are all verified. The current v12.0 work is a release-candidate preparation, not proof of a completed production release.
