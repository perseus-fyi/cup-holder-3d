import { zipSync, strToU8 } from 'fflate';
import type { ModelPart } from './types';

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_\-]+/gi, '_');
}

function triggerDownload(data: Uint8Array | Blob, filename: string) {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ----------------------------- STL -----------------------------

/** Бинарный STL из объединения частей (один цвет/файл). */
export function buildBinaryStl(parts: ModelPart[]): Uint8Array {
  let triCount = 0;
  for (const p of parts) triCount += p.indices.length / 3;

  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  // header 80 байт пропускаем (нули)
  view.setUint32(80, triCount, true);

  let offset = 84;
  for (const p of parts) {
    const pos = p.positions;
    const idx = p.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3;
      const b = idx[i + 1] * 3;
      const c = idx[i + 2] * 3;
      const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
      const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
      const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
      // нормаль
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      view.setFloat32(offset, nx, true);
      view.setFloat32(offset + 4, ny, true);
      view.setFloat32(offset + 8, nz, true);
      view.setFloat32(offset + 12, ax, true);
      view.setFloat32(offset + 16, ay, true);
      view.setFloat32(offset + 20, az, true);
      view.setFloat32(offset + 24, bx, true);
      view.setFloat32(offset + 28, by, true);
      view.setFloat32(offset + 32, bz, true);
      view.setFloat32(offset + 36, cx, true);
      view.setFloat32(offset + 40, cy, true);
      view.setFloat32(offset + 44, cz, true);
      view.setUint16(offset + 48, 0, true);
      offset += 50;
    }
  }
  return new Uint8Array(buffer);
}

export function exportSingleStl(parts: ModelPart[], baseName = 'coaster') {
  triggerDownload(buildBinaryStl(parts), `${baseName}.stl`);
}

/** ZIP с отдельным STL на каждую часть (цвет) + памятка по цветам. */
export function exportStlZip(parts: ModelPart[], baseName = 'coaster') {
  const files: Record<string, Uint8Array> = {};
  const lines: string[] = ['# Соответствие файлов и цветов', ''];
  parts.forEach((p, i) => {
    const fname = `${String(i + 1).padStart(2, '0')}_${sanitize(p.name)}.stl`;
    files[fname] = buildBinaryStl([p]);
    lines.push(`${fname}  ->  ${p.color}  (${p.name})`);
  });
  files['colors.txt'] = strToU8(lines.join('\n'));
  const zip = zipSync(files, { level: 6 });
  triggerDownload(zip, `${baseName}_stl.zip`);
}

// ----------------------------- 3MF -----------------------------

function colorToHex8(color: string): string {
  let c = color.replace('#', '').trim();
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  if (c.length === 6) c = c + 'FF';
  return '#' + c.toUpperCase();
}

const f = (n: number): string => {
  const r = Math.round(n * 100000) / 100000;
  return Object.is(r, -0) ? '0' : String(r);
};

