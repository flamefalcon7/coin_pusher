import { PrimitiveType } from "./EditorObject";
import { GizmoMode } from "./EditorManager";

interface EditorToolbarProps {
  gizmoMode: GizmoMode;
  hasSelection: boolean;
  onCreateObject: (type: PrimitiveType) => void;
  onSetGizmoMode: (mode: GizmoMode) => void;
  onDelete: () => void;
  onSave: () => void;
  onLoad: () => void;
}

export function EditorToolbar({
  gizmoMode,
  hasSelection,
  onCreateObject,
  onSetGizmoMode,
  onDelete,
  onSave,
  onLoad,
}: EditorToolbarProps) {
  return (
    <div className="editor-toolbar">
      <div className="editor-toolbar-label">Create</div>
      <div className="editor-toolbar-row">
        <button className="editor-btn" onClick={() => onCreateObject("box")}>Box</button>
        <button className="editor-btn" onClick={() => onCreateObject("sphere")}>Sphere</button>
        <button className="editor-btn" onClick={() => onCreateObject("cylinder")}>Cyl</button>
        <button className="editor-btn" onClick={() => onCreateObject("prism")}>Prism</button>
      </div>

      <div className="editor-toolbar-label">Gizmo</div>
      <div className="editor-toolbar-row">
        <button
          className={`editor-btn ${gizmoMode === "position" ? "active" : ""}`}
          onClick={() => onSetGizmoMode("position")}
        >
          Move
        </button>
        <button
          className={`editor-btn ${gizmoMode === "rotation" ? "active" : ""}`}
          onClick={() => onSetGizmoMode("rotation")}
        >
          Rotate
        </button>
        <button
          className={`editor-btn ${gizmoMode === "scale" ? "active" : ""}`}
          onClick={() => onSetGizmoMode("scale")}
        >
          Scale
        </button>
      </div>

      <div className="editor-toolbar-row">
        <button
          className="editor-btn danger"
          onClick={onDelete}
          disabled={!hasSelection}
        >
          Delete
        </button>
        <button className="editor-btn" onClick={onSave}>Save</button>
        <button className="editor-btn" onClick={onLoad}>Load</button>
      </div>
    </div>
  );
}
