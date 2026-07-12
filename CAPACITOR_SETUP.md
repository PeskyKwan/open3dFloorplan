# All-in-one iOS app — scan (LiDAR) + edit, one app

Wraps the OpenPlan3D web editor in a native iOS shell (Capacitor) and adds a native
**RoomPlan (LiDAR)** scan screen. In the app: tap **工具 → 掃描 Scan** → scan the room →
you land straight in the editor with that room loaded. One icon, no file juggling.

Web editing stays 100% the code you already have; only a thin native shell + one scan
plugin are added.

## What's already in the repo (done by Claude)
- `svelte.config.js` → **adapter-static** (SPA) so the web build can be bundled into the app.
- `src/routes/+layout.ts` → `ssr = false` (client-only, runs from `file://`).
- `capacitor.config.ts` → appId `com.peskykwan.open3d`, `webDir: 'build'`.
- `package.json` → Capacitor deps + `build:mobile` / `ios` scripts.
- `src/lib/native/roomplanScan.ts` → JS bridge (native scan in the app, file-import fallback in a browser).
- Scan button wired into the mobile **工具** sheet.
- `native/ios/` → the native RoomPlan plugin: `RoomPlanPlugin.swift`, `RoomPlanPlugin.m`, `RoomScanViewController.swift` (reuses HomeScanner's proven `JSONEncoder().encode(CapturedRoom)` — same JSON the importer reads).

## What you run on your Mac (A–B–C)

**A. Install deps + build the web**
```
cd ~/Developer/GitHub/open3dFloorplan
npm install
npm run build          # writes build/ (static SPA)
```

**B. Create the iOS project**
```
npx cap add ios        # creates ios/ (Xcode project) + runs pod install
```

**C. Add the RoomPlan plugin to the app**
Copy the three files into the iOS app target folder:
```
cp native/ios/RoomPlanPlugin.swift native/ios/RoomPlanPlugin.m native/ios/RoomScanViewController.swift ios/App/App/
```
Then in Xcode (next step) make sure those 3 files show under the **App** target
(if not: right-click the App group → *Add Files to "App"…* → pick them → Target = App).
If Xcode offers to create an Objective-C **bridging header**, click **Create** (needed once for the `.m`).

**D. Camera permission + iOS version**
```
npx cap open ios       # opens Xcode
```
In Xcode, select the **App** target:
- **Info** tab → add key **Privacy - Camera Usage Description** (`NSCameraUsageDescription`)
  value: `掃描房間需要用鏡頭`.
- **General** → **Minimum Deployments** = **iOS 16.0** (RoomPlan needs 16+).
- **Signing & Capabilities** → pick your Apple ID **Team**.

**E. Run on your iPhone**
- Plug in the LiDAR iPhone (12 Pro / 13 Pro / 14 Pro / 15 Pro or newer), select it as the run destination.
- Press **▶ Run**. First run: on the phone, Settings → General → VPN & Device Management → trust your dev cert.

**F. Use it**
- App opens on the project list → open a project (or scan into a new one).
- **工具 → 掃描 Scan** → RoomPlan camera opens → walk the room → **完成 Done** → editor loads the scan.

## After you change web code later
```
npm run build && npx cap sync ios      # or:  npm run build:mobile
```
Then Run again in Xcode.

## Notes / gotchas
- **Simulator can't scan** — RoomPlan/LiDAR only works on a real LiDAR device. In the Simulator (or any browser) the Scan button falls back to a file picker.
- Change app name / id in `capacitor.config.ts` (then `npx cap sync ios`).
- The JS calls `window.Capacitor.Plugins.RoomPlan.scan()`. That global only exists inside the app, so the same button safely file-imports in Safari.
- Desktop DMG later: the same static `build/` can be wrapped with Tauri/Electron — no rework.
