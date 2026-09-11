# map-2d · 二维地图模块

> 一句话：**把"二维地图 + 往地图上画东西"做成了一个能直接拿来用的模块。**
> 你不用接触 MapLibre，只要调接口：给数据 → 出图；要画什么 → 调 `MapDraw`。

---

## 一、这个模块是干什么的

它解决的是这类问题：**我想在一个网页里显示一张地图，并在上面画无人机、目标、区域、航线、链路……**

不用这个模块的话，你得自己：搭 MapLibre、写样式、管图层、把业务坐标转成 GeoJSON、处理缩放重算、控制显隐、处理和底图切换的冲突……
用这个模块，这些都不用管，业务侧只剩三件事：

```ts
// 1. 给地图一个配置（看哪儿、底图瓦片在哪）
const data: MapData = { config: {...}, targets: [...], uavs: [...], ... }

// 2. 把地图挂到页面上
<MapView data={data} />

// 3. 要画什么就调接口
MapDraw.add('target', { id: 'T-1', lng: 116.45, lat: 39.88, threat: 'high' })
MapDraw.set('area', [{ id: 'A-1', polygon: [[...]], color: '#3b82f6' }])
```

**现在就能画的**：无人机、无人机轨迹、不规则区域、封闭区域、目标、集群编组、扫描覆盖、脉冲标记、文本标注（共 9 类，见 §3.1）。
**现在就能做的**：图层分组开关、视角控制与定位、图元快照导入导出、显示模式徽标、清屏模式、底图热切换不丢图元。

**还在计划里的**（航线、圆形/椭圆区域、单个图元显隐、手绘与编辑、时间轴回放、多套底图切换……）：见 §3.2 完整清单。

**技术边界**：只有二维（不旋转、不倾斜，正北朝上）；不含业务逻辑；不含界面框架；不依赖任何后端代码。

---

## 二、空白机器怎么跑起来（五步）

### 第 0 步 · 需要什么

| 需要 | 说明 |
|---|---|
| Node.js 18 以上 | 唯一必需的软件。命令行执行 `node -v` 能打印版本即可 |
| 底图瓦片数据 | 一张约 172 MB 的压缩包，见第 2 步。**没有它地图也能打开，只是底图是空的** |
| 后端服务 | **不需要**。本模块不依赖任何后端 |
| 浏览器 | Chrome / Edge 等 Chromium 系 |

> Windows 上请在 **cmd** 里执行命令，不要用 PowerShell（PowerShell 默认禁止运行 `npm.ps1`，会报
> `running scripts is disabled on this system`）。

---

### 第 1 步 · 把模块拉下来

```bat
git clone https://github.com/soft-monk/map-2d.git
cd map-2d
```

没有 git 的话，在仓库页面点 **Code → Download ZIP**，解压后同样进入该目录。

---

### 第 2 步 · 手动下载底图数据，并放到指定位置

**① 打开下载页**

浏览器访问：**https://github.com/soft-monk/smart-mission-system/releases/tag/tiles-v1**

在页面下方的 **Assets** 里点 **`mapapp-tiles-raster.zip`** 下载。

> 直链（也可直接粘到浏览器地址栏）：
> `https://github.com/soft-monk/smart-mission-system/releases/download/tiles-v1/mapapp-tiles-raster.zip`

**② 这个包里是什么**

| 项 | 内容 |
|---|---|
| 格式 | 标准 XYZ 栅格瓦片，文件是 `jpg` |
| 数量 | 14,205 张，压缩包约 172 MB |
| 覆盖 | 全球 z0–z6（5,461 张，全世界都有但很糊）+ 北京 z7–z14（5,329 张，清楚）+ 上海 z7–z13 |
| 来源 | Esri World Imagery（署名见第七节） |

**③ 解压到哪里（这一步最容易错，请对照图看）**

把 zip **解压到 `map-2d` 目录下**，解压后要得到 `map-2d/tiles/raster/...` 这样的结构：

```
map-2d/                          ← 你 clone 下来的目录
├─ tiles/                        ← ★ 新建/解压出来的（zip 里自带 tiles 的内容）
│  └─ raster/
│     ├─ 0/0/0.jpg
│     ├─ 6/50/23.jpg
│     ├─ 12/3423/1665.jpg
│     └─ ...
├─ src/
├─ package.json
├─ README.md                     ← 你正在看的文件
└─ vite.config.ts
```

