import { normalizePath, Platform, type DataAdapter, type Vault } from "obsidian";
import type { CommunityPluginInfo, PluginComparison, PrivateSyncSettings, RemoteManifest } from "../types/model";

const AJIMO_SYNC_ID = "floryajimo-private-sync";
const MAX_MANIFEST_BYTES = 64 * 1024;

export function isCommunityPluginId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value) && value !== AJIMO_SYNC_ID;
}

function readPluginInfo(value: unknown): CommunityPluginInfo | undefined {
  if (typeof value !== "object" || !value || Array.isArray(value)) return undefined;
  const { id, name, isDesktopOnly } = value as Partial<CommunityPluginInfo>;
  if (!isCommunityPluginId(id) || typeof name !== "string" || !name.trim() || name.length > 256 ||
      typeof isDesktopOnly !== "boolean") return undefined;
  return { id, name: name.trim(), isDesktopOnly };
}

export async function readInstalledPlugin(adapter: DataAdapter, folder: string): Promise<CommunityPluginInfo | undefined> {
  const path = `${folder}/manifest.json`;
  const stat = await adapter.stat(path);
  if (stat?.type !== "file" || stat.size > MAX_MANIFEST_BYTES) return undefined;
  if ((await adapter.stat(`${folder}/main.js`))?.type !== "file") return undefined;

  let contents: string;
  try {
    contents = await adapter.read(path);
  } catch (error) {
    if (!(await adapter.stat(path))) return undefined; // The plugin may have been uninstalled during the scan.
    throw error;
  }
  try {
    return readPluginInfo(JSON.parse(contents));
  } catch {
    return undefined; // An incomplete manifest is not an installed plugin.
  }
}

export async function listInstalledPlugins(
  vault: Vault,
  includes?: (plugin: CommunityPluginInfo, folder: string) => boolean
): Promise<CommunityPluginInfo[]> {
  const { adapter } = vault;
  const directory = normalizePath(`${vault.configDir}/plugins`);
  if ((await adapter.stat(directory))?.type !== "folder") return [];
  const { folders } = await adapter.list(directory);
  const plugins = new Map<string, CommunityPluginInfo>();
  for (const folder of folders.sort()) {
    if (!folder.startsWith(`${directory}/`)) continue;
    const name = folder.slice(directory.length + 1);
    if (!name || name === "." || name === ".." || name === AJIMO_SYNC_ID || /[/\\:\u0000-\u001f]/.test(name)) continue;

    const plugin = await readInstalledPlugin(adapter, folder);
    if (plugin && (!includes || includes(plugin, name)) && !plugins.has(plugin.id)) plugins.set(plugin.id, plugin);
  }
  return [...plugins.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
}

export async function reconcilePluginLists(
  vault: Vault,
  settings: Pick<PrivateSyncSettings, "deviceId" | "syncPluginList">,
  manifest: RemoteManifest
): Promise<{ changed: boolean; comparison?: PluginComparison }> {
  const { deviceId } = settings;
  const index = manifest.pluginLists;
  const lists = index && typeof index === "object" && !Array.isArray(index) ? index : {};
  if (settings.syncPluginList !== true) {
    if (!Object.hasOwn(lists, deviceId)) return { changed: false };
    delete lists[deviceId];
    if (Object.keys(lists).length === 0) delete manifest.pluginLists;
    return { changed: true };
  }

  const installed = await listInstalledPlugins(vault);
  const installedIds = new Set(installed.map(plugin => plugin.id));
  const missing = new Map<string, CommunityPluginInfo>();
  let otherDevices = 0;
  for (const peer of Object.keys(lists).sort()) {
    const plugins = lists[peer];
    if (peer === deviceId || !Array.isArray(plugins)) continue;
    otherDevices += 1;
    for (const value of plugins) {
      const plugin = readPluginInfo(value);
      if (!plugin || installedIds.has(plugin.id) || missing.has(plugin.id) || (Platform.isMobile && plugin.isDesktopOnly)) continue;
      missing.set(plugin.id, plugin);
    }
  }

  const alreadyListed = Object.hasOwn(lists, deviceId) && JSON.stringify(lists[deviceId]) === JSON.stringify(installed);
  if (!alreadyListed) manifest.pluginLists = { ...lists, [deviceId]: installed };
  return {
    changed: !alreadyListed,
    comparison: { otherDevices, missing: [...missing.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) }
  };
}
