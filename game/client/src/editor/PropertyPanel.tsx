import { useCallback } from "react";
import { EditorObjectData } from "./EditorObject";

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

interface PropertyPanelProps {
  object: EditorObjectData | null;
  onTransformChange: (
    id: string,
    pos?: [number, number, number],
    rot?: [number, number, number],
    scale?: [number, number, number]
  ) => void;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function Vec3Row({
  label,
  values,
  onChange,
}: {
  label: string;
  values: [number, number, number];
  onChange: (axis: number, value: number) => void;
}) {
  const axes = ["X", "Y", "Z"];
  return (
    <div className="editor-property-group">
      <div className="editor-property-label">{label}</div>
      <div className="editor-property-row">
        {axes.map((a, i) => (
          <span key={a} style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span className="editor-property-axis">{a}</span>
            <input
              className="editor-property-input"
              type="number"
              step={label === "Rotation" ? 1 : 0.1}
              value={round3(values[i])}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v)) onChange(i, v);
              }}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

export function PropertyPanel({ object, onTransformChange }: PropertyPanelProps) {
  if (!object) {
    return (
      <div className="editor-property-panel">
        <div className="editor-empty">Select an object</div>
      </div>
    );
  }

  const handlePosChange = useCallback(
    (axis: number, value: number) => {
      const pos: [number, number, number] = [...object.position];
      pos[axis] = value;
      onTransformChange(object.id, pos, undefined, undefined);
    },
    [object, onTransformChange]
  );

  const handleRotChange = useCallback(
    (axis: number, valueDeg: number) => {
      const rot: [number, number, number] = [...object.rotation];
      rot[axis] = valueDeg * DEG_TO_RAD;
      onTransformChange(object.id, undefined, rot, undefined);
    },
    [object, onTransformChange]
  );

  const handleScaleChange = useCallback(
    (axis: number, value: number) => {
      const scale: [number, number, number] = [...object.scale];
      scale[axis] = value;
      onTransformChange(object.id, undefined, undefined, scale);
    },
    [object, onTransformChange]
  );

  const rotDeg: [number, number, number] = [
    round3(object.rotation[0] * RAD_TO_DEG),
    round3(object.rotation[1] * RAD_TO_DEG),
    round3(object.rotation[2] * RAD_TO_DEG),
  ];

  return (
    <div className="editor-property-panel">
      <div className="editor-property-label" style={{ marginBottom: 6, color: "#8bf" }}>
        {object.name}
      </div>
      <Vec3Row label="Position" values={object.position} onChange={handlePosChange} />
      <Vec3Row label="Rotation" values={rotDeg} onChange={handleRotChange} />
      <Vec3Row label="Scale" values={object.scale} onChange={handleScaleChange} />
    </div>
  );
}
