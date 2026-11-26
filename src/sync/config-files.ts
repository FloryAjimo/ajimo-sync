import { normalizePath, type DataAdapter, type Vault } from "obsidian";

export class ConfigFiles {
  readonly configDir: string;
  readonly adapter: DataAdapter;

  constructor(vault: Vault) {
    this.configDir = normalizePath(vault.configDir);
    this.adapter = vault.adapter;
  }

  fullPath(path: string): string {
    return `${this.configDir}/${path}`;
  }

  relativePath(path: string): string | undefined {
    const prefix = `${this.configDir}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
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
