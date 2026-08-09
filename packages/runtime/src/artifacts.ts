import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureParent(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensureParent(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

export async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function writeJsonLinesAtomic(filePath: string, rows: readonly unknown[]): Promise<void> {
  await ensureParent(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(temporary, content ? `${content}\n` : "", { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

export async function readJsonLines<T = unknown>(filePath: string): Promise<T[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

export async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export function timestampSlug(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}
