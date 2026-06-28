import type { CircleTextSettings, CoasterParams, LogoRegion } from './types';
import { mergeSimilarColors } from './svg';

export interface UICtx {
  params: CoasterParams;
  getFonts: () => { key: string; label: string }[];
  requestRebuild: () => void;
  onLoadSvg: (file: File) => Promise<void> | void;
  onLoadFont: (file: File) => Promise<string | undefined>;
  onClearLogo: () => void;
  export3mf: () => void;
  exportStlZip: () => void;
  exportStl: () => void;
}

export interface ControlsApi {
  refreshLogo: () => void;
  refreshFonts: () => void;
  setWarnings: (w: string[]) => void;
}

// --------- DOM-хелперы ---------
type Props = Record<string, any>;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      e.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== undefined && v !== null) {
      (e as any).setAttribute(k, String(v));
    }
  }
  for (const c of children) e.append(c);
  return e;
}

function section(title: string, collapsed = false): { wrap: HTMLElement; body: HTMLElement } {
  const body = el('div', { class: 'section-body' });
  const chev = el('span', { class: 'chev', text: '▾' });
  const head = el('div', { class: 'section-head' }, [el('span', { text: title }), chev]);
  const wrap = el('div', { class: 'section' + (collapsed ? ' collapsed' : '') }, [head, body]);
  head.addEventListener('click', () => wrap.classList.toggle('collapsed'));
  return { wrap, body };
}

function sliderRow(
  parent: HTMLElement,
  label: string,
  get: () => number,
  set: (v: number) => void,
  min: number,
  max: number,
  step: number,
  unit: string,
  onChange: () => void
) {
  const out = el('output', { text: fmt(get(), unit) });
  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(get()),
  }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    set(v);
    out.textContent = fmt(v, unit);
    onChange();
  });
  const row = el('div', { class: 'slider-row' }, [
    el('div', { class: 'slider-top' }, [el('label', { text: label }), out]),
    input,
  ]);
  parent.append(row);
}

function fmt(v: number, unit: string): string {
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(v % 1 === 0 ? 0 : 1);
  return unit ? `${s} ${unit}` : s;
}

function checkboxRow(parent: HTMLElement, label: string, get: () => boolean, set: (v: boolean) => void, onChange: () => void) {
  const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
  cb.checked = get();
  cb.addEventListener('change', () => {
    set(cb.checked);
    onChange();
  });
  parent.append(el('div', { class: 'row' }, [el('label', { text: label }), cb]));
  return cb;
}

function colorRow(parent: HTMLElement, label: string, get: () => string, set: (v: string) => void, onChange: () => void) {
  const c = el('input', { type: 'color', value: get() }) as HTMLInputElement;
  c.addEventListener('input', () => {
    set(c.value);
    onChange();
  });
  parent.append(el('div', { class: 'row' }, [el('label', { text: label }), c]));
}

function selectRow<T extends string>(
  parent: HTMLElement,
  label: string,
  options: { value: T; label: string }[],
  get: () => T,
  set: (v: T) => void,
  onChange: () => void
): HTMLSelectElement {
  const sel = el('select') as HTMLSelectElement;
  for (const o of options) {
    const opt = el('option', { value: o.value, text: o.label });
    if (o.value === get()) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => {
    set(sel.value as T);
    onChange();
  });
  parent.append(el('div', { class: 'row' }, [el('label', { text: label }), sel]));
  return sel;
}

function textRow(parent: HTMLElement, label: string, get: () => string, set: (v: string) => void, onChange: () => void) {
  const inp = el('input', { type: 'text', value: get() }) as HTMLInputElement;
  inp.addEventListener('input', () => {
    set(inp.value);
    onChange();
  });
  parent.append(el('div', { class: 'row full' }, [el('label', { text: label }), inp]));
}

