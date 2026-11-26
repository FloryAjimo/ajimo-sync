import { Platform, type Vault } from "obsidian";
import type { ConfigFiles } from "./config-files";
import { isCommunityPluginId, listInstalledPlugins, readInstalledPlugin } from "./plugin-list";

function isPluginSettingsId(value: unknown): value is string {
  return isCommunityPluginId(value) && value !== "private-sync" &&
    !/^(?:con|prn|aux|nul|(?:com|lpt)[1-9])$/.test(value);
}

export function selectedPluginIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(isPluginSettingsId))].sort() : [];
}

export function listConfigurablePlugins(vault: Vault) {
  return listInstalledPlugins(vault, (plugin, folder) =>
    plugin.id === folder && isPluginSettingsId(folder) && (!Platform.isMobile || !plugin.isDesktopOnly));
}

export async function isPluginSettingsInstalled(files: ConfigFiles, path: string): Promise<boolean> {
  const parts = path.split("/");
  const id = parts[1];
  if (parts.length !== 3 || parts[0] !== "plugins" || parts[2] !== "data.json" || !isPluginSettingsId(id)) return false;
  const plugin = await readInstalledPlugin(files.adapter, files.fullPath(`plugins/${id}`));
  return plugin?.id === id && (!Platform.isMobile || !plugin.isDesktopOnly);
}

export async function listSelectedSettingsPaths(files: ConfigFiles, selected: unknown): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const id of selectedPluginIds(selected)) {
    const path = `plugins/${id}/data.json`;
    if (await isPluginSettingsInstalled(files, path)) paths.add(path);
  }
  return paths;
}

export function checkPluginSettingsJson(text: string | undefined, path: string): void {
  try {
    if (text !== undefined) {
      JSON.parse(text.replace(/^\uFEFF/, ""));
      return;
    }
  } catch {
    // Report only the file path. Settings may include credentials.
  }
  throw new Error(`Файл настроек ${path} должен содержать корректный JSON в UTF-8.`);
}
