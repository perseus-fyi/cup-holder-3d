import './style.css';
import type { ManifoldToplevel } from 'manifold-3d';
import { getManifold } from './manifold-setup';
import { defaultParams } from './types';
import type { BuildResult, Contour, CoasterParams } from './types';
import { buildCoasterWith } from './modeling';
import { Viewer } from './viewer';
import { buildControls, type ControlsApi, type UICtx } from './ui';
import { parseSvg, makeLogoSettings, mergeSimilarColors } from './svg';
import {
  loadDefaultFonts,
  registerFont,
  getFontEntry,
  listFonts,
  buildTextContours,
} from './text';
import { export3mf, exportStlZip, exportSingleStl } from './exporters';

const params: CoasterParams = defaultParams();

let wasm: ManifoldToplevel;
let viewer: Viewer;
let controls: ControlsApi;
let lastResult: BuildResult | null = null;

const statusEl = document.getElementById('status')!;
const dimsEl = document.getElementById('dims')!;

function setStatus(text: string, kind: '' | 'busy' | 'error' = '') {
  statusEl.textContent = text;
  statusEl.className = 'badge' + (kind ? ' ' + kind : '');
}

function computeBottomText(t: CoasterParams['bottomText']): Contour[] {
  if (!t.enabled || !t.text.trim()) return [];
  const fe = getFontEntry(t.fontKey) ?? listFonts()[0];
  if (!fe) return [];
  const R = params.diameter / 2;
  const radius = t.radius > 0 ? t.radius : Math.max(8, R - 4 - t.size * 0.6);
  return buildTextContours(fe.font, {
    text: t.text,
    size: t.size,
    radius,
    centerAngleDeg: t.startAngle,
    letterSpacing: t.letterSpacing,
    flip: t.flip,
    // обе надписи на нижней грани — без зеркала по X (читаются прямо при перевороте)
  });
}

function rebuildNow() {
  if (!wasm) return;
  setStatus('Сборка…', 'busy');
  try {
    const result = buildCoasterWith(wasm, params, {
      bottomTextContours: computeBottomText(params.bottomText),
      bottomText2Contours: computeBottomText(params.bottomText2),
    });
    lastResult = result;
    viewer.setParts(result.parts);
    controls.setWarnings(result.warnings);
    updateDims(result);
    setStatus(result.warnings.length ? 'Готово (с замечаниями)' : 'Готово', '');
  } catch (err) {
    console.error(err);
    setStatus('Ошибка геометрии — см. консоль', 'error');
  }
}

function updateDims(result: BuildResult) {
  let tris = 0;
  for (const p of result.parts) tris += p.indices.length / 3;
  const cm3 = (result.volume / 1000).toFixed(1);
  dimsEl.textContent = `Ø${params.diameter} × ${params.thickness} мм · ${tris.toLocaleString('ru')} трис · ${cm3} см³`;
}

// Дебаунс ребилда (слайдеры дёргают часто)
let pending = 0;
function requestRebuild() {
  if (pending) cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    pending = 0;
    rebuildNow();
  });
}

async function onLoadSvg(file: File) {
  try {
    const text = await file.text();
    const parsed = parseSvg(text);
    if (!parsed.regions.length) {
      setStatus('В SVG не найдено заливок (fill)', 'error');
      return;
    }
    params.logo = makeLogoSettings(parsed, params.logo);
    controls.refreshLogo();
    rebuildNow();
    const src = params.logo.sourceRegions?.length ?? params.logo.regions.length;
    const out = params.logo.regions.length;
    setStatus(src === out ? `Логотип: ${out} цв.` : `Логотип: ${src} оттенков → ${out} цв.`, '');
  } catch (e) {
    console.error(e);
    setStatus('Не удалось разобрать SVG', 'error');
  }
}

async function onLoadFont(file: File): Promise<string | undefined> {
  try {
    const buf = await file.arrayBuffer();
    const key = file.name.replace(/\.[^.]+$/, '');
    registerFont(key, file.name, buf);
    controls.refreshFonts();
    return key;
  } catch (e) {
    console.error(e);
    setStatus('Не удалось загрузить шрифт', 'error');
    return undefined;
  }
}

function onClearLogo() {
  params.logo = null;
  controls.refreshLogo();
  rebuildNow();
}

async function main() {
  setStatus('Загрузка движка…', 'busy');
  const canvas = document.getElementById('three-canvas') as HTMLCanvasElement;
  viewer = new Viewer(canvas);

  [wasm] = await Promise.all([getManifold(), loadDefaultFonts()]);

  const ctx: UICtx = {
    params,
    getFonts: () => listFonts().map((f) => ({ key: f.key, label: f.label })),
    requestRebuild,
    onLoadSvg,
    onLoadFont,
    onClearLogo,
    export3mf: () => lastResult && export3mf(lastResult.parts),
    exportStlZip: () => lastResult && exportStlZip(lastResult.parts),
    exportStl: () => lastResult && exportSingleStl(lastResult.parts),
  };

  controls = buildControls(document.getElementById('controls')!, ctx);
  controls.refreshFonts();

  rebuildNow();
  viewer.frameModel();

  // Dev-хелперы для отладки/визуальной проверки (только в режиме разработки).
  if (import.meta.env.DEV) {
    (window as any).coaster = {
      params,
      rebuild: rebuildNow,
      view: (v: 'iso' | 'top' | 'bottom') => viewer.frameModel(v),
      flip: (on: boolean) => viewer.setFlip(on),
      setMerge: (t: number) => {
        if (params.logo?.sourceRegions) {
          params.logo.mergeThreshold = t;
          params.logo.regions = mergeSimilarColors(params.logo.sourceRegions, t);
          controls.refreshLogo();
          rebuildNow();
        }
      },
      get result() {
        return lastResult;
      },
      controls,
    };
  }
}

main().catch((e) => {
  console.error(e);
  setStatus('Сбой инициализации — см. консоль', 'error');
});
