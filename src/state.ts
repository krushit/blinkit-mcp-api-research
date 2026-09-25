import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

export function stateDir(): string {
  const dir = process.env.BLINKIT_STATE_DIR ?? join(homedir(), ".blinkit-mcp");
  if (!isAbsolute(dir)) throw new Error("BLINKIT_STATE_DIR must be an absolute path");
  return dir;
}

export function stateFile(name: string): string {
  if (!/^[a-z-]+\.json$/.test(name)) throw new Error("Invalid state filename");
  return join(stateDir(), name);
}

async function ensurePrivateDir(): Promise<void> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw new Error("Blinkit state path is not a directory");
  await chmod(dir, 0o700);
}

export async function readState<T>(name: string): Promise<T | null> {
  await ensurePrivateDir();
  try {
    const file = stateFile(name);
    if (!(await lstat(file)).isFile()) throw new Error("Blinkit state path is not a regular file");
    await chmod(file, 0o600);
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeState(name: string, value: unknown): Promise<void> {
  await ensurePrivateDir();
  const target = stateFile(name);
  const temporary = join(stateDir(), `.blinkit-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function deleteState(name: string): Promise<void> {
  await unlink(stateFile(name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
