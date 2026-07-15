/**
 * Mobile e2e suite — simulates REAL iPhone usage of the Capacitor app against
 * the static build, with window.Capacitor mocked (native scan returns
 * build/test-room2.json). Run:  node tests/mobile_e2e.mjs
 *
 * Uses the __o3d debug hook (world→screen) so taps land EXACTLY on elements.
 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { extname, join } from 'path';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  let f = join('./build', req.url.split('?')[0]);
  if (!existsSync(f) || req.url === '/') f = join('./build', 'index.html');
  try { res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' }); res.end(readFileSync(f)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(8899, r));

const scanJson = readFileSync('./build/test-room2.json', 'utf8');
const chromiumCandidates = [
  process.env.PW_CHROMIUM,
  '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromiumExecutable = chromiumCandidates.find((path) => existsSync(path));
if (!chromiumExecutable) {
  throw new Error(`No Chromium executable found. Checked: ${chromiumCandidates.join(', ')}`);
}
const browser = await chromium.launch({ executablePath: chromiumExecutable });
const ctx = await browser.newContext({ viewport: { width: 428, height: 926 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await ctx.addInitScript(`window.Capacitor = { isNativePlatform: () => true, Plugins: { RoomPlan: { scan: async () => ({ json: ${JSON.stringify(scanJson)} }) } } };`);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

let pass = 0, fail = 0;
async function check(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ❌ FAIL: ' + name); } }
const sleep = (ms) => page.waitForTimeout(ms);

// ── store helpers (read the saved project like the app does) ──
async function floorData() {
  return page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('floorplan_projects') || '{}');
    const ps = Object.values(all).map(raw => JSON.parse(raw));
    ps.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
    const p = ps[ps.length - 1];
    const fl = p.floors.find(f => f.id === p.activeFloorId) ?? p.floors[0];
    return { projectId: p.id, walls: fl.walls, doors: fl.doors ?? [], windows: fl.windows ?? [], furniture: fl.furniture ?? [] };
  });
}
// tap at WORLD coordinates using the debug hook
async function tapWorld(x, y) {
  await page.evaluate(([wx, wy]) => {
    const s = window.__o3d.worldToScreen(wx, wy);
    const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const fire = (type) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 11, isPrimary: true, pointerType: 'touch', clientX: s.x, clientY: s.y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
    fire('pointerdown'); fire('pointerup');
  }, [x, y]);
  await sleep(250);
}
async function dragWorld(x1, y1, x2, y2, steps = 12) {
  await page.evaluate(([ax, ay, bx, by, n]) => new Promise((resolve) => {
    const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const A = window.__o3d.worldToScreen(ax, ay), B = window.__o3d.worldToScreen(bx, by);
    const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 12, isPrimary: true, pointerType: 'touch', clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
    fire('pointerdown', A.x, A.y);
    let i = 0;
    const iv = setInterval(() => {
      i++;
      fire('pointermove', A.x + (B.x - A.x) * i / n, A.y + (B.y - A.y) * i / n);
      if (i >= n) { clearInterval(iv); fire('pointerup', B.x, B.y); resolve(true); }
    }, 16);
  }), [x1, y1, x2, y2, steps]);
  await sleep(300);
}
function wallPt(w, t) { return { x: w.start.x + (w.end.x - w.start.x) * t, y: w.start.y + (w.end.y - w.start.y) * t }; }
function panelOpen(txt) { return page.evaluate((t) => document.body.innerText.includes(t), txt); }
// geometry: does furniture AABB overlap any wall band?
function overlapsWalls(fi, walls, dims) {
  const a = ((fi.rotation ?? 0) * Math.PI) / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
  const w = dims.w * c + dims.d * sn, h = dims.w * sn + dims.d * c;
  for (const wl of walls) {
    const dx = wl.end.x - wl.start.x, dy = wl.end.y - wl.start.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len, ht = (wl.thickness ?? 15) / 2;
    // sample along the wall, check point-in-AABB with wall thickness padding
    for (let t = 0; t <= 1; t += 0.02) {
      const px = wl.start.x + dx * t, py = wl.start.y + dy * t;
      for (const s of [-1, 1]) {
        const qx = px + nx * ht * s * 0.9, qy = py + ny * ht * s * 0.9;
        if (Math.abs(qx - fi.position.x) < w / 2 - 12 && Math.abs(qy - fi.position.y) < h / 2 - 12) return true;
      }
    }
  }
  return false;
}

// ═══ SCENARIO 1: scan → editor imports everything ═══
console.log('\nS1 scan → editor');
await page.goto('http://localhost:8899/');
await sleep(1000);
await page.getByRole('button', { name: '掃描房間' }).first().tap();
await page.waitForURL(/\/editor/); await sleep(1800);
let fd = await floorData();
await check(`imported walls (${fd.walls.length}) / doors (${fd.doors.length}) / windows (${fd.windows.length}) / furniture (${fd.furniture.length})`,
  fd.walls.length > 10 && fd.doors.length >= 3 && fd.windows.length >= 3 && fd.furniture.length > 8);

// ═══ SCENARIO 2 (Sum's bug): table beside a window still gets the tap ═══
console.log('\nS2 tap furniture parked beside a window');
const win0 = fd.windows[0];
const wWall = fd.walls.find(w => w.id === win0.wallId);
const wc = wallPt(wWall, win0.position);
// wall normal → a point INSIDE the plan, half-a-table away from the window
const wl = Math.hypot(wWall.end.x - wWall.start.x, wWall.end.y - wWall.start.y) || 1;
const nx = -(wWall.end.y - wWall.start.y) / wl, ny = (wWall.end.x - wWall.start.x) / wl;
// try both sides; pick the one that lands nearer the plan centroid
const cx0 = fd.walls.reduce((s, w) => s + w.start.x + w.end.x, 0) / (fd.walls.length * 2);
const cy0 = fd.walls.reduce((s, w) => s + w.start.y + w.end.y, 0) / (fd.walls.length * 2);
const side = ((wc.x + nx * 100 - cx0) ** 2 + (wc.y + ny * 100 - cy0) ** 2) < ((wc.x - nx * 100 - cx0) ** 2 + (wc.y - ny * 100 - cy0) ** 2) ? 1 : -1;
const tablePos = { x: wc.x + nx * side * 75, y: wc.y + ny * side * 75 }; // 75cm from wall centre — flush-ish for a 90cm-deep table
// place a table via the sheet, then DRAG it beside the window
await page.getByText('傢俬', { exact: true }).tap(); await sleep(400);
await page.getByPlaceholder('搵傢俬…').fill('table'); await sleep(300);
let tiles = page.locator('.absolute.left-0.right-0.bottom-0.z-50 .grid.grid-cols-3 button');
if (await tiles.count() === 0) { await page.getByPlaceholder('搵傢俬…').fill(''); await sleep(300); }
await tiles.first().tap(); await sleep(500);
fd = await floorData();
const table = fd.furniture[fd.furniture.length - 1];
await dragWorld(table.position.x, table.position.y, tablePos.x, tablePos.y);
await tapWorld(0, -10000); await sleep(200); // deselect far away (empty space)
fd = await floorData();
const tNow = fd.furniture[fd.furniture.length - 1];
await tapWorld(tNow.position.x, tNow.position.y);
const gotFurniturePanel = await panelOpen('貼牆');
const gotWindowPanel = await panelOpen('窗 Window');
await check('tap on the table selects the TABLE (not the window)', gotFurniturePanel && !gotWindowPanel);
await page.screenshot({ path: '/tmp/e2e_s2.png' });

// ═══ SCENARIO 3: the window itself is still selectable ═══
console.log('\nS3 window still selectable');
await tapWorld(0, -10000); await sleep(150);
await tapWorld(wc.x, wc.y);
await check('tap on the window opens 窗 panel', await panelOpen('窗 Window'));

// ═══ SCENARIO 4: door select + resize via steppers ═══
console.log('\nS4 door select + stepper resize');
await tapWorld(0, -10000);
const door0 = fd.doors[0];
const dWall = fd.walls.find(w => w.id === door0.wallId);
const dc = wallPt(dWall, door0.position);
await tapWorld(dc.x, dc.y);
const doorPanel = await panelOpen('門 Door');
await check('tap on a door opens 門 panel', doorPanel);
if (doorPanel) {
  const doorsBefore = fd.doors.map(d => d.width);
  await page.getByLabel('Door wider').tap(); await sleep(1000);
  fd = await floorData();
  const grew = fd.doors.filter((d, i) => d.width === doorsBefore[i] + 5).length;
  const same = fd.doors.filter((d, i) => d.width === doorsBefore[i]).length;
  await check(`exactly one door grew +5 (${grew} grew, ${same} unchanged)`, grew === 1 && same === fd.doors.length - 1);
}

// ═══ SCENARIO 5: wall select needs a tap BETWEEN openings ═══
console.log('\nS5 wall select');
await tapWorld(0, -10000);
// find a wall with no door/window on it
const busy = new Set([...fd.doors.map(d => d.wallId), ...fd.windows.map(w => w.wallId)]);
const quietWalls = fd.walls.filter(w => !busy.has(w.id)).sort((a, b) =>
  Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y) - Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y));
function clearOfFurniture(pt) {
  return fd.furniture.every(f => Math.hypot(f.position.x - pt.x, f.position.y - pt.y) > 130);
}
let quietWall = quietWalls[0], qc = wallPt(quietWall, 0.5);
outer: for (const w of quietWalls) {
  for (const t of [0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6]) {
    const pt = wallPt(w, t);
    if (clearOfFurniture(pt)) { quietWall = w; qc = pt; break outer; }
  }
}
await tapWorld(qc.x, qc.y);
await check('tap on a bare wall opens 牆 panel', await panelOpen('牆 Wall'));

// ═══ SCENARIO 6: wall height + apply-all ═══
console.log('\nS6 wall height apply-all');
if (await panelOpen('牆高')) {
  await page.getByText('呢個高度套用去全部牆').tap(); await sleep(800);
  fd = await floorData();
  const hs = new Set(fd.walls.map(w => Math.round(w.height)));
  await check(`apply-all → every wall same height (${[...hs].join(',')})`, hs.size === 1);
}

// ═══ SCENARIO 7: drag furniture INTO a wall → pushed out on release ═══
console.log('\nS7 drop-on-wall push-out');
await tapWorld(0, -10000);
fd = await floorData();
const t7 = fd.furniture.find(f => f.width && f.depth); // scanned piece: dims known
const i7 = fd.furniture.indexOf(t7);
const midWall = quietWall;
const mwC = wallPt(midWall, 0.5);
await dragWorld(t7.position.x, t7.position.y, mwC.x, mwC.y);
await sleep(1100);
fd = await floorData();
const t7b = fd.furniture[i7];
const dims7 = { w: t7b.width, d: t7b.depth };
await check(`furniture (${dims7.w}×${dims7.d}) released on a wall does not REST inside it`, !overlapsWalls(t7b, fd.walls, dims7));

// ═══ SCENARIO 8: two-finger twist rotates; finger-1 mis-tap doesn't steal selection ═══
console.log('\nS8 twist + selection survival');
fd = await floorData();
const t8 = fd.furniture[fd.furniture.length - 1];
await tapWorld(t8.position.x, t8.position.y);
await check('furniture selected before gesture', await panelOpen('貼牆'));
await page.evaluate(([wx, wy]) => new Promise((resolve) => {
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const c = window.__o3d.worldToScreen(wx, wy);
  const mkT = (id, x, y) => new Touch({ identifier: id, target: canvas, clientX: x, clientY: y });
  const fireT = (type, touches) => canvas.dispatchEvent(new TouchEvent(type, { touches, changedTouches: touches, bubbles: true, cancelable: true }));
  const fireP = (type, pid, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: pid, isPrimary: pid === 1, pointerType: 'touch', clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
  const f1 = { x: c.x - 200, y: c.y - 200 }, f2 = { x: c.x + 90, y: c.y };
  fireP('pointerdown', 1, f1.x, f1.y); fireT('touchstart', [mkT(1, f1.x, f1.y)]);
  setTimeout(() => {
    fireP('pointerdown', 2, f2.x, f2.y); fireT('touchstart', [mkT(1, f1.x, f1.y), mkT(2, f2.x, f2.y)]);
    let i = 0;
    const iv = setInterval(() => {
      i++;
      const ang = i * 0.10; // rotate finger pair
      const r1 = { x: c.x - 200 * Math.cos(ang) + 0 , y: c.y - 200 * Math.sin(ang) - 200 * Math.cos(ang) * 0 };
      // simple circular motion of finger 1 around centre, finger 2 fixed-ish
      const rr = { x: c.x + Math.cos(Math.PI + ang) * 220, y: c.y + Math.sin(Math.PI + ang) * 220 };
      const f2r = { x: c.x + Math.cos(ang) * 90, y: c.y + Math.sin(ang) * 90 };
      fireP('pointermove', 1, rr.x, rr.y); fireP('pointermove', 2, f2r.x, f2r.y);
      fireT('touchmove', [mkT(1, rr.x, rr.y), mkT(2, f2r.x, f2r.y)]);
      if (i >= 9) { clearInterval(iv); fireP('pointerup', 1, rr.x, rr.y); fireP('pointerup', 2, f2r.x, f2r.y); fireT('touchend', []); resolve(true); }
    }, 25);
  }, 60);
}), [t8.position.x, t8.position.y]);
await sleep(1200);
fd = await floorData();
const t8b = fd.furniture[fd.furniture.length - 1];
await check(`twist rotated the selected piece (${Math.round(t8.rotation ?? 0)}→${Math.round(t8b.rotation ?? 0)})`, Math.round(t8b.rotation ?? 0) !== Math.round(t8.rotation ?? 0));
await check('selection panel still open after gesture', await panelOpen('貼牆'));

// ═══ SCENARIO 9: 轉90° straightens, 貼牆 flushes ═══
console.log('\nS9 轉90° + 貼牆');
await page.getByText('轉 90°').tap(); await sleep(600);
fd = await floorData();
const t9 = fd.furniture[fd.furniture.length - 1];
await check(`轉90° → rotation is a multiple of 90 (${Math.round(t9.rotation)})`, Math.round(t9.rotation) % 90 === 0);
await page.getByText('貼牆').tap(); await sleep(700);
fd = await floorData();
const t9b = fd.furniture[fd.furniture.length - 1];
const moved9 = Math.hypot(t9b.position.x - t9.position.x, t9b.position.y - t9.position.y);
// nearest wall distance from final position ≈ depth/2 + halfThickness
let bestGap = Infinity;
for (const w of fd.walls) {
  const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y, len = Math.hypot(dx, dy) || 1;
  const t = Math.max(0, Math.min(1, ((t9b.position.x - w.start.x) * dx + (t9b.position.y - w.start.y) * dy) / (len * len)));
  const px = w.start.x + dx * t, py = w.start.y + dy * t;
  bestGap = Math.min(bestGap, Math.hypot(t9b.position.x - px, t9b.position.y - py));
}
const dims9 = { w: t9b.width ?? 200, d: t9b.depth ?? 90 };
await check(`貼牆 pulls the piece against a wall (gap ${Math.round(bestGap)}cm ≈ depth/2+thick/2)`, bestGap < dims9.d / 2 + 25);

// ═══ SCENARIO 10: pinch resizes selected door, zoom untouched ═══
console.log('\nS10 pinch door resize (zoom must not move)');
await tapWorld(0, -10000);
fd = await floorData();
const d10 = fd.doors[0];
const dW = fd.walls.find(w => w.id === d10.wallId);
const dC = wallPt(dW, d10.position);
await tapWorld(dC.x, dC.y);
await check('door selected', await panelOpen('門 Door'));
const zoomBefore = await page.evaluate(() => window.__o3d.getView().zoom);
await page.evaluate(([wx, wy]) => new Promise((resolve) => {
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const c = window.__o3d.worldToScreen(wx, wy);
  const mkT = (id, x, y) => new Touch({ identifier: id, target: canvas, clientX: x, clientY: y });
  const fireT = (type, touches) => canvas.dispatchEvent(new TouchEvent(type, { touches, changedTouches: touches, bubbles: true, cancelable: true }));
  const fireP = (type, pid, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: pid, isPrimary: pid === 1, pointerType: 'touch', clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
  let R = 60;
  fireP('pointerdown', 1, c.x - R, c.y + 150); fireT('touchstart', [mkT(1, c.x - R, c.y + 150)]);
  fireP('pointerdown', 2, c.x + R, c.y + 150); fireT('touchstart', [mkT(1, c.x - R, c.y + 150), mkT(2, c.x + R, c.y + 150)]);
  let i = 0;
  const iv = setInterval(() => {
    i++; R = 60 + i * 10;
    fireP('pointermove', 1, c.x - R, c.y + 150); fireP('pointermove', 2, c.x + R, c.y + 150);
    fireT('touchmove', [mkT(1, c.x - R, c.y + 150), mkT(2, c.x + R, c.y + 150)]);
    if (i >= 8) { clearInterval(iv); fireP('pointerup', 1, c.x - R, c.y + 150); fireP('pointerup', 2, c.x + R, c.y + 150); fireT('touchend', []); resolve(true); }
  }, 25);
}), [dC.x, dC.y]);
await sleep(1200);
fd = await floorData();
const zoomAfter = await page.evaluate(() => window.__o3d.getView().zoom);
await check(`pinch widened the door (${d10.width + 5}→${fd.doors[0].width})`, fd.doors[0].width > d10.width + 10);
await check(`canvas zoom untouched while adjusting (${zoomBefore.toFixed(2)}→${zoomAfter.toFixed(2)})`, Math.abs(zoomAfter - zoomBefore) < 0.01);

// ═══ SCENARIO 11: pinch with NOTHING selected zooms the canvas ═══
console.log('\nS11 pinch-zoom when deselected');
await tapWorld(0, -10000); await sleep(300);
const z0 = await page.evaluate(() => window.__o3d.getView().zoom);
await page.evaluate(() => new Promise((resolve) => {
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const r = canvas.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const mkT = (id, x, y) => new Touch({ identifier: id, target: canvas, clientX: x, clientY: y });
  const fireT = (type, touches) => canvas.dispatchEvent(new TouchEvent(type, { touches, changedTouches: touches, bubbles: true, cancelable: true }));
  const fireP = (type, pid, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: pid, isPrimary: pid === 1, pointerType: 'touch', clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
  let R = 60;
  fireP('pointerdown', 1, cx - R, cy); fireT('touchstart', [mkT(1, cx - R, cy)]);
  fireP('pointerdown', 2, cx + R, cy); fireT('touchstart', [mkT(1, cx - R, cy), mkT(2, cx + R, cy)]);
  let i = 0;
  const iv = setInterval(() => {
    i++; R = 60 + i * 10;
    fireP('pointermove', 1, cx - R, cy); fireP('pointermove', 2, cx + R, cy);
    fireT('touchmove', [mkT(1, cx - R, cy), mkT(2, cx + R, cy)]);
    if (i >= 8) { clearInterval(iv); fireP('pointerup', 1, cx - R, cy); fireP('pointerup', 2, cx + R, cy); fireT('touchend', []); resolve(true); }
  }, 25);
}));
await sleep(500);
const z1 = await page.evaluate(() => window.__o3d.getView().zoom);
await check(`pinch-out zoomed in (${z0.toFixed(2)}→${z1.toFixed(2)}) exactly once`, z1 > z0 * 1.5 && z1 < z0 * 4);

// ═══ SCENARIO 12: one-finger pan on empty space ═══
console.log('\nS12 one-finger pan');
const v0 = await page.evaluate(() => window.__o3d.getView());
await page.evaluate(() => new Promise((resolve) => {
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const r = canvas.getBoundingClientRect();
  const sx = r.left + r.width / 2, sy = r.top + 100;
  const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 5, isPrimary: true, pointerType: 'touch', clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
  fire('pointerdown', sx, sy);
  let i = 0;
  const iv = setInterval(() => { i++; fire('pointermove', sx + i * 15, sy + i * 8); if (i >= 8) { clearInterval(iv); fire('pointerup', sx + 120, sy + 64); resolve(true); } }, 20);
}));
await sleep(400);
const v1 = await page.evaluate(() => window.__o3d.getView());
await check(`one-finger drag panned the camera (${Math.round(v0.camX)}→${Math.round(v1.camX)})`, Math.abs(v1.camX - v0.camX) > 20);

// ═══ SCENARIO 13: auto-arrange keeps good pieces + undo restores ═══
console.log('\nS13 arrange + undo');
fd = await floorData();
const posBefore = fd.furniture.map(f => `${Math.round(f.position.x)},${Math.round(f.position.y)}`).join('|');
await page.getByLabel('更多').tap(); await sleep(250);
await page.getByText('執位 / 試位', { exact: true }).tap(); await sleep(400);
await page.getByText('一鍵執靚').tap(); await sleep(1200);
const msg = await page.locator('button:has-text("一鍵執靚")').textContent();
await check('arrange reports kept-in-place pieces', /原位冇郁|全部擺得好/.test(msg));
await page.locator('.absolute.inset-0.z-40').first().tap().catch(() => {}); await sleep(400);
await page.getByLabel('Undo 復原').tap(); await sleep(800);
fd = await floorData();
const posAfterUndo = fd.furniture.map(f => `${Math.round(f.position.x)},${Math.round(f.position.y)}`).join('|');
await check('undo restores pre-arrange layout', posAfterUndo === posBefore);

// ═══ SCENARIO 14: add window on a wall; door type → opening persists ═══
console.log('\nS14 add window + opening type');
const winCountBefore = fd.windows.length;
await page.getByLabel('更多').tap(); await sleep(250);
await page.getByText('加入項目', { exact: true }).tap(); await sleep(400);
await page.getByText('🪟 窗', { exact: true }).tap(); await sleep(400);
await tapWorld(qc.x, qc.y); await sleep(400);
fd = await floorData();
await check(`加窗 on a bare wall (${winCountBefore}→${fd.windows.length})`, fd.windows.length === winCountBefore + 1);
// door → opening
await tapWorld(0, -10000);
await tapWorld(dC.x, dC.y); await sleep(300);
if (await panelOpen('門 Door')) {
  await page.locator('select').first().selectOption('opening'); await sleep(600);
  fd = await floorData();
  await check('door type 冇門淨開口 persisted', fd.doors[0].type === 'opening');
}

// ═══ SCENARIO 15: back to list → reopen → everything still there ═══
console.log('\nS15 persistence round-trip');
const fdBefore = await floorData();
await page.getByLabel('返去專案列表').tap(); await sleep(900);
await page.locator('h3').first().tap();
await page.waitForURL(/\/editor/); await sleep(1200);
fd = await floorData();
await check('project reopens with identical content',
  fd.walls.length === fdBefore.walls.length && fd.doors.length === fdBefore.doors.length &&
  fd.windows.length === fdBefore.windows.length && fd.furniture.length === fdBefore.furniture.length);

// ═══ SCENARIO 16: 3D + secure mobile AI Render flow ═══
console.log('\nS16 3D + AI Render mobile flow');
await page.getByLabel('3D 睇').tap(); await sleep(4000);
await check('3D loads (平面 tab stays visible)', await page.getByLabel('平面 Plan').count() > 0);

let renderRequest = null;
let gptRenderRequest = null;
let renderAttempt = 0;
await page.route('https://asia-east2-openplan3d-55cb6.cloudfunctions.net/aiRender', async (route) => {
  renderAttempt++;
  renderRequest = {
    authorization: route.request().headers().authorization,
    body: route.request().postDataJSON(),
  };
  if (renderAttempt === 2) {
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Mock backend failure for mobile error visibility test.' }),
    });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      model: 'gemini-3.1-flash-image',
    }),
  });
});
await page.route('https://us-central1-openplan3d-55cb6.cloudfunctions.net/aiRenderOpenAIComparison', async (route) => {
  gptRenderRequest = {
    authorization: route.request().headers().authorization,
    body: route.request().postDataJSON(),
  };
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      model: 'gpt-image-2',
    }),
  });
});
await page.getByTestId('mobile-ai-render').tap();
const canvas3d = page.locator('canvas').last();
const canvas3dBox = await canvas3d.boundingBox();
if (canvas3dBox) {
  const placementCandidates = [
    [0.5, 0.65], [0.4, 0.55], [0.6, 0.55], [0.35, 0.7], [0.65, 0.7], [0.5, 0.8],
  ];
  for (const [x, y] of placementCandidates) {
    await canvas3d.tap({ position: { x: canvas3dBox.width * x, y: canvas3dBox.height * y } });
    await sleep(350);
    if (await page.getByTestId('ai-camera-panel').count()) break;
  }
}
await sleep(400);
const aiPanel = page.getByTestId('ai-render-panel');
await check('AI Render bottom sheet opens on iPhone', await aiPanel.count() === 1);
const aiPanelBox = await page.getByTestId('ai-camera-panel').boundingBox();
await check('AI Render sheet stays inside 428×926 viewport', !!aiPanelBox && aiPanelBox.x >= 0 && aiPanelBox.y >= 0 && aiPanelBox.x + aiPanelBox.width <= 428 && aiPanelBox.y + aiPanelBox.height <= 926);
const aiScroller = page.getByTestId('ai-camera-scroll');
await sleep(500);
const previewHealth = await aiScroller.locator('canvas').first().evaluate((canvas) => {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { visible: 0, total: 0 };
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let visible = 0, total = 0;
  for (let i = 0; i < pixels.length; i += 320) {
    total++;
    if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 24) visible++;
  }
  return { visible, total };
});
await check('interior camera preview contains visible pixels (not black)', previewHealth.total > 0 && previewHealth.visible / previewHealth.total > 0.05 && await page.getByTestId('camera-preview-warning').count() === 0);
const previewGesture = page.getByTestId('camera-preview-gesture');
const gestureBox = await previewGesture.boundingBox();
await check('AI camera identifies the current room',
  (await page.getByTestId('camera-room-label').textContent())?.includes('Room'));
const yawBefore = Number(await previewGesture.getAttribute('data-camera-yaw'));
if (gestureBox) {
  await page.mouse.move(gestureBox.x + gestureBox.width * 0.5, gestureBox.y + gestureBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(gestureBox.x + gestureBox.width * 0.75, gestureBox.y + gestureBox.height * 0.4, { steps: 6 });
  await page.mouse.up();
  await sleep(400);
}
const yawAfter = Number(await previewGesture.getAttribute('data-camera-yaw'));
await check('single-finger/mouse drag rotates the AI camera', !!gestureBox && Math.abs(yawAfter - yawBefore) > 5);
// Return to the original into-room view before testing floor navigation.
if (gestureBox) {
  await page.mouse.move(gestureBox.x + gestureBox.width * 0.5, gestureBox.y + gestureBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(gestureBox.x + gestureBox.width * 0.25, gestureBox.y + gestureBox.height * 0.6, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
}
const positionBeforeNavigate = {
  x: Number(await previewGesture.getAttribute('data-camera-x')),
  z: Number(await previewGesture.getAttribute('data-camera-z')),
};
const navigateCountBefore = Number(await previewGesture.getAttribute('data-camera-navigate-count'));
if (gestureBox) {
  const floorCandidates = [
    [0.5, 0.65], [0.35, 0.65], [0.65, 0.65],
    [0.5, 0.75], [0.25, 0.75], [0.75, 0.75],
    [0.35, 0.85], [0.65, 0.85],
  ];
  for (const [x, y] of floorCandidates) {
    await previewGesture.dblclick({ position: { x: gestureBox.width * x, y: gestureBox.height * y }, delay: 80 });
    await sleep(250);
    if (Number(await previewGesture.getAttribute('data-camera-navigate-count')) > navigateCountBefore) break;
  }
}
const positionAfterNavigate = {
  x: Number(await previewGesture.getAttribute('data-camera-x')),
  z: Number(await previewGesture.getAttribute('data-camera-z')),
};
const navigateCountAfter = Number(await previewGesture.getAttribute('data-camera-navigate-count'));
await check('double tap moves the AI camera toward the tapped floor',
  !!gestureBox && navigateCountAfter === navigateCountBefore + 1 &&
  Math.hypot(positionAfterNavigate.x - positionBeforeNavigate.x, positionAfterNavigate.z - positionBeforeNavigate.z) > 10);
const positionBeforeRejectedNavigate = {
  x: Number(await previewGesture.getAttribute('data-camera-x')),
  z: Number(await previewGesture.getAttribute('data-camera-z')),
};
const countBeforeRejectedNavigate = Number(await previewGesture.getAttribute('data-camera-navigate-count'));
if (gestureBox) {
  await previewGesture.dblclick({ position: { x: gestureBox.width * 0.5, y: gestureBox.height * 0.12 }, delay: 80 });
  await sleep(250);
}
const positionAfterRejectedNavigate = {
  x: Number(await previewGesture.getAttribute('data-camera-x')),
  z: Number(await previewGesture.getAttribute('data-camera-z')),
};
await check('double tap outside visible floor never teleports through walls',
  Number(await previewGesture.getAttribute('data-camera-navigate-count')) === countBeforeRejectedNavigate &&
  Math.hypot(
    positionAfterRejectedNavigate.x - positionBeforeRejectedNavigate.x,
    positionAfterRejectedNavigate.z - positionBeforeRejectedNavigate.z,
  ) < 1);
await check('rejected camera navigation explains what happened',
  (await page.getByTestId('camera-navigation-notice').textContent())?.includes('唔係地板'));
const previousPositionButton = page.getByLabel('AI camera previous position');
const previousPositionWasEnabled = await previousPositionButton.isEnabled();
if (previousPositionWasEnabled) {
  await previousPositionButton.tap();
  await sleep(300);
}
const positionAfterBack = {
  x: Number(await previewGesture.getAttribute('data-camera-x')),
  z: Number(await previewGesture.getAttribute('data-camera-z')),
};
await check('Previous Position restores the camera after entering a room',
  previousPositionWasEnabled &&
  Math.hypot(positionAfterBack.x - positionBeforeNavigate.x, positionAfterBack.z - positionBeforeNavigate.z) < 2);
const touchPinchFovBefore = Number(await previewGesture.getAttribute('data-camera-fov'));
const touchPinchYawBefore = Number(await previewGesture.getAttribute('data-camera-yaw'));
await previewGesture.evaluate((element) => new Promise((resolve) => {
  const rect = element.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const mkTouch = (id, x) => new Touch({ identifier: id, target: element, clientX: x, clientY: cy });
  const fire = (type, touches, changedTouches = touches) => element.dispatchEvent(new TouchEvent(type, {
    touches,
    targetTouches: touches,
    changedTouches,
    bubbles: true,
    cancelable: true,
  }));
  let radius = 35;
  let currentTouches = [mkTouch(31, cx - radius), mkTouch(32, cx + radius)];
  fire('touchstart', currentTouches);
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    radius = 35 + step * 10;
    currentTouches = [mkTouch(31, cx - radius), mkTouch(32, cx + radius)];
    fire('touchmove', currentTouches);
    if (step >= 6) {
      clearInterval(timer);
      fire('touchend', [], currentTouches);
      resolve(true);
    }
  }, 20);
}));
await sleep(300);
const touchPinchFovAfter = Number(await previewGesture.getAttribute('data-camera-fov'));
const touchPinchYawAfter = Number(await previewGesture.getAttribute('data-camera-yaw'));
await check('native two-finger TouchEvent pinch zooms the AI camera exactly once',
  touchPinchFovAfter < touchPinchFovBefore - 10 && touchPinchFovAfter > 35);
await check('two-finger AI camera pinch does not rotate the view',
  Math.abs(touchPinchYawAfter - touchPinchYawBefore) < 0.1);
await check('captured iPhone pinch shows visible touch diagnostics',
  await page.getByTestId('camera-pinch-detected').count() === 1);
await page.getByLabel('AI camera normal angle').tap(); await sleep(150);
await check('normal 90° uses a corrected ~58.7° vertical projection',
  Math.abs(Number(await previewGesture.getAttribute('data-camera-projection-fov')) - 58.7) < 0.2);
await page.getByLabel('AI camera zoom out').tap(); await sleep(250);
await check('Simulator has a visible zoom-out button', Number(await previewGesture.getAttribute('data-camera-fov')) > 90);
await page.getByLabel('AI camera zoom in').tap(); await sleep(250);
await check('Simulator has a visible zoom-in button', Number(await previewGesture.getAttribute('data-camera-fov')) === 90);
await previewGesture.dispatchEvent('wheel', { deltaY: 100 }); await sleep(300);
await check('non-passive wheel listener zooms the AI camera out', Number(await previewGesture.getAttribute('data-camera-fov')) > 90);
await page.getByLabel('AI camera wide angle').tap(); await sleep(300);
await check('phone has one-tap wide-angle recovery', (await page.getByLabel('AI camera wide angle').getAttribute('class'))?.includes('bg-blue-600'));
await check('wide 120° stays 120° horizontal rather than becoming ultra-wide',
  Math.abs(Number(await previewGesture.getAttribute('data-camera-projection-fov')) - 88.5) < 0.2);
const generateBoxAtTop = await page.getByTestId('ai-render-generate').boundingBox();
await check('Generate quick draft button stays visible without scrolling', !!generateBoxAtTop && !!aiPanelBox &&
  generateBoxAtTop.y >= aiPanelBox.y && generateBoxAtTop.y + generateBoxAtTop.height <= aiPanelBox.y + aiPanelBox.height);
const scrollState = await aiScroller.evaluate((el) => {
  const max = el.scrollHeight - el.clientHeight;
  el.scrollTop = Math.min(120, max);
  return { max, top: el.scrollTop };
});
await check('AI Render sheet has a working independent vertical scroller', scrollState.max > 0 && scrollState.top > 0);
await page.getByTestId('ai-access-code').fill('e2e-beta-code');
await page.getByTestId('ai-access-code').locator('xpath=following-sibling::button[last()]').tap();
await page.getByTestId('ai-render-generate').tap();
await page.getByAltText('AI Render').waitFor({ timeout: 5000 });
await sleep(700);
await check('mobile app sends only beta code to secure backend', renderRequest?.authorization === 'Bearer e2e-beta-code');
await check('draft render sends low quality + a real camera preview', renderRequest?.body?.quality === 'low' && renderRequest?.body?.imageDataUrl?.startsWith('data:image/png;base64,') && renderRequest.body.imageDataUrl.length > 10000);
await check('mock Nano Banana 2 result displays', await page.getByAltText('AI Render').count() === 1);
await check('successful Nano render is auto-saved to local history',
  (await page.getByTestId('ai-render-history-toggle').textContent())?.includes('1'));
const aiPanelAfterRender = await page.getByTestId('ai-camera-panel').boundingBox();
await check('result scroll keeps the sheet horizontally aligned', !!aiPanelAfterRender && aiPanelAfterRender.x >= 0 && aiPanelAfterRender.x + aiPanelAfterRender.width <= 428);
await page.getByText('再整一張').tap();
await page.getByLabel('Use GPT Image 2').tap();
await page.getByTestId('ai-render-generate').tap();
await page.getByAltText('AI Render').waitFor({ timeout: 5000 });
await sleep(500);
await check('GPT Image 2 choice uses only the protected US comparison endpoint',
  gptRenderRequest?.authorization === 'Bearer e2e-beta-code' && gptRenderRequest?.body?.quality === 'low');
await check('successful GPT render is also auto-saved',
  (await page.getByTestId('ai-render-history-toggle').textContent())?.includes('2'));
await page.getByTestId('ai-render-history-toggle').tap();
await check('saved AI history can retrieve both provider results later',
  await page.getByAltText('Saved AI Render').count() === 2);
await page.getByAltText('Saved AI Render').first().tap();
await check('tapping an AI history thumbnail restores the full result',
  await page.getByTestId('ai-render-result').getByAltText('AI Render', { exact: true }).count() === 1);
await page.getByText('再整一張').tap();
await page.getByLabel('Use Nano Banana 2').tap();
await page.getByTestId('ai-render-generate').tap();
const errorCard = page.getByTestId('ai-render-error');
await errorCard.waitFor({ timeout: 5000 });
const [errorBox, scrollerBox] = await Promise.all([errorCard.boundingBox(), aiScroller.boundingBox()]);
await check('backend error auto-scrolls into the visible mobile sheet', !!errorBox && !!scrollerBox && errorBox.y < scrollerBox.y + scrollerBox.height && errorBox.y + errorBox.height > scrollerBox.y);
await page.screenshot({ path: '/tmp/e2e_ai_render_mobile.png' });
await page.getByLabel('Close camera').tap(); await sleep(300);
await page.getByLabel('平面 Plan').tap(); await sleep(800);
await check('back to 2D', await page.getByLabel('3D 睇').count() > 0);

// ═══ SCENARIO 17: blank project — empty CTA → place → CTA gone; fit-check no-room msg ═══
console.log('\nS17 blank project flow');
await page.getByLabel('返去專案列表').tap(); await sleep(900);
await page.getByText('新專案').tap();
await page.waitForURL(/\/editor/); await sleep(1000);
await check('blank project shows big scan CTA', await panelOpen('掃描房間'));
await page.getByText('傢俬', { exact: true }).tap(); await sleep(400);
await page.locator('.absolute.left-0.right-0.bottom-0.z-50 .grid.grid-cols-3 button').first().tap(); await sleep(500);
await check('CTA disappears once content exists', !(await panelOpen('拎住部機行一圈')));
await page.getByLabel('更多').tap(); await sleep(250);
await page.getByText('執位 / 試位', { exact: true }).tap(); await sleep(400);
await page.getByText('一鍵執靚').tap(); await sleep(600);
await check('arrange without rooms shows friendly message', await panelOpen('未偵測到房間'));

console.log(`\n══ RESULT: ${pass} passed, ${fail} failed ══`);
if (errors.length) { console.log('JS ERRORS:'); errors.slice(0, 6).forEach(e => console.log('  ' + e)); }
else console.log('no JS errors');
await browser.close(); server.close();
process.exit(fail === 0 && errors.length === 0 ? 0 : 1);
