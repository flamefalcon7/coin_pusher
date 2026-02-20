import { EditorObjectData } from "./EditorObject";
import { EditorManager, GizmoMode } from "./EditorManager";
import { EditorToolbar } from "./EditorToolbar";
import { ObjectListPanel } from "./ObjectListPanel";
import { PropertyPanel } from "./PropertyPanel";
import { downloadSceneJSON, loadSceneJSON } from "./EditorSerializer";
import { PrimitiveType } from "./EditorObject";
import "./editor.css";

interface EditorPanelProps {
  manager: EditorManager;
  objects: EditorObjectData[];
  selectedId: string | null;
  gizmoMode: GizmoMode;
  onObjectsChange: () => void;
}

export function EditorPanel({
  manager,
  objects,
  selectedId,
  gizmoMode,
  onObjectsChange,
}: EditorPanelProps) {
  const selectedObject = objects.find((o) => o.id === selectedId) ?? null;

  const handleCreate = (type: PrimitiveType) => {
    manager.createObject(type);
  };

  const handleSetGizmoMode = (mode: GizmoMode) => {
    manager.setGizmoMode(mode);
    onObjectsChange();
  };

  const handleDelete = () => {
    manager.removeSelected();
  };

  const handleSave = () => {
    const data = manager.getSceneData();
    downloadSceneJSON(data);
  };

  const handleLoad = async () => {
    try {
      const data = await loadSceneJSON();
      manager.loadSceneData(data);
    } catch (e) {
      // User cancelled or invalid file — ignore
      console.warn("Load cancelled or failed:", e);
    }
  };

  const handleSelect = (id: string) => {
    manager.select(id);
  };

  const handleTransformChange = (
    id: string,
    pos?: [number, number, number],
    rot?: [number, number, number],
    scale?: [number, number, number]
  ) => {
    manager.updateObjectTransform(id, pos, rot, scale);
  };

  return (
    <div className="editor-panel">
      <div className="editor-panel-header">Scene Editor</div>
      <EditorToolbar
        gizmoMode={gizmoMode}
        hasSelection={selectedId != null}
        onCreateObject={handleCreate}
        onSetGizmoMode={handleSetGizmoMode}
        onDelete={handleDelete}
        onSave={handleSave}
        onLoad={handleLoad}
      />
      <ObjectListPanel
        objects={objects}
        selectedId={selectedId}
        onSelect={handleSelect}
      />
      <PropertyPanel
        object={selectedObject}
        onTransformChange={handleTransformChange}
      />
    </div>
  );
}