判断标准只有一条：**存在文件 `map-2d/tiles/raster/12/3423/1665.jpg`**，就说明放对了。

> **常见错误**：解压后变成 `map-2d/tiles/mapapp-tiles-raster/raster/...`（多套了一层）。
> 这种情况下把里面那层 `raster` 直接挪到 `map-2d/tiles/` 下即可。

**④ 如果数据不在 `tiles/`，或者你不想挪动它**

用环境变量指向实际位置（该目录下同样要有 `raster/`）：

```bat
set MAP2D_TILES_DIR=D:\mapapp-tiles
```

> 已经在主仓 `mapApp` 里工作时，瓦片本来就在主仓的 `tiles\`，不必再拷一份：
> ```bat
> cd mapApp\map-2d
> set MAP2D_TILES_DIR=..\tiles
> ```

---

### 第 3 步 · 装依赖并启动

```bat
npm install
npm run dev
```

终端出现下面两行，说明**瓦片认到了**：

```
[tiles] 本地瓦片目录: D:\...\map-2d\tiles
[tiles] 可用层级 z0–z14（15 级）
```

如果出现的是 `[tiles] 未找到瓦片：...`，说明第 2 步的位置不对——按上面的判断标准核对后重启即可。

---

### 第 4 步 · 打开看效果

浏览器访问：**http://localhost:5180/**

你会看到：一张北京卫星影像地图 + 左上角一条控制条 + **23 个示例图元**（三种颜色的区域、四个无人机、三个目标、三条链路、扫描覆盖圈、轨迹线、脉冲圈、文本标注）。

把浏览器窗口缩到手机大小也能用：单指拖动、双指缩放。

局域网内其他电脑/平板要访问时，用 `npm run dev:host` 启动，然后访问 `http://<这台机器的IP>:5180/`。

---

### 第 5 步 · 确认"是这个模块在干活"

在地图页面上做这几件事，能直观确认各能力都在：

| 你做的 | 应该看到 |
|---|---|
| 拖拽地图、滚轮缩放 | 影像平滑移动；**地图不会旋转/倾斜**（二维锁定） |
| 点左上「载入示例图元」 | 23 个图元重新铺开；旁边显示"已绘制 23 个图元" |
| 点「清空图元」 | 地图上只剩底图与区域 |
| 点「图层」，切换各分组 | 区域/目标/无人机/链路/扫描/轨迹可以逐个隐藏与显示 |
| 点「清屏」 | 界面上只剩地图与绘制物（Esc 或右上按钮退出） |
| 点「复位视角」 | 回到初始视角（北京，z12） |
| 顶栏下拉切「在线 · MapLibre demotiles」 | 换成另一种底图样式（需要能上外网） |
| 右下角 | 比例尺随缩放变化 |
---

## 三、这个模块现在有什么（功能清单）

状态口径：**✅ 已完成 ｜ ⏳ 待完成**（当前 93 条需求中已完成 36 条，详见 [doc/需求文档.md](doc/需求文档.md) §6）。

### 3.1 已经能用的（✅）

