import type { Vec2 } from './types';

/** Число сегментов для аппроксимации кривой по её «размаху». */
function bezierSteps(approxLen: number, quality = 0.25): number {
  return Math.max(2, Math.min(64, Math.ceil(approxLen * quality)));
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** Аппроксимация кубической кривой Безье в набор точек (без начальной точки). */
export function flattenCubic(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  out: Vec2[]
): void {
  const approx =
    dist(p0[0], p0[1], p1[0], p1[1]) +
    dist(p1[0], p1[1], p2[0], p2[1]) +
    dist(p2[0], p2[1], p3[0], p3[1]);
  const n = bezierSteps(approx);
  for (let i = 1; i <= n; i++) {
    const u = i / n;
    const v = 1 - u;
    const a = v * v * v;
    const b = 3 * v * v * u;
    const c = 3 * v * u * u;
    const d = u * u * u;
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ]);
  }
}

/** Аппроксимация квадратичной кривой Безье в набор точек (без начальной точки). */
export function flattenQuadratic(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  out: Vec2[]
): void {
  const approx =
    dist(p0[0], p0[1], p1[0], p1[1]) + dist(p1[0], p1[1], p2[0], p2[1]);
  const n = bezierSteps(approx);
  for (let i = 1; i <= n; i++) {
    const u = i / n;
    const v = 1 - u;
    const a = v * v;
    const b = 2 * v * u;
    const c = u * u;
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0],
      a * p0[1] + b * p1[1] + c * p2[1],
    ]);
  }
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function expandBounds(b: Bounds, x: number, y: number): void {
  if (x < b.minX) b.minX = x;
  if (y < b.minY) b.minY = y;
  if (x > b.maxX) b.maxX = x;
  if (y > b.maxY) b.maxY = y;
}

/** Площадь контура со знаком (для определения внешний/дырка и фильтрации мусора). */
export function signedArea(c: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = c.length; i < n; i++) {
    const [x1, y1] = c[i];
    const [x2, y2] = c[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
