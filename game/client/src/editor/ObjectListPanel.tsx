import { EditorObjectData } from "./EditorObject";

interface ObjectListPanelProps {
  objects: EditorObjectData[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ObjectListPanel({ objects, selectedId, onSelect }: ObjectListPanelProps) {
  return (
    <div className="editor-object-list">
      <div className="editor-object-list-header">
        Objects ({objects.length})
      </div>
      {objects.length === 0 ? (
        <div className="editor-empty">No objects yet</div>
      ) : (
        objects.map((obj) => (
          <div
            key={obj.id}
            className={`editor-object-item ${obj.id === selectedId ? "selected" : ""}`}
            onClick={() => onSelect(obj.id)}
          >
            <span className="editor-object-item-type">{obj.type}</span>
            <span className="editor-object-item-name">{obj.name}</span>
          </div>
        ))
      )}
    </div>
  );
}
