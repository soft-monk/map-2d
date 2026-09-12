// map-2d · 独立宿主的"功能验收台"（需求完成情况的可点验证）
//
// 设计：每个按钮**直接调用模块的真实 API**，右侧显示返回值/计数/指标，右上角显示操作与事件反馈。
// 用途：验收时不用读代码——点一遍就能看到"哪条需求已经能用了"，也能一眼看到还差什么。
import React from 'react'
import {
  MapDraw, basemaps, mapCommands, onPrimitiveEvent, recentErrors, resetDiagnostics,
  runtimeStats, useMapUiStore,
} from '../index'
import type { PrimitiveKind } from '../index'
import { ACCEPTED_FEATURES, DEMO_SNAPSHOT, OPEN_ITEMS } from './demo-data'

const PANEL: React.CSSProperties = {
  background: 'rgba(8,16,30,.86)',
  border: '1px solid var(--panel-border, #1d3a5c)',
  borderRadius: 8,
  backdropFilter: 'blur(8px)',
  color: 'var(--text-1, #cfe3f5)',
  fontFamily: 'inherit',
}

const btn: React.CSSProperties = {
  padding: '4px 9px', fontSize: 11.5, fontFamily: 'inherit', cursor: 'pointer',
  borderRadius: 5, background: 'rgba(12,24,42,.9)',
  border: '1px solid var(--panel-border, #1d3a5c)', color: 'var(--text-1, #cfe3f5)',
  whiteSpace: 'nowrap',
}

const KINDS: PrimitiveKind[] = ['area', 'drone', 'target', 'link', 'track', 'scan', 'pulse', 'cluster', 'label', 'route', 'shape']

const countAll = () => KINDS.reduce((n, k) => n + MapDraw.list(k).length, 0)