| 能力 | 说明 | 你能在哪看到 |
|---|---|---|
| 拖拽平移 / 滚轮缩放 / 双击放大 / 触屏手势 | 缩放以光标为中心 | 页面上直接操作 |
| 二维锁定 | 禁旋转、禁俯仰，方向恒定 | 怎么拖都不歪 |
| 初始视角与缩放范围 | 由配置下发（中心/层级/最小/最大） | `MapConfigData` |
| 视角命令 | 设置视角、飞行、定位到坐标、复位、相对缩放、读当前视口、查就绪 | [doc/接口文档.md](doc/接口文档.md) §6 |
| 本地栅格瓦片底图 | 按 `{z}/{x}/{y}` 模板加载本地瓦片 | 页面上就是 |
| 在线样式底图 | 支持直接给样式 URL | 顶栏下拉切换 |
| 无瓦片兜底 | 瓦片缺失也能打开、可交互 | 不装瓦片时启动 |
| 底图缺口观感 | 缺口是深蓝灰"地面色"，不是刺眼黑 | 拖动时边缘 |
| 运行中换底图 | 换样式后已绘图元**不丢**（自动重放） | 顶栏切换底图 |
| 版权署名开关 | 一行开关控制是否显示署名 | `MAP_OPTIONS.showAttribution` |
| **9 类图元绘制** | 区域、无人机、目标、链路、轨迹、扫描、脉冲、集群、标注 | 示例图元即是 |
| 图元增删改查 | 整组替换 / 单个增改 / 单个删除 / 按类清空 / 读列表 | `MapDraw` |
| 图元快照导入导出 | 一次导出全部、一次导入覆盖（可 JSON 存档） | `MapDraw.export/load` |
| 扫描半径按公里 | 千米表达，随缩放自动换算像素 | 示例里的扫描圈 |
| 图元样式覆盖 | 颜色、透明度、虚线、标签、选中态逐图元指定 | 示例图元配色 |
| 10 个图层分组开关 | 独立开关，状态跨底图切换保留 | 「图层」面板 |
| 数据驱动渲染 | 颜色/威胁级别/状态由图元属性决定，未给用内置调色板 | 改数据即变色 |
| 增量更新 | 数据变更走 `setData`，不重建图层 | 高频更新不闪 |
| 脉冲扩散动画 | 目标/无人机外围扩散环 | 示例里的扩散圈 |
| 地图工具条 | 选择 / 图层 / 清屏 / 全屏 | 左上角 |
| 清屏模式 | 只留地图与绘制物（隐藏哪些面板由宿主决定） | 「清屏」 |
| 显示模式徽标 | 按场景+阶段展示 10 种取值 | 右上角 |
| 独立演示宿主 | 一条命令打开即出图 | `npm run dev` |
| 接口文档 / 类型自带 / 模块开关集中 | 看文档即可接入 | [doc/接口文档.md](doc/接口文档.md) |

> **注**：指北针、缩放按钮（右上角）与比例尺（左下角）目前是**默认显示**的；
> 按计划要改成"默认隐藏、调接口才显示"（见 3.2 第一行）。

### 3.2 还没做的（⏳，需要时按优先级排）

| 方向 | 具体条目 |
|---|---|
| **控件按需显示** | 指北针、鼠标位置经纬度、缩放按钮、比例尺目前是"默认显示"或缺失；目标状态是**默认隐藏、调接口才显示**（含新增"鼠标位置经纬度"控件） |
| **多套底图切换** | 本地装了影像/路网/地形多套底图时，可枚举、可切换（整幅替换）、切换后视角与图元保持，并对宿主暴露查询/切换/通知接口 |
| **瓦片精度上限** | 按地面分辨率（米/像素）设上限，超过就不再请求更细层级（默认不限制，只作用于本地底图） |
| **绘制对象补全** | 无人机**航线**、圆形/椭圆区域、目标区域 |
| **图元显隐** | 每个图元单独显示/隐藏（现在只能按"分组"开关） |
| **手绘与编辑** | 鼠标画点/线/面（测距、区域绘制、新建、标绘）+ 拖拽与顶点编辑（**同期做**） |
| **回放** | 模块提供时间轴（播放/暂停/倍速/定位），数据与存储由宿主负责 |
| **态势增强** | 圈层图元（距离环/方位线）、目标聚合、标签避让、图层排序、**国军标符号库** |
| **量算与事件** | 测距/测面/方位角；图元点击/悬停/选中回调 |
| **工程性** | 性能基线维护、资源上限、大数据量降级、多实例隔离、错误边界 |
| **观感遗留** | 缩放/拖拽时偶发的深蓝灰方块（已定位成因，曾试一版体感变卡顿已回退） |

完整条目、验收标准与决策记录见 [doc/需求文档.md](doc/需求文档.md)。

---

## 四、怎么在自己的项目里用它

### 4.1 拷贝与安装

把 `map-2d/` 目录拷进你的项目（**只需 `src/`、`package.json`、`tsconfig.json`、`vite.config.ts`**；
`tiles/`、`dist/`、`node_modules/` 不需要），然后：

```bat
npm i maplibre-gl react react-dom zustand
```

### 4.2 配别名

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

### 4.3 最小可运行代码

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

// 画东西（不碰 MapLibre）
MapDraw.set('area', [{ id: 'A-1', polygon: [[116.30, 39.94], [116.42, 39.95], [116.44, 39.88]], color: '#3b82f6', label: 'A 区' }])
MapDraw.add('target', { id: 'T-1', lng: 116.452, lat: 39.878, threat: 'high', selected: true })

