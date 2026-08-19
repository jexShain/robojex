// packages/ceo-core/src/toolscout.ts
// Autonomous tool inventory: scan the PATH for known CLI tools, verify them,
// user-level-install the cheap ones (npm/pip), queue system ones for the
// operator, and generate short usage manuals the CEO can inject into prompts.
import { execFile, spawn as pspawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { LLMClient } from "./llm.js";

export type ToolCategory = "system" | "text" | "media" | "network" | "data" | "dev";

export interface SeedTool {
  name: string;
  category: ToolCategory;
  blurb: string;               // one English sentence, becomes a TOOLS.md line
  verifyArgs: string[];        // arguments that make the tool print its version
  install?: { npm?: string; pip?: string; apt?: string }; // npm/pip auto-install, apt queued for a human
}

export interface VerifiedTool { name: string; category: ToolCategory; version: string; }

export interface ScoutReport {
  verified: VerifiedTool[];
  manualsGenerated: number;
  pendingInstalls: string[];   // apt packages written to PENDING_INSTALLS.md
}

// Test seams: the real implementations shell out; tests inject fakes.
export type WhichFn = (name: string) => Promise<string | null>;
export type SpawnFn = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const SEED_TOOLS: SeedTool[] = [
  // ---- system: packaging, transfer, process/session management ----
  { name: "crontab", category: "system", blurb: "List and edit cron scheduled jobs.", verifyArgs: ["-V"], install: { apt: "cron" } },
  { name: "7z", category: "system", blurb: "7-Zip archiver with a high compression ratio.", verifyArgs: [], install: { apt: "p7zip-full" } },
  { name: "unzip", category: "system", blurb: "Extract and list ZIP archives.", verifyArgs: ["-h"], install: { apt: "unzip" } },
  { name: "zip", category: "system", blurb: "Create ZIP archives.", verifyArgs: ["-h"], install: { apt: "zip" } },
  { name: "tar", category: "system", blurb: "Bundle and extract tar archives.", verifyArgs: ["--version"] },
  { name: "gzip", category: "system", blurb: "Compress and decompress files with gzip.", verifyArgs: ["--version"] },
  { name: "xz", category: "system", blurb: "High-ratio XZ compression.", verifyArgs: ["--version"], install: { apt: "xz-utils" } },
  { name: "bzip2", category: "system", blurb: "Burrows-Wheeler block-sorting compressor.", verifyArgs: ["--version"] },
  { name: "zstd", category: "system", blurb: "Fast Zstandard compression.", verifyArgs: ["--version"], install: { apt: "zstd" } },
  { name: "rsync", category: "system", blurb: "Fast incremental file transfer and sync.", verifyArgs: ["--version"], install: { apt: "rsync" } },
  { name: "ssh", category: "system", blurb: "Secure remote shell and port forwarding.", verifyArgs: ["-V"], install: { apt: "openssh-client" } },
  { name: "htop", category: "system", blurb: "Interactive process viewer.", verifyArgs: ["--version"], install: { apt: "htop" } },
  { name: "tmux", category: "system", blurb: "Terminal multiplexer for persistent sessions.", verifyArgs: ["--version"], install: { apt: "tmux" } },
  { name: "exa", category: "system", blurb: "Modern ls replacement with colors and git status.", verifyArgs: ["--version"], install: { apt: "exa" } },
  { name: "duf", category: "system", blurb: "Disk usage viewer with friendly tables.", verifyArgs: ["--version"], install: { apt: "duf" } },
  { name: "ncdu", category: "system", blurb: "Interactive disk usage analyzer.", verifyArgs: ["--version"], install: { apt: "ncdu" } },
  { name: "file", category: "system", blurb: "Identify file types by content, not name.", verifyArgs: ["--version"] },
  { name: "pv", category: "system", blurb: "Monitor data progress through pipes.", verifyArgs: ["--version"], install: { apt: "pv" } },
  // ---- text: search, transform, render ----
  { name: "rg", category: "text", blurb: "Fast recursive regex search (ripgrep).", verifyArgs: ["--version"], install: { apt: "ripgrep" } },
  { name: "fd", category: "text", blurb: "Simple, fast file finder.", verifyArgs: ["--version"] },
  { name: "fzf", category: "text", blurb: "General-purpose command-line fuzzy finder.", verifyArgs: ["--version"], install: { apt: "fzf" } },
  { name: "bat", category: "text", blurb: "Cat clone with syntax highlighting and git gutter.", verifyArgs: ["--version"] },
  { name: "pandoc", category: "text", blurb: "Convert documents between Markdown, HTML, DOCX and more.", verifyArgs: ["--version"], install: { apt: "pandoc" } },
  { name: "xmllint", category: "text", blurb: "XML linting, formatting, and XPath queries.", verifyArgs: ["--version"], install: { apt: "libxml2-utils" } },
  { name: "htmlq", category: "text", blurb: "CSS-selector extraction from HTML.", verifyArgs: ["--version"] },
  { name: "xmlstarlet", category: "text", blurb: "Transform, query, and edit XML from the shell.", verifyArgs: ["--version"], install: { apt: "xmlstarlet" } },
  { name: "iconv", category: "text", blurb: "Convert text between character encodings.", verifyArgs: ["--version"] },
  { name: "dos2unix", category: "text", blurb: "Normalize line endings between DOS, Unix, and Mac.", verifyArgs: ["--version"], install: { apt: "dos2unix" } },
  { name: "aspell", category: "text", blurb: "Interactive spell checker.", verifyArgs: ["--version"], install: { apt: "aspell" } },
  { name: "hunspell", category: "text", blurb: "Spell checker and morphological analyzer.", verifyArgs: ["--version"], install: { apt: "hunspell" } },
  { name: "glow", category: "text", blurb: "Render Markdown beautifully in the terminal.", verifyArgs: ["--version"] },
  { name: "sd", category: "text", blurb: "Intuitive find-and-replace, easier than sed.", verifyArgs: ["--version"] },
  // ---- media: audio, video, image, PDF ----
  { name: "ffmpeg", category: "media", blurb: "Record, convert, and stream audio and video.", verifyArgs: ["-version"], install: { apt: "ffmpeg" } },
  { name: "ffprobe", category: "media", blurb: "Probe media container and stream metadata.", verifyArgs: ["-version"], install: { apt: "ffmpeg" } },
  { name: "convert", category: "media", blurb: "ImageMagick image conversion and processing.", verifyArgs: ["--version"], install: { apt: "imagemagick" } },
  { name: "identify", category: "media", blurb: "Describe image format, size, and colorspace.", verifyArgs: ["--version"], install: { apt: "imagemagick" } },
  { name: "sox", category: "media", blurb: "Sound processing Swiss Army knife.", verifyArgs: ["--version"], install: { apt: "sox" } },
  { name: "yt-dlp", category: "media", blurb: "Download videos from YouTube and thousands of sites.", verifyArgs: ["--version"], install: { pip: "yt-dlp" } },
  { name: "tesseract", category: "media", blurb: "OCR engine for images and scanned pages.", verifyArgs: ["--version"], install: { apt: "tesseract-ocr" } },
  { name: "wkhtmltopdf", category: "media", blurb: "Render HTML to PDF with a WebKit engine.", verifyArgs: ["--version"], install: { apt: "wkhtmltopdf" } },
  { name: "pdftotext", category: "media", blurb: "Extract plain text from PDFs (poppler).", verifyArgs: ["-v"], install: { apt: "poppler-utils" } },
  { name: "qpdf", category: "media", blurb: "Inspect, split, encrypt, and transform PDFs.", verifyArgs: ["--version"], install: { apt: "qpdf" } },
  { name: "exiftool", category: "media", blurb: "Read and write image and document metadata.", verifyArgs: ["--version"], install: { apt: "libimage-exiftool-perl" } },
  { name: "img2pdf", category: "media", blurb: "Losslessly pack images into a PDF.", verifyArgs: ["--version"], install: { pip: "img2pdf" } },
  { name: "chafa", category: "media", blurb: "Print images as terminal graphics and ANSI art.", verifyArgs: ["--version"], install: { apt: "chafa" } },
  { name: "espeak", category: "media", blurb: "Compact text-to-speech synthesizer.", verifyArgs: ["--version"], install: { apt: "espeak" } },
  { name: "mpv", category: "media", blurb: "Media player with scripting and GPU output.", verifyArgs: ["--version"], install: { apt: "mpv" } },
  // ---- network: transfer, diagnosis, security ----
  { name: "curl", category: "network", blurb: "Transfer data to and from URLs.", verifyArgs: ["--version"], install: { apt: "curl" } },
  { name: "wget", category: "network", blurb: "Non-interactive network downloader.", verifyArgs: ["--version"], install: { apt: "wget" } },
  { name: "dig", category: "network", blurb: "DNS lookup and debugging utility.", verifyArgs: ["-v"], install: { apt: "dnsutils" } },
  { name: "whois", category: "network", blurb: "Query WHOIS registry records for domains.", verifyArgs: ["--help"], install: { apt: "whois" } },
  { name: "traceroute", category: "network", blurb: "Trace the route packets take to a host.", verifyArgs: ["--version"], install: { apt: "traceroute" } },
  { name: "nc", category: "network", blurb: "TCP/UDP Swiss Army knife (netcat).", verifyArgs: ["-h"], install: { apt: "netcat-openbsd" } },
  { name: "nmap", category: "network", blurb: "Network discovery and security scanning.", verifyArgs: ["--version"], install: { apt: "nmap" } },
  { name: "openssl", category: "network", blurb: "TLS toolkit and crypto Swiss Army knife.", verifyArgs: ["version"], install: { apt: "openssl" } },
  { name: "mtr", category: "network", blurb: "Combined ping and traceroute in real time.", verifyArgs: ["--version"], install: { apt: "mtr-tiny" } },
  { name: "aria2c", category: "network", blurb: "Multi-protocol segmented downloader.", verifyArgs: ["--version"], install: { apt: "aria2" } },
  { name: "iperf3", category: "network", blurb: "Measure network throughput between hosts.", verifyArgs: ["--version"], install: { apt: "iperf3" } },
  { name: "socat", category: "network", blurb: "Relay data between sockets and addresses.", verifyArgs: ["-V"], install: { apt: "socat" } },
  { name: "http", category: "network", blurb: "Human-friendly HTTP client (HTTPie).", verifyArgs: ["--version"], install: { pip: "httpie", apt: "httpie" } },
  { name: "speedtest-cli", category: "network", blurb: "Bandwidth test against Speedtest servers.", verifyArgs: ["--version"], install: { pip: "speedtest-cli" } },
  // ---- data: structured formats and databases ----
  { name: "jq", category: "data", blurb: "Slice, filter, and transform JSON on the command line.", verifyArgs: ["--version"], install: { apt: "jq" } },
  { name: "yq", category: "data", blurb: "jq-style processor for YAML, TOML, and XML.", verifyArgs: ["--version"], install: { pip: "yq" } },
  { name: "sqlite3", category: "data", blurb: "CLI for SQLite database files.", verifyArgs: ["--version"], install: { apt: "sqlite3" } },
  { name: "psql", category: "data", blurb: "PostgreSQL interactive terminal.", verifyArgs: ["--version"], install: { apt: "postgresql-client" } },
  { name: "mysql", category: "data", blurb: "MySQL and MariaDB command-line client.", verifyArgs: ["--version"], install: { apt: "default-mysql-client" } },
  { name: "redis-cli", category: "data", blurb: "Redis command-line client.", verifyArgs: ["--version"], install: { apt: "redis-tools" } },
  { name: "mongosh", category: "data", blurb: "Modern MongoDB shell.", verifyArgs: ["--version"], install: { npm: "mongosh" } },
  { name: "litecli", category: "data", blurb: "Autocompleting SQLite CLI.", verifyArgs: ["--version"], install: { pip: "litecli" } },
  { name: "pgcli", category: "data", blurb: "Autocompleting PostgreSQL CLI.", verifyArgs: ["--version"], install: { pip: "pgcli" } },
  { name: "mlr", category: "data", blurb: "Miller: name-indexed CSV, TSV, and JSON transformer.", verifyArgs: ["--version"], install: { apt: "miller" } },
  { name: "datamash", category: "data", blurb: "Statistical operations on tabular text.", verifyArgs: ["--version"], install: { apt: "datamash" } },
  // ---- dev: languages, build, version control ----
  { name: "git", category: "dev", blurb: "Distributed version control.", verifyArgs: ["--version"], install: { apt: "git" } },
  { name: "python3", category: "dev", blurb: "Python 3 interpreter.", verifyArgs: ["--version"], install: { apt: "python3" } },
  { name: "pip", category: "dev", blurb: "Python package installer.", verifyArgs: ["--version"], install: { apt: "python3-pip" } },
  { name: "node", category: "dev", blurb: "JavaScript runtime.", verifyArgs: ["--version"], install: { apt: "nodejs" } },
  { name: "npm", category: "dev", blurb: "Node.js package manager.", verifyArgs: ["--version"], install: { apt: "npm" } },
  { name: "pnpm", category: "dev", blurb: "Fast, disk-efficient Node package manager.", verifyArgs: ["--version"], install: { npm: "pnpm" } },
  { name: "yarn", category: "dev", blurb: "JavaScript package manager.", verifyArgs: ["--version"], install: { npm: "yarn" } },
  { name: "tsc", category: "dev", blurb: "TypeScript compiler CLI.", verifyArgs: ["--version"], install: { npm: "typescript" } },
  { name: "cargo", category: "dev", blurb: "Rust package manager and build tool.", verifyArgs: ["--version"], install: { apt: "cargo" } },
  { name: "rustc", category: "dev", blurb: "Rust compiler.", verifyArgs: ["--version"], install: { apt: "rustc" } },
  { name: "go", category: "dev", blurb: "Go toolchain: build, vet, and test.", verifyArgs: ["version"], install: { apt: "golang-go" } },
  { name: "java", category: "dev", blurb: "Java runtime.", verifyArgs: ["--version"], install: { apt: "default-jre" } },
  { name: "mvn", category: "dev", blurb: "Java build automation (Maven).", verifyArgs: ["--version"], install: { apt: "maven" } },
  { name: "gradle", category: "dev", blurb: "Java and Kotlin build system.", verifyArgs: ["--version"], install: { apt: "gradle" } },
  { name: "make", category: "dev", blurb: "Build automation from Makefiles.", verifyArgs: ["--version"], install: { apt: "make" } },
  { name: "cmake", category: "dev", blurb: "Cross-platform build system generator.", verifyArgs: ["--version"], install: { apt: "cmake" } },
  { name: "gcc", category: "dev", blurb: "GNU C and C++ compiler.", verifyArgs: ["--version"], install: { apt: "gcc" } },
  { name: "docker", category: "dev", blurb: "Container engine CLI.", verifyArgs: ["--version"], install: { apt: "docker.io" } },
  { name: "gh", category: "dev", blurb: "GitHub CLI for repos, PRs, and issues.", verifyArgs: ["--version"] },
  { name: "tig", category: "dev", blurb: "Text-mode git repository browser.", verifyArgs: ["--version"], install: { apt: "tig" } },
  { name: "delta", category: "dev", blurb: "Syntax-highlighted, side-by-side git diffs.", verifyArgs: ["--version"] },
  { name: "shellcheck", category: "dev", blurb: "Static analysis for shell scripts.", verifyArgs: ["--version"], install: { apt: "shellcheck" } },
  { name: "shfmt", category: "dev", blurb: "Canonical shell script formatter.", verifyArgs: ["--version"] },
  { name: "pre-commit", category: "dev", blurb: "Git hook framework for repo hygiene.", verifyArgs: ["--version"], install: { pip: "pre-commit" } },
  { name: "uv", category: "dev", blurb: "Fast Python package manager, pip replacement.", verifyArgs: ["--version"], install: { pip: "uv" } },
  { name: "poetry", category: "dev", blurb: "Python dependency and virtualenv manager.", verifyArgs: ["--version"], install: { pip: "poetry" } },
  { name: "just", category: "dev", blurb: "Command runner for Justfiles.", verifyArgs: ["--version"] },
  { name: "nvim", category: "dev", blurb: "Modern Vim editor.", verifyArgs: ["--version"], install: { apt: "neovim" } },
  { name: "hexyl", category: "dev", blurb: "Colorful command-line hex viewer.", verifyArgs: ["--version"] },
];

const VERIFY_TIMEOUT_MS = 3000;
const INSTALL_TIMEOUT_MS = 60_000;
const TOOLS_CAP = 80;            // max tool lines written to TOOLS.md
const MANUAL_MAX_CHARS = 800;    // per-manual cap
const TOOLS_BLOCK_MAX = 4096;    // TOOLS.md slice served into decide prompts
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/; // candidate names the query pass may accept
const QUERY_NAMES_CAP = 10;      // max dynamic candidates per query
const DISCOVERED_BLURB = "(discovered via query)"; // fallback when blurb generation fails

const defaultWhich: WhichFn = (name) => new Promise((resolve) => {
  execFile("which", [name], (err, stdout) => resolve(err || !stdout.trim() ? null : stdout.trim()));
});

// ES2022 target has no Promise.withResolvers typings; executor form matches loop.ts
export const defaultSpawn: SpawnFn = (cmd, args, o = {}) => new Promise((resolve, reject) => {
  const child = pspawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: o.env });
  let stdout = "", stderr = "", timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, o.timeoutMs ?? VERIFY_TIMEOUT_MS);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => { stdout += d; });
  child.stderr?.on("data", (d: string) => { stderr += d; });
  child.on("error", (e) => { clearTimeout(timer); reject(e); });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (timedOut) reject(new Error(`${cmd} timed out after ${o.timeoutMs ?? VERIFY_TIMEOUT_MS}ms`));
    else resolve({ code: code ?? -1, stdout, stderr });
  });
});

