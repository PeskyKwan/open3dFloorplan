<script lang="ts">
  import { onMount } from 'svelte';
  import FloorPlanCanvas from '$lib/components/editor/FloorPlanCanvas.svelte';
  import {
    currentProject, activeFloor, viewMode, selectedElementId, selectedRoomId,
    simpleMode, addFurniture, updateFurniture, removeFurniture, setFurnitureRotation,
    moveFurniture, commitFurnitureMove, beginUndoGroup, endUndoGroup, detectedRoomsStore, canvasCamX, canvasCamY,
    undo, redo, selectedTool, placingStair, cancelPlacement,
    loadProject, createDefaultProject, canvasZoom, updateWall, removeElement,
    updateDoor, updateWindow,
  } from '$lib/stores/project';
  import { furnitureCatalog, getCatalogItem } from '$lib/utils/furnitureCatalog';
  import type { FurnitureDef } from '$lib/utils/furnitureCatalog';
  import { arrangeRoom, pointInPolygon, recommendPlacementForRoom, itemAabb, aabbsOverlap, flushToNearestWall } from '$lib/utils/placementRecommender';
  import { getRoomPolygon, roomCentroid } from '$lib/utils/roomDetection';
  import { importRoomPlan, extractRoomJsonFromZip } from '$lib/utils/roomplanImport';
  import { scanAndCreateProject, isNativeScanAvailable } from '$lib/native/roomplanScan';

  // ── reactive app state ──
  let project = $state<any>(null);
  let floor = $state<any>(null);
  let mode = $state<'2d' | '3d'>('2d');
  let selId = $state<string | null>(null);
  let rooms = $state<any[]>([]);
  let camX = 0, camY = 0;
  currentProject.subscribe((p) => { project = p; });
  activeFloor.subscribe((f) => { floor = f; });
  viewMode.subscribe((m) => { mode = m; });
  selectedElementId.subscribe((id) => { selId = id; });
  detectedRoomsStore.subscribe((r) => { rooms = r; });
  canvasCamX.subscribe((v) => { camX = v; });
  canvasCamY.subscribe((v) => { camY = v; });

  // Currently selected furniture item (or null)
  let selFurniture = $derived(
    floor && selId ? floor.furniture.find((f: any) => f.id === selId) ?? null : null
  );
  function catOf(fi: any) { return getCatalogItem(fi.catalogId); }
  function fw(fi: any) { return Math.round(fi.width ?? catOf(fi)?.width ?? 100); }
  function fd(fi: any) { return Math.round(fi.depth ?? catOf(fi)?.depth ?? 80); }

  // Currently selected wall (for thickness editing)
  let selWall = $derived(
    floor && selId ? floor.walls.find((w: any) => w.id === selId) ?? null : null
  );
  function wallLen(w: any) { return Math.round(Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y)); }
  function setThickness(v: number) { if (selWall) updateWall(selWall.id, { thickness: Math.max(1, Math.round(v)) }); }
  function nudgeThk(d: number) { if (selWall) setThickness((selWall.thickness ?? 15) + d); }
  function setHeight(v: number) { if (selWall) updateWall(selWall.id, { height: Math.max(50, Math.round(v)) }); }
  function nudgeHgt(d: number) { if (selWall) setHeight((selWall.height ?? 260) + d); }
  /** Apply the selected wall's height to EVERY wall on the floor (fix a mis-scanned ceiling in one go). */
  function applyHeightAll() {
    if (!selWall || !floor) return;
    const h = Math.round(selWall.height ?? 260);
    for (const w of floor.walls) updateWall(w.id, { height: h });
    heightAllMsg = `✓ ${floor.walls.length} 幅牆全部改咗 ${h}cm 高`;
    setTimeout(() => { heightAllMsg = ''; }, 2500);
  }
  let heightAllMsg = $state('');
  function delWall() { if (selWall) { removeElement(selWall.id); selectedElementId.set(null); } }

  // Currently selected door / window
  let selDoor = $derived(
    floor && selId ? floor.doors.find((d: any) => d.id === selId) ?? null : null
  );
  let selWin = $derived(
    floor && selId ? floor.windows.find((w: any) => w.id === selId) ?? null : null
  );
  const doorTypes: Array<{ v: string; label: string }> = [
    { v: 'single', label: '單掩門' }, { v: 'double', label: '雙掩門' }, { v: 'sliding', label: '趟門' },
    { v: 'french', label: '法式門' }, { v: 'pocket', label: '暗藏趟門' }, { v: 'bifold', label: '摺門' },
    { v: 'opening', label: '冇門淨開口' }, { v: 'garage', label: '車房門' },
  ];
  function setDoorW(v: number) { if (selDoor) updateDoor(selDoor.id, { width: Math.max(30, Math.round(v)) }); }
  function setDoorH(v: number) { if (selDoor) updateDoor(selDoor.id, { height: Math.max(50, Math.round(v)) }); }
  function setWinW(v: number) { if (selWin) updateWindow(selWin.id, { width: Math.max(20, Math.round(v)) }); }
  function setWinH(v: number) { if (selWin) updateWindow(selWin.id, { height: Math.max(20, Math.round(v)) }); }
  function setWinSill(v: number) { if (selWin) updateWindow(selWin.id, { sillHeight: Math.max(0, Math.round(v)) }); }
  function delSel() { if (selId) { removeElement(selId); selectedElementId.set(null); } }

  // Empty project → show the big scan call-to-action over the canvas
  let hasContent = $derived(
    !!floor && (((floor.walls?.length ?? 0) > 0) || ((floor.furniture?.length ?? 0) > 0))
  );

  // ── lazy 3D ──
  let ThreeViewer = $state<any>(null);
  $effect(() => {
    if (mode === '3d' && !ThreeViewer) {
      import('$lib/components/viewer3d/ThreeViewer.svelte').then((m) => { ThreeViewer = m.default; });
    }
  });

  // ── bottom sheet ──
  type Sheet = null | 'tools' | 'furniture' | 'arrange' | 'more';
  let sheet = $state<Sheet>(null);
  function openSheet(s: Sheet) { sheet = sheet === s ? null : s; }
  function closeSheet() { sheet = null; }

  // ── furniture search ──
  let search = $state('');
  let filtered = $derived(
    (() => {
      const s = search.trim().toLowerCase();
      return s ? furnitureCatalog.filter((f) => f.name.toLowerCase().includes(s)) : furnitureCatalog;
    })()
  );

  function placeFurniture(item: FurnitureDef) {
    // Drop at the current view centre so it's visible, then select it.
    const id = addFurniture(item.id, { x: Math.round(camX), y: Math.round(camY) });
    selectedElementId.set(id);
    selectedRoomId.set(null);
    closeSheet();
  }

  // ── size editing ──
  function setWidth(v: number) { if (selFurniture) updateFurniture(selFurniture.id, { width: Math.max(10, Math.round(v)) }); }
  function setDepth(v: number) { if (selFurniture) updateFurniture(selFurniture.id, { depth: Math.max(10, Math.round(v)) }); }
  function nudgeW(d: number) { if (selFurniture) setWidth(fw(selFurniture) + d); }
  function nudgeD(d: number) { if (selFurniture) setDepth(fd(selFurniture) + d); }
  /** Crooked (scanned) pieces straighten to the nearest 90° first; straight pieces turn +90°. */
  function rotate90() {
    if (!selFurniture) return;
    const r = (((selFurniture.rotation ?? 0) % 360) + 360) % 360;
    const nearest = ((Math.round(r / 90) * 90) % 360 + 360) % 360;
    const isStraight = Math.abs(r - Math.round(r / 90) * 90) < 0.5;
    setFurnitureRotation(selFurniture.id, isStraight ? (nearest + 90) % 360 : nearest);
  }
  /** One tap: push the selected piece flush against the nearest wall, facing the room. */
  function snapSelToWall() {
    if (!selFurniture || !floor) return;
    const r = flushToNearestWall(floor.walls, selFurniture.position, fw(selFurniture), fd(selFurniture));
    if (!r) return;
    beginUndoGroup();
    setFurnitureRotation(selFurniture.id, r.rotation);
    moveFurniture(selFurniture.id, r.position);
    endUndoGroup('貼牆');
  }
  function del() { if (selFurniture) { removeFurniture(selFurniture.id); selectedElementId.set(null); } }
  function deselect() { selectedElementId.set(null); selectedRoomId.set(null); }

  // ── tools ──
  let toolNow = $state('select');
  selectedTool.subscribe((t) => { toolNow = t; });
  function pick(tool: 'select' | 'wall' | 'door' | 'window') { cancelPlacement(); selectedTool.set(tool); closeSheet(); }
  function addStairs() { cancelPlacement(); placingStair.set(true); closeSheet(); }

  // Native LiDAR scan when in the app; file import in a browser. Same button either way.
  async function importScan() {
    closeSheet();
    await scanAndCreateProject();
  }

  // ── auto-arrange (same engine as desktop) ──
  let arrangeMsg = $state('');
  let arranging = $state(false);
  function autoArrange() {
    if (!floor) return;
    const rs = (rooms.length ? rooms : floor.rooms) ?? [];
    if (!rs.length) { arrangeMsg = '未偵測到房間 — 先 import scan'; return; }
    arranging = true;
    beginUndoGroup();
    try {
      const polys = rs.map((r: any) => ({ r, poly: getRoomPolygon(r, floor.walls) }));
      const buckets = new Map<string, any[]>();
      for (const f of floor.furniture) {
        let target = polys.find((p: any) => p.poly.length >= 3 && pointInPolygon(f.position, p.poly))?.r;
        if (!target) {
          let bestD = Infinity;
          for (const p of polys) {
            if (p.poly.length < 3) continue;
            const c = roomCentroid(p.poly);
            const d = Math.hypot(c.x - f.position.x, c.y - f.position.y);
            if (d < bestD) { bestD = d; target = p.r; }
          }
        }
        if (!target) continue;
        if (!buckets.has(target.id)) buckets.set(target.id, []);
        buckets.get(target.id)!.push(f);
      }
      let moved = 0, failed = 0, kept = 0;
      for (const room of rs) {
        const fs = buckets.get(room.id) ?? [];
        if (!fs.length) continue;
        const poly = getRoomPolygon(room, floor.walls);
        // Decide which pieces are already fine: inside the room and not overlapping
        // another piece — those DON'T move. Only the problem pieces get re-placed.
        const withRects = fs.map((f: any) => {
          const c = getCatalogItem(f.catalogId);
          const w = f.width ?? c?.width ?? 100, d = f.depth ?? c?.depth ?? 80;
          return { f, w, d, rect: itemAabb(f.position, f.rotation ?? 0, w, d) };
        });
        const good: any[] = [], bad: any[] = [];
        for (const it of withRects) {
          const inside = poly.length >= 3 && pointInPolygon(it.f.position, poly);
          const collides = withRects.some((o) => o !== it && aabbsOverlap(it.rect, o.rect));
          (inside && !collides ? good : bad).push(it);
        }
        kept += good.length;
        if (!bad.length) continue;
        const items = bad.map((it: any) => ({ id: it.f.id, width: it.w, depth: it.d }));
        const res = arrangeRoom(room, floor.walls, floor.doors, items, { fixedRects: good.map((g: any) => g.rect) });
        for (const r of res) { if (r.position) { setFurnitureRotation(r.id, r.rotation); moveFurniture(r.id, r.position); moved++; } else failed++; }
      }
      arrangeMsg = moved === 0 && failed === 0
        ? `✓ ${kept} 件全部擺得好，冇嘢需要郁`
        : `✓ 執咗 ${moved} 件，${kept} 件原位冇郁${failed ? `，${failed} 件冇位` : ''}（唔啱撳 ↩ 復原）`;
    } finally { arranging = false; endUndoGroup('一鍵執靚'); }
  }

  // ── fit-check ──
  let fitCatalogId = $state('sofa');
  let fitW = $state<number | ''>('');
  let fitD = $state<number | ''>('');
  let fitMsg = $state('');
  let fitOk = $state(false);
  function fitCheck() {
    if (!floor) return;
    const cat = getCatalogItem(fitCatalogId);
    const width = Number(fitW) || cat?.width || 100;
    const depth = Number(fitD) || cat?.depth || 80;
    const rs = (rooms.length ? rooms : floor.rooms) ?? [];
    if (!rs.length) { fitOk = false; fitMsg = '未偵測到房間 — 先 import scan'; return; }
    const others = floor.furniture.map((f: any) => { const c = getCatalogItem(f.catalogId); return { position: f.position, rotation: f.rotation ?? 0, width: f.width ?? c?.width ?? 100, depth: f.depth ?? c?.depth ?? 80 }; });
    let best: any = null, bestRoom: any = null;
    for (const room of rs) {
      const r = recommendPlacementForRoom(room, floor.walls, floor.doors, others, { width, depth }, { strategy: 'wall' });
      if (r && (!best || r.score > best.score)) { best = r; bestRoom = room; }
    }
    if (!best) { fitOk = false; fitMsg = `✗ 擺唔落 — 冇位放 ${width}×${depth}cm`; return; }
    beginUndoGroup();
    const id = addFurniture(fitCatalogId, best.position);
    setFurnitureRotation(id, best.rotation);
    if (Number(fitW) || Number(fitD)) updateFurniture(id, { width, depth });
    endUndoGroup('試位');
    selectedElementId.set(id);
    fitOk = true;
    fitMsg = `✓ 擺得落！放咗喺 ${bestRoom.name ?? '間房'}`;
    closeSheet();
  }
