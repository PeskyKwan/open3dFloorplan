<script lang="ts">
  import { onMount } from 'svelte';
  import FloorPlanCanvas from '$lib/components/editor/FloorPlanCanvas.svelte';
  import {
    currentProject, activeFloor, viewMode, selectedElementId, selectedRoomId,
    simpleMode, addFurniture, updateFurniture, removeFurniture, setFurnitureRotation,
    moveFurniture, commitFurnitureMove, detectedRoomsStore, canvasCamX, canvasCamY,
    undo, redo, selectedTool, placingStair, cancelPlacement,
    loadProject, createDefaultProject, canvasZoom, updateWall, removeElement,
  } from '$lib/stores/project';
  import { furnitureCatalog, getCatalogItem } from '$lib/utils/furnitureCatalog';
  import type { FurnitureDef } from '$lib/utils/furnitureCatalog';
  import { arrangeRoom, pointInPolygon, recommendPlacementForRoom } from '$lib/utils/placementRecommender';
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
  function delWall() { if (selWall) { removeElement(selWall.id); selectedElementId.set(null); } }

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
  function rotate90() { if (selFurniture) setFurnitureRotation(selFurniture.id, ((selFurniture.rotation ?? 0) + 90) % 360); }
  function del() { if (selFurniture) { removeFurniture(selFurniture.id); selectedElementId.set(null); } }
  function deselect() { selectedElementId.set(null); selectedRoomId.set(null); }

  // ── tools ──
  function pick(tool: 'select' | 'wall') { cancelPlacement(); selectedTool.set(tool); closeSheet(); }
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
      let moved = 0, failed = 0;
      for (const room of rs) {
        const fs = buckets.get(room.id) ?? [];
        if (!fs.length) continue;
        const items = fs.map((f: any) => { const c = getCatalogItem(f.catalogId); return { id: f.id, width: f.width ?? c?.width ?? 100, depth: f.depth ?? c?.depth ?? 80 }; });
        const res = arrangeRoom(room, floor.walls, floor.doors, items, {});
        for (const r of res) { if (r.position) { setFurnitureRotation(r.id, r.rotation); moveFurniture(r.id, r.position); moved++; } else failed++; }
      }
      commitFurnitureMove();
      arrangeMsg = `✓ 排好 ${moved} 件${failed ? `，${failed} 件冇位` : ''}`;
    } finally { arranging = false; }
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
    const id = addFurniture(fitCatalogId, best.position);
    setFurnitureRotation(id, best.rotation);
    if (Number(fitW) || Number(fitD)) updateFurniture(id, { width, depth });
    selectedElementId.set(id);
    fitOk = true;
    fitMsg = `✓ 擺得落！放咗喺 ${bestRoom.name ?? '間房'}`;
    closeSheet();
  }
</script>

