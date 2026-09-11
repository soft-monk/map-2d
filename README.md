# map-2d · 二维地图模块

**二维地图能力的基座**：别的模块不用懂 MapLibre——看 [doc/接口文档.md](doc/接口文档.md) 就能把地图用起来。
MapLibre 渲染 + API 驱动绘制（无人机 / 航线 / 轨迹 / 区域 / 目标 / 链路 / 扫描 / 标注…）。

- 本模块**可独立运行**（自带演示宿主），也可**嵌进任何 React 项目**（主系统就是这么用的）
- 只依赖 `maplibre-gl` / `react` / `zustand`；**不依赖任何后端代码**
- 地图数据（瓦片）由配置指向；数据放本地后可**完全离线运行**

---

## 一、快速开始（三条命令）

在 **cmd** 里执行（PowerShell 下 `npm` 可能被执行策略挡住）：

```bat
git clone https://github.com/soft-monk/map-2d.git
cd map-2d
npm install
npm run dev
```

浏览器打开 **http://localhost:5180/** 。此时**地图能开、但底图是空的**（缺口底色）——因为还没有瓦片数据。
按第二节把瓦片放到位，刷新即可出图。

> 手头没有瓦片也能继续：页面、示例图元、交互都正常，只是没有底图。

---

## 二、准备底图数据（首次必做）

### 2.1 下载

底图瓦片包发布在本项目主仓的 Release 里（**Esri World Imagery** 卫星影像，约 172 MB）：

| 项 | 值 |
|---|---|
| Release 页面 | https://github.com/soft-monk/smart-mission-system/releases/tag/tiles-v1 |
| 直接下载 | https://github.com/soft-monk/smart-mission-system/releases/download/tiles-v1/mapapp-tiles-raster.zip |
| 内容 | XYZ 栅格瓦片：`raster/{z}/{x}/{y}.jpg`，共 14,204 张 |
| 覆盖范围 | 全球 z0–6 + 北京 z7–14 + 上海 z7–13 |

### 2.2 解压到指定位置（关键）

把 zip 解压到模块根目录下的 `tiles/`，**解压后必须长这样**：

```
map-2d/
├─ tiles/
│  └─ raster/
│     ├─ 6/50/23.jpg
│     ├─ 12/3423/1665.jpg
│     └─ ...
├─ src/
├─ package.json
└─ README.md
```

也就是说：zip 里自带 `raster/` 这一层，**直接解压到 `map-2d/` 目录即可**，不要再套一层。

> `tiles/` 已被 git 忽略，不会误提交。

### 2.3 瓦片不在 `tiles/` 时怎么办

用环境变量指向实际位置即可（目录下同样要有 `raster/`）：

```bat
set MAP2D_TILES_DIR=D:\data\mapapp-tiles
npm run dev
```

> **主仓（mapApp）里调试时**：瓦片本来就在主仓的 `tiles\` 下，不用再拷一份：
> ```bat
> cd mapApp\map-2d
> set MAP2D_TILES_DIR=..\tiles
> npm run dev
> ```

### 2.4 怎么确认瓦片放对了

启动时终端会打印一行：

```
[tiles] 本地瓦片目录: D:\...\map-2d\tiles
[tiles] 可用层级 z0–z14（15 级）
```

看到这两行就说明认到了。若打印 `未找到瓦片：...`，说明路径不对——按 2.2 的结构核对。

---

## 三、独立运行（演示 / 调试 / 交付验证）

```bat
npm run dev
::    http://localhost:5180/

npm run dev:host
::    监听所有网卡，局域网内其他电脑/平板可直接访问  http://<本机IP>:5180/
```

页面上的控制条：

| 控件 | 作用 |
|---|---|
| 底图下拉 | 本地瓦片 / 在线样式（MapLibre demotiles、OpenFreeMap、CARTO 深色） |
| 载入示例图元 / 清空图元 | 9 类示例图元（23 个）一键铺开或清空 |
| 图层 | 10 个图层分组开关面板 |
| 清屏 | 只留地图与绘制物 |
| 复位视角 | 回到配置中的初始视角 |

其他命令：

| 命令 | 作用 |
|---|---|
| `npm run build` | 类型检查 + 打包到 `dist/` |
| `npm run preview` | 预览打包产物 |
| `npm run typecheck` | 只做类型检查 |

**运行前提**

| 依赖 | 说明 |
|---|---|
| Node.js 18+ | 必需 |
| 瓦片数据 | 非必需（没有则底图空白），见第二节 |
| 后端 | **不需要**。本模块不依赖任何后端；瓦片由开发服务器直接伺服 |

**端口**：`5180`（可用 `npm run dev -- --port 5190` 改）。

---

## 四、嵌进你自己的项目

### 4.1 拷贝模块

把整个 `map-2d/` 目录拷到你的项目里（只拷 `src/`、`package.json`、`tsconfig.json`、`vite.config.ts` 也可，`tiles/`、`dist/`、`node_modules/` 不需要）。然后装依赖：

```bat
npm i maplibre-gl react react-dom zustand
```

### 4.2 配别名（推荐）

```ts
// vite.config.ts
import { fileURLToPath, URL } from 'node:url'
export default defineConfig({
  resolve: { alias: { '@map2d': fileURLToPath(new URL('./map-2d/src/index.ts', import.meta.url)) } },
  server: { fs: { allow: ['..'] } },   // 模块在项目外时需要
})
```

```json
// tsconfig.json
{ "compilerOptions": { "paths": { "@map2d": ["./map-2d/src/index.ts"] } },
  "include": ["src", "map-2d/src"] }