export const Acceptance: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const [log, setLog] = React.useState<string[]>([])
  const [stats, setStats] = React.useState(() => runtimeStats())
  const [subscribed, setSubscribed] = React.useState(false)
  /** 最近一次导出的视图状态（"打乱后恢复"按钮用） */
  const savedStateRef = React.useRef<Awaited<ReturnType<typeof mapCommands.exportViewState>> | null>(null)
  /** 最近一次导出的图片 dataURL（供界面预览） */
  const [exportedImage, setExportedImage] = React.useState<string | null>(null)
  void exportedImage
  const controls = useMapUiStore((s) => s.controls)

  const say = React.useCallback((msg: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${msg}`, ...l].slice(0, 40))
  }, [])

  // 指标每秒刷新一次（帧率/图元数/瓦片缓存…）
  React.useEffect(() => {
    const t = window.setInterval(() => setStats(runtimeStats()), 1000)
    return () => window.clearInterval(t)
  }, [])

  // 图元点击事件：订阅一次，之后点图元就在日志里显示 kind:id
  React.useEffect(() => {
    if (!subscribed) return
    const off = onPrimitiveEvent('click', (e) => say(`点击命中 → ${e.kind}:${e.id}`))
    return off
  }, [subscribed, say])

  const only = (kinds: PrimitiveKind[]) => {
    MapDraw.clear()
    const picked: Partial<Record<PrimitiveKind, unknown[]>> = {}
    for (const k of kinds) picked[k] = DEMO_SNAPSHOT[k] as unknown[]
    MapDraw.load(picked as never)
    say(`只保留 ${kinds.join('/')} → 共 ${countAll()} 个图元`)
  }

  const run = async (label: string) => {
    switch (label) {
      case '飞回北京 z12':
        mapCommands.setView(116.3974, 39.9093, 12, 600)
        say('setView(116.3974, 39.9093, 12) 已执行')
        break
      case '定位到目标 001':
        mapCommands.focus(116.452, 39.878, 14)
        say('focus(116.452, 39.878, 14) 已执行')
        break
      case '开启全部控件':
        mapCommands.showControls(['compass', 'coords', 'zoom', 'scale'])
        say(`已开启：${mapCommands.getControls().join(', ') || '（无）'}`)
        break
      case '关闭全部控件':
        mapCommands.showControls(['compass', 'coords', 'zoom', 'scale'], false)
        say('四类控件已关闭')
        break
      case '打开图层面板':
        useMapUiStore.getState().toggleLayersPanel()
        say('图层面板已切换（左上「图层」按钮同效）')
        break
      case '显示图例':
        mapCommands.toggleControl('legend')
        say(mapCommands.getControlState().legend ? '图例已显示（左上）' : '图例已隐藏')
        break
      case '区域压到最上层':
        mapCommands.moveLayerGroup('area', 'target', 'after')
        say('area 已移到 target 之后 → 顺序：' + mapCommands.getLayerOrder().slice(-6).join(' > '))
        break
      case '恢复区域原位置':
        mapCommands.moveLayerGroup('area', 'target', 'before')
        say('area 已移回 target 之前')
        break
      case '目标组半透明':
        mapCommands.setLayerGroupOpacity('target', 0.35)
        say('target 组透明度 = ' + mapCommands.getLayerGroupOpacity('target'))
        break
      case '目标组恢复不透明':
        mapCommands.setLayerGroupOpacity('target', 1)
        say('target 组透明度 = ' + mapCommands.getLayerGroupOpacity('target'))
        break
      case '切到画区模式':
        mapCommands.setDrawMode('area')
        say('已进入画区模式：地图上单击落点，双击 / Enter 闭合（Esc 取消）')
        break
      case '切到航线模式':
        mapCommands.setDrawMode('line')
        say('已进入航线模式：单击落点，双击 / Enter 完成')
        break
      case '进入测距模式':
        mapCommands.setDrawMode('measure-line')
        say('已进入测距：单击起点与终点，双击 / Enter 结束')
        break
      case '进入测面模式':
        mapCommands.setDrawMode('measure-area')
        say('已进入测面：单击多个点，双击 / Enter 结束')
        break
      case '编辑第一个区域': {
        const first = MapDraw.list('area')[0]
        if (!first) { say('当前没有区域图元，先点「载入全部示例」'); break }
        const r = mapCommands.editPrimitive('area', first.id)
        say(r.ok ? `进入编辑态：area:${first.id}，拖动顶点手柄即可修改` : `进入编辑失败：${r.reason}`)
        break
      }
      case '退出所有交互':
        mapCommands.cancelInteraction()
        mapCommands.finishEdit()
        say('已退出绘制/编辑；预览已清空、拖拽平移已恢复')
        break
      case '只画目标': only(['target']); break
      case '只画航线': only(['route']); break
      case '只画圆形/椭圆/目标区': only(['shape']); break
      case '只画扫描与脉冲': only(['scan', 'pulse']); break
      case '载入全部示例':
        MapDraw.load(DEMO_SNAPSHOT)
        say(`已载入全部示例 → 共 ${countAll()} 个图元（11 类）`)
        break
      case '隐藏目标 001':
        MapDraw.hide('target', 'T-1')
        say(`hide('target','T-1')；目标数据仍有 ${MapDraw.list('target').length} 条，可见性=${MapDraw.isVisible('target', 'T-1')}`)
        break
      case '恢复显示':
        MapDraw.show('target', 'T-1')
        say(`show('target','T-1')；可见性=${MapDraw.isVisible('target', 'T-1')}`)
        break
      case '批量加 2000 个点': {
        MapDraw.clear('drone')
        let submits = 0
        const src = (window as unknown as { __map2dMap?: unknown })
        void src
        const t0 = performance.now()
        const r = MapDraw.batch(() => {
          for (let i = 0; i < 2000; i++) {
            MapDraw.add('drone', { id: 'B' + i, lng: 116.30 + (i % 200) * 1e-4, lat: 39.85 + Math.floor(i / 200) * 1e-3 })
          }
        })
        submits = r.kinds.length
        say(`batch 提交 2000 点：耗时 ${(performance.now() - t0).toFixed(1)} ms，渲染类型 ${submits} 类（${r.kinds.join(',')}）`)
        break
      }
      case '限制到 1km/像素': {
        const z = mapCommands.setTilePrecisionLimit({ maxMetersPerPixel: 1000 })
        const map = (await import('../core/instance')).mapInstance.current
        say(`精度上限 → maxZoom=${z}；源 maxzoom=${(map?.getStyle()?.sources?.base as { maxzoom?: number } | undefined)?.maxzoom ?? '—'}（继续放大不再请求更细瓦片）`)
        break
      }
      case '取消精度限制': {
        mapCommands.setTilePrecisionLimit(null)
        const map = (await import('../core/instance')).mapInstance.current
        say(`已取消限制；源 maxzoom=${(map?.getStyle()?.sources?.base as { maxzoom?: number } | undefined)?.maxzoom ?? '—'}`)
        break
      }
      case '切到「路网」底图':
      case '切回「卫星影像」': {
        const id = label.includes('路网') ? 'road' : 'satellite'
        const r = mapCommands.switchBasemap(id)
        say(r.ok ? `switchBasemap('${id}') 成功（整幅替换）` : `switchBasemap('${id}') 失败：${r.reason}`)
        break
      }
      case '切不存在的底图': {
        const r = mapCommands.switchBasemap('not-exist')
        say(r.ok ? '意外成功？' : `已按预期失败：${r.reason}；当前底图仍为 ${mapCommands.currentBasemap()?.id}`)
        break
      }
      case '订阅点击（看提示）':
        setSubscribed((v) => !v)
        say(subscribed ? '已取消点击订阅' : '已订阅图元点击 → 现在点地图上的图元试试')
        break
      case '注入 3 条脏数据': {
        resetDiagnostics()
        MapDraw.add('target', { id: 'dirty-1', lng: 'x' as unknown as number, lat: 39.9 })
        MapDraw.add('target', { id: 'dirty-2' } as never)
        MapDraw.add('scan', { id: 'dirty-3', lng: 116.4, lat: 39.9, radiusKm: 0 })
        const errs = recentErrors().map((e) => `${e.kind}/${e.id}:${e.reason}`)
        say(`脏数据被跳过并上报 ${errs.length} 条 → ${errs.join('；')}`)
        break
      }
      case '导出视图状态': {
        void mapCommands.exportViewState().then((s) => {
          savedStateRef.current = s
          say('已导出视图状态：' + Object.keys(s).join(', '))
        })
        break
      }
      case '打乱后恢复状态': {
        if (!savedStateRef.current) { say('请先点「导出视图状态」'); break }
        // 故意打乱：换视角、关控件、清图元
        mapCommands.setView(121.4737, 31.2304, 6)
        mapCommands.showControls(['compass', 'legend', 'coords', 'zoom', 'scale'], false)
        MapDraw.clear()
        say('已打乱（视角移到上海、控件全关、图元清空），1 秒后恢复…')
        window.setTimeout(() => {
          void mapCommands.restoreViewState(savedStateRef.current!).then((r) => {
            const vp = mapCommands.getViewport()
            const total = KINDS.reduce((n, k) => n + MapDraw.list(k).length, 0)
            say(r.ok
              ? `已恢复：${r.applied.join('、')}；当前视角 ${vp.lng.toFixed(3)},${vp.lat.toFixed(3)} z${vp.zoom}；图元 ${total} 个`
              : `恢复失败：${r.reason}`)
          })
        }, 1000)
        break
      }
      case '图片导出（带控件）': {
        void mapCommands.exportImage({ withControls: true }).then((url) => {
          const img = new Image()
          img.src = url
          img.onload = () => say(`已导出 PNG：${img.naturalWidth}×${img.naturalHeight}，约 ${Math.round((url.length * 0.75) / 1024)} KB（含控件底色）`)
          setExportedImage(url)
        })
        break
      }
      case '对比批量与非批量': {
        MapDraw.clear('label')
        const w0 = mapCommands.getRenderTiming()
        for (let i = 0; i < 50; i++) MapDraw.add('label', { id: 'RT' + i, lng: 116.30 + i * 1e-4, lat: 39.95, text: 'x' })
        const w1 = mapCommands.getRenderTiming()
        MapDraw.clear('label')
        mapCommands.setView(116.3974, 39.9093, 12)
        const w2 = mapCommands.getRenderTiming()
        MapDraw.batch(() => {
          for (let i = 0; i < 50; i++) MapDraw.add('label', { id: 'RB' + i, lng: 116.32 + i * 1e-4, lat: 39.95, text: 'y' })
        })
        const w3 = mapCommands.getRenderTiming()
        say(`非批量：写入 ${w1.writes - w0.writes} 次 → 渲染 ${w1.renders - w0.renders} 次；批量：写入 ${w3.writes - w2.writes} 次 → 渲染 ${w3.renders - w2.renders} 次`)
        break
      }
      case '刷新指标':
        setStats(runtimeStats())
        say('指标已刷新（右侧面板每秒也自动刷新）')
        break
      default:
        say(`（按钮「${label}」还没有绑定动作）`)
    }
  }

  const openTotal = OPEN_ITEMS.reduce((n, o) => n + o.count, 0)

  return (
    <>
      {subscribed && (
        <div style={{ ...PANEL, position: 'absolute', top: 60, left: 12, zIndex: 12, padding: '4px 10px', fontSize: 11.5, color: '#7fd1ff' }}>
          图元点击订阅中：点地图上的任意图元，右侧日志会显示 kind:id
        </div>
      )}

      <div
        style={{
          ...PANEL, position: 'absolute', top: 12, right: 12, zIndex: 12, width: 306,
          maxHeight: 'calc(100% - 24px)', overflowY: 'auto', padding: 10, fontSize: 11.5,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <b style={{ fontSize: 12.5 }}>功能验收台</b>
          <span style={{ color: '#8fb0cc' }}>
            93 条需求：已完成 58 · 待完成 {openTotal}
          </span>
          {onClose && <button style={{ ...btn, marginLeft: 'auto' }} onClick={onClose}>收起</button>}
        </div>

        {/* 实时指标：对应 M2-CTRL-15 */}
        <div style={{ ...PANEL, background: 'rgba(4,10,20,.6)', padding: '6px 8px', marginBottom: 8, fontFamily: 'Consolas, monospace', fontSize: 11 }}>
          <div>帧率 {stats.fps} fps ｜ 瓦片缓存 {stats.tileCache ?? '—'} ｜ 提交 {stats.lastSubmitMs} ms ｜ 堆 {stats.jsHeapMB ?? '—'} MB</div>
          <div style={{ color: '#8fb0cc' }}>
            图元 {KINDS.filter((k) => (stats.primitives[k] ?? 0) > 0).map((k) => `${k}:${stats.primitives[k]}`).join(' ') || '（无）'}
          </div>
        </div>

        {/* 已实现能力：逐条可点 */}
        {Array.from(new Set(ACCEPTED_FEATURES.map((f) => f.domain))).map((domain) => (
          <div key={domain} style={{ marginBottom: 8 }}>
            <div style={{ color: '#7fd1ff', fontWeight: 600, margin: '6px 0 4px' }}>
              ✅ {domain}
            </div>
            {ACCEPTED_FEATURES.filter((f) => f.domain === domain).map((f) => (
              <div key={f.label} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4 }}>
                <button style={btn} onClick={() => void run(f.label)} title={f.ids}>{f.label}</button>
                <span style={{ color: '#8fb0cc', fontSize: 11, lineHeight: 1.35 }}>{f.expect}</span>
              </div>
            ))}
          </div>
        ))}

        {/* 待完成清单：来自需求文档 §6，只读展示 */}
        <div style={{ color: '#f7b955', fontWeight: 600, margin: '10px 0 4px' }}>
          ⏳ 待完成（{openTotal} 条）
        </div>
        {OPEN_ITEMS.map((o) => (
          <div key={o.domain} style={{ marginBottom: 5 }}>
            <div style={{ color: '#e6c07b' }}>{o.domain} · {o.open}（{o.count} 条）</div>
            <div style={{ color: '#8fb0cc', fontSize: 11, lineHeight: 1.35 }}>{o.summary}</div>
          </div>
        ))}

        {/* 操作日志 */}
        <div style={{ color: '#7fd1ff', fontWeight: 600, margin: '10px 0 4px' }}>操作结果 / 事件</div>
        <div style={{ fontFamily: 'Consolas, monospace', fontSize: 10.5, lineHeight: 1.5, maxHeight: 132, overflowY: 'auto', color: '#cfe3f5' }}>
          {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <div style={{ color: '#8fb0cc' }}>还没有操作，点上面的按钮试试</div>}
        </div>

        <div style={{ marginTop: 8, color: '#8fb0cc', fontSize: 10.5 }}>
          底图：{basemaps.list().map((b) => (b.isCurrent ? `【${b.id}】` : b.id)).join(' ')}
          ｜ 控件：{Object.entries(controls).filter(([, v]) => v).map(([k]) => k).join(',') || '全关'}
        </div>
      </div>
    </>
  )
}
