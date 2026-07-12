// Capacitor config. (Type import omitted so the web build doesn't require @capacitor/cli
// to be installed; `npx cap` reads this file fine as a plain default-exported object.)
const config = {
  appId: 'com.peskykwan.open3d',
  appName: 'OpenPlan3D',
  // adapter-static writes the SPA here; Capacitor bundles it into the iOS app.
  webDir: 'build',
  // NOTE: don't try packageClassList here for the in-app RoomPlan plugin — the CLI
  // regenerates that list (empty) on every `cap sync`. Registration happens in
  // native/ios/AppViewController.swift (capacitorDidLoad → registerPluginInstance).
  ios: {
    contentInset: 'always',
  },
};

export default config;
