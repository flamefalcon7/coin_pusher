import {
  Scene,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  GizmoManager,
  HighlightLayer,
  PointerEventTypes,
  Observer,
  PointerInfo,
  ArcRotateCamera,
} from "@babylonjs/core";
import { EditorObjectData, EditorSceneData, PrimitiveType } from "./EditorObject";

export type GizmoMode = "position" | "rotation" | "scale";

type ChangeCallback = (objects: EditorObjectData[], selectedId: string | null) => void;

export class EditorManager {
  private scene: Scene;
  private active = false;
  private gizmoManager: GizmoManager;
  private highlightLayer: HighlightLayer;
  private pointerObserver: Observer<PointerInfo> | null = null;

  private objects: Map<string, EditorObjectData> = new Map();
  private meshes: Map<string, Mesh> = new Map();
  private selectedId: string | null = null;
  private counters: Record<PrimitiveType, number> = { box: 0, sphere: 0, cylinder: 0, prism: 0 };
  private currentGizmoMode: GizmoMode = "position";
  private onChange: ChangeCallback | null = null;

  private editorMaterial: StandardMaterial;

  constructor(scene: Scene) {
    this.scene = scene;

    // Material for editor objects — distinct from game CellMaterial
    this.editorMaterial = new StandardMaterial("editorMat", scene);
    this.editorMaterial.diffuseColor = new Color3(0.4, 0.7, 1.0);
    this.editorMaterial.specularColor = new Color3(0.3, 0.3, 0.3);
    this.editorMaterial.alpha = 0.85;

    // Gizmo manager
    this.gizmoManager = new GizmoManager(scene);
    this.gizmoManager.positionGizmoEnabled = false;
    this.gizmoManager.rotationGizmoEnabled = false;
    this.gizmoManager.scaleGizmoEnabled = false;
    this.gizmoManager.usePointerToAttachGizmos = false;
    this.gizmoManager.attachableMeshes = [];

    // Highlight layer for selection outline
    this.highlightLayer = new HighlightLayer("editorHighlight", scene);
  }

  setOnChange(cb: ChangeCallback): void {
    this.onChange = cb;
  }

  private notify(): void {
    if (this.onChange) {
      this.onChange(Array.from(this.objects.values()), this.selectedId);
    }
  }

  // ── Active toggle ──────────────────────────────────────────────────────

  setActive(active: boolean): void {
    this.active = active;

    if (active) {
      this.enablePointerPick();
      this.enableCameraPanning(true);
      if (this.selectedId) {
        this.applyGizmoMode();
      }
    } else {
      this.disablePointerPick();
      this.enableCameraPanning(false);
      this.detachGizmos();
      this.highlightLayer.removeAllMeshes();
    }

    this.notify();
  }

  isActive(): boolean {
    return this.active;
  }

  // ── Camera panning ─────────────────────────────────────────────────────

  private enableCameraPanning(enable: boolean): void {
    const camera = this.scene.activeCamera as ArcRotateCamera | null;
    if (camera) {
      camera.panningSensibility = enable ? 100 : 0;
    }
  }

  // ── Create / Remove ────────────────────────────────────────────────────

