import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import type { Contour, LogoRegion, LogoSettings, LogoShape, Vec2 } from './types';
import { emptyBounds, expandBounds, signedArea } from './geom';

const CURVE_DIVISIONS = 16;
const DEFAULT_MERGE = 18;

// ---------------- цветовые утилиты ----------------
type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB | null {
  let s = hex.trim();
  const rgbm = /rgba?\(([^)]+)\)/i.exec(s);
  if (rgbm) {
    const p = rgbm[1].split(',').map((x) => parseFloat(x));
    if (p.length >= 3) return [p[0], p[1], p[2]];
    return null;
  }
  s = s.replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (s.length < 6) return null;
  const n = parseInt(s.slice(0, 6), 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

function srgbToLin(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function rgbToLab([r, g, b]: RGB): RGB {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a: RGB, b: RGB): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ---------------- разбор градиентов ----------------
/** id градиента → представительный (усреднённый по стопам) цвет. */
function parseGradients(svgText: string): Map<string, string> {
  const out = new Map<string, string>();
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch {
    return out;
  }
  const byId = new Map<string, Element>();
  doc.querySelectorAll('linearGradient,radialGradient').forEach((g) => {
    const id = g.getAttribute('id');
    if (id) byId.set(id, g);
  });

  const stopColor = (s: Element): string | null => {
    let c = s.getAttribute('stop-color');
    if (!c) {
      const st = s.getAttribute('style');
      const m = st && /stop-color\s*:\s*([^;]+)/i.exec(st);
      c = m ? m[1].trim() : null;
    }
    return c;
  };

  const getStops = (g: Element, seen = new Set<string>()): string[] => {
    const own = Array.from(g.querySelectorAll('stop'))
      .map(stopColor)
      .filter((c): c is string => !!c);
    if (own.length) return own;
    // наследование стопов через href
    const href = g.getAttribute('xlink:href') || g.getAttribute('href');
    if (href && href.startsWith('#')) {
      const id = href.slice(1);
      if (!seen.has(id) && byId.has(id)) {
        seen.add(id);
        return getStops(byId.get(id)!, seen);
      }
    }
    return [];
  };

  for (const [id, g] of byId) {
    const stops = getStops(g);
    let r = 0, gg = 0, b = 0, n = 0;
    for (const sc of stops) {
      const rgb = hexToRgb(sc);
      if (rgb) {
        r += rgb[0];
        gg += rgb[1];
        b += rgb[2];
        n++;
      }
    }
    if (n) out.set(id, rgbToHex([r / n, gg / n, b / n]));
  }
  return out;
}

// ---------------- парсинг SVG ----------------
/**
 * Разбирает SVG в исходные участки (по точным цветам, с разрешением градиентов).
 * Координаты — в системе SVG (y вниз), смещены так, что bbox начинается в (0,0).
 */
export function parseSvg(svgText: string): {
  regions: LogoRegion[];
  srcWidth: number;
  srcHeight: number;
} {
  const gradients = parseGradients(svgText);
  const loader = new SVGLoader();
  const data = loader.parse(svgText);

  // Группируем фигуры по точному цвету, сохраняя порядок первого появления.
  const byColor = new Map<string, LogoShape[]>();

  for (const path of data.paths) {
    const style = (path as any).userData?.style ?? {};
    const fillRaw: string | undefined = style.fill;
    if (!fillRaw || fillRaw === 'none') continue;

    let color: string;
    const m = /url\(\s*#([^)\s]+)\s*\)/.exec(fillRaw);
    if (m && gradients.has(m[1])) {
      color = gradients.get(m[1])!;
    } else {
      color = '#' + (path as any).color.getHexString();
    }

    const shapes = SVGLoader.createShapes(path);
    for (const shape of shapes) {
      const pts = shape.extractPoints(CURVE_DIVISIONS);
      const outer = toContour(pts.shape);
      if (!outer) continue;
      const holes: Contour[] = [];
      for (const hole of pts.holes) {
        const h = toContour(hole);
        if (h) holes.push(h);
      }
      const arr = byColor.get(color);
      if (arr) arr.push({ outer, holes });
      else byColor.set(color, [{ outer, holes }]);
    }
  }

  // Глобальный bbox.
  const b = emptyBounds();
  for (const shapes of byColor.values()) {
    for (const sh of shapes) {
      for (const [x, y] of sh.outer) expandBounds(b, x, y);
    }
  }
  if (!isFinite(b.minX)) return { regions: [], srcWidth: 1, srcHeight: 1 };

  const shiftC = (c: Contour): Contour => c.map(([x, y]): Vec2 => [x - b.minX, y - b.minY]);
  const regions: LogoRegion[] = [];
  let i = 0;
  for (const [color, shapes] of byColor) {
    regions.push({
      id: `r${i}_${color.replace('#', '')}`,
      shapes: shapes.map((sh) => ({ outer: shiftC(sh.outer), holes: sh.holes.map(shiftC) })),
      color,
      enabled: true,
      label: `Цвет ${i + 1}`,
    });
    i++;
  }

  return { regions, srcWidth: b.maxX - b.minX || 1, srcHeight: b.maxY - b.minY || 1 };
}

function toContour(points: { x: number; y: number }[]): Contour | null {
  if (!points || points.length < 3) return null;
  const c: Contour = points.map((p) => [p.x, p.y] as Vec2);
  const f = c[0];
  const l = c[c.length - 1];
  if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) c.pop();
  if (c.length < 3) return null;
  if (Math.abs(signedArea(c)) < 1e-6) return null;
  return c;
}

// ---------------- объединение похожих цветов ----------------
function shapeArea(sh: LogoShape): number {
  let a = Math.abs(signedArea(sh.outer));
  for (const h of sh.holes) a -= Math.abs(signedArea(h));
  return Math.max(0, a);
}
function regionArea(r: LogoRegion): number {
  return r.shapes.reduce((s, sh) => s + shapeArea(sh), 0);
}

interface Cluster {
  sumR: number;
  sumG: number;
  sumB: number;
  area: number;
  shapes: LogoShape[];
  minIndex: number;
  repLab: RGB;
}

/**
 * Объединяет участки, чьи цвета ближе порога ΔE, в один (с площадно-взвешенным
 * усреднённым цветом). Порядок результата сохраняет порядок отрисовки (по
 * наименьшему исходному индексу) — важно для композиции слоёв в 3D.
 */
export function mergeSimilarColors(regions: LogoRegion[], threshold: number): LogoRegion[] {
  if (!regions.length) return [];
  if (threshold <= 0) return regions.map((r, i) => ({ ...r, label: `Цвет ${i + 1}` }));

  const items = regions.map((r, index) => {
    const rgb = hexToRgb(r.color) ?? ([0, 0, 0] as RGB);
    return { region: r, rgb, lab: rgbToLab(rgb), area: regionArea(r) || 1, index };
  });
  // крупные участки задают «семя» кластера
  const order = [...items].sort((a, b) => b.area - a.area);

  const clusters: Cluster[] = [];
  for (const it of order) {
    let best: Cluster | null = null;
    let bestD = Infinity;
    for (const cl of clusters) {
      const d = deltaE(it.lab, cl.repLab);
      if (d <= threshold && d < bestD) {
        bestD = d;
        best = cl;
      }
    }
    if (best) {
      best.sumR += it.rgb[0] * it.area;
      best.sumG += it.rgb[1] * it.area;
      best.sumB += it.rgb[2] * it.area;
      best.area += it.area;
      best.shapes.push(...it.region.shapes);
      best.minIndex = Math.min(best.minIndex, it.index);
      best.repLab = rgbToLab([best.sumR / best.area, best.sumG / best.area, best.sumB / best.area]);
    } else {
      clusters.push({
        sumR: it.rgb[0] * it.area,
        sumG: it.rgb[1] * it.area,
        sumB: it.rgb[2] * it.area,
        area: it.area,
        shapes: [...it.region.shapes],
        minIndex: it.index,
        repLab: it.lab,
      });
    }
  }

  clusters.sort((a, b) => a.minIndex - b.minIndex);
  return clusters.map((cl, i) => ({
    id: `m${i}`,
    shapes: cl.shapes,
    color: rgbToHex([cl.sumR / cl.area, cl.sumG / cl.area, cl.sumB / cl.area]),
    enabled: true,
    label: `Цвет ${i + 1}`,
  }));
}

/** Собирает LogoSettings из результата парсинга и применяет объединение цветов. */
export function makeLogoSettings(
  parsed: ReturnType<typeof parseSvg>,
  prev?: LogoSettings | null
): LogoSettings {
  const threshold = prev?.mergeThreshold ?? DEFAULT_MERGE;
  const sourceRegions = parsed.regions;
  return {
    sourceRegions,
    mergeThreshold: threshold,
    regions: mergeSimilarColors(sourceRegions, threshold),
    srcWidth: parsed.srcWidth,
    srcHeight: parsed.srcHeight,
    fitDiameter: prev?.fitDiameter ?? 50,
    rotation: prev?.rotation ?? 0,
    offsetX: prev?.offsetX ?? 0,
    offsetY: prev?.offsetY ?? 0,
    mirror: prev?.mirror ?? false,
    stretch: prev?.stretch ?? false,
    mode: prev?.mode ?? 'inlay',
    depth: prev?.depth ?? 0.8,
  };
}
