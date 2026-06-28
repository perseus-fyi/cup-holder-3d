import Module from 'manifold-3d';
// Vite отдаёт URL .wasm-файла; передаём его в locateFile.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { ManifoldToplevel } from 'manifold-3d';

let cached: Promise<ManifoldToplevel> | null = null;

/** Лениво инициализирует WASM-модуль manifold (один раз на страницу). */
export function getManifold(): Promise<ManifoldToplevel> {
  if (!cached) {
    cached = Module({ locateFile: () => wasmUrl }).then((wasm) => {
      wasm.setup();
      return wasm;
    });
  }
  return cached;
}
