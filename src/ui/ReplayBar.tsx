// map-2d · 回放时间轴（需求 M2-DRAW-17 的界面部分）
//
// 由模块提供，宿主放进 <MapView> 即可用：
//   <ReplayBar />                      默认样式（底部居中）
//   <ReplayBar compact />              紧凑版（只有进度条与播放键）
// 没有加载回放数据时**不渲染**（避免空荡荡一条控件挂在界面上）。
import React from 'react'
import {
  pause, play, seekProgress, setFollow, setSpeed, status, step, useReplay,
} from '../core/replay'

const PANEL: React.CSSProperties = {
  background: 'rgba(8,16,30,.86)',
  border: '1px solid var(--panel-border, #1d3a5c)',
  borderRadius: 8,
  backdropFilter: 'blur(8px)',
  color: 'var(--text-1, #cfe3f5)',
  fontFamily: 'inherit',
}

const btn: React.CSSProperties = {
  padding: '3px 8px', fontSize: 11.5, fontFamily: 'inherit', cursor: 'pointer',
  borderRadius: 5, background: 'rgba(12,24,42,.9)',
  border: '1px solid var(--panel-border, #1d3a5c)', color: 'var(--text-1, #cfe3f5)',
  minWidth: 30,
}

/** 毫秒时间戳 → HH:MM:SS（按本地时区；回放更关心"相对进度"） */
function fmtClock(t: number): string {
  if (!t) return '--:--:--'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 时长 → 可读文案 */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m} 分 ${Math.round(s - m * 60)} 秒`
}

const SPEEDS = [0.5, 1, 2, 4, 8]

export const ReplayBar: React.FC<{ compact?: boolean; style?: React.CSSProperties }> = ({ compact, style }) => {
  const loaded = useReplay((s) => s.loaded)
  const playing = useReplay((s) => s.playing)
  const speed = useReplay((s) => s.speed)
  const current = useReplay((s) => s.current)
  const start = useReplay((s) => s.start)
  const end = useReplay((s) => s.end)
  const follow = useReplay((s) => s.follow)
  const states = useReplay((s) => s.states)

  if (!loaded) return null

  const progress = end > start ? (current - start) / (end - start) : 0
  const activeCount = states.filter((s) => s.active).length

  return (
    <div
      data-map2d-replay="true"
      style={{
        ...PANEL,
        position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 14, zIndex: 12,
        padding: compact ? '6px 10px' : '8px 12px',
        display: 'flex', alignItems: 'center', gap: 8, width: compact ? 380 : 560, maxWidth: 'calc(100% - 24px)',
        ...style,
      }}
    >
      <button style={btn} title={playing ? '暂停' : '播放'} onClick={() => (playing ? pause() : play())}>
        {playing ? '❚❚' : '▶'}
      </button>
      <button style={btn} title="上一个采样点" onClick={() => step(-1)}>⏮</button>
      <button style={btn} title="下一个采样点" onClick={() => step(1)}>⏭</button>

      <span style={{ fontSize: 11, fontFamily: 'Consolas, monospace', whiteSpace: 'nowrap' }}>
        {fmtClock(current)}
      </span>

      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(progress * 1000)}
        title="拖拽定位到任意时刻"
        onChange={(e) => seekProgress(Number(e.target.value) / 1000)}
        style={{ flex: 1, minWidth: 80, accentColor: '#22d3ee', cursor: 'pointer' }}
      />

      <span style={{ fontSize: 11, fontFamily: 'Consolas, monospace', whiteSpace: 'nowrap' }}>
        {fmtClock(end)}
      </span>

      {!compact && (
        <>
          <select
            value={speed}
            title="播放倍速"
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ ...btn, paddingRight: 4 }}
          >
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>

          <label
            title="自动跟随：播放时把视角跟到对象上"
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'pointer' }}
          >
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} style={{ margin: 0 }} />
            跟随
          </label>

          <span style={{ fontSize: 11, color: '#8fb0cc', whiteSpace: 'nowrap' }}>
            {activeCount} 个对象 · 时长 {fmtDuration(end - start)}
          </span>
        </>
      )}
    </div>
  )
}

/** 供宿主或调试读取：当前回放状态的快照 */
export const replayStatus = status