// 动镜头
mapCommands.focus(116.452, 39.878, 14)
```

### 4.4 三条接入规矩

1. **数据只从 props 进**（`MapData`）：模块不读你的 store。业务状态 → `MapData` 建议写一个适配器函数（主系统就是 `useMapData.ts` 一个文件）。
2. **图元一律走 `MapDraw`**：不要在业务代码里 `.addSource()` / `.addLayer()`。
3. **瓦片地址由你决定**：`basemap.tileUrlTemplate` 指向你自己的服务或本地路径。

> 主系统的做法（供参考）：启动页会先把全球低精度瓦片预热一遍再走完进度条，
> 目的是让低缩放拖拽时少出现空白。那段逻辑在宿主侧（`useStore.ts`），不属于模块——
> 模块只提供被调用的绘制与命令接口。

### 4.5 打生产包

```bat
npm run build      :: 产物在 dist/
```

---

## 五、出问题怎么查

| 现象 | 原因 | 处理 |
|---|---|---|
| 地图打开但一片深蓝灰，没有影像 | 瓦片没放对 | 看启动日志的 `[tiles]` 两行；用"存在 `map-2d/tiles/raster/12/3423/1665.jpg`"这条标准核对 |
| 日志打印 `[tiles] 未找到瓦片：...` | 解压位置不对（最常见是多套了一层目录） | 把 `raster` 挪到 `map-2d/tiles/` 下，或用 `MAP2D_TILES_DIR` 指过去 |
| 只有北京/上海清楚，其他地方很糊 | 正常：瓦片只预切了这两个区域，其余是全球 z0–6 低精度 | 要更多区域得自己扩瓦片（切图不在本模块职责内） |
| 拖动时出现深蓝灰方块，约半秒后出图 | 该处瓦片正在加载（已知观感问题） | 见 [doc/需求文档.md](doc/需求文档.md) `M2-NFR-06`；暂无根治方案 |
| `npm run dev` 报端口被占用 | 5180 被别的程序占了 | `npm run dev -- --port 5190` |
| PowerShell 里 npm 报 `running scripts is disabled` | PowerShell 执行策略 | 改用 cmd，或 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| 切到"在线样式"底图后一片空白 | 那几个选项要上外网 | 断网环境请用"本地瓦片" |
| 平板/手机上打不开 | `npm run dev` 只监听本机 | 用 `npm run dev:host`，访问 `http://<本机IP>:5180/` |

---

## 六、目录与文档

```
map-2d/
├─ doc/                       # 模块文档（只讲本模块）
│  ├─ 接口文档.md             # ★ 接入的唯一依据：签名/参数/默认值/示例/错误约定
│  ├─ 需求文档.md             #   功能清单（完成/待完成）、验收准则、性能基线、决策记录
│  └─ 设计文档.md             #   内部分层、渲染管线、设计决策与取舍、已知边界
├─ examples/                  # 可复现示例（性能基准脚本 benchmark.ts）
├─ src/                       # 源码
├─ tiles/                     # ★ 底图数据（自己解压进来，已被 git 忽略）
├─ index.html / vite.config.ts / package.json / tsconfig.json
└─ README.md
```

**面对不同目的，看哪份**

| 你的目的 | 看这个 |
|---|---|
| 接入到我的项目里 | [doc/接口文档.md](doc/接口文档.md)（先看它）+ 本文 §4 |
| 想知道模块有哪些能力、还差什么 | 本文 §3 + [doc/需求文档.md](doc/需求文档.md) §6 |
| 想改模块内部实现 | [doc/设计文档.md](doc/设计文档.md) |
| 想知道性能到什么水平 | [doc/需求文档.md](doc/需求文档.md) §4（实测基线）+ `examples/benchmark.ts` |

---

## 七、许可与数据来源

- **代码**：Apache-2.0
- **瓦片数据**：Esri World Imagery，署名应为 *Esri, Maxar, Earthstar Geographics, and the GIS User Community*。
  是否在界面右下角显示署名由 `src/core/options.ts` 的 `MAP_OPTIONS.showAttribution` 控制，**当前默认隐藏**；
  对外展示或再分发前，请自行确认符合来源条款（把该开关改为 `true` 即恢复署名）。
  Release 中的瓦片包属于**对外再分发**，使用与传播同样需自行确认条款。