export class ToolScout {
  private which: WhichFn;
  private spawn: SpawnFn;
  private timeoutMs: number;
  private busy = false;          // one inventory pass may run at a time
  private lastReport: ScoutReport | null = null; // served to callers that re-enter mid-pass

  constructor(private opts: {
    llm: LLMClient | null; runtimeDir: string;
    whichFn?: WhichFn; spawnFn?: SpawnFn; timeoutMs?: number;
    spend?: (u: { promptTokens: number; completionTokens: number }) => void; // books every scout LLM call into the budget
  }) {
    this.which = opts.whichFn ?? defaultWhich;
    this.spawn = opts.spawnFn ?? defaultSpawn;
    this.timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
    mkdirSync(opts.runtimeDir, { recursive: true });
  }

  // Which seed tools are on the PATH right now.
  async scan(): Promise<SeedTool[]> {
    const found: SeedTool[] = [];
    for (const t of SEED_TOOLS) {
      if (await this.which(t.name)) found.push(t);
    }
    return found;
  }

  // Run the tool's version probe; the first non-empty stdout line (<=80 chars)
  // is the "version"; some probes (nc -h) only answer on stderr, so an empty
  // stdout falls back to stderr's first non-empty line. Any spawn error or
  // silence on both streams means unverifiable: null.
  async verify(tool: SeedTool): Promise<string | null> {
    try {
      const r = await this.spawn(tool.name, tool.verifyArgs, { timeoutMs: this.timeoutMs });
      // stdout first; nc-style probes answer on stderr only when stdout is empty
      const line = r.stdout.split("\n").map((s) => s.trim()).find((s) => s.length > 0)
        ?? r.stderr.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
      return line ? line.slice(0, 40) : null; // short tag: this line ships in the standing TOOLS.md context
    } catch {
      return null;
    }
  }

