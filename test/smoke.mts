// Смоук-тест моделирования без браузера: геометрия строится во всех режимах,
// текст по дуге раскладывается, экспортеры дают валидные байты.
// Запуск: npm run smoke
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Module from 'manifold-3d';
import { buildCoasterWith } from '../src/modeling.ts';
import { registerFont, buildTextContours } from '../src/text.ts';
import { build3mf, buildBinaryStl } from '../src/exporters.ts';
import { defaultParams, type Contour } from '../src/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function run() {
  const wasm = await Module();
  wasm.setup();
  console.log('✓ manifold setup');

  const fontBuf = readFileSync(join(root, 'public/fonts/PTSans-Bold.ttf'));
  const ab = fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength) as ArrayBuffer;
  const fe = registerFont('test', 'test', ab);
  console.log('✓ font loaded, unitsPerEm =', fe.font.unitsPerEm);

  const textContours: Contour[] = buildTextContours(fe.font, {
    text: '2026',
    size: 6,
    radius: 38,
    centerAngleDeg: 270,
    letterSpacing: 0.5,
    flip: false,
  });
  assert(textContours.length > 0, 'есть контуры текста');
  console.log('✓ text contours:', textContours.length);

  const params = defaultParams();
  params.logo = {
    regions: [
      {
        id: 'a',
        shapes: [
          {
            outer: [ [0, 0], [40, 0], [40, 40], [0, 40] ],
            holes: [ [ [10, 10], [30, 10], [30, 30], [10, 30] ] ], // дырка
          },
        ],
        color: '#ff0000',
        enabled: true,
        label: 'Цвет 1',
      },
      {
        id: 'b',
        shapes: [ { outer: [ [15, 15], [25, 15], [25, 25], [15, 25] ], holes: [] } ],
        color: '#00aa55',
        enabled: true,
        label: 'Цвет 2',
      },
    ],
    srcWidth: 40,
    srcHeight: 40,
    fitDiameter: 50,
    rotation: 0,
    offsetX: 0,
    offsetY: 0,
    mirror: false,
    mode: 'inlay',
    depth: 0.8,
  };

  for (const mode of ['inlay', 'emboss', 'engrave'] as const) {
    params.logo!.mode = mode;
    const res = buildCoasterWith(wasm, params, { bottomTextContours: textContours });
    const tris = res.parts.reduce((s, p) => s + p.indices.length / 3, 0);
    for (const p of res.parts) {
      assert(p.positions.length > 0 && p.indices.length > 0, `непустая часть ${p.name} (${mode})`);
    }
    assert(res.volume > 0, `объём > 0 (${mode})`);
    console.log(`✓ mode=${mode}: parts=${res.parts.length} tris=${tris} vol=${(res.volume / 1000).toFixed(1)}cm3 warns=${res.warnings.length}`);
  }

  // Проверка предупреждений: слишком глубокие ножки
  {
    const pp = defaultParams();
    pp.feet.holeDepth = pp.thickness; // насквозь
    const res = buildCoasterWith(wasm, pp, {});
    assert(res.warnings.length > 0, 'предупреждение о тонкой стенке');
    console.log('✓ warnings triggered:', res.warnings.length);
  }

  // Экспорт
  params.logo!.mode = 'inlay';
  const res = buildCoasterWith(wasm, params, { bottomTextContours: textContours });
  const stl = buildBinaryStl(res.parts);
  const mf = build3mf(res.parts);
  assert(stl.byteLength === 84 + (res.parts.reduce((s, p) => s + p.indices.length / 3, 0)) * 50, 'размер STL соответствует заголовку');
  assert(mf.byteLength > 1000, '3MF непустой');
  const out = tmpdir();
  writeFileSync(join(out, 'coaster-smoke.stl'), stl);
  writeFileSync(join(out, 'coaster-smoke.3mf'), mf);
  console.log(`✓ exports: STL=${stl.byteLength}B 3MF=${mf.byteLength}B → ${out}`);

  console.log('\nALL OK');
}

run().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
