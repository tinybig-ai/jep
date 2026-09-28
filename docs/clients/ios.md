# iOS client

A native SwiftUI app under `ios/`, built to the same shape as the Android
client and talking to the same [gateway](../GATEWAY.md). Nothing on the daemon
is iOS-specific except one optional push sender.

```
ios/
  JepKit/   Swift package: Domain · Data (gateway, SSE) · Device (stores) · Presentation (stores, transcript)
  Jep/      the app: SwiftUI screens, Keychain, notifications — generated with XcodeGen
```

`JepKit` is Foundation-only, so its tests run anywhere Swift does:

```sh
cd ios/JepKit && swift test
```

The app needs Xcode 16+ (Xcode 26 for Liquid Glass; older SDKs fall back to
system materials):

```sh
brew install xcodegen
cd ios/Jep && xcodegen generate && open Jep.xcodeproj
```

## Pairing

Same as Android: the gateway's `host:port` and the pairing code from
`npm run pair`. The token lives in the Keychain (this device only); the
gateway address in UserDefaults. Plain `http://` is allowed for local and
Tailscale addresses only (`NSAllowsLocalNetworking`).

## Background notifications

iOS does not let an app hold a stream open in the background. jep does two
things instead, both behind the "Background updates" setting:

1. For the grace period iOS gives a just-backgrounded app, the stream keeps
   playing into local notifications, decided by `NotificationPolicy` exactly as
   on Android.
2. After that, APNs. The app registers its device token with the gateway as
   `apns:<hex>`, and the daemon sends an alert whose words come from the app's
   `Localizable.strings` (a `loc-key`), so the client still owns the wording.

To turn on APNs, set on the daemon:

| variable | value |
| --- | --- |
| `JEP_APNS_KEY` | path to the `.p8` key from Apple Developer → Keys |
| `JEP_APNS_KEY_ID` | that key's id |
| `JEP_APNS_TEAM_ID` | your team id |
| `JEP_APNS_TOPIC` | the app's bundle id (`dev.jep.client` unless you changed it) |
| `JEP_APNS_SANDBOX` | `1` for development builds |

FCM (`JEP_FCM_KEY`) and APNs can be on together; each token goes to the
service that issued it.

## Screen tour

`JepUITests/ScreenTour.swift` walks every screen and sheet against a canned
gateway and keeps a screenshot of each; CI runs it on the newest iPhone
Simulator and uploads the shots and a video as the `ios-screens` artifact.
To run it locally:

```sh
node ios/Jep/JepUITests/demo-gateway.mjs 8931 &
cd ios/Jep && xcodegen generate
xcodebuild -project Jep.xcodeproj -scheme Jep -only-testing:JepUITests/ScreenTour \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

The tour launches at text size S; the demo gateway's pairing code is any code.
