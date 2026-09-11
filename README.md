# map-2d · 二维地图绘制模块

一个**可独立运行、可整包交付**的二维地图模块：MapLibre 渲染 + **API 驱动绘制**（无人机 / 区域 / 目标 / 链路 / 轨迹 / 扫描 / 标注…）。
主系统「智能任务管理系统」通过别名 `@map2d` 消费它——**用法与调用第三方库一致**；本目录也可单独 clone、单独启动。

---

## 一、独立运行（一条命令看到地图）

```bat
cd /d D:\dsh_workpath\mapApp\map-2d
npm install          :: 首次
npm run dev          :: → http://localhost:5180/
```

打开后即可看到：地图 + 指北针 + 极简控制条（底图切换 / 载入示例图元 / 清空 / 图层 / 清屏 / 复位视角）。
**不依赖后端、不依赖主系统**：示例图元来自 `src/standalone/demo-data.ts`。

其他命令：

| 命令 | 作用 |
|---|---|
| `npm run dev:host` | 监听所有网卡，局域网内其他设备可访问（演示用） |
| `npm run build` | 类型检查 + 打包（产物 `dist/`） |
| `npm run preview` | 本地预览 `dist/` |
| `npm run typecheck` | 仅类型检查 |

**底图两种来源都支持**（控制条下拉切换）：

| 选项 | 说明 |
|---|---|
| 本地瓦片 | `/tiles/raster/{z}/{x}/{y}.jpg`（由主系统 C++ 后端托管；独立运行时若没有该路径会回落深色纯底） |
| 在线样式 | MapLibre demotiles / OpenFreeMap Liberty / CARTO 深色（`basemap.styleUrl`，需能上外网） |

---

## 二、目录结构

```
map-2d/
├─ index.html                 # 独立宿主页面
├─ package.json / tsconfig.json / vite.config.ts
├─ src/
│  ├─ index.ts                # ★ 唯一公开入口（嵌入方只从此处导入）
│  ├─ core/
│  │  ├─ types.ts             # 对外契约：MapData / 图元 DTO（模块自带，不依赖主系统）
│  │  ├─ instance.ts          # MapLibre 实例单例
│  │  ├─ commands.ts          # 命令式视角 API：setView / flyTo / focus / resetView / getViewport
│  │  ├─ store.ts             # 模块 UI 状态：清屏 / 图层开关 / 工具 / 视口 / 显示模式
│  │  ├─ displayMode.ts       # 显示模式定义
│  │  └─ options.ts           # 模块开关（版权署名等）
│  ├─ primitives/api.ts       # ★ 绘制 API：MapDraw（9 类图元的增删改查 / 导入导出）
│  ├─ render/LayerManager.ts  # 底层图层与 source 管理（含图层分组显隐）
│  ├─ ui/                     # MapView / MapToolbar / LayerPanel / Compass
│  └─ standalone/             # 独立宿主入口 + 示例数据 + 独立样式
└─ README.md                  # 本文档
```

**依赖规则**：只依赖 `maplibre-gl` / `react` / `zustand`；**不依赖**主系统的 store、面板、组件库或后端。
因此整个 `map-2d/` 可以原样拷给别人（见第六节）。

---

## 三、公开 API（`import { ... } from '@map2d'`）

| 导出 | 用途 |
|---|---|
| `<MapView data={MapData}>` | 地图容器；children 作为地图内浮层 |
| `<MapToolbar />` | 地图工具条（选择 / 图层 / 清屏 / 全屏；测距等为占位） |
| `<LayerPanel />` | 图层开关面板（10 个图层分组独立开关） |
| `<Compass />` | 指北针（随 bearing 旋转，点击复位正北） |
| `<MapModeBadge mode={string} />` | 显示模式徽标 |
| `MapDraw` | **绘制 API**（见下节） |
| `mapCommands` | 视角命令：`setView / flyTo / focus / resetView / zoomBy / getViewport / isReady` |
| `useMapUiStore()` | 模块 UI 状态：`clearMode / activeTool / layersOpen / hiddenGroups / viewport / displayMode` |
| `LAYER_GROUPS` / `LAYER_GROUP_LABELS` | 图层分组清单与中文名 |
| `displayModeOf(scenarioKey, phase)` | 按场景 + 阶段取显示模式名 |
| `MAP_OPTIONS` | 模块开关（`showAttribution` 等） |
| `mapInstance` | MapLibre 实例（高级用法） |

---

## 四、绘制 API（渲染 + API 驱动）