  createObject(type: PrimitiveType): EditorObjectData {
    this.counters[type]++;
    const id = crypto.randomUUID();
    const name = `${type.charAt(0).toUpperCase() + type.slice(1)}_${this.counters[type]}`;

    const data: EditorObjectData = {
      id,
      name,
      type,
      position: [0, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };

    const mesh = this.createMesh(data);
    this.objects.set(id, data);
    this.meshes.set(id, mesh);
    this.updateAttachableList();

    // Auto-select newly created object
    this.select(id);
    return data;
  }

  private createMesh(data: EditorObjectData): Mesh {
    let mesh: Mesh;
    switch (data.type) {
      case "box":
        mesh = MeshBuilder.CreateBox(data.name, { size: 1 }, this.scene);
        break;
      case "sphere":
        mesh = MeshBuilder.CreateSphere(data.name, { diameter: 1, segments: 16 }, this.scene);
        break;
      case "cylinder":
        mesh = MeshBuilder.CreateCylinder(data.name, { height: 1, diameter: 1, tessellation: 24 }, this.scene);
        break;
      case "prism":
        mesh = MeshBuilder.CreateCylinder(data.name, { height: 1, diameter: 1, tessellation: 3 }, this.scene);
        break;
    }

    mesh.material = this.editorMaterial;
    mesh.metadata = { editorId: data.id };

    mesh.position = new Vector3(data.position[0], data.position[1], data.position[2]);
    mesh.rotation = new Vector3(data.rotation[0], data.rotation[1], data.rotation[2]);
    mesh.scaling = new Vector3(data.scale[0], data.scale[1], data.scale[2]);

    return mesh;
  }

  removeSelected(): void {
    if (!this.selectedId) return;
    const id = this.selectedId;
    this.select(null);

    const mesh = this.meshes.get(id);
    if (mesh) {
      mesh.dispose();
      this.meshes.delete(id);
    }
    this.objects.delete(id);
    this.updateAttachableList();
    this.notify();
  }

  // ── Selection ──────────────────────────────────────────────────────────

  select(id: string | null): void {
    // Deselect previous
    if (this.selectedId) {
      const prevMesh = this.meshes.get(this.selectedId);
      if (prevMesh) {
        this.highlightLayer.removeMesh(prevMesh);
      }
    }

    this.selectedId = id;

    if (id) {
      const mesh = this.meshes.get(id);
      if (mesh) {
        this.highlightLayer.addMesh(mesh, Color3.Green());
        if (this.active) {
          this.applyGizmoMode();
          this.gizmoManager.attachToMesh(mesh);
        }
      }
    } else {
      this.detachGizmos();
    }

    this.notify();
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  // ── Gizmo Mode ─────────────────────────────────────────────────────────

  setGizmoMode(mode: GizmoMode): void {
    this.currentGizmoMode = mode;
    if (this.active && this.selectedId) {
      this.applyGizmoMode();
      const mesh = this.meshes.get(this.selectedId);
      if (mesh) {
        this.gizmoManager.attachToMesh(mesh);
      }
    }
  }

  getGizmoMode(): GizmoMode {
    return this.currentGizmoMode;
  }

  private applyGizmoMode(): void {
    this.gizmoManager.positionGizmoEnabled = this.currentGizmoMode === "position";
    this.gizmoManager.rotationGizmoEnabled = this.currentGizmoMode === "rotation";
    this.gizmoManager.scaleGizmoEnabled = this.currentGizmoMode === "scale";

    // Listen for drag end to sync data
    this.attachDragEndObservers();
  }

  private detachGizmos(): void {
    this.gizmoManager.positionGizmoEnabled = false;
    this.gizmoManager.rotationGizmoEnabled = false;
    this.gizmoManager.scaleGizmoEnabled = false;
    this.gizmoManager.attachToMesh(null);
  }

  private attachDragEndObservers(): void {
    const syncSelected = () => {
      if (this.selectedId) {
        this.syncDataFromMesh(this.selectedId);
        this.notify();
      }
    };

    const pg = this.gizmoManager.gizmos.positionGizmo;
    if (pg) {
      pg.onDragEndObservable.removeCallback(syncSelected);
      pg.onDragEndObservable.add(syncSelected);
    }
    const rg = this.gizmoManager.gizmos.rotationGizmo;
    if (rg) {
      rg.onDragEndObservable.removeCallback(syncSelected);
      rg.onDragEndObservable.add(syncSelected);
    }
    const sg = this.gizmoManager.gizmos.scaleGizmo;
    if (sg) {
      sg.onDragEndObservable.removeCallback(syncSelected);
      sg.onDragEndObservable.add(syncSelected);
    }
  }

  // ── Pointer pick ───────────────────────────────────────────────────────

  private enablePointerPick(): void {
    if (this.pointerObserver) return;

    this.pointerObserver = this.scene.onPointerObservable.add((info) => {
      if (info.type !== PointerEventTypes.POINTERTAP) return;
      const pick = this.scene.pick(
        this.scene.pointerX,
        this.scene.pointerY,
        (mesh) => mesh.metadata?.editorId != null
      );
      if (pick?.hit && pick.pickedMesh?.metadata?.editorId) {
        this.select(pick.pickedMesh.metadata.editorId);
      }
    });
  }

  private disablePointerPick(): void {
    if (this.pointerObserver) {
      this.scene.onPointerObservable.remove(this.pointerObserver);
      this.pointerObserver = null;
    }
  }

  // ── Transform sync ─────────────────────────────────────────────────────

  syncDataFromMesh(id: string): void {
    const mesh = this.meshes.get(id);
    const data = this.objects.get(id);
    if (!mesh || !data) return;

    data.position = [mesh.position.x, mesh.position.y, mesh.position.z];
    data.rotation = [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z];
    data.scale = [mesh.scaling.x, mesh.scaling.y, mesh.scaling.z];
  }

  updateObjectTransform(
    id: string,
    pos?: [number, number, number],
    rot?: [number, number, number],
    scale?: [number, number, number]
  ): void {
    const mesh = this.meshes.get(id);
    const data = this.objects.get(id);
    if (!mesh || !data) return;

    if (pos) {
      data.position = pos;
      mesh.position.set(pos[0], pos[1], pos[2]);
    }
    if (rot) {
      data.rotation = rot;
      mesh.rotation.set(rot[0], rot[1], rot[2]);
    }
    if (scale) {
      data.scale = scale;
      mesh.scaling.set(scale[0], scale[1], scale[2]);
    }

    this.notify();
  }

  // ── Scene data export/import ───────────────────────────────────────────

  getSceneData(): EditorSceneData {
    // Sync all meshes before export
    for (const id of this.objects.keys()) {
      this.syncDataFromMesh(id);
    }
    return {
      version: 1,
      objects: Array.from(this.objects.values()),
    };
  }

  loadSceneData(data: EditorSceneData): void {
    this.clearAll();

    for (const objData of data.objects) {
      const mesh = this.createMesh(objData);
      this.objects.set(objData.id, { ...objData });
      this.meshes.set(objData.id, mesh);

      // Update name counters
      const match = objData.name.match(/_(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > this.counters[objData.type]) {
          this.counters[objData.type] = num;
        }
      }
    }

    this.updateAttachableList();
    this.notify();
  }

  clearAll(): void {
    this.select(null);
    for (const mesh of this.meshes.values()) {
      mesh.dispose();
    }
    this.meshes.clear();
    this.objects.clear();
    this.updateAttachableList();
    this.notify();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private updateAttachableList(): void {
    this.gizmoManager.attachableMeshes = Array.from(this.meshes.values());
  }

  getObjects(): EditorObjectData[] {
    return Array.from(this.objects.values());
  }

  dispose(): void {
    this.disablePointerPick();
    this.clearAll();
    this.gizmoManager.dispose();
    this.highlightLayer.dispose();
    this.editorMaterial.dispose();
  }
}
