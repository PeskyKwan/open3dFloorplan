/**
 * Room scan bridge.
 *
 * Inside the native iOS app (Capacitor), this calls the native `RoomPlan` plugin
 * which runs Apple RoomPlan (LiDAR) and returns a CapturedRoom JSON string.
 * In a plain browser, it falls back to a file picker (.json/.zip) so the same
 * button works everywhere. Either way you end up in the editor with the scan loaded.
 *
 * We reach Capacitor via the injected `window.Capacitor` global (no static import),
 * so the web build has zero hard dependency on Capacitor and keeps working in any browser.
 */
import { importRoomPlan, extractRoomJsonFromZip } from '$lib/utils/roomplanImport';
import { createDefaultProject, loadProject } from '$lib/stores/project';
import { localStore } from '$lib/services/datastore';
import { goto } from '$app/navigation';

function cap(): any {
  return typeof window !== 'undefined' ? (window as any).Capacitor : undefined;
}

/** True when running inside the native app AND the RoomPlan plugin is present. */
export function isNativeScanAvailable(): boolean {
  const c = cap();
  return !!(c && c.isNativePlatform && c.isNativePlatform() && c.Plugins && c.Plugins.RoomPlan);
}

async function nativeScan(): Promise<any | null> {
  const c = cap();
  const res = await c.Plugins.RoomPlan.scan();
  if (!res || res.cancelled || !res.json) return null;
  return JSON.parse(res.json);
}

async function browserScanFallback(): Promise<any | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.zip';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        const data = file.name.endsWith('.zip')
          ? await extractRoomJsonFromZip(file)
          : JSON.parse(await file.text());
        resolve(data);
      } catch (e: any) {
        alert('讀取掃描檔失敗: ' + e.message);
        resolve(null);
      }
    };
    // Some browsers fire cancel; ignore if unsupported.
    (input as any).oncancel = () => resolve(null);
    input.click();
  });
}

/** Run a scan (native LiDAR or file fallback). Returns parsed CapturedRoom JSON or null if cancelled. */
export async function runRoomScan(): Promise<any | null> {
  return isNativeScanAvailable() ? nativeScan() : browserScanFallback();
}

/** Full flow: scan → import into a fresh project → open the editor. Returns false if cancelled. */
export async function scanAndCreateProject(): Promise<boolean> {
  const data = await runRoomScan();
  if (!data) return false;
  const floor = importRoomPlan(data, { straighten: true, orthogonal: true });
  const np = createDefaultProject('Scan ' + new Date().toLocaleDateString());
  const af = np.floors[0];
  af.walls = floor.walls;
  af.doors = floor.doors;
  af.windows = floor.windows;
  af.furniture = floor.furniture;
  if (floor.stairs) af.stairs = floor.stairs;
  if (floor.columns) af.columns = floor.columns;
  await localStore.save(np);
  loadProject(np);
  await goto('/editor?id=' + np.id);
  return true;
}
