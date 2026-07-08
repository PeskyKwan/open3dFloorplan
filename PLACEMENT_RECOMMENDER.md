# 自動傢俬擺位 (Auto-Placement) — v1

「呢件傢俬擺邊度最好?」— 揀咗一件傢俬，撳一個掣，就自動搵最佳空位。

## 點跑（喺 Mac 個 terminal）

```
cd ~/Developer/GitHub/open3dFloorplan
npm install     # 第一次先做，約 1–2 分鐘
npm run dev      # 開發伺服器
```

之後開瀏覽器去 terminal 印出嗰條 `http://localhost:5173`。

## 一鍵執靚成間房（Auto-arrange，feature B）

Import 完個 scan 之後，左邊 **Build** 面板 → **Layout** 區 → 撳 **✨ Auto-arrange / 一鍵執靚**。
間房所有傢俬會即刻自動貼牆排好、唔重疊、縮返入牆內（解決 RoomPlan 影出嚟疊晒/出界嗰個問題）。
> 實測你張 scan：13 件全部排好、零重疊、無一件出界。

## 買之前試位（Fit-check，feature A）

想買件新傢俬，睇吓間屋擺唔擺得落:

A. 左邊 **Build** → **Layout** 區 → **🛒 試位 Fit-check**。
B. 揀一件傢俬（或者喺下面 **闊 / 深 cm** 打返 IKEA 標籤上嘅尺寸，留空就用預設）。
C. 撳 **✨ 試位 / Find a spot**。
D. 擺得落 → 綠字話你放咗喺邊間房，件嘢即刻出喺 plan 上（唔啱可以揀住 Delete）。擺唔落 → 紅字話你冇位。
> 你現有傢俬當「死位」唔會郁，只係試新嗰件擺唔擺得落。

## 點用（單件 Auto-place）

A. Import 你個 scan（側邊 **Import RoomPlan** → 揀 `scan-xxxx.json` → Import）。
B. 由 **Objects** 揀一件傢俬擺入去（或者揀返個已經喺度嘅）。
C. 撳一下件傢俬揀中佢 → 右邊 **Properties** 面板頂會見到 **✨ Auto-place / 自動擺位**。
D. 撳佢 → 件傢俬會跳去最佳位（貼牆、避開其他傢俬、唔阻門口）。面板會顯示結果。

## 計法（v1）

- 用房間偵測到嘅範圍（`getRoomPolygon`）當作可擺區。
- 產生候選位：沿住每幅牆貼住擺 + 室內網格點。
- 硬性條件:要完全喺房內、同其他傢俬保持 **8cm** 間距、唔可以壓住 **門口 80cm** 淨空區。
- 評分（預設 `wall` 策略）：優先貼牆 → 再要周圍夠空 → 再遠離門口。
- 揀分數最高嗰個；搵唔到就話你「間房太逼／件嘢太大」。

## 改咗嘅檔

- `src/lib/utils/placementRecommender.ts` — 新，核心演算法（純幾何，冇 UI 依賴）。
- `src/lib/components/sidebar/PropertiesPanel.svelte` — 加咗「Auto-place」掣同 handler。
- `src/lib/utils/roomDetection.ts` + `src/lib/models/types.ts` — `detectRooms` 依家會保留正確嘅房間邊界多邊形（`Room.polygon`），順手整靚咗 `getRoomPolygon`（之前喺嘈雜掃描上會拼錯）。

## v1 已知限制（下輪執）

- 傢俬**朝向**（正面向邊）暫時淨係擺個 footprint，未一定啱（例如梳化面住牆）。
- 一次擺一件；未有「一次過擺勻成間房」。
- 未計窗、走廊動線、風水/美觀。
- 用直角化(orthogonal)後嘅房；歪牆房效果會差啲。

已用你真實 scan（`scan-1783531286.json`）測過：主房 ~11.6 m²，正確搵到椅/細件嘅貼牆位、避開 11 件現有傢俬同門口；夾硬塞大梳化入逼爆嘅房會正確咁話「冇位」。
