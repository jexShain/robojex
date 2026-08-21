// packages/ceo-core/src/tools/file.ts
// File tools — semantic port of hermes-agent tools/file_tools.py: same tool
// names, same parameter shapes (path/offset/limit; old_string/new_string;
// pattern/target), zero npm deps (node:fs only).
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, join, relative, extname } from "node:path";
import type { ToolEntry, ToolCtx } from "./registry.js";

const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".zip", ".gz", ".tar", ".tgz", ".jar", ".exe", ".dll", ".so", ".dylib", ".bin", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".avi", ".mov", ".sqlite", ".db", ".pdf", ".doc", ".xls", ".ppt"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".cache"]);

// hermes budget: reads cap at ~100K chars on a line boundary with next_offset
const READ_CHAR_BUDGET = 100_000;

function expand(p: string): string { return p.startsWith("~/") ? join(process.env.HOME ?? "~", p.slice(2)) : p; }

async function readFile(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const path = expand(String(args.path ?? ""));
  if (!path) return "error: path required";
  if (BINARY_EXT.has(extname(path).toLowerCase())) return `error: refusing to read binary file ${extname(path)} — save it to disk and reference by path`;
  if (!existsSync(path)) {
    // hermes suggests similar filenames when the target is missing
    const dir = dirname(path); const want = path.split(/[\\/]/).pop() ?? "";
    let alt = "";
    try {
      alt = readdirSync(dir).filter((f) => f.slice(0, 3).toLowerCase() === want.slice(0, 3).toLowerCase()).slice(0, 5).join(", ");
    } catch { /* dir itself missing */ }
    return `error: file not found: ${path}${alt ? `\nsimilar: ${alt}` : ""}`;
  }
  const offset = Math.max(1, Number(args.offset ?? 1));
  const limit = Math.min(2000, Math.max(1, Number(args.limit ?? 2000)));
  const lines = readFileSync(path, "utf8").split("\n");
  // Remove phantom trailing newline if file ends with \n
  if (lines.length > 0 && lines[lines.length - 1] === "" && lines.length > 1) lines.pop();
  
  if (lines.length === 0) return "(empty file)";
  if (offset > lines.length) return `(EOF: offset ${offset} is past the last line ${lines.length})`;
  const slice: string[] = [];
  let chars = 0; let next: number | null = null;
  for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
    const row = `${i + 1}|${lines[i]}`;
    // If first line itself exceeds budget, truncate and ensure progress
    if (i === offset - 1 && row.length > READ_CHAR_BUDGET) {
      const truncated = row.slice(0, READ_CHAR_BUDGET - 30) + "... [line truncated]";
      slice.push(truncated);
      next = i + 2; // Next line to ensure progress
      break;
    }
    if (chars + row.length > READ_CHAR_BUDGET) { next = i + 1; break; }
    slice.push(row); chars += row.length + 1;
  }
  // Simplified next logic: set next only if we filled budget and more lines remain
  if (next === null && offset - 1 + limit < lines.length && offset - 1 + slice.length < lines.length) {
    next = offset + slice.length;
  }
  const tail = next !== null ? `\n[next_offset: ${next} — ${lines.length} lines total]` : "";
  return slice.join("\n") + tail;
}

async function writeFile(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const path = expand(String(args.path ?? ""));
  const content = args.content;
  if (!path || typeof content !== "string") return "error: path and content (string) required";
  mkdirSync(dirname(path), { recursive: true });
  // atomic write: temp file in the same dir, then rename over the target
  const tmp = join(dirname(path), `.rjtmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } finally {
    // Cleanup temp file if rename failed (ignore errors if already gone)
    try { unlinkSync(tmp); } catch { /* temp already renamed or doesn't exist */ }
  }
  return `wrote ${Buffer.byteLength(content)} bytes to ${path}`;
}

async function patch(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const mode = String(args.mode ?? "replace");
  if (mode !== "replace") return `error: unsupported patch mode '${mode}' — use mode='replace' (path, old_string, new_string, replace_all?)`;
  const path = expand(String(args.path ?? ""));
  const oldS = args.old_string; const newS = args.new_string;
  if (typeof oldS !== "string" || typeof newS !== "string" || oldS === "") return "error: mode='replace' requires non-empty old_string and new_string (pass '' as new_string to delete)";
  if (oldS === newS) return "error: new_string must differ from old_string";
  if (!existsSync(path)) return `error: file not found: ${path}`;
  const src = readFileSync(path, "utf8");
  const count = src.split(oldS).length - 1;
  if (count === 0) {
    // hermes surfaces a nearby-context hint on miss
    const first = oldS.split("\n")[0].slice(0, 60);
    const near = src.includes(first) ? `\nhint: first line '${first}' IS present — a later line differs` : "";
    return `error: old_string not found in ${path}${near}`;
  }
  if (count > 1 && args.replace_all !== true) return `error: old_string matches ${count} locations — add surrounding context lines to make it unique, or set replace_all=true`;
  const out = src.split(oldS).join(newS);
  const tmp = join(dirname(path), `.rjtmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, out); renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch { /* temp already renamed or doesn't exist */ }
  }
  const n = args.replace_all === true ? count : 1;
  return `patched ${path}: ${n} replacement${n > 1 ? "s" : ""}\n-${oldS.split("\n").slice(0, 3).join("\n-")}\n+${newS.split("\n").slice(0, 3).join("\n+")}`;
}