function uuid(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // запасной генератор
  let s = '';
  for (let i = 0; i < 32; i++) s += ((i * 7 + 11) % 16).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * 3MF в формате OrcaSlicer/BambuStudio: геометрия физически разбита на под-объекты
 * (3MF components), а имена и экструдеры частей заданы в Metadata/model_settings.config.
 * Так логотип и база приходят отдельными частями одного объекта, и каждой части
 * можно назначить свой филамент. Дополнительно есть Slic3r_PE_model.config для
 * совместимости с PrusaSlicer.
 */
export function build3mf(parts: ModelPart[]): Uint8Array {
  // Уникальные цвета → экструдеры (1-based). База обычно первая.
  const extruderOf = new Map<string, number>();
  const materials: { color: string; name: string }[] = [];
  for (const p of parts) {
    const hex = colorToHex8(p.color);
    if (!extruderOf.has(hex)) {
      extruderOf.set(hex, materials.length + 1);
      materials.push({ color: hex, name: p.name });
    }
  }
  const bases = materials
    .map((m) => `<base name="${escapeXml(m.name)}" displaycolor="${m.color}"/>`)
    .join('\n      ');

  // id-пространство ресурсов: 1 — basematerials; 2..N+1 — меши частей; N+2 — родитель.
  const MAT_ID = 1;
  const childIds = parts.map((_, i) => i + 2);
  const parentId = parts.length + 2;

  // Меш-объект на каждую часть (свои локальные индексы вершин).
  const childObjects = parts
    .map((p, i) => {
      const pindex = (extruderOf.get(colorToHex8(p.color))! - 1);
      const pos = p.positions;
      const idx = p.indices;
      const verts: string[] = [];
      for (let k = 0; k < pos.length; k += 3) {
        verts.push(`<vertex x="${f(pos[k])}" y="${f(pos[k + 1])}" z="${f(pos[k + 2])}"/>`);
      }
      const tris: string[] = [];
      for (let k = 0; k < idx.length; k += 3) {
        tris.push(`<triangle v1="${idx[k]}" v2="${idx[k + 1]}" v3="${idx[k + 2]}"/>`);
      }
      return (
        `    <object id="${childIds[i]}" p:UUID="${uuid()}" type="model" pid="${MAT_ID}" pindex="${pindex}">\n` +
        `      <mesh>\n` +
        `        <vertices>\n          ${verts.join('\n          ')}\n        </vertices>\n` +
        `        <triangles>\n          ${tris.join('\n          ')}\n        </triangles>\n` +
        `      </mesh>\n` +
        `    </object>`
      );
    })
    .join('\n');

  // Родительский объект: компоненты ссылаются на меш-объекты (это и даёт «части»).
  const components = childIds
    .map((id) => `      <component objectid="${id}" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`)
    .join('\n');

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" ` +
    `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ` +
    `xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">\n` +
    `  <metadata name="Application">OrcaSlicer-2.2.0</metadata>\n` +
    `  <resources>\n` +
    `    <basematerials id="${MAT_ID}">\n      ${bases}\n    </basematerials>\n` +
    `${childObjects}\n` +
    `    <object id="${parentId}" p:UUID="${uuid()}" type="model">\n` +
    `      <components>\n${components}\n      </components>\n` +
    `    </object>\n` +
    `  </resources>\n` +
    `  <build p:UUID="${uuid()}">\n` +
    `    <item objectid="${parentId}" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n` +
    `  </build>\n` +
    `</model>\n`;

  // OrcaSlicer/BambuStudio: имена и экструдеры частей.
  const partsXml = parts
    .map(
      (p, i) =>
        `  <part id="${childIds[i]}" subtype="normal_part">\n` +
        `   <metadata key="name" value="${escapeXml(p.name)}"/>\n` +
        `   <metadata key="extruder" value="${extruderOf.get(colorToHex8(p.color))!}"/>\n` +
        `  </part>`
    )
    .join('\n');
  const orcaConfig =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<config>\n` +
    ` <object id="${parentId}">\n` +
    `  <metadata key="name" value="coaster"/>\n` +
    `${partsXml}\n` +
    ` </object>\n` +
    `</config>\n`;

  // PrusaSlicer: разбиение того же объекта по диапазонам треугольников.
  let triCursor = 0;
  const psVolumes = parts
    .map((p) => {
      const first = triCursor;
      triCursor += p.indices.length / 3;
      return (
        `  <volume firstid="${first}" lastid="${triCursor - 1}">\n` +
        `   <metadata type="volume" key="name" value="${escapeXml(p.name)}"/>\n` +
        `   <metadata type="volume" key="extruder" value="${extruderOf.get(colorToHex8(p.color))!}"/>\n` +
        `  </volume>`
      );
    })
    .join('\n');
  const prusaConfig =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<config>\n <object id="${parentId}" instances_count="1">\n` +
    `  <metadata type="object" key="name" value="coaster"/>\n${psVolumes}\n </object>\n</config>\n`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n` +
    `  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n` +
    `  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n` +
    `  <Default Extension="config" ContentType="application/xml"/>\n` +
    `</Types>\n`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
    `  <Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n` +
    `</Relationships>\n`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(orcaConfig),
    'Metadata/Slic3r_PE_model.config': strToU8(prusaConfig),
  };
  return zipSync(files, { level: 6 });
}

export function export3mf(parts: ModelPart[], baseName = 'coaster') {
  triggerDownload(build3mf(parts), `${baseName}.3mf`);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&apos;'
  );
}
