import type { ManifoldToplevel, Manifold, CrossSection } from 'manifold-3d';
import type {
  BuildResult,
  Contour,
  CoasterParams,
  LogoSettings,
  ModelPart,
  Vec2,
} from './types';

/** Доп. вход для сборки (контуры текста уже разложены по дуге в мм, y вверх). */
export interface BuildInput {
  /** Контуры первой нижней надписи (финальные XY, мм, центр = 0,0). */
  bottomTextContours?: Contour[];
  /** Контуры второй нижней надписи (финальные XY, мм, центр = 0,0). */
  bottomText2Contours?: Contour[];
}

/** Учёт WASM-объектов для последующего освобождения памяти. */
class Trash {
  private items: { delete(): void }[] = [];
  keep<T extends { delete(): void }>(x: T): T {
    this.items.push(x);
    return x;
  }
  dispose() {
    for (const i of this.items) {
      try {
        i.delete();
      } catch {
        /* уже удалён */
      }
    }
    this.items = [];
  }
}

const EPS = 0.05;

function meshToPart(m: Manifold, name: string, color: string): ModelPart {
  const mesh = m.getMesh();
  const numProp = mesh.numProp;
  const vp = mesh.vertProperties;
  let positions: Float32Array;
  if (numProp === 3) {
    positions = new Float32Array(vp);
  } else {
    const n = mesh.numVert;
    positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = vp[i * numProp];
      positions[i * 3 + 1] = vp[i * numProp + 1];
      positions[i * 3 + 2] = vp[i * numProp + 2];
    }
  }
  const indices = new Uint32Array(mesh.triVerts);
  return { name, color, positions, indices };
}

/** Профиль диска (revolve вокруг Y): x = радиус, y = высота. С верхней фаской. */
function diskProfile(R: number, t: number, chamfer: number): Vec2[] {
  const c = Math.max(0, Math.min(chamfer, Math.min(R, t) - 0.2));
  if (c <= 0) {
    return [
      [0, 0],
      [R, 0],
      [R, t],
      [0, t],
    ];
  }
  return [
    [0, 0],
    [R, 0],
    [R, t - c],
    [R - c, t],
    [0, t],
  ];
}

