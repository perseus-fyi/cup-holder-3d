// Точка на плоскости [x, y] (мм или исходные единицы SVG/шрифта).
export type Vec2 = [number, number];

/**
 * Контур — замкнутая ломаная. Регион может состоять из нескольких контуров
 * (внешний + дырки), которые интерпретируются по правилу заливки EvenOdd.
 */
export type Contour = Vec2[];

/** Одна фигура: внешний контур и его дырки (правило EvenOdd внутри фигуры). */
export interface LogoShape {
  outer: Contour;
  holes: Contour[];
}

/** Один заливаемый участок логотипа (один цвет, возможно из нескольких фигур). */
export interface LogoRegion {
  id: string;
  /** Фигуры в системе координат исходного SVG (y вниз). Между собой объединяются. */
  shapes: LogoShape[];
  /** Цвет участка для печати (#RRGGBB). */
  color: string;
  /** Участвует ли регион в модели. */
  enabled: boolean;
  /** Подпись для UI. */
  label: string;
}

export type LogoMode = 'inlay' | 'emboss' | 'engrave';

export interface LogoSettings {
  /** Итоговые участки (после объединения похожих цветов) — их использует модель. */
  regions: LogoRegion[];
  /** Исходные участки из SVG (по точным цветам) — основа для перекластеризации. */
  sourceRegions?: LogoRegion[];
  /** Порог объединения похожих цветов (ΔE, 0 — не объединять). */
  mergeThreshold?: number;
  /** Габариты исходного рисунка (для нормализации/вписывания). */
  srcWidth: number;
  srcHeight: number;
  /** Целевой диаметр области логотипа на верхней грани (мм). */
  fitDiameter: number;
  /** Поворот логотипа (градусы). */
  rotation: number;
  /** Сдвиг центра логотипа относительно центра костера (мм). */
  offsetX: number;
  offsetY: number;
  /** Зеркалирование по X. */
  mirror: boolean;
  /**
   * inlay  — заподлицо: в верхней грани делается карман, участки заполняют его (мультицвет, плоский верх);
   * emboss — рельеф над верхней гранью;
   * engrave — гравировка (углубление, один цвет базы).
   */
  mode: LogoMode;
  /** Глубина кармана/гравировки или высота рельефа (мм). */
  depth: number;
  /** Растягивать без сохранения пропорций (заполнить квадрат fitDiameter). */
  stretch?: boolean;
}

export type TextMode = 'engrave' | 'emboss';

/** Надпись по окружности (верхняя или нижняя грань). */
export interface CircleTextSettings {
  enabled: boolean;
  text: string;
  /** Имя шрифта (ключ в реестре fonts). */
  fontKey: string;
  /** Высота шрифта (мм, ~ кегль em). */
  size: number;
  /** Глубина гравировки / высота рельефа (мм). */
  depth: number;
  /** Радиус базовой окружности текста (мм). 0 => авто (у края). */
  radius: number;
  mode: TextMode;
  /** Угол центра строки (градусы, 0 — справа, 90 — сверху по экрану). */
  startAngle: number;
  /** Дополнительный трекинг между буквами (мм). */
  letterSpacing: number;
  /** Цвет (для emboss-мультицвета). */
  color: string;
  /** Текст внутрь (по нижней дуге) или наружу (по верхней дуге). */
  flip: boolean;
}

/** @deprecated используйте CircleTextSettings */
export type BottomTextSettings = CircleTextSettings;

export interface FeetSettings {
  enabled: boolean;
  /** Количество отверстий. */
  count: number;
  /** Диаметр отверстия (мм). */
  holeDiameter: number;
  /** Глубина глухого отверстия (мм). */
  holeDepth: number;
  /** Диаметр окружности расположения центров отверстий (мм). */
  bcd: number;
  /** Угловое смещение всей группы (градусы). */
  angleOffset: number;
}

export interface CoasterParams {
  /** Внешний диаметр (мм). */
  diameter: number;
  /** Толщина диска (мм). */
  thickness: number;
  /** Фаска верхней кромки (мм, 0 — нет). */
  topChamfer: number;
  /** Число сегментов окружности (гладкость). */
  segments: number;
  /** Цвет основы (#RRGGBB). */
  baseColor: string;

  logo: LogoSettings | null;
  /** Первая надпись на нижней грани (по умолчанию по нижней дуге). */
  bottomText: CircleTextSettings;
  /** Вторая надпись на нижней грани (по умолчанию по верхней дуге, напротив первой). */
  bottomText2: CircleTextSettings;
  feet: FeetSettings;
}

/** Готовая к рендеру/экспорту часть модели одного цвета. */
export interface ModelPart {
  name: string;
  color: string; // #RRGGBB
  /** Позиции вершин xyz (мм). */
  positions: Float32Array;
  /** Индексы треугольников. */
  indices: Uint32Array;
}

export interface BuildResult {
  parts: ModelPart[];
  /** Итоговый объём (мм³) для информации. */
  volume: number;
  /** Сообщения/предупреждения для UI. */
  warnings: string[];
}

export function defaultParams(): CoasterParams {
  return {
    diameter: 90,
    thickness: 5,
    topChamfer: 0.8,
    segments: 192,
    baseColor: '#3a4252',
    logo: null,
    bottomText: {
      enabled: true,
      text: '2026',
      fontKey: 'PTSans-Bold',
      size: 6,
      depth: 0.6,
      radius: 0, // авто
      mode: 'engrave',
      startAngle: 270, // нижняя дуга
      letterSpacing: 0.5,
      color: '#e0e0e0',
      flip: false,
    },
    bottomText2: {
      enabled: false,
      text: 'CRAFT',
      fontKey: 'PTSans-Bold',
      size: 6,
      depth: 0.6,
      radius: 0, // авто
      mode: 'engrave',
      startAngle: 90, // верхняя дуга (напротив первой), та же нижняя грань
      letterSpacing: 0.5,
      color: '#e0e0e0',
      flip: true, // по верхней дуге буквы наружу — читается прямо при перевороте
    },
    feet: {
      enabled: true,
      count: 4,
      holeDiameter: 8,
      holeDepth: 2,
      bcd: 64,
      angleOffset: 45,
    },
  };
}
