import fsp from "node:fs/promises";

export async function ensureDir(dirPath: string) {
  await fsp.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath: string) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