  // npm/pip install at user level immediately; apt packages need root, so they
  // are only queued into PENDING_INSTALLS.md for the operator. Returns the
  // apt queue (whether freshly appended or already listed).
  async installMissing(missing: SeedTool[]): Promise<string[]> {
    const pending: string[] = [];
    for (const t of missing) {
      const inst = t.install;
      if (!inst) continue;
      if (inst.npm) {
        try { await this.spawn("npm", ["install", "-g", inst.npm], { timeoutMs: INSTALL_TIMEOUT_MS, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --dns-result-order=ipv4first`.trim() } }); }
        catch (e) { console.error(`[toolscout] npm install ${inst.npm} failed: ${e instanceof Error ? e.message : String(e)}`); }
      } else if (inst.pip) {
        try { await this.spawn("pip", ["install", "--user", inst.pip], { timeoutMs: INSTALL_TIMEOUT_MS }); }
        catch (e) { console.error(`[toolscout] pip install ${inst.pip} failed: ${e instanceof Error ? e.message : String(e)}`); }
      } else if (inst.apt) {
        pending.push(inst.apt);
        this.queueApt(inst.apt, t);
      }
    }
    return pending;
  }

  // One idempotent line per package: a second scan appends nothing.
  private queueApt(pkg: string, tool: SeedTool): void {
    const p = join(this.opts.runtimeDir, "PENDING_INSTALLS.md");
    let existing = "";
    try { existing = readFileSync(p, "utf8"); } catch { /* first entry */ }
    if (new RegExp(`^- ${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `, "m").test(existing)) return;
    writeFileSync(p, `${existing || "# PENDING INSTALLS (system packages the operator must install)\n"}- ${pkg} (for ${tool.name}: ${tool.blurb})\n`);
  }

  // LLM-written usage manuals for verified tools that lack one. Idempotent:
  // an existing file is never regenerated. Returns how many were written.
  async writeManuals(verified: VerifiedTool[]): Promise<number> {
    if (!this.opts.llm) return 0;
    const dir = join(this.opts.runtimeDir, "tool-manuals");
    mkdirSync(dir, { recursive: true });
    let generated = 0;
    for (const v of verified) {
      const p = join(dir, `${v.name}.md`);
      if (existsSync(p)) continue;
      const r = await this.opts.llm.chat("patrol", [
        { role: "system", content: "You write terse English CLI tool manuals. Plain text only, at most 800 characters total: one sentence on what the tool is for, a '## Common commands' list with exactly 3 one-line examples, and one 'Caution:' line naming the sharpest edge." },
        { role: "user", content: `Write the usage manual for the command-line tool '${v.name}' (${v.category}).` },
      ], { maxTokens: 500 });
      this.opts.spend?.(r.usage); // manual generation burns tokens: book them
      writeFileSync(p, r.content.slice(0, MANUAL_MAX_CHARS));
      generated++;
    }
    return generated;
  }

  // Query-driven expansion: the patrol LLM pulls candidate CLI names out of the
  // CEO's query. Malformed names and seed duplicates are dropped; any LLM or
  // JSON failure simply ignores the query (plain seed pass).
  private async discoverCandidates(query: string): Promise<SeedTool[]> {
    if (!this.opts.llm) return [];
    try {
      const r = await this.opts.llm.chat("patrol", [
        { role: "system", content: 'You extract candidate command-line tool names from a task description. Reply ONLY JSON: {"names":["tool1","tool2"]} — lowercase executable names only, at most 10, no prose.' },
        { role: "user", content: `Task: ${query}` },
      ], { json: true, maxTokens: 300 });
      this.opts.spend?.(r.usage);
      const parsed = JSON.parse(r.content) as { names?: unknown };
      if (!Array.isArray(parsed.names)) return [];
      const out: SeedTool[] = [];
      for (const n of parsed.names) {
        if (typeof n !== "string" || !NAME_RE.test(n) || SEED_TOOLS.some((s) => s.name === n)) continue;
        if (!out.some((t) => t.name === n)) out.push({ name: n, category: "system", blurb: "", verifyArgs: ["--version"] });
        if (out.length >= QUERY_NAMES_CAP) break;
      }
      return out;
    } catch {
      return []; // llm down or garbage JSON: degrade to the seed-only pass
    }
  }

  // One-sentence TOOLS.md blurb for a query-discovered tool the seed table has
  // no line for. Failure degrades to a fixed placeholder, never a broken line.
  private async blurbFor(name: string): Promise<string> {
    if (!this.opts.llm) return DISCOVERED_BLURB;
    try {
      const r = await this.opts.llm.chat("patrol", [
        { role: "system", content: "You write one terse English sentence describing what a command-line tool does. Reply with the sentence only." },
        { role: "user", content: `Describe the command-line tool '${name}' in one sentence.` },
      ], { maxTokens: 100 });
      this.opts.spend?.(r.usage);
      const s = r.content.trim().split("\n")[0]?.trim() ?? "";
      return s ? s.slice(0, 200) : DISCOVERED_BLURB;
    } catch {
      return DISCOVERED_BLURB;
    }
  }

  // Full inventory pass: scan -> verify -> install missing -> TOOLS.md -> manuals.
  // Re-entrant calls (index.ts first boot + a CEO toolscout action racing) get
  // the previous report back instead of a second concurrent pass.
  async run(query?: string): Promise<ScoutReport> {
    if (this.busy) {
      console.warn("[toolscout] inventory pass already in flight: returning the previous report");
      return this.lastReport ?? { verified: [], manualsGenerated: 0, pendingInstalls: [] };
    }
    this.busy = true;
    try {
      const discovered = query ? await this.discoverCandidates(query) : [];
      const installed = await this.scan();
      const missing = SEED_TOOLS.filter((t) => !installed.includes(t));
      const verified: VerifiedTool[] = [];
      for (const t of [...installed, ...discovered]) {
        const version = await this.verify(t);
        if (version !== null) verified.push({ name: t.name, category: t.category, version });
      }
      const pendingInstalls = await this.installMissing(missing);

      const today = new Date().toISOString().slice(0, 10);
      const listed = verified.slice(0, TOOLS_CAP);
      const lines: string[] = [];
      for (const v of listed) {
        const t = SEED_TOOLS.find((s) => s.name === v.name) ?? discovered.find((s) => s.name === v.name)!;
        const blurb = t.blurb || await this.blurbFor(v.name); // discovered tools have no seed line
        lines.push(`- ${v.name} (${v.category}) — ${blurb} [v${v.version}] verified ${today}`);
      }
      writeFileSync(join(this.opts.runtimeDir, "TOOLS.md"), `${lines.join("\n")}\n`);

      const manualsGenerated = await this.writeManuals(listed);
      const report: ScoutReport = { verified, manualsGenerated, pendingInstalls };
      this.lastReport = report;
      return report;
    } finally {
      this.busy = false;
    }
  }

  // The decide-prompt view of the inventory: TOOLS.md capped at 4KB; a blank
  // file reads as absent so no empty "# AVAILABLE TOOLS" tail is ever served.
  readToolsBlock(): string {
    try {
      const body = readFileSync(join(this.opts.runtimeDir, "TOOLS.md"), "utf8").trim();
      return body ? body.slice(0, TOOLS_BLOCK_MAX) : "";
    } catch { return ""; }
  }

  // Verified tool names straight from TOOLS.md (full file, not the 4KB block).
  verifiedNames(): string[] {
    const names: string[] = [];
    try {
      for (const line of readFileSync(join(this.opts.runtimeDir, "TOOLS.md"), "utf8").split("\n")) {
        const m = line.match(/^- (\S+) \(/);
        if (m) names.push(m[1]);
      }
    } catch { /* no inventory yet */ }
    return names;
  }

  // One tool's manual, or null when it was never generated.
  readManual(name: string): string | null {
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(name)) return null; // TOOLS.md is self-written, still: no traversal
    try { return readFileSync(join(this.opts.runtimeDir, "tool-manuals", `${name}.md`), "utf8"); }
    catch { return null; }
  }
}
