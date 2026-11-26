# BLAZING-WAY Customer App — Version 2.0

## Branch
`customer-app-v2.0`

This branch is isolated from `main`. The existing production pages and Firestore rules are not changed by this planning commit.

## Version 2.0 objectives

1. Preserve the existing single Customer account for Ride, Food Delivery, Parcel, and Business Delivery.
2. Strengthen authentication and account lifecycle.
3. Add Firebase App Check (Android Play Integrity for Android builds; reCAPTCHA Enterprise or the supported web provider for web).
4. Review and test Firestore authorization without weakening division boundaries or the default-deny rule.
5. Keep wallet balances and financial ledger writes server-authoritative; never trust client-submitted balances, prices, or fees.
6. Add safe error handling, loading states, accessibility, and weak-network behavior.
7. Verify the Android package signing, permissions, dependencies, and release artifact before distributing an APK.

## Initial code review findings (from current main)

- `customer-app.html` currently uses Firebase Authentication email/password and Firestore.
- Registration creates both `passengerProfiles` and `foodCustomerProfiles` client-side.
- Email verification is not enforced in the current Customer page.
- The page imports Firebase JS SDK 12.0.0.
- Firebase App Check is not initialized in the current Customer page.
- Ride, Food, Parcel, and Business Delivery entry points are present, but this file alone does not prove every service flow is complete.
- Food ordering calls the `placeFoodOrder` callable function; the server implementation must be reviewed before changes to pricing, fees, or wallet behavior.
- The existing Firestore rules contain role-specific access controls and a default-deny fallback. They must be preserved and tested, not replaced with permissive rules.

## Android APK release signing (implemented on this branch)

- The Android Gradle release build now reads signing values from environment variables; no keystore or password is committed to the repository.
- The GitHub Actions workflow now builds `assembleRelease`, verifies the APK signature with `apksigner`, and publishes only the release APK.
- Debug APKs are no longer published by this workflow as production releases.
- Before running the workflow, configure these repository Actions secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`.
- `ANDROID_KEYSTORE_BASE64` must contain the base64 encoding of the app's release keystore file. Keep an offline, secure backup of that keystore and its passwords. Never share them in chat or commit them.
- If the same application is already distributed, use its original signing key for updates. A different key may prevent an in-place Android update.
- The release workflow intentionally fails if any signing secret is missing. Do not replace this with an unsigned or debug-signed production release.

## Security requirements

- Do not store passwords, OTPs, payment credentials, or trusted role claims in Firestore client-writable documents.
- Do not allow customers to set or modify wallet balances, order totals, service fees, or privileged roles.
- Enforce authorization and financial calculations in trusted Cloud Functions / server code.
- Enforce App Check on supported Firebase services after valid app attestation is configured and tested.
- Use Firebase Auth email verification and a properly designed phone OTP flow; do not treat a client-side phone field as proof of phone ownership.
- Avoid exposing precise location except to the customer and authorized participants during an active booking.
- Investigate any Play Protect harmful-app warning by reviewing the actual APK, signing certificate, permissions, dependencies, and build provenance. Never instruct users to bypass Play Protect.

## Planned sequence

- 2.0: Baseline, authentication hardening, App Check integration plan, rules review, and regression tests.
- 3.0: Device/app attestation enforcement and abuse controls.
- 4.0: Ride booking UX and server-authoritative booking validation.
- 5.0: Food ordering reliability and server-side pricing/fee validation.
- 6.0: Parcel and business-delivery flows.
- 7.0: Customer wallet views and secure deposit/transaction workflows.
- 8.0: Active-booking live location with strict participant authorization.
- 9.0: Notifications, support, and order status updates.
- 10.0: Performance, accessibility, offline/weak-network handling, and crash diagnostics.
- 11.0: Fraud monitoring, session/account protection, and security regression suite.
- 12.0: Consolidated release candidate, end-to-end testing, signed Android build, and release documentation.

## Release gates

A version is not considered complete until its code is implemented, reviewed, tested, and the Android artifact is built and checked. A version label alone does not establish security or feature completeness.
