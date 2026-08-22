import { Directory, File, Paths } from 'expo-file-system';

export interface ModelFiles {
  config: File;
  symbols: File;
  duration: File;
  decode: File;
}

export interface ModelDownloadProgress {
  file: string;
  completedFiles: number;
  totalFiles: number;
}

const MODEL_BASE = 'https://huggingface.co/Danny-Dasilva/inflect-kokoro-voices/resolve/main/sky-v3';
const MODEL_ENTRIES = [
  { path: 'config.json', size: 1880 },
  { path: 'symbols.json', size: 2262 },
  { path: 'onnx/duration.onnx', size: 7_321_366 },
  { path: 'onnx/decode.onnx', size: 30_423_557 },
] as const;

function modelDirectories(): { root: Directory; onnx: Directory } {
  return {
    root: new Directory(Paths.document, 'models', 'inflect', 'sky-v3'),
    onnx: new Directory(Paths.document, 'models', 'inflect', 'sky-v3', 'onnx'),
  };
}

function targetFor(path: string, root: Directory, onnx: Directory): File {
  return path.startsWith('onnx/') ? new File(onnx, path.slice(5)) : new File(root, path);
}

export async function ensureSkyModel(
  onProgress?: (progress: ModelDownloadProgress) => void,
): Promise<ModelFiles> {
  const { root, onnx } = modelDirectories();
  root.create({ idempotent: true, intermediates: true });
  onnx.create({ idempotent: true, intermediates: true });

  let completedFiles = 0;
  for (const entry of MODEL_ENTRIES) {
    const target = targetFor(entry.path, root, onnx);
    if (!target.exists || target.size !== entry.size) {
      if (target.exists) target.delete();
      await File.downloadFileAsync(`${MODEL_BASE}/${entry.path}`, target);
      if (target.size !== entry.size) {
        throw new Error(`Sky v3 download is incomplete: ${entry.path}`);
      }
    }
    completedFiles += 1;
    onProgress?.({ file: entry.path, completedFiles, totalFiles: MODEL_ENTRIES.length });
  }

  return {
    config: new File(root, 'config.json'),
    symbols: new File(root, 'symbols.json'),
    duration: new File(onnx, 'duration.onnx'),
    decode: new File(onnx, 'decode.onnx'),
  };
}