<div class="h-screen w-full flex flex-col overflow-hidden relative bg-[#0b0f14]">
  <!-- Top bar -->
  <div class="flex items-center gap-2 px-3 h-14 shrink-0">
    <a href="/" class="w-10 h-10 rounded-full bg-[#1c2530] text-slate-200 flex items-center justify-center active:bg-[#26313d]" aria-label="Projects">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </a>
    <div class="flex-1 min-w-0 text-center px-1">
      <div class="text-sm font-medium text-white truncate">{project?.name ?? 'Untitled'}</div>
      <div class="text-[11px] text-slate-500 truncate">{floor?.name ?? ''}</div>
    </div>
    <button onclick={() => undo()} class="w-10 h-10 flex items-center justify-center rounded-full bg-[#1c2530] text-slate-200 active:bg-[#26313d]" aria-label="Undo 復原">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
    </button>
    <button onclick={() => redo()} class="w-10 h-10 flex items-center justify-center rounded-full bg-[#1c2530] text-slate-200 active:bg-[#26313d]" aria-label="Redo 重做">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
    </button>
  </div>

  <!-- Canvas area -->
  <div class="flex-1 min-h-0 relative mx-3 rounded-2xl overflow-hidden bg-[#0d1218]">
    {#if mode === '2d'}
      <FloorPlanCanvas />
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
          <span class="text-base font-medium text-white truncate">{catOf(selFurniture)?.name ?? 'Furniture'}</span>
          <div class="ml-auto flex gap-2">
            <button onclick={rotate90} class="w-11 h-11 rounded-full bg-[#1c2530] text-slate-200 flex items-center justify-center active:bg-[#26313d]" aria-label="Rotate 90">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </button>
            <button onclick={del} class="w-11 h-11 rounded-full bg-[#2a1416] text-[#f0787a] flex items-center justify-center active:bg-[#3a1a1c]" aria-label="Delete">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
            <button onclick={deselect} class="w-11 h-11 rounded-full bg-[#1c2530] text-slate-200 flex items-center justify-center active:bg-[#26313d]" aria-label="Deselect">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <div class="text-[11px] text-slate-500 mb-1.5">闊 Width (cm)</div>
            <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12">
              <button onclick={() => nudgeW(-1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Width down">−</button>
              <input type="number" inputmode="numeric" value={fw(selFurniture)} onchange={(e) => setWidth(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
              <button onclick={() => nudgeW(1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Width up">+</button>
            </div>
          </div>
          <div>
            <div class="text-[11px] text-slate-500 mb-1.5">深 Depth (cm)</div>
            <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12">
              <button onclick={() => nudgeD(-1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Depth down">−</button>
              <input type="number" inputmode="numeric" value={fd(selFurniture)} onchange={(e) => setDepth(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
              <button onclick={() => nudgeD(1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Depth up">+</button>
            </div>
          </div>
        </div>
        <div class="text-[11px] text-slate-500 mt-2.5 text-center">拖傢俬移位 · 拖角改尺寸 · 或用 ± / 打數字</div>
      </div>
    {:else if mode === '2d' && selWall}
      <div class="absolute left-2 right-2 bottom-2 bg-[#141b23] rounded-2xl p-4">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-base font-medium text-white">牆 Wall</span>
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
        <div class="text-[11px] text-slate-500 mb-1.5">牆厚 Thickness (cm)</div>
        <div class="flex items-center bg-[#0b0f14] rounded-xl overflow-hidden h-12 mb-1.5">
          <button onclick={() => nudgeThk(-1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Thinner">−</button>
          <input type="number" inputmode="numeric" value={Math.round(selWall.thickness ?? 15)} onchange={(e) => setThickness(Number((e.target as HTMLInputElement).value))} class="flex-1 min-w-0 text-center text-base font-medium bg-transparent text-white outline-none" />
          <button onclick={() => nudgeThk(1)} class="w-12 h-full text-2xl text-slate-400 active:bg-white/5" aria-label="Thicker">+</button>
        </div>
        <div class="text-[11px] text-slate-500 text-center">掃描量唔到牆厚,預設 15cm — 度返實際改</div>
      </div>
    {/if}
  </div>

  <!-- Bottom quick-action bar (Tesla-style round buttons) -->
  <div class="flex justify-between gap-1 px-4 pt-3 pb-5 shrink-0">
    <button onclick={() => openSheet('furniture')} class="flex-1 flex flex-col items-center gap-1.5" aria-label="傢俬">
      <span class="w-12 h-12 rounded-full flex items-center justify-center {sheet === 'furniture' ? 'bg-[#5b9bf6] text-[#04213f]' : 'bg-[#1c2530] text-slate-300'}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h20v6H2zM4 12V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4M6 18v2M18 18v2"/></svg>
      </span>
      <span class="text-[10px] {sheet === 'furniture' ? 'text-slate-200' : 'text-slate-500'}">傢俬</span>
    </button>
    <button onclick={() => openSheet('arrange')} class="flex-1 flex flex-col items-center gap-1.5" aria-label="執位">
      <span class="w-12 h-12 rounded-full flex items-center justify-center {sheet === 'arrange' ? 'bg-[#5b9bf6] text-[#04213f]' : 'bg-[#1c2530] text-slate-300'}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.2H22l-6 4.6 2.4 7.2L12 16.6 5.6 21l2.4-7.2L2 9.2h7.6z"/></svg>
      </span>
      <span class="text-[10px] {sheet === 'arrange' ? 'text-slate-200' : 'text-slate-500'}">執位</span>
    </button>
    <button onclick={() => openSheet('tools')} class="flex-1 flex flex-col items-center gap-1.5" aria-label="工具">
      <span class="w-12 h-12 rounded-full flex items-center justify-center {sheet === 'tools' ? 'bg-[#5b9bf6] text-[#04213f]' : 'bg-[#1c2530] text-slate-300'}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3zM13 13l6 6"/></svg>
      </span>
      <span class="text-[10px] {sheet === 'tools' ? 'text-slate-200' : 'text-slate-500'}">工具</span>
    </button>
    <button onclick={() => viewMode.set(mode === '3d' ? '2d' : '3d')} class="flex-1 flex flex-col items-center gap-1.5" aria-label="3D 睇">
      <span class="w-12 h-12 rounded-full flex items-center justify-center text-sm font-semibold {mode === '3d' ? 'bg-[#5b9bf6] text-[#04213f]' : 'bg-[#1c2530] text-slate-300'}">{mode === '3d' ? '2D' : '3D'}</span>
      <span class="text-[10px] {mode === '3d' ? 'text-slate-200' : 'text-slate-500'}">{mode === '3d' ? '2D 平面' : '3D 睇'}</span>
    </button>
    <button onclick={() => openSheet('more')} class="flex-1 flex flex-col items-center gap-1.5" aria-label="更多">
      <span class="w-12 h-12 rounded-full flex items-center justify-center {sheet === 'more' ? 'bg-[#5b9bf6] text-[#04213f]' : 'bg-[#1c2530] text-slate-300'}">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h.01M12 12h.01M19 12h.01"/></svg>
      </span>
      <span class="text-[10px] {sheet === 'more' ? 'text-slate-200' : 'text-slate-500'}">更多</span>
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
        <h2 class="text-sm font-medium text-white mt-1">
          {sheet === 'tools' ? '工具' : sheet === 'furniture' ? '傢俬' : sheet === 'arrange' ? '執位 / 試位' : '更多'}
        </h2>
        <button onclick={closeSheet} class="ml-auto w-8 h-8 rounded-full bg-[#1c2530] text-slate-300 flex items-center justify-center leading-none active:bg-[#26313d]" aria-label="Close">✕</button>
      </div>

      <div class="overflow-y-auto px-3 pb-5">
        {#if sheet === 'tools'}
          <div class="grid grid-cols-2 gap-2">
            <button onclick={() => pick('select')} class="p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left">
              <div class="font-medium text-sm text-white">↖︎ 揀 Select</div>
              <div class="text-xs text-slate-500 mt-0.5">撳嚟揀 / 改嘢</div>
            </button>
            <button onclick={() => pick('wall')} class="p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left">
              <div class="font-medium text-sm text-white">▭ 畫牆 Wall</div>
              <div class="text-xs text-slate-500 mt-0.5">撳兩點畫，dbl 收</div>
            </button>
            <button onclick={addStairs} class="p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left">
              <div class="font-medium text-sm text-white">▦ 樓梯 Stairs</div>
              <div class="text-xs text-slate-500 mt-0.5">撳畫面放樓梯</div>
            </button>
            <button onclick={importScan} class="p-4 rounded-2xl bg-[#12233c] active:bg-[#16304f] text-left">
              <div class="font-medium text-sm text-[#5b9bf6]">◎ {isNativeScanAvailable() ? '掃描 Scan' : 'Import 掃描'}</div>
              <div class="text-xs text-[#5b9bf6]/60 mt-0.5">{isNativeScanAvailable() ? 'LiDAR 掃間房' : '匯入 .json/.zip'}</div>
            </button>
          </div>
        {:else if sheet === 'furniture'}
          <input type="text" placeholder="搵傢俬…" bind:value={search} class="w-full px-3 h-11 bg-[#0f151c] rounded-xl text-sm text-white placeholder-slate-500 mb-3 outline-none" />
          <div class="grid grid-cols-3 gap-2">
            {#each filtered as item (item.id)}
              <button onclick={() => placeFurniture(item)} class="flex flex-col items-center gap-1 p-2.5 rounded-2xl bg-[#0f151c] active:bg-[#1c2530]">
                <span class="text-2xl">{item.icon}</span>
                <span class="text-[11px] text-slate-300 text-center leading-tight">{item.name}</span>
                <span class="text-[10px] text-slate-500">{item.width}×{item.depth}</span>
              </button>
            {/each}
          </div>
        {:else if sheet === 'arrange'}
          <button onclick={autoArrange} disabled={arranging} class="w-full p-4 rounded-2xl bg-[#12233c] active:bg-[#16304f] text-left mb-3">
            <div class="font-medium text-sm text-[#5b9bf6]">✨ Auto-arrange / 一鍵執靚</div>
            <div class="text-xs text-[#5b9bf6]/60 mt-0.5">{arrangeMsg || '間房傢俬貼牆排好、唔重疊'}</div>
          </button>
          <div class="p-3 rounded-2xl bg-[#0f151c]">
            <div class="text-xs font-medium text-[#b79bf6] mb-2">🛒 試位 Fit-check — 買之前試吓擺唔擺得落</div>
            <select bind:value={fitCatalogId} class="w-full px-2 h-11 bg-[#141b23] rounded-xl text-sm text-white mb-2 outline-none">
              {#each furnitureCatalog as f}
                <option value={f.id}>{f.icon} {f.name} · {f.width}×{f.depth}cm</option>
              {/each}
            </select>
            <div class="flex gap-2 mb-2">
              <input type="number" inputmode="numeric" bind:value={fitW} placeholder="闊 cm" class="w-1/2 px-2 h-11 bg-[#141b23] rounded-xl text-sm text-white placeholder-slate-500 outline-none" />
              <input type="number" inputmode="numeric" bind:value={fitD} placeholder="深 cm" class="w-1/2 px-2 h-11 bg-[#141b23] rounded-xl text-sm text-white placeholder-slate-500 outline-none" />
            </div>
            <button onclick={fitCheck} class="w-full h-11 rounded-xl text-sm font-medium bg-[#7c5cf0] active:bg-[#6b4be0] text-white">✨ 試位 / Find a spot</button>
            {#if fitMsg}<p class="text-xs mt-2 {fitOk ? 'text-emerald-400' : 'text-[#f0787a]'}">{fitMsg}</p>{/if}
          </div>
        {:else if sheet === 'more'}
          <div class="space-y-2">
            <button onclick={() => { simpleMode.update((v) => !v); }} class="w-full p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left flex items-center">
              <div>
                <div class="font-medium text-sm text-white">簡單模式</div>
                <div class="text-xs text-slate-500 mt-0.5">收埋進階工具（鎖牆防誤觸）</div>
              </div>
              <span class="ml-auto text-sm font-medium {$simpleMode ? 'text-emerald-400' : 'text-slate-500'}">{$simpleMode ? '開 ✓' : '關'}</span>
            </button>
            <a href="/" class="block w-full p-4 rounded-2xl bg-[#0f151c] active:bg-[#1c2530] text-left">
              <div class="font-medium text-sm text-white">← 返專案列表</div>
            </a>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
