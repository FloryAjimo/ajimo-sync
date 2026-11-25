import { normalizePath, type DataAdapter, type Vault } from "obsidian";

function isPortableName(name: string): boolean {
  return name.length > 0 && !/[\\:<>"|?*\u0000-\u001f]/u.test(name) && !/[ .]$/u.test(name) &&
    !/^(?:con|prn|aux|nul|(?:com|lpt)[1-9¹²³])(?:\.|$)/iu.test(name);
}

export function isAppearancePath(path: string): boolean {
  const parts = path.split("/");
  if (!parts.every(isPortableName)) return false;
  if (parts[0] === "snippets") return parts.length === 2 && parts[1].length > 4 && parts[1].endsWith(".css");
  return parts[0] === "themes" && parts.length === 3 && (parts[2] === "theme.css" || parts[2] === "manifest.json");
}

export class AppearanceFiles {
  readonly configDir: string;
  readonly adapter: DataAdapter;

  constructor(vault: Vault) {
    this.configDir = normalizePath(vault.configDir);
    this.adapter = vault.adapter;
  }

  fullPath(path: string): string {
    return `${this.configDir}/${path}`;
  }

  contains(path: string): boolean {
    const prefix = `${this.configDir}/`;
    return path.startsWith(prefix) && isAppearancePath(path.slice(prefix.length));
  }

  async listPaths(): Promise<string[]> {
    const snippets = await this.list("snippets");
    const themes = await this.list("themes");
    const paths = [...snippets.files];
    for (const folder of themes.folders) {
      const name = folder.slice("themes/".length);
      if (name.includes("/") || !isPortableName(name)) continue;
      paths.push(...(await this.list(folder)).files);
    }
    return paths.filter(isAppearancePath);
  }

  private async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const fullPath = this.fullPath(path);
    const stat = await this.adapter.stat(fullPath);
    if (!stat) return { files: [], folders: [] };
    if (stat.type !== "folder") throw new Error(`Путь ${fullPath} должен быть папкой.`);
    const listing = await this.adapter.list(fullPath);
    const children = (paths: string[]) => paths
      .filter(child => child.startsWith(`${fullPath}/`) && !child.slice(fullPath.length + 1).includes("/"))
      .map(child => child.slice(this.configDir.length + 1));
    return { files: children(listing.files), folders: children(listing.folders) };
  }

  async ensureParentFolders(path: string): Promise<void> {
    const parts = path.split("/");
    let directory = "";
    for (const part of parts.slice(0, -1)) {
      directory = directory ? `${directory}/${part}` : part;
      const stat = await this.adapter.stat(directory);
      if (!stat) await this.adapter.mkdir(directory);
      else if (stat.type !== "folder") throw new Error(`Путь ${directory} должен быть папкой.`);
    }
  }

  conflictPath(path: string): string {
    return this.fullPath(`ajimo-sync-conflicts/${path.slice(this.configDir.length + 1)}`);
  }
}

export function checkAppearanceNames(paths: string[]): void {
  const names = new Map<string, string>();
  for (const path of paths) {
    // Treat aliases the same on all devices, including file systems that ignore case.
    const parts = path.split("/");
    for (const name of [path, parts.slice(0, -1).join("/")]) {
      const folded = name.normalize("NFC").toLowerCase();
      const previous = names.get(folded);
      if (previous && name !== previous) throw new Error(`Имена файлов оформления совпадают без учёта регистра: ${previous}, ${name}.`);
      names.set(folded, name);
    }
  }
}
