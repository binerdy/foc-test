/** Pastel palette for colour-coding pieces (soft, light backgrounds). */
export const PASTEL_PALETTE = [
  '#f5bcbc', // rose
  '#f6d0b3', // apricot
  '#f8e6ae', // sand
  '#e8f0b3', // lime
  '#c9ecc0', // mint
  '#bfead9', // seafoam
  '#bde3f0', // sky
  '#c3cdf2', // periwinkle
  '#d6c4f0', // lilac
  '#ecc4ea', // orchid
  '#f3c3d6', // blossom
  '#ddd2c4', // taupe
]

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return { h: 0, s: 0, l: 50 }
  const int = parseInt(m[1], 16)
  const r = ((int >> 16) & 255) / 255
  const g = ((int >> 8) & 255) / 255
  const b = (int & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: l * 100 }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h = (h * 60 + 360) % 360
  return { h, s: s * 100, l: l * 100 }
}

/**
 * Ink colour for text drawn on top of a pastel background: the complementary
 * hue (opposite side of the colour wheel), dark enough for solid contrast.
 */
export function inkFor(pastel: string): string {
  const { h, s } = hexToHsl(pastel)
  if (s < 12) return 'hsl(0 0% 25%)' // near-grey pastel → neutral dark ink
  return `hsl(${Math.round((h + 180) % 360)} 45% 28%)`
}