// --------- основной билдер ---------
export function buildControls(root: HTMLElement, ctx: UICtx): ControlsApi {
  const p = ctx.params;
  const rebuild = ctx.requestRebuild;
  root.innerHTML = '';

  // ===== Размеры =====
  {
    const { wrap, body } = section('Размеры костера');
    sliderRow(body, 'Диаметр', () => p.diameter, (v) => (p.diameter = v), 40, 200, 1, 'мм', rebuild);
    sliderRow(body, 'Толщина', () => p.thickness, (v) => (p.thickness = v), 1.5, 20, 0.5, 'мм', rebuild);
    sliderRow(body, 'Фаска верх. кромки', () => p.topChamfer, (v) => (p.topChamfer = v), 0, 4, 0.1, 'мм', rebuild);
    sliderRow(body, 'Гладкость (сегментов)', () => p.segments, (v) => (p.segments = v), 48, 384, 12, '', rebuild);
    colorRow(body, 'Цвет основы', () => p.baseColor, (v) => (p.baseColor = v), rebuild);
    root.append(wrap);
  }

  // ===== Логотип =====
  const logoSec = section('Логотип (SVG)');
  root.append(logoSec.wrap);
  const refreshLogo = () => renderLogoSection(logoSec.body, ctx);
  refreshLogo();

  // ===== Надписи по окружности (сверху и снизу) =====
  const fontRefs: HTMLSelectElement[] = [];
  const refreshFonts = () => {
    const fonts = ctx.getFonts();
    for (const sel of fontRefs) {
      sel.innerHTML = '';
      for (const fnt of fonts) sel.append(el('option', { value: fnt.key, text: fnt.label }));
      const getKey = (sel as any)._getKey as (() => string) | undefined;
      if (getKey) sel.value = getKey();
    }
  };
  fontRefs.push(
    buildTextSection(root, ctx, p.bottomText, refreshFonts, {
      title: 'Надпись снизу — первая',
      hint: 'На нижней грани, по нижней дуге. Центрируется автоматически, читается прямо при перевороте костера.',
    })
  );
  fontRefs.push(
    buildTextSection(root, ctx, p.bottomText2, refreshFonts, {
      title: 'Надпись снизу — вторая (напротив)',
      hint: 'Тоже на нижней грани, но по верхней дуге — напротив первой (как год и название на монете). Угол центра 90° = напротив нижней (270°).',
    })
  );

  // ===== Ножки =====
  {
    const { wrap, body } = section('Ножки (глухие отверстия)');
    checkboxRow(body, 'Включить', () => p.feet.enabled, (v) => (p.feet.enabled = v), rebuild);
    sliderRow(body, 'Количество', () => p.feet.count, (v) => (p.feet.count = Math.round(v)), 2, 8, 1, '', rebuild);
    sliderRow(body, 'Диаметр отверстия', () => p.feet.holeDiameter, (v) => (p.feet.holeDiameter = v), 3, 16, 0.5, 'мм', rebuild);
    sliderRow(body, 'Глубина отверстия', () => p.feet.holeDepth, (v) => (p.feet.holeDepth = v), 0.5, 8, 0.5, 'мм', rebuild);
    sliderRow(body, 'Диаметр расстановки', () => p.feet.bcd, (v) => (p.feet.bcd = v), 10, 180, 1, 'мм', rebuild);
    sliderRow(body, 'Угол группы', () => p.feet.angleOffset, (v) => (p.feet.angleOffset = v), 0, 90, 5, '°', rebuild);
    body.append(el('p', { class: 'hint', text: 'Отверстия под мебельные демпферы. Печатаются на нижней грани, на дне остаётся стенка (толщина − глубина).' }));
    root.append(wrap);
  }

  // ===== Экспорт =====
  const warnBox = el('div', { class: 'hint' });
  {
    const { wrap, body } = section('Экспорт');
    body.append(
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'primary', text: '3MF (мультицвет)', onClick: ctx.export3mf }),
      ])
    );
    body.append(
      el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
        el('button', { text: 'STL по цветам (zip)', onClick: ctx.exportStlZip }),
        el('button', { text: 'Один STL', onClick: ctx.exportStl }),
      ])
    );
    body.append(el('p', { class: 'hint', text: '3MF импортируется в PrusaSlicer/OrcaSlicer как один объект из отдельных частей (база + каждый цвет логотипа), уже назначенных на экструдеры 1, 2, 3… Останется сопоставить экструдерам нужные филаменты. Нужен профиль принтера с несколькими экструдерами/филаментами (MMU/AMS).' }));
    body.append(warnBox);
    root.append(wrap);
  }

  return {
    refreshLogo,
    refreshFonts,
    setWarnings: (w: string[]) => {
      warnBox.innerHTML = '';
      if (!w.length) return;
      warnBox.append(el('strong', { text: '⚠ Предупреждения:' }));
      for (const line of w) warnBox.append(el('div', { text: '• ' + line }));
    },
  };
}

function fileButton(label: string, accept: string, onFile: (f: File) => void): HTMLElement {
  const input = el('input', { type: 'file', accept }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    if (f) onFile(f);
    input.value = '';
  });
  const drop = el('label', { class: 'file-drop', style: 'margin-top:6px', text: label }, [input]);
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
  return drop;
}

