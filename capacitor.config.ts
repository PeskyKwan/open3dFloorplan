// Capacitor config. (Type import omitted so the web build doesn't require @capacitor/cli
// to be installed; `npx cap` reads this file fine as a plain default-exported object.)
const config = {
  appId: 'com.peskykwan.open3d',
  appName: 'OpenPlan3D',
  // adapter-static writes the SPA here; Capacitor bundles it into the iOS app.
  webDir: 'build',
  // REQUIRED (Capacitor 6+): custom in-app plugins are ONLY registered when their
  // ObjC class name is listed here — without this the JS bridge never sees RoomPlan
  // and the scan button silently falls back to the file picker.
  packageClassList: ['RoomPlanPlugin'],
  ios: {
    contentInset: 'always',
  },
};

export default config;
