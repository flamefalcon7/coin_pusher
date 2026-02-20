import { EditorSceneData } from "./EditorObject";

export function downloadSceneJSON(data: EditorSceneData): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "scene-layout.json";
  a.click();
  URL.revokeObjectURL(url);
}

export function loadSceneJSON(): Promise<EditorSceneData> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        reject(new Error("No file selected"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result as string) as EditorSceneData;
          if (data.version !== 1 || !Array.isArray(data.objects)) {
            reject(new Error("Invalid scene data format"));
            return;
          }
          resolve(data);
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    };
    input.click();
  });
}
