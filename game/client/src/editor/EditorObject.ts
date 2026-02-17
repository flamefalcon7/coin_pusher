export type PrimitiveType = "box" | "sphere" | "cylinder" | "prism";

export interface EditorObjectData {
  id: string;
  name: string;
  type: PrimitiveType;
  position: [number, number, number];
  rotation: [number, number, number]; // euler radians
  scale: [number, number, number];
}

export interface EditorSceneData {
  version: 1;
  objects: EditorObjectData[];
}
