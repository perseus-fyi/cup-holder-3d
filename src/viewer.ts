import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ModelPart } from './types';

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private modelGroup: THREE.Group;
  private grid: THREE.GridHelper;
  private framed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x1b1d23, 1);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1); // z — вверх (толщина костера)
    this.camera.position.set(120, -120, 100);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // Освещение
    const hemi = new THREE.HemisphereLight(0xffffff, 0x404552, 0.9);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, -1.2, 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbcd2ff, 0.5);
    fill.position.set(-1.5, 1, 0.5);
    this.scene.add(fill);

    // Сетка в плоскости XY (z=0)
    this.grid = new THREE.GridHelper(200, 20, 0x4a5063, 0x33384a);
    this.grid.rotation.x = Math.PI / 2;
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(this.grid);

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.animate();
  }

  private resize() {
    const el = this.renderer.domElement;
    const parent = el.parentElement;
    const w = parent ? parent.clientWidth : window.innerWidth;
    const h = parent ? parent.clientHeight : window.innerHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  setParts(parts: ModelPart[]) {
    // Чистим прошлые меши
    for (const child of [...this.modelGroup.children]) {
      this.modelGroup.remove(child);
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material)?.dispose();
    }

    for (const part of parts) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(part.indices, 1));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(part.color),
        metalness: 0.0,
        roughness: 0.62,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = part.name;
      this.modelGroup.add(mesh);
    }

    this.fitGrid(parts);
    if (!this.framed) {
      this.frameModel();
      this.framed = true;
    }
  }

  private fitGrid(parts: ModelPart[]) {
    let maxR = 50;
    for (const p of parts) {
      for (let i = 0; i < p.positions.length; i += 3) {
        const r = Math.hypot(p.positions[i], p.positions[i + 1]);
        if (r > maxR) maxR = r;
      }
    }
    const size = Math.ceil((maxR * 2.4) / 10) * 10;
    this.grid.scale.setScalar(size / 200);
  }

  /** Имитация физического переворота костера влево-вправо (для проверки нижней грани). */
  setFlip(on: boolean) {
    this.modelGroup.rotation.y = on ? Math.PI : 0;
    this.frameModel('top');
  }

  frameModel(view: 'iso' | 'top' | 'bottom' = 'iso') {
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    if (box.isEmpty()) return;
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    const center = sphere.center;
    this.controls.target.copy(center);
    const dist = sphere.radius / Math.sin((this.camera.fov * Math.PI) / 360);
    // Для строго вертикальных видов up не должен совпадать с направлением взгляда.
    if (view === 'iso') this.camera.up.set(0, 0, 1);
    else this.camera.up.set(0, 1, 0);
    const dir =
      view === 'top'
        ? new THREE.Vector3(0, 0, 1)
        : view === 'bottom'
        ? new THREE.Vector3(0, 0, -1)
        : new THREE.Vector3(0.8, -0.9, 0.7);
    dir.normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist * 1.15);
    this.camera.near = Math.max(0.1, dist * 0.01);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
}