```

### 4.3 画地图

```tsx
import 'maplibre-gl/dist/maplibre-gl.css'
import { MapView, MapToolbar, Compass, MapDraw, mapCommands } from '@map2d'
import type { MapData } from '@map2d'

const data: MapData = {
  config: {
    center: [116.3974, 39.9093], zoom: 11, minZoom: 3, maxZoom: 15,
    basemap: { tileUrlTemplate: '/tiles/raster/{z}/{x}/{y}.jpg', attribution: 'Esri, Maxar' },
  },
  scenarioKey: 'demo', phase: 'T0',
  targets: [], groups: [], uavs: [], edges: [], topology: null, track: [],
}

export const Situation = () => (
  <div style={{ position: 'absolute', inset: 0 }}>
    <MapView data={data}>
      <MapToolbar />
      <Compass />
    </MapView>
  </div>
)

// 画图：不碰 MapLibre
MapDraw.set('area', [{ id: 'A-1', polygon: [[116.30, 39.94], [116.42, 39.95], [116.44, 39.88]], color: '#3b82f6', label: 'A 区' }])
MapDraw.add('target', { id: 'T-1', lng: 116.452, lat: 39.878, threat: 'high', selected: true })

// 动镜头
mapCommands.focus(116.452, 39.878, 14)
```

**接入要点**

- 数据只能从 props 进（`MapData`），模块不读你的 store；业务 state → `MapData` 建议写一个适配器函数；
- 图元一律走 `MapDraw`，不要在业务代码里 `.addSource()` / `.addLayer()`；
- 瓦片地址由 `basemap.tileUrlTemplate` 决定——**你自己的服务托管瓦片时，把它改成你的路径**。

### 4.4 主系统怎么接的（参考）

| 关注点 | 做法 |
|---|---|
| 别名 | `vite.config.ts` + `tsconfig.json` 里的 `@map2d` |
| 唯一适配器 | `frontend/src/app/useMapData.ts`：业务 store → `MapData`（换数据源只改这一个文件） |
| 装配 | `frontend/src/app/AppShell.tsx`：`<MapView data={...}>` 里放工具条、图层面板、指北针、徽标 |
| 瓦片 | 由 C++ 后端静态托管在 `/tiles/raster/{z}/{x}/{y}.jpg` |

完整接口清单、参数默认值、错误与降级约定：**[doc/接口文档.md](doc/接口文档.md)**。

---

## 五、出图不正常时

| 现象 | 原因 | 处理 |
|---|---|---|
| 地图打开但一片深蓝灰，没有任何影像 | 瓦片没放对，或路径不对 | 看启动日志的 `[tiles]` 两行；按 §2.2 核对 `tiles/raster/{z}/{x}/{y}.jpg` |
| 启动日志 `未找到瓦片：...` | 同上 | 解压位置不对（多套了一层目录最常见），或用 `MAP2D_TILES_DIR` 指过去 |
| 只有北京/上海清楚，别处很糊 | 正常：瓦片只预切了这两个区域；别处是全球 z0–6 低精度 | 需要更多区域就自行扩瓦片（本模块不做切图） |
| 拖动时出现深蓝灰方块、约半秒后出图 | 该处瓦片正在加载（已知观感问题，见需求文档 M2-NFR-06） | 暂无根治方案，已记录 |
| `npm run dev` 报端口占用 | 5180 被占 | `npm run dev -- --port 5190` |
| PowerShell 里 `npm` 报 `running scripts is disabled` | 执行策略限制 | 用 cmd，或 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| 底图选择"在线样式"后一片空白 | 该选项拉的是外网样式（demotiles / OpenFreeMap / CARTO） | 断网或无外网时用"本地瓦片" |

---

## 六、目录与文档

```
map-2d/
├─ doc/                       # 模块文档（只讲本模块）
│  ├─ 接口文档.md             # ★ 接入的唯一依据：签名/参数/默认值/示例/错误约定
│  ├─ 需求文档.md             #   定位与边界 / 需求条目（M2-域-序号）/ 验收 / 性能基线 / 决策记录
│  └─ 设计文档.md             #   分层 / 渲染管线 / 设计决策与取舍 / 已知边界
├─ examples/                  # 可复现示例（性能基准脚本）
├─ src/                       # 源码（结构见 doc/设计文档.md §2）
├─ tiles/                     # 底图数据（自己放，已 git 忽略）
├─ index.html / vite.config.ts / package.json / tsconfig.json
└─ README.md
```

**怎么读这套文档**

| 你是 | 先看 |
|---|---|
| 要接入的开发者 | [doc/接口文档.md](doc/接口文档.md) → 本文 §4 |
| 需求/验收 | [doc/需求文档.md](doc/需求文档.md)（§6 需求追踪：哪些完成、哪些待完成） |
| 要改模块内部 | [doc/设计文档.md](doc/设计文档.md) |

---

## 七、许可与数据来源

- 代码：Apache-2.0
- 瓦片数据：**Esri World Imagery**（署名 Esri / Maxar / Earthstar Geographics）。是否显示署名由
  `src/core/options.ts` 的 `MAP_OPTIONS.showAttribution` 控制，**当前默认隐藏**——对外展示或再分发前，
  请自行确认符合来源条款（改回 `true` 即恢复右下角署名）。
  Release 里的瓦片包属**对外再分发**，使用与传播同样需自行确认条款。