function buildTextSection(
  root: HTMLElement,
  ctx: UICtx,
  s: CircleTextSettings,
  refreshFonts: () => void,
  opts: { title: string; hint: string }
): HTMLSelectElement {
  const rebuild = ctx.requestRebuild;
  const { wrap, body } = section(opts.title, !s.enabled);
  checkboxRow(body, 'Включить', () => s.enabled, (v) => (s.enabled = v), rebuild);
  textRow(body, 'Текст', () => s.text, (v) => (s.text = v), rebuild);

  const fontSel = selectRow(
    body,
    'Шрифт',
    ctx.getFonts().map((f) => ({ value: f.key, label: f.label })),
    () => s.fontKey,
    (v) => (s.fontKey = v),
    rebuild
  );
  (fontSel as any)._getKey = () => s.fontKey;
  body.append(
    fileButton('Загрузить шрифт (.ttf/.otf)', '.ttf,.otf,.woff', async (file) => {
      const key = await ctx.onLoadFont(file);
      if (key) s.fontKey = key;
      refreshFonts();
      rebuild();
    })
  );

  sliderRow(body, 'Высота букв', () => s.size, (v) => (s.size = v), 2, 16, 0.5, 'мм', rebuild);
  sliderRow(body, 'Глубина', () => s.depth, (v) => (s.depth = v), 0.2, 3, 0.1, 'мм', rebuild);
  sliderRow(body, 'Радиус (0 = авто)', () => s.radius, (v) => (s.radius = v), 0, 100, 1, 'мм', rebuild);
  sliderRow(body, 'Угол центра', () => s.startAngle, (v) => (s.startAngle = v), 0, 360, 5, '°', rebuild);
  sliderRow(body, 'Трекинг', () => s.letterSpacing, (v) => (s.letterSpacing = v), -2, 6, 0.1, 'мм', rebuild);
  selectRow(
    body,
    'Тип',
    [
      { value: 'engrave', label: 'Гравировка (углубление)' },
      { value: 'emboss', label: 'Рельеф (мультицвет)' },
    ],
    () => s.mode,
    (v) => (s.mode = v),
    rebuild
  );
  checkboxRow(body, 'Буквы наружу (верхняя дуга)', () => s.flip, (v) => (s.flip = v), rebuild);
  colorRow(body, 'Цвет (для рельефа)', () => s.color, (v) => (s.color = v), rebuild);
  body.append(el('p', { class: 'hint', text: opts.hint }));
  root.append(wrap);
  return fontSel;
}

