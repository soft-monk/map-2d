import type { Map as MlMap } from 'maplibre-gl'

type GlyphManagerLike = {
  localIdeographFontFamily?: string | false
  _doesCharSupportLocalGlyph: (id: number) => boolean
  entries: Record<string, unknown>
}

const patched = new WeakSet<object>()

/**
 * Label-text glyphs only: force every printable BMP glyph requested by the
 * map text layers through MapLibre's local TinySDF path.
 *
 * MapLibre's stock gate accepts only ideographs. Labels contain mixed
 * CJK/Latin/digit strings; mixing local and PBF glyph runs makes MapLibre
 * lay those runs out separately. The current map has no other non-empty
 * symbol-text layers, so this map-level glyph hook affects label text only.
 *
 * Other layers, styles, anchors, sizes, halos and data are untouched.
 */
export function enableLocalGlyphsForLabelText(map: MlMap): boolean {
  const style = map.style as unknown as { glyphManager?: GlyphManagerLike } | undefined
  const gm = style?.glyphManager
  if (!gm || !gm.localIdeographFontFamily || typeof gm._doesCharSupportLocalGlyph !== 'function') {
    return false
  }
  if (patched.has(gm)) return true

  gm._doesCharSupportLocalGlyph = (id: number) => {
    if (!Number.isInteger(id) || id < 0x20 || id > 0xffff) return false
    // Exclude UTF-16 surrogate code units; only valid BMP scalar values remain.
    return id < 0xd800 || id > 0xdfff
  }

  // Drop any glyphs cached through the stock PBF path before the hook ran.
  gm.entries = {}
  patched.add(gm)
  return true
}
