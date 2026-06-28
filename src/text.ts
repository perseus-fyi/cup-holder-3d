import opentype from 'opentype.js';
import type { Contour, Vec2 } from './types';
import { flattenCubic, flattenQuadratic } from './geom';

export interface FontEntry {
  key: string;
  label: string;
  font: opentype.Font;
}

const registry = new Map<string, FontEntry>();

const DEFAULT_FONTS = [
  { key: 'PTSans-Bold', label: 'PT Sans Bold', file: 'PTSans-Bold.ttf' },
  { key: 'PTSansNarrow-Bold', label: 'PT Sans Narrow Bold', file: 'PTSansNarrow-Bold.ttf' },
  { key: 'PTSans-Regular', label: 'PT Sans', file: 'PTSans-Regular.ttf' },
];

function baseUrl(): string {
  // Vite подставляет base; нормализуем до строки с завершающим слешем.
  const b = (import.meta as any).env?.BASE_URL ?? '/';
  return b.endsWith('/') ? b : b + '/';
}

/** Регистрирует шрифт из бинарных данных. */
export function registerFont(key: string, label: string, buffer: ArrayBuffer): FontEntry {
  const font = opentype.parse(buffer);
  const entry: FontEntry = { key, label, font };
  registry.set(key, entry);
  return entry;
}

export function getFontEntry(key: string): FontEntry | undefined {
  return registry.get(key);
}

export function listFonts(): FontEntry[] {
  return [...registry.values()];
}

/** Грузит встроенные шрифты из public/fonts. Возвращает ключи успешно загруженных. */
export async function loadDefaultFonts(): Promise<string[]> {
  const ok: string[] = [];
  await Promise.all(
    DEFAULT_FONTS.map(async (f) => {
      try {
        const res = await fetch(`${baseUrl()}fonts/${f.file}`);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        registerFont(f.key, f.label, buf);
        ok.push(f.key);
      } catch {
        /* шрифт недоступен — пропускаем */
      }
    })
  );
  return ok;
}

interface GlyphResult {
  contours: Vec2[][];
  advance: number;
}

/** Контуры одного символа в локальной системе (x от penX, y вверх, базовая линия y=0). */
function glyphContours(font: opentype.Font, ch: string, fontSize: number, penX: number): GlyphResult {
  const glyph = font.charToGlyph(ch);
  const path = glyph.getPath(penX, 0, fontSize);
  const contours: Vec2[][] = [];
  let cur: Vec2[] = [];
  let start: Vec2 = [0, 0];
  let prev: Vec2 = [0, 0];

  const flushContour = () => {
    if (cur.length >= 3) contours.push(cur);
    cur = [];
  };

  for (const cmd of path.commands as any[]) {
    // opentype отдаёт y вниз (canvas); переворачиваем в y-вверх.
    switch (cmd.type) {
      case 'M': {
        flushContour();
        start = [cmd.x, -cmd.y];
        prev = start;
        cur = [start];
        break;
      }
      case 'L': {
        prev = [cmd.x, -cmd.y];
        cur.push(prev);
        break;
      }
      case 'C': {
        const p3: Vec2 = [cmd.x, -cmd.y];
        flattenCubic(prev, [cmd.x1, -cmd.y1], [cmd.x2, -cmd.y2], p3, cur);
        prev = p3;
        break;
      }
      case 'Q': {
        const p2: Vec2 = [cmd.x, -cmd.y];
        flattenQuadratic(prev, [cmd.x1, -cmd.y1], p2, cur);
        prev = p2;
        break;
      }
      case 'Z': {
        flushContour();
        prev = start;
        break;
      }
    }
  }
  flushContour();

  const advance = (glyph.advanceWidth ?? 0) * (fontSize / font.unitsPerEm);
  return { contours, advance };
}

export interface TextLayoutOptions {
  text: string;
  /** Высота шрифта (мм, em). */
  size: number;
  /** Радиус базовой окружности (мм). */
  radius: number;
  /** Угол центра строки (градусы). */
  centerAngleDeg: number;
  /** Доп. трекинг между буквами (мм). */
  letterSpacing: number;
  /** Сторона/направление дуги: false — буквы наружу, true — внутрь. */
  flip: boolean;
  /** Зеркалирование по X. Нужно для текста на ВЕРХНЕЙ грани (читается прямо сверху). */
  mirrorX?: boolean;
}

/**
 * Раскладывает строку по дуге и возвращает контуры в системе модели (мм, y вверх),
 * уже зеркалированные по X для корректного чтения на НИЖНЕЙ грани костера.
 */
export function buildTextContours(font: opentype.Font, opts: TextLayoutOptions): Contour[] {
  const chars = Array.from(opts.text);
  if (!chars.length || opts.radius <= 0) return [];

  // 1) Плоская раскладка вдоль X (y-вверх, базовая линия y=0).
  const flat: Vec2[][] = [];
  let penX = 0;
  for (const ch of chars) {
    if (ch === ' ') {
      const sp = font.charToGlyph(' ');
      penX += (sp.advanceWidth ?? font.unitsPerEm * 0.3) * (opts.size / font.unitsPerEm) + opts.letterSpacing;
      continue;
    }
    const g = glyphContours(font, ch, opts.size, penX);
    for (const c of g.contours) flat.push(c);
    penX += g.advance + opts.letterSpacing;
  }
  const totalWidth = Math.max(0, penX - opts.letterSpacing);
  if (totalWidth <= 0 || !flat.length) return [];

  // 2) Центрируем по X.
  const half = totalWidth / 2;
  for (const c of flat) for (const p of c) p[0] -= half;

  // 3) Раскладка на окружность + зеркало по X (нижняя грань).
  const centerAngle = (opts.centerAngleDeg * Math.PI) / 180;
  const R = opts.radius;
  // По умолчанию (flip=false) буквы смотрят внутрь — это правильная ориентация
  // для надписи по НИЖНЕЙ дуге (читается прямо при перевороте костера).
  // flip=true разворачивает наружу — для надписи по верхней дуге.
  const sign = opts.flip ? 1 : -1;
  const mx = opts.mirrorX ? -1 : 1;

  return flat.map((c) =>
    c.map(([lx, ly]): Vec2 => {
      const dθ = lx / R;
      const angle = centerAngle + sign * dθ;
      const r = R + sign * ly;
      const X = r * Math.cos(angle);
      const Y = r * Math.sin(angle);
      return [mx * X, Y];
    })
  );
}
