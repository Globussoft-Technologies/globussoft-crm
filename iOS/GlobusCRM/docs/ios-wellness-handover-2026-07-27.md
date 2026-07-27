# iOS Wellness CRM Handover - 2026-07-27

## Scope

This handover covers the iOS work completed in `iOS/GlobusCRM` to align the app with the Android Wellness CRM project at:

`/Users/sumitghosh/Downloads/WellnessCRM`

It also includes the supplied splash artwork:

`/Users/sumitghosh/Downloads/Dr v.png`

Current branch at handover: `iOS/Development`

## Phase Commits

| Commit | Summary |
| --- | --- |
| `7eb85ea9` | Ported wellness treatment workflows and medication reminders. |
| `1e09047a` | Added Android wellness branding assets and applied them to login/splash UI. |
| `e7a66d07` | Replaced the app icon with the wellness mark. |
| `722f4efe` | Added the supplied Dr. Enhance splash artwork. |
| `8e5df737` | Aligned color theme with Android and added system/light/dark appearance controls. |
| `7b6c2ac2` | Aligned notification REST, cache, push-tap, and deep-link flow with Android. |
| `13726bad` | Added auth stack navigation handling and enabled iPhone/iPad target families. |
| `aeb40809` | Set the app display name to `Dr. Enhance Wellness`. |
| `0a6a047c` | Raised all explicit iOS deployment targets to `18.0`. |
| `9150de0a` | Fixed membership join behavior to show the clinic-contact alert. |

## Implemented Changes

### Treatment Analysis

- Added `GlobusCRM/Features/TreatmentAnalysis/` with domain, repository, use case, view model, and SwiftUI view layers.
- Added local draft persistence for before/after treatment captures.
- Added image processing and quality checks before saving or uploading captures.
- Added upload support for `wellness/visits/{visitId}/photos` with stage-specific `kind` values.
- Added treatment analysis navigation from prescription rows and deep links.
- Added camera/photo permissions in `GlobusCRM/Info.plist`.

### Medication Reminders

- Added `GlobusCRM/Features/Health/Reminder/MedicationReminderScheduler.swift`.
- Added prescription row reminder toggles and local notification scheduling.
- Added parser coverage for common frequency and duration strings.

### Branding, Logo, App Icon, and Splash

- Added Android-derived brand assets:
  - `GlobusCRM/Assets.xcassets/GlobusCRMLogo.imageset/`
  - `GlobusCRM/Assets.xcassets/WellnessLogo.imageset/`
  - `GlobusCRM/Assets.xcassets/WellnessSplashLogo.imageset/`
- Replaced the app icon asset with `wellness_app_icon.png`.
- Replaced splash artwork with the supplied `Dr v.png` image as `dr_v.png`.
- Updated login and splash surfaces to use the wellness logo/artwork.

### Theme and Appearance

- Updated wellness colors in `Color+Wellness.swift` and `Color+Dynamic.swift` to match the Android gold/silver/onyx direction.
- Added `AppThemePreference` with `.system`, `.light`, and `.dark`.
- Default appearance now follows the system theme.
- Added Profile appearance controls for System, Light, and Dark.
- Preserved migration from the old `wellness.isDarkTheme` flag when present.

### Notifications

- Updated iOS notification DTO decoding to match the live backend/Android shape:
  - `message` maps to body.
  - `link` maps to screen/destination.
  - `count` maps to total.
  - `unreadCount` is decoded.
- Changed mark-read and mark-all-read calls to accept empty success bodies.
- Updated local notification cache to replace existing IDs instead of ignoring server updates.
- Added Android-compatible deep-link handling for:
  - `globuscrm://screen/...`
  - snake_case routes such as `treatment_plans`, `consent_forms`, `gift_cards`, and `visit_history`
  - path links such as `/wallet/transactions`
- Wired push tap events posted through `.handleDeepLink` into `RootView`.
- Updated inbox navigation to canonicalize notification destinations before routing.

### Navigation and Device Support

- Added auth stack handling in `AppRouter` so `.register` pushes on the unauthenticated path.
- Updated router back behavior to pop the auth path first when present.
- Enabled target device family `1,2` for iPhone and iPad.

### App Identity and Deployment

- Set app display name to `Dr. Enhance Wellness` for Debug and Release.
- Verified the generated app bundle contains:
  - `CFBundleDisplayName = Dr. Enhance Wellness`
  - `MinimumOSVersion = 18.0`
- Raised project, app target, and test target deployment settings to iOS `18.0`.

### Memberships

- Matched Android behavior for membership joining.
- Tapping Join Now now shows an alert:
  - title: `Join membership?`
  - message: `Contact the clinic to purchase <plan name>.`
- Removed the unsupported in-app membership purchase call that previously set an error state.
- Removed unused joining/success UI state.

## Verification Performed

Primary simulator build command used after the latest changes:

```bash
xcodebuild -quiet -project GlobusCRM.xcodeproj -scheme GlobusCRM -configuration Debug -sdk iphonesimulator -derivedDataPath /private/tmp/GlobusCRMMembershipBuild build
```

Focused test command used after the latest changes:

```bash
xcodebuild -quiet -project GlobusCRM.xcodeproj -scheme GlobusCRM -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.5' -derivedDataPath /private/tmp/GlobusCRMMembershipBuild -only-testing:GlobusCRMTests test
```

Additional checks performed during the phase work:

```bash
git diff --check
plutil -lint GlobusCRM.xcodeproj/project.pbxproj
```

The latest build and focused `GlobusCRMTests` run passed.

Known warnings during iOS 18 builds:

- Existing `onChange(of:perform:)` deprecation warnings appear in:
  - `GlobusCRM/Features/Profile/Presentation/ProfileView.swift`
  - `GlobusCRM/Features/TreatmentAnalysis/Presentation/TreatmentAnalysisView.swift`
  - `GlobusCRM/Features/Booking/Presentation/BookAppointment/Steps/Step3DateTimeView.swift`

These warnings do not block the build.

## Tests Added or Updated

The single test file `GlobusCRMTests/GlobusCRMTests.swift` now includes coverage for:

- Treatment analysis draft status helpers.
- Medication reminder frequency/duration parsing.
- Theme preference defaulting to system and honoring light/dark overrides.
- Android-compatible deep links and snake_case aliases.
- Live notification response decoding with `message`, `link`, `unreadCount`, and `count`.
- Notification cache replacement by ID.
- Membership join prompt behavior, ensuring the alert dismisses without attempting the unsupported join API.

## Remaining Gaps and Follow-Up

### Notifications

Android has `WellnessSocketManager` listening to Socket.IO `notification_new`, inserting the notification locally, and showing a system notification immediately. iOS still has no Socket.IO/WebSocket client wired for this flow.

iOS APNs registration currently stores the device token locally through `KeychainManager.saveAPNsToken(_:)`. No backend upload call is wired yet, even though `WellnessEndpoint.fcmToken` exists.

### Display Name on Real Device

The built bundle contains `CFBundleDisplayName = Dr. Enhance Wellness`. If the Home Screen still shows a name without visible spacing, it is most likely because:

- the installed device build is old and should be deleted/reinstalled, or
- iOS is truncating/wrapping the long Home Screen icon label.

For a shorter visible Home Screen name, use something like `Dr. Enhance`.

### iOS 18 Cleanup

Because the minimum deployment target is now iOS 18, the remaining `onChange(of:perform:)` usages can be updated to the newer `onChange` closure form in a separate cleanup commit.

## Current Working Tree

At the time this handover was created, the working tree was clean before adding this document.