/** Функция преобразования точки логотипа из координат SVG (y вниз) в XY мм (y вверх). */
function logoPointTransform(logo: LogoSettings): (p: Vec2) => Vec2 {
  const w = logo.srcWidth || 1;
  const h = logo.srcHeight || 1;
  // contain — равномерно вписать по большей стороне; stretch — заполнить квадрат fitDiameter.
  const scaleX = logo.stretch ? logo.fitDiameter / w : logo.fitDiameter / Math.max(w, h);
  const scaleY = logo.stretch ? logo.fitDiameter / h : logo.fitDiameter / Math.max(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const rot = (logo.rotation * Math.PI) / 180;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const sx = logo.mirror ? -1 : 1;

  return ([x, y]: Vec2): Vec2 => {
    const px = (x - cx) * scaleX * sx; // центрируем, масштабируем, зеркало
    const py = -(y - cy) * scaleY; // SVG y-вниз → модель y-вверх
    const rx = px * cosR - py * sinR;
    const ry = px * sinR + py * cosR;
    return [rx + logo.offsetX, ry + logo.offsetY];
  };
}

/** Главная сборка модели. wasm должен быть уже инициализирован (setup вызван). */
export function buildCoasterWith(
  wasm: ManifoldToplevel,
  params: CoasterParams,
  input: BuildInput = {}
): BuildResult {
  const { Manifold, CrossSection } = wasm;
  const trash = new Trash();
  const warnings: string[] = [];

  const R = params.diameter / 2;
  const t = params.thickness;
  const segments = Math.max(24, Math.round(params.segments));
  wasm.setCircularSegments(segments);

  try {
    // --- База (диск с верхней фаской) ---
    const profile = diskProfile(R, t, params.topChamfer);
    let base = trash.keep(Manifold.revolve(profile as Vec2[], segments));

    // --- Глухие отверстия под ножки ---
    if (params.feet.enabled && params.feet.count > 0) {
      const f = params.feet;
      const holeR = f.holeDiameter / 2;
      const ringR = f.bcd / 2;
      if (f.holeDepth >= t - 0.4) {
        warnings.push('Глубина отверстий под ножки близка к толщине — стенка тонкая.');
      }
      if (ringR + holeR > R - 0.8) {
        warnings.push('Отверстия под ножки выходят за край костера.');
      }
      const cutters: Manifold[] = [];
      for (let i = 0; i < f.count; i++) {
        const a = ((f.angleOffset + (i * 360) / f.count) * Math.PI) / 180;
        const cx = ringR * Math.cos(a);
        const cy = ringR * Math.sin(a);
        const hole = trash.keep(
          Manifold.cylinder(f.holeDepth + EPS, holeR, holeR, Math.max(24, segments / 4))
            .translate([cx, cy, -EPS])
        );
        cutters.push(hole);
      }
      if (cutters.length) {
        const allHoles = trash.keep(Manifold.union(cutters));
        base = trash.keep(base.subtract(allHoles));
      }
    }

    const parts: ModelPart[] = [];

    // --- Логотип ---
    if (params.logo && params.logo.regions.some((r) => r.enabled)) {
      const logo = params.logo;
      const depth = Math.min(logo.depth, t - 0.4);
      if (logo.depth >= t) {
        warnings.push('Глубина логотипа больше толщины — уменьшена.');
      }
      const clipR = R - 0.6;
      const clip = trash.keep(CrossSection.circle(clipR, segments));
      const tf = logoPointTransform(logo);

      // 2D cross-section для каждого включённого региона:
      // регион = объединение его фигур; каждая фигура — EvenOdd (внешний контур + дырки).
      const regionCS: { cs: CrossSection; color: string; name: string }[] = [];
      const activeRegions = logo.regions.filter((r) => r.enabled);
      for (const reg of activeRegions) {
        const shapeCS: CrossSection[] = [];
        for (const sh of reg.shapes) {
          if (!sh.outer.length) continue;
          const contours: Vec2[][] = [sh.outer.map(tf), ...sh.holes.map((h) => h.map(tf))];
          shapeCS.push(trash.keep(new CrossSection(contours, 'EvenOdd')));
        }
        if (!shapeCS.length) continue;
        let cs = trash.keep(CrossSection.union(shapeCS));
        cs = trash.keep(cs.intersect(clip));
        if (cs.isEmpty()) continue;
        regionCS.push({ cs, color: reg.color, name: `logo_${reg.label}` });
      }

      if (regionCS.length) {
        // Полное «пятно» логотипа (для кармана inlay и для гравировки).
        const footprint = trash.keep(CrossSection.union(regionCS.map((r) => r.cs)));

        // Композиция наложенных слоёв: верхний (нарисованный позже) выигрывает.
        // effective[i] = region[i] − объединение всех слоёв выше него.
        const n = regionCS.length;
        const effective: { cs: CrossSection; color: string; name: string }[] = [];
        for (let i = 0; i < n; i++) {
          let cs = regionCS[i].cs;
          if (i < n - 1) {
            const above = trash.keep(CrossSection.union(regionCS.slice(i + 1).map((r) => r.cs)));
            cs = trash.keep(regionCS[i].cs.subtract(above));
          }
          if (!cs.isEmpty()) effective.push({ cs, color: regionCS[i].color, name: regionCS[i].name });
        }

        if (logo.mode === 'inlay') {
          const pocket = trash.keep(footprint.extrude(depth + EPS).translate([0, 0, t - depth]));
          base = trash.keep(base.subtract(pocket));
          for (const r of effective) {
            const solid = trash.keep(r.cs.extrude(depth).translate([0, 0, t - depth]));
            parts.push(meshToPart(solid, r.name, r.color));
          }
        } else if (logo.mode === 'emboss') {
          for (const r of effective) {
            const solid = trash.keep(r.cs.extrude(depth).translate([0, 0, t]));
            parts.push(meshToPart(solid, r.name, r.color));
          }
        } else {
          // engrave — гравировка всего пятна логотипа, один цвет базы
          const cutter = trash.keep(footprint.extrude(depth + EPS).translate([0, 0, t - depth]));
          base = trash.keep(base.subtract(cutter));
        }
      }
    }

    // --- Надписи по окружности (обе на нижней грани) ---
    const applyBottomText = (
      contours: Contour[] | undefined,
      settings: typeof params.bottomText,
      name: string
    ) => {
      if (!settings.enabled || !contours || !contours.length) return;
      const depth = Math.min(settings.depth, t - 0.4);
      const cs = trash.keep(new CrossSection(contours as Vec2[][], 'EvenOdd'));
      if (cs.isEmpty()) return;
      if (settings.mode === 'engrave') {
        const cutter = trash.keep(cs.extrude(depth + EPS).translate([0, 0, -EPS]));
        base = trash.keep(base.subtract(cutter));
      } else {
        // emboss — рельеф снизу (выступает вниз)
        const solid = trash.keep(cs.extrude(depth).translate([0, 0, -depth]));
        parts.push(meshToPart(solid, name, settings.color));
      }
    };
    applyBottomText(input.bottomTextContours, params.bottomText, 'bottom_text');
    applyBottomText(input.bottomText2Contours, params.bottomText2, 'bottom_text2');

    // База — всегда первая часть
    const basePart = meshToPart(base, 'base', params.baseColor);
    const volume = base.volume();

    return {
      parts: [basePart, ...parts],
      volume,
      warnings,
    };
  } finally {
    trash.dispose();
  }
}
