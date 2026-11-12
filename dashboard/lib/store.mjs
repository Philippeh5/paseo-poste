import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Écriture atomique : fichier temporaire voisin, puis renommage.
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Petit magasin de fichiers JSON dans un dossier de données.
export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const fileOf = (name) => {
    if (!/^[\w-]+(\.json)?$/.test(name)) throw new Error(`nom de fichier de données invalide : ${name}`);
    return join(dataDir, name.endsWith(".json") ? name : `${name}.json`);
  };
  return {
    read: (name, fallback = null) => readJson(fileOf(name), fallback),
    write: (name, value) => writeJsonAtomic(fileOf(name), value),
  };
}