function renderLogoSection(body: HTMLElement, ctx: UICtx) {
  const p = ctx.params;
  const rebuild = ctx.requestRebuild;
  body.innerHTML = '';

  body.append(
    fileButton('Загрузить SVG (логотип)', '.svg,image/svg+xml', (file) => ctx.onLoadSvg(file))
  );

  if (!p.logo || !p.logo.regions.length) {
    body.append(el('p', { class: 'hint', text: 'Загрузите SVG. Заливаемые участки определятся по цветам — каждому можно назначить свой цвет печати.' }));
    return;
  }

  const logo = p.logo;

  selectRow(
    body,
    'Способ',
    [
      { value: 'inlay', label: 'Заподлицо (мультицвет)' },
      { value: 'emboss', label: 'Рельеф (выпуклый)' },
      { value: 'engrave', label: 'Гравировка (вогнутый)' },
    ],
    () => logo.mode,
    (v) => (logo.mode = v),
    rebuild
  );
  sliderRow(body, 'Размер (вписать в Ø)', () => logo.fitDiameter, (v) => (logo.fitDiameter = v), 10, p.diameter, 1, 'мм', rebuild);
  sliderRow(body, 'Глубина/высота', () => logo.depth, (v) => (logo.depth = v), 0.2, 3, 0.1, 'мм', rebuild);
  sliderRow(body, 'Поворот', () => logo.rotation, (v) => (logo.rotation = v), -180, 180, 5, '°', rebuild);
  sliderRow(body, 'Сдвиг X', () => logo.offsetX, (v) => (logo.offsetX = v), -40, 40, 0.5, 'мм', rebuild);
  sliderRow(body, 'Сдвиг Y', () => logo.offsetY, (v) => (logo.offsetY = v), -40, 40, 0.5, 'мм', rebuild);
  checkboxRow(body, 'Зеркало', () => logo.mirror, (v) => (logo.mirror = v), rebuild);
  checkboxRow(body, 'Растянуть (без пропорций)', () => !!logo.stretch, (v) => (logo.stretch = v), rebuild);
  body.append(
    el('div', { class: 'btn-row', style: 'margin-top:6px' }, [
      el('button', {
        text: 'Центрировать',
        onClick: () => {
          logo.offsetX = 0;
          logo.offsetY = 0;
          renderLogoSection(body, ctx);
          rebuild();
        },
      }),
      el('button', {
        text: 'Макс. размер',
        onClick: () => {
          logo.fitDiameter = Math.max(10, Math.round(p.diameter - 4));
          renderLogoSection(body, ctx);
          rebuild();
        },
      }),
    ])
  );
  body.append(
    el('p', { class: 'hint', text: '«Растянуть» + «Макс. размер» = логотип заполняет всю грань (по краям обрезается окружностью).' })
  );

  // Объединение похожих цветов (схлопывание оттенков/градиентов).
  // Перекластеризуем из sourceRegions без перестроения слайдера, чтобы не сбивать перетаскивание.
  const dynamic = el('div');
  const remerge = () => {
    if (logo.sourceRegions) {
      logo.regions = mergeSimilarColors(logo.sourceRegions, logo.mergeThreshold ?? 0);
    }
    renderDynamic();
    rebuild();
  };
  if (logo.sourceRegions && logo.sourceRegions.length > 1) {
    sliderRow(
      body,
      'Объединять похожие цвета',
      () => logo.mergeThreshold ?? 0,
      (v) => (logo.mergeThreshold = v),
      0,
      60,
      1,
      'ΔE',
      remerge
    );
  }

  body.append(dynamic);
  renderDynamic();

  body.append(
    el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
      el('button', { class: 'ghost', text: 'Убрать логотип', onClick: ctx.onClearLogo }),
    ])
  );

  function renderDynamic() {
    dynamic.innerHTML = '';
    const srcN = logo.sourceRegions?.length ?? logo.regions.length;
    const outN = logo.regions.length;
    dynamic.append(
      el('p', { class: 'hint', text: `Оттенков в SVG: ${srcN} → цветов печати: ${outN}` })
    );

    const canvas = el('canvas', { class: 'svg-preview', width: '300', height: '150' }) as HTMLCanvasElement;
    dynamic.append(canvas);
    drawLogoPreview(canvas, logo.regions, logo.srcWidth, logo.srcHeight);

    const list = el('div', { class: 'region-list' });
    logo.regions.forEach((reg) => {
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = reg.enabled;
      cb.addEventListener('change', () => {
        reg.enabled = cb.checked;
        drawLogoPreview(canvas, logo.regions, logo.srcWidth, logo.srcHeight);
        rebuild();
      });
      const col = el('input', { type: 'color', value: normHex(reg.color) }) as HTMLInputElement;
      col.addEventListener('input', () => {
        reg.color = col.value;
        drawLogoPreview(canvas, logo.regions, logo.srcWidth, logo.srcHeight);
        rebuild();
      });
      list.append(
        el('div', { class: 'region-item' }, [cb, col, el('span', { class: 'name', text: reg.label })])
      );
    });
    dynamic.append(list);
  }
}

function drawLogoPreview(canvas: HTMLCanvasElement, regions: LogoRegion[], w: number, h: number) {
  const ctx2 = canvas.getContext('2d');
  if (!ctx2) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx2.clearRect(0, 0, W, H);
  ctx2.fillStyle = '#ffffff';
  ctx2.fillRect(0, 0, W, H);
  const pad = 8;
  const scale = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
  const ox = (W - w * scale) / 2;
  const oy = (H - h * scale) / 2;
  const trace = (c: [number, number][]) => {
    c.forEach(([x, y], i) => {
      const px = ox + x * scale;
      const py = oy + y * scale;
      if (i === 0) ctx2.moveTo(px, py);
      else ctx2.lineTo(px, py);
    });
    ctx2.closePath();
  };
  for (const reg of regions) {
    ctx2.fillStyle = reg.enabled ? normHex(reg.color) : 'rgba(180,180,180,0.25)';
    // каждая фигура рисуется отдельно (outer + holes, even-odd), фигуры накладываются.
    for (const sh of reg.shapes) {
      ctx2.beginPath();
      trace(sh.outer);
      for (const hole of sh.holes) trace(hole);
      ctx2.fill('evenodd');
    }
  }
}

function normHex(c: string): string {
  let s = c.replace('#', '');
  if (s.length === 3) s = s.split('').map((x) => x + x).join('');
  if (s.length > 6) s = s.slice(0, 6);
  return '#' + s.padEnd(6, '0');
}