九类图元：`area`（区域多边形）· `drone`（无人机）· `target`（目标/锁定框）· `link`（链路）·
`track`（轨迹）· `scan`（扫描覆盖）· `pulse`（脉冲环）· `cluster`（集群）· `label`（标注/标记）

```ts
import { MapDraw } from '@map2d'

// 整组替换
MapDraw.set('area', [
  { id: 'A-1', polygon: [[116.30,39.94],[116.42,39.95],[116.44,39.88]], color: '#3b82f6', label: 'A 区' },
])

// 单个增改删
MapDraw.add('drone', { id: 'U-1', lng: 116.378, lat: 39.920, type: 'optical', label: '光电-01' })
MapDraw.add('target', { id: 'T-1', lng: 116.452, lat: 39.878, threat: 'high', selected: true, label: '目标 001' })
MapDraw.add('link', { id: 'L-1', from: [116.365,39.912], to: [116.452,39.878], state: 'yellow' })
MapDraw.add('scan', { id: 'S-1', lng: 116.365, lat: 39.912, radiusKm: 6, label: '光电覆盖' })
MapDraw.remove('target', 'T-1')

// 查询 / 清空 / 导入导出
const items = MapDraw.list('drone')
MapDraw.clear('track')            // 清空某类
MapDraw.clear()                   // 清空全部（含地图上的动态图层）
const snap = MapDraw.export()     // 可 JSON 序列化，便于存档/交付
MapDraw.load(snap)                // 整体导入
```

要点：

- **样式与数据解耦**：图元自带 `color / label / selected / status / threat / state` 等属性；未给则用内置调色板
  （威胁：高红 / 中琥珀 / 低青；无人机：光电青 / 雷达琥珀 / 电子紫 / 通信绿；链路：绿通 / 黄弱 / 红断）
- **扫描半径**用「公里」表达，模块按当前缩放自动换算像素，并在缩放变化后重算
- 所有图元写入走 `source.setData()` 增量更新，不重建图层
- 换底图（`setStyle`）后模块会自动重建图层并重放已绘制的图元
- **手绘交互（鼠标画多边形/线/点）不在本版本范围**，留待后续

---

## 五、嵌入到主系统

主系统（`frontend/`）通过别名消费，代码里看不到 MapLibre 细节：

```ts
// frontend/vite.config.ts
alias: { '@map2d': fileURLToPath(new URL('../map-2d/src/index.ts', import.meta.url)) }

// 使用（frontend/src/app/AppShell.tsx）
import { MapView, MapToolbar, Compass, useMapUiStore } from '@map2d'
```

数据由**唯一适配器**注入：`frontend/src/app/useMapData.ts`（业务 store → `MapData`）。
换遥测源、改数据结构，只改这个文件；`map-2d` 内部零改动。

```ts
interface MapData {
  config: MapConfigData | null
  scenarioKey: string
  phase: string
  targets: Target[]
  selectedTargetId?: string | null
  groups: Group[]
  uavs: UavPosEvent[]
  edges: LinkEdge[]
  topology: LinkTopology | null
  track: TargetTrackPoint[]
}
```

---

## 六、交付给别人 / 独立子仓

**方式一：整包拷贝**（最简单）
把 `map-2d/` 整个目录拷走 → `npm install` → `npm run dev` 即可运行；嵌入时按第五节配一个别名。

**方式二：独立子仓（可 git clone）**
本目录已在主仓中以普通目录维护；需要独立仓库时，用主仓提供的脚本一键发布：

```bat
:: 在主仓根目录执行
scripts\publish-map2d.bat              :: 默认推送到 soft-monk/map-2d
scripts\publish-map2d.bat <repo-url>   :: 或推送到指定仓库
```

脚本用 `git subtree split --prefix=map-2d` 生成只含本模块的历史并推送目标仓库——
主仓结构不变，本模块可被单独 clone 使用；后续同步只需重跑该脚本。

---

## 七、约束与备注

- **仅二维**：`dragRotate / maxPitch` 锁定为平面；三维能力（地形/建筑/2D-3D 切换）已按 v1.2 范围收敛放弃
- **版权署名**：`src/core/options.ts` 的 `showAttribution` 控制是否显示底图署名（当前默认隐藏，
  合规责任由使用方承担；改回 `true` 即恢复）
- **源码交付**：本模块以源码形式交付，未发布 npm 包（`package.json` 中 `private: true`）
- 无左侧导航、无底部状态栏——独立宿主只保留"地图 + 地图相关控件"，符合"干净的二维绘制模块"定位