// depth-first walk, SKIP_DIRS pruned, bounded to keep the loop responsive
function* walk(dir: string, budget: { n: number }): Generator<string> {
  if (budget.n <= 0) return;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (budget.n <= 0) return;
    const p = join(dir, name);
    let st; try { st = lstatSync(p); } catch { continue; }
    // Skip symlinks to avoid loops and duplicates
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) yield* walk(p, budget); }
    else { budget.n--; yield p; }
  }
}

async function searchFiles(args: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return "error: pattern required";
  const target = String(args.target ?? "content");
  const root = expand(String(args.path ?? "."));
  const limit = Math.min(200, Math.max(1, Number(args.limit ?? 50)));
  const budget = { n: 5000 }; // files scanned cap
  const out: string[] = [];
  if (target === "files") {
    const rx = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    for (const p of walk(root, budget)) {
      if (rx.test(p.split(/[\\/]/).pop() ?? "")) { out.push(relative(process.cwd(), p)); if (out.length >= limit) break; }
    }
    return out.length ? out.join("\n") : `no files matching '${pattern}' under ${root}`;
  }
  // content mode
  let rx: RegExp;
  try { rx = new RegExp(pattern); } catch (e) { return `error: invalid regex: ${e instanceof Error ? e.message : String(e)}`; }
  const fileGlob = typeof args.file_glob === "string" && args.file_glob ? new RegExp("^" + args.file_glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$") : null;
  for (const p of walk(root, budget)) {
    if (fileGlob && !fileGlob.test(p.split(/[\\/]/).pop() ?? "")) continue;
    if (BINARY_EXT.has(extname(p).toLowerCase())) continue;
    let lines: string[]; try { lines = readFileSync(p, "utf8").split("\n"); } catch { continue; }
    lines.forEach((line, i) => {
      if (rx.test(line) && out.length < limit) out.push(`${relative(process.cwd(), p)}:${i + 1}:${line.slice(0, 200)}`);
    });
    if (out.length >= limit) break;
  }
  return out.length ? out.join("\n") : `no matches for '${pattern}' under ${root}`;
}

export function fileTools(): ToolEntry[] {
  return [
    { name: "read_file", toolset: "file", writes: false, handler: readFile,
      schema: { name: "read_file", description: "Read a text file with line numbers (format LINE|CONTENT). Use offset/limit for large files; reads cap at ~100K chars and report next_offset to continue.", parameters: { type: "object", properties: { path: { type: "string", description: "Path to the file (absolute, relative, or ~/path)" }, offset: { type: "integer", description: "Line to start from (1-indexed)", default: 1 }, limit: { type: "integer", description: "Max lines (default 2000)", default: 2000 } }, required: ["path"] } } },
    { name: "write_file", toolset: "file", writes: true, handler: writeFile,
      schema: { name: "write_file", description: "Write content to a file, completely replacing existing content. Creates parent directories automatically. OVERWRITES the whole file — use 'patch' for targeted edits.", parameters: { type: "object", properties: { path: { type: "string", description: "File path (created if missing, overwritten if present)" }, content: { type: "string", description: "Complete file content" } }, required: ["path", "content"] } } },
    { name: "patch", toolset: "file", writes: true, handler: patch,
      schema: { name: "patch", description: "Targeted find-and-replace edit. mode='replace': find a unique old_string and replace with new_string (replace_all=true for every match; '' deletes). Returns a diff summary.", parameters: { type: "object", properties: { mode: { type: "string", description: "Edit mode", enum: ["replace"], default: "replace" }, path: { type: "string", description: "File to edit" }, old_string: { type: "string", description: "Exact text to find; include context lines to ensure uniqueness" }, new_string: { type: "string", description: "Replacement; must differ from old_string; '' deletes the match" }, replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match", default: false } }, required: ["mode", "path", "old_string", "new_string"] } } },
    { name: "search_files", toolset: "file", writes: false, handler: searchFiles,
      schema: { name: "search_files", description: "Search file contents (regex, target='content') or find files by glob (target='files'). Skips .git/node_modules/dist.", parameters: { type: "object", properties: { pattern: { type: "string", description: "Regex for content search or glob (e.g. '*.ts') for file search" }, target: { type: "string", description: "'content' greps inside files, 'files' globs by name", enum: ["content", "files"], default: "content" }, path: { type: "string", description: "Directory to search (default '.')", default: "." }, file_glob: { type: "string", description: "Filter files by glob in content mode (e.g. '*.py')" }, limit: { type: "integer", description: "Max results (default 50)", default: 50 } }, required: ["pattern"] } } },
  ];
}