</script>

<div class="h-screen w-full flex flex-col overflow-hidden relative bg-[#0b0f14]" style="padding-top: env(safe-area-inset-top);">
  <!-- Top bar -->
  <div class="flex items-center gap-2 px-3 h-16 shrink-0">
    <a href="/" class="h-12 pl-2 pr-4 rounded-full bg-[#1c2530] text-slate-100 flex items-center gap-1 active:bg-[#26313d]" aria-label="返去專案列表">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      <span class="text-[15px] font-medium">返去</span>
    </a>
    <div class="flex-1 min-w-0 text-center px-1">
      <div class="text-base font-semibold text-white truncate">{project?.name ?? 'Untitled'}</div>
    </div>
    <button onclick={() => undo()} class="w-12 h-12 flex items-center justify-center rounded-full bg-[#1c2530] text-slate-200 active:bg-[#26313d]" aria-label="Undo 復原">
      <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
    </button>
    <button onclick={() => redo()} class="w-12 h-12 flex items-center justify-center rounded-full bg-[#1c2530] text-slate-200 active:bg-[#26313d]" aria-label="Redo 重做">
      <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
    </button>
  </div>

  <!-- Canvas area -->
  <div class="flex-1 min-h-0 relative mx-3 rounded-2xl overflow-hidden bg-[#0d1218]">
    {#if mode === '2d'}
      <FloorPlanCanvas />

      <!-- Empty project: big scan call-to-action so you can't get lost -->
      {#if !hasContent}
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-[#0d1218]/70 pointer-events-none">
          <button onclick={importScan} class="pointer-events-auto flex flex-col items-center gap-3 active:scale-95 transition-transform" aria-label="掃描房間">
            <span class="w-28 h-28 rounded-full bg-gradient-to-b from-[#4a8df0] to-[#2f6fd8] shadow-2xl shadow-blue-500/40 flex items-center justify-center">
              <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M4 12h16"/></svg>
            </span>
            <span class="text-xl font-semibold text-white">掃描房間</span>
          </button>
          <p class="text-[15px] text-slate-400 text-center px-8">{isNativeScanAvailable() ? '拎住部機行一圈,自動出平面圖' : '匯入 RoomPlan .json / .zip 掃描檔'}</p>
        </div>
      {/if}

      <!-- Active placing-tool banner -->
      {#if toolNow === 'door' || toolNow === 'window' || toolNow === 'wall'}
        <div class="absolute top-2 left-2 right-14 z-30 flex items-center gap-2 bg-[#12233c]/95 rounded-xl px-3 py-2.5">
          <span class="text-[14px] font-medium text-[#5b9bf6] flex-1">
            {toolNow === 'door' ? '🚪 撳一下幅牆 — 門就放喺嗰度' : toolNow === 'window' ? '🪟 撳一下幅牆 — 窗就放喺嗰度' : '▭ 撳兩點畫牆,dbl-tap 收筆'}
          </span>
          <button onclick={() => { cancelPlacement(); selectedTool.set('select'); }} class="shrink-0 h-9 px-3 rounded-lg bg-[#1c2530] text-slate-200 text-[13px] font-medium active:bg-[#26313d]">取消</button>
        </div>
      {/if}
      <!-- Zoom controls (floating) -->
      <div class="absolute top-2 right-2 flex flex-col bg-[#0b0f14]/85 rounded-xl overflow-hidden">
        <button onclick={() => canvasZoom.update((z) => Math.min(10, z * 1.25))} class="w-11 h-11 text-2xl text-slate-200 active:bg-white/10" aria-label="Zoom in">+</button>
        <div class="h-px bg-white/10"></div>
        <button onclick={() => canvasZoom.update((z) => Math.max(0.1, z / 1.25))} class="w-11 h-11 text-2xl text-slate-200 active:bg-white/10" aria-label="Zoom out">−</button>
      </div>
    {:else if ThreeViewer}
      <ThreeViewer />
    {:else}
      <div class="flex items-center justify-center h-full text-slate-400">Loading 3D…</div>
    {/if}

    <!-- Selected furniture size panel (2D only) -->
    {#if mode === '2d' && selFurniture}
      <div class="absolute left-2 right-2 bottom-2 bg-[#141b23] rounded-2xl p-4">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-lg font-semibold text-white truncate">{catOf(selFurniture)?.name ?? 'Furniture'}</span>
          <div class="ml-auto flex gap-2">
            <button onclick={del} class="w-11 h-11 rounded-full bg-[#2a1416] text-[#f0787a] flex items-center justify-center active:bg-[#3a1a1c]" aria-label="Delete">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
            <button onclick={deselect} class="w-11 h-11 rounded-full bg-[#1c2530] text-slate-200 flex items-center justify-center active:bg-[#26313d]" aria-label="Deselect">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="flex gap-2 mb-3">
          <button onclick={snapSelToWall} class="flex-1 h-12 rounded-xl bg-[#12233c] active:bg-[#16304f] text-[#5b9bf6] text-[15px] font-semibold flex items-center justify-center gap-1.5">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18"/><path d="M9 12h12"/><path d="M13 8l-4 4 4 4"/></svg>
            貼牆
          </button>
          <button onclick={rotate90} class="flex-1 h-12 rounded-xl bg-[#1c2530] active:bg-[#26313d] text-slate-100 text-[15px] font-semibold flex items-center justify-center gap-1.5">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            轉 90°
          </button>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <div class="text-[13px] text-slate-500 mb-1.5">闊 Width (cm)</div>
            <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12">
              <button onclick={() => nudgeW(-1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Width down">−</button>
              <input type="number" inputmode="numeric" value={fw(selFurniture)} onchange={(e) => setWidth(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
              <button onclick={() => nudgeW(1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Width up">+</button>
            </div>
          </div>
          <div>
            <div class="text-[13px] text-slate-500 mb-1.5">深 Depth (cm)</div>
            <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12">
              <button onclick={() => nudgeD(-1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Depth down">−</button>
              <input type="number" inputmode="numeric" value={fd(selFurniture)} onchange={(e) => setDepth(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
              <button onclick={() => nudgeD(1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Depth up">+</button>
            </div>
          </div>
        </div>
        <div class="text-[13px] text-slate-500 mt-2.5 text-center">拖傢俬移位 · 兩指扭轉方向 · ± / 打數字改尺寸</div>
      </div>
    {:else if mode === '2d' && selWall}
      <div class="absolute left-2 right-2 bottom-2 bg-[#141b23] rounded-2xl p-4">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-lg font-semibold text-white">牆 Wall</span>
          <span class="text-xs text-slate-500">長 {wallLen(selWall)} cm</span>
          <div class="ml-auto flex gap-2">
            <button onclick={delWall} class="w-11 h-11 rounded-full bg-[#2a1416] text-[#f0787a] flex items-center justify-center active:bg-[#3a1a1c]" aria-label="Delete wall">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
            <button onclick={deselect} class="w-11 h-11 rounded-full bg-[#1c2530] text-slate-200 flex items-center justify-center active:bg-[#26313d]" aria-label="Deselect">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-1.5">
          <div>
            <div class="text-[13px] text-slate-500 mb-1.5">牆厚 Thickness (cm)</div>
            <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12">
              <button onclick={() => nudgeThk(-1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Thinner">−</button>
              <input type="number" inputmode="numeric" value={Math.round(selWall.thickness ?? 15)} onchange={(e) => setThickness(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
              <button onclick={() => nudgeThk(1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Thicker">+</button>
            </div>
          </div>
          <div>
            <div class="text-[13px] text-slate-500 mb-1.5">牆高 Height (cm)</div>
            <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12">
              <button onclick={() => nudgeHgt(-5)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Lower">−</button>
              <input type="number" inputmode="numeric" value={Math.round(selWall.height ?? 260)} onchange={(e) => setHeight(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
              <button onclick={() => nudgeHgt(5)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Higher">+</button>
            </div>
          </div>
        </div>
        <button onclick={applyHeightAll} class="w-full h-11 rounded-xl bg-[#12233c] active:bg-[#16304f] text-[#5b9bf6] text-[14px] font-semibold mb-1.5">呢個高度套用去全部牆</button>
        <div class="text-[13px] text-slate-500 text-center">{heightAllMsg || '掃描量唔到牆厚,預設 15cm — 度返實際改;高度睇 3D 先覺'}</div>
      </div>
    {:else if mode === '2d' && selDoor}
      <div class="absolute left-2 right-2 bottom-2 bg-[#141b23] rounded-2xl p-4">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-lg font-semibold text-white">🚪 門 Door</span>
          <div class="ml-auto flex gap-2">
            <button onclick={delSel} class="w-11 h-11 rounded-full bg-[#2a1416] text-[#f0787a] flex items-center justify-center active:bg-[#3a1a1c]" aria-label="Delete door">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
            <button onclick={deselect} class="w-11 h-11 rounded-full bg-[#1c2530] text-slate-200 flex items-center justify-center active:bg-[#26313d]" aria-label="Deselect">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3 mb-2.5">
          <div>
            <div class="text-[13px] text-slate-500 mb-1.5">闊 Width (cm)</div>
            <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12">
              <button onclick={() => setDoorW(selDoor.width - 5)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Door narrower">−</button>
              <input type="number" inputmode="numeric" value={Math.round(selDoor.width)} onchange={(e) => setDoorW(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
              <button onclick={() => setDoorW(selDoor.width + 5)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Door wider">+</button>
            </div>
          </div>
          <div>
            <div class="text-[13px] text-slate-500 mb-1.5">高 Height (cm)</div>
            <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12">
              <button onclick={() => setDoorH(selDoor.height - 5)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Door shorter">−</button>
              <input type="number" inputmode="numeric" value={Math.round(selDoor.height)} onchange={(e) => setDoorH(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
              <button onclick={() => setDoorH(selDoor.height + 5)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Door taller">+</button>
            </div>
          </div>
        </div>
        <div class="flex gap-2">
          <select value={selDoor.type} onchange={(e) => updateDoor(selDoor.id, { type: (e.target as HTMLSelectElement).value as any })} class="flex-1 px-3 h-11 bg-[#0b0f14] rounded-xl text-[14px] text-white outline-none">
            {#each doorTypes as t}<option value={t.v}>{t.label}</option>{/each}
          </select>
          <button onclick={() => updateDoor(selDoor.id, { swingDirection: selDoor.swingDirection === 'left' ? 'right' : 'left' })} class="h-11 px-3 rounded-xl bg-[#1c2530] text-slate-100 text-[14px] font-medium active:bg-[#26313d]">換開邊</button>
          <button onclick={() => updateDoor(selDoor.id, { flipSide: !selDoor.flipSide })} class="h-11 px-3 rounded-xl bg-[#1c2530] text-slate-100 text-[14px] font-medium active:bg-[#26313d]">內/外</button>
        </div>
        <div class="text-[13px] text-slate-500 mt-2 text-center">拖道門可以沿住幅牆移位</div>
      </div>
    {:else if mode === '2d' && selWin}
      <div class="absolute left-2 right-2 bottom-2 bg-[#141b23] rounded-2xl p-4">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-lg font-semibold text-white">🪟 窗 Window</span>
          <div class="ml-auto flex gap-2">
            <button onclick={delSel} class="w-11 h-11 rounded-full bg-[#2a1416] text-[#f0787a] flex items-center justify-center active:bg-[#3a1a1c]" aria-label="Delete window">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
            <button onclick={deselect} class="w-11 h-11 rounded-full bg-[#1c2530] text-slate-200 flex items-center justify-center active:bg-[#26313d]" aria-label="Deselect">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <div>
            <div class="text-[13px] text-slate-500 mb-1.5">闊 (cm)</div>
            <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12">
              <button onclick={() => setWinW(selWin.width - 5)} class="w-10 h-full text-xl text-slate-400 active:bg-white/5" aria-label="Window narrower">−</button>
              <input type="number" inputmode="numeric" value={Math.round(selWin.width)} onchange={(e) => setWinW(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
              <button onclick={() => setWinW(selWin.width + 5)} class="w-10 h-full text-xl text-slate-400 active:bg-white/5" aria-label="Window wider">+</button>
            </div>
          </div>
          <div>
            <div class="text-[13px] text-slate-500 mb-1.5">高 (cm)</div>
            <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12">
              <button onclick={() => setWinH(selWin.height - 5)} class="w-10 h-full text-xl text-slate-400 active:bg-white/5" aria-label="Window shorter">−</button>
              <input type="number" inputmode="numeric" value={Math.round(selWin.height)} onchange={(e) => setWinH(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
              <button onclick={() => setWinH(selWin.height + 5)} class="w-10 h-full text-xl text-slate-400 active:bg-white/5" aria-label="Window taller">+</button>
            </div>
          </div>
          <div>
            <div class="text-[13px] text-slate-500 mb-1.5">窗台高 (cm)</div>
            <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12">
              <button onclick={() => setWinSill((selWin.sillHeight ?? 90) - 5)} class="w-10 h-full text-xl text-slate-400 active:bg-white/5" aria-label="Sill lower">−</button>
              <input type="number" inputmode="numeric" value={Math.round(selWin.sillHeight ?? 90)} onchange={(e) => setWinSill(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
              <button onclick={() => setWinSill((selWin.sillHeight ?? 90) + 5)} class="w-10 h-full text-xl text-slate-400 active:bg-white/5" aria-label="Sill higher">+</button>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- Bottom action bar — Scan is the big centre button (camera-app style) -->
  <div class="flex items-end justify-between gap-1 px-3 pt-2 shrink-0" style="padding-bottom: max(1rem, env(safe-area-inset-bottom));">
    <button onclick={() => openSheet('furniture')} class="flex-1 flex flex-col items-center gap-1" aria-label="傢俬">
      <span class="w-14 h-14 rounded-full flex items-center justify-center {sheet === 'furniture' ? 'bg-[#5b9bf6] text-[#04213f]' : 'bg-[#1c2530] text-slate-300'}">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h20v6H2zM4 12V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4M6 18v2M18 18v2"/></svg>
      </span>
      <span class="text-[12px] font-medium {sheet === 'furniture' ? 'text-white' : 'text-slate-400'}">傢俬</span>
    </button>
    <button onclick={() => openSheet('arrange')} class="flex-1 flex flex-col items-center gap-1" aria-label="執位">
      <span class="w-14 h-14 rounded-full flex items-center justify-center {sheet === 'arrange' ? 'bg-[#5b9bf6] text-[#04213f]' : 'bg-[#1c2530] text-slate-300'}">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.6 5.6 21l2.4-7.2L2 9.2h7.6z"/></svg>
      </span>
      <span class="text-[12px] font-medium {sheet === 'arrange' ? 'text-white' : 'text-slate-400'}">執位</span>
    </button>
    <button onclick={importScan} class="flex-1 flex flex-col items-center gap-1 -mt-5" aria-label="掃描房間">
      <span class="w-[72px] h-[72px] rounded-full bg-gradient-to-b from-[#4a8df0] to-[#2f6fd8] text-white shadow-xl shadow-blue-500/40 flex items-center justify-center border-4 border-[#0b0f14]">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M4 12h16"/></svg>
      </span>
      <span class="text-[12px] font-semibold text-[#5b9bf6]">掃描</span>
    </button>
    <button onclick={() => viewMode.set(mode === '3d' ? '2d' : '3d')} class="flex-1 flex flex-col items-center gap-1" aria-label="3D 睇">
      <span class="w-14 h-14 rounded-full flex items-center justify-center text-base font-bold {mode === '3d' ? 'bg-[#5b9bf6] text-[#04213f]' : 'bg-[#1c2530] text-slate-300'}">{mode === '3d' ? '2D' : '3D'}</span>
      <span class="text-[12px] font-medium {mode === '3d' ? 'text-white' : 'text-slate-400'}">{mode === '3d' ? '平面' : '立體'}</span>
    </button>
    <button onclick={() => openSheet('more')} class="flex-1 flex flex-col items-center gap-1" aria-label="更多">
      <span class="w-14 h-14 rounded-full flex items-center justify-center {sheet === 'more' ? 'bg-[#5b9bf6] text-[#04213f]' : 'bg-[#1c2530] text-slate-300'}">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h.01M12 12h.01M19 12h.01"/></svg>
      </span>
      <span class="text-[12px] font-medium {sheet === 'more' ? 'text-white' : 'text-slate-400'}">更多</span>
    </button>
  </div>

  <!-- Bottom sheet overlay -->
  {#if sheet}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="absolute inset-0 z-40 bg-black/50" onclick={closeSheet}></div>
    <div class="absolute left-0 right-0 bottom-0 z-50 bg-[#141b23] rounded-t-3xl max-h-[72%] flex flex-col">
      <div class="relative flex items-center px-4 pt-4 pb-3">
        <div class="w-10 h-1 bg-white/20 rounded-full absolute left-1/2 -translate-x-1/2 top-2"></div>
        <h2 class="text-base font-semibold text-white mt-1">
          {sheet === 'furniture' ? '傢俬' : sheet === 'arrange' ? '執位 / 試位' : '更多'}
        </h2>
        <button onclick={closeSheet} class="ml-auto w-8 h-8 rounded-full bg-[#1c2530] text-slate-300 flex items-center justify-center leading-none active:bg-[#26313d]" aria-label="Close">✕</button>
      </div>

      <div class="overflow-y-auto px-3 pb-6">
        {#if sheet === 'furniture'}
          <input type="text" placeholder="搵傢俬…" bind:value={search} class="w-full px-4 h-12 bg-[#0f151c] rounded-xl text-base text-white placeholder-slate-500 mb-3 outline-none" />
          <div class="grid grid-cols-3 gap-2">
            {#each filtered as item (item.id)}
              <button onclick={() => placeFurniture(item)} class="flex flex-col items-center gap-1 p-3 rounded-2xl bg-[#0f151c] active:bg-[#1c2530]">
                <span class="text-3xl">{item.icon}</span>
                <span class="text-[13px] text-slate-200 text-center leading-tight">{item.name}</span>
                <span class="text-[12px] text-slate-500">{item.width}×{item.depth}</span>
              </button>
            {/each}
          </div>
        {:else if sheet === 'arrange'}
          <button onclick={autoArrange} disabled={arranging} class="w-full p-4 rounded-2xl bg-[#12233c] active:bg-[#16304f] text-left mb-3">
            <div class="font-semibold text-base text-[#5b9bf6]">✨ 一鍵執靚 Auto-arrange</div>
            <div class="text-[13px] text-[#5b9bf6]/70 mt-1">{arrangeMsg || '間房傢俬貼牆排好、唔重疊'}</div>
          </button>
          <div class="p-4 rounded-2xl bg-[#0f151c]">
            <div class="text-[14px] font-semibold text-[#b79bf6] mb-2.5">🛒 試位 — 買之前試吓擺唔擺得落</div>
            <select bind:value={fitCatalogId} class="w-full px-3 h-12 bg-[#141b23] rounded-xl text-base text-white mb-2 outline-none">
              {#each furnitureCatalog as f}
                <option value={f.id}>{f.icon} {f.name} · {f.width}×{f.depth}cm</option>
              {/each}
            </select>
            <div class="flex gap-2 mb-2.5">
              <input type="number" inputmode="numeric" bind:value={fitW} placeholder="闊 cm" class="w-1/2 px-3 h-12 bg-[#141b23] rounded-xl text-base text-white placeholder-slate-500 outline-none" />
              <input type="number" inputmode="numeric" bind:value={fitD} placeholder="深 cm" class="w-1/2 px-3 h-12 bg-[#141b23] rounded-xl text-base text-white placeholder-slate-500 outline-none" />
            </div>
            <button onclick={fitCheck} class="w-full h-12 rounded-xl text-base font-semibold bg-[#7c5cf0] active:bg-[#6b4be0] text-white">✨ 試位 / Find a spot</button>
            {#if fitMsg}<p class="text-[14px] mt-2.5 {fitOk ? 'text-emerald-400' : 'text-[#f0787a]'}">{fitMsg}</p>{/if}
          </div>
        {:else if sheet === 'more'}
          <div class="text-[13px] font-medium text-slate-500 px-1 mb-2">工具</div>
          <div class="grid grid-cols-2 gap-2 mb-4">
            <button onclick={() => pick('select')} class="p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left">
              <div class="font-semibold text-base text-white">↖︎ 揀嘢</div>
              <div class="text-[13px] text-slate-500 mt-1">撳嚟揀 / 改嘢</div>
            </button>
            <button onclick={() => pick('wall')} class="p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left">
              <div class="font-semibold text-base text-white">▭ 畫牆</div>
              <div class="text-[13px] text-slate-500 mt-1">撳兩點畫一幅牆</div>
            </button>
            <button onclick={() => pick('door')} class="p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left">
              <div class="font-semibold text-base text-white">🚪 加門</div>
              <div class="text-[13px] text-slate-500 mt-1">撳落幅牆度就有門</div>
            </button>
            <button onclick={() => pick('window')} class="p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left">
              <div class="font-semibold text-base text-white">🪟 加窗</div>
              <div class="text-[13px] text-slate-500 mt-1">撳落幅牆度就有窗</div>
            </button>
            <button onclick={addStairs} class="p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left">
              <div class="font-semibold text-base text-white">▦ 樓梯</div>
              <div class="text-[13px] text-slate-500 mt-1">撳畫面放樓梯</div>
            </button>
            <button onclick={importScan} class="p-4 rounded-2xl bg-[#12233c] active:bg-[#16304f] text-left">
              <div class="font-semibold text-base text-[#5b9bf6]">◎ {isNativeScanAvailable() ? '掃描房間' : '匯入掃描檔'}</div>
              <div class="text-[13px] text-[#5b9bf6]/70 mt-1">{isNativeScanAvailable() ? 'LiDAR 掃間房' : '匯入 .json / .zip 掃描檔'}</div>
            </button>
          </div>
          <div class="space-y-2">
            <button onclick={() => { simpleMode.update((v) => !v); }} class="w-full p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left flex items-center">
              <div>
                <div class="font-semibold text-base text-white">簡單模式</div>
                <div class="text-[13px] text-slate-500 mt-1">收埋進階工具（鎖牆防誤觸）</div>
              </div>
              <span class="ml-auto text-base font-semibold {$simpleMode ? 'text-emerald-400' : 'text-slate-500'}">{$simpleMode ? '開 ✓' : '關'}</span>
            </button>
            <a href="/" class="block w-full p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left">
              <div class="font-semibold text-base text-white">← 返專案列表</div>
            </a>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
