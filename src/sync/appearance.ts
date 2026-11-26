import { parseConfigJson, type ConfigFiles } from "./config-files";

export const APPEARANCE_SETTINGS_PATH = "appearance.json";

interface AppearanceSelection {
  cssTheme: string;
  enabledCssSnippets: string[];
}

function readAppearanceSettings(text: string | undefined, path: string): Record<string, unknown> {
  const value = parseConfigJson(text, path);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Файл ${path} должен содержать объект настроек оформления.`);
  }
  return value as Record<string, unknown>;
}

function selectAppearance(settings: Record<string, unknown>, path: string, useDefaults: boolean): AppearanceSelection {
  const cssTheme = useDefaults ? settings.cssTheme ?? "" : settings.cssTheme;
  const enabledCssSnippets = useDefaults ? settings.enabledCssSnippets ?? [] : settings.enabledCssSnippets;
  if (typeof cssTheme !== "string" || !Array.isArray(enabledCssSnippets) ||
      !enabledCssSnippets.every(snippet => typeof snippet === "string")) {
    throw new Error(`Файл ${path} содержит некорректный выбор темы или сниппетов.`);
  }
  return { cssTheme, enabledCssSnippets };
}

export function readAppearanceSelection(text: string | undefined, path: string, useDefaults: boolean): AppearanceSelection {
  return selectAppearance(readAppearanceSettings(text, path), path, useDefaults);
}

export function mergeAppearanceSelection(text: string, path: string, expected: string, selection: AppearanceSelection): string | undefined {
  const settings = readAppearanceSettings(text, path);
  if (JSON.stringify(selectAppearance(settings, path, true)) !== expected) return undefined;
  return JSON.stringify({ ...settings, ...selection }, null, 2);
}

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

export async function listAppearancePaths(files: ConfigFiles): Promise<string[]> {
  const snippets = await files.list("snippets");
  const themes = await files.list("themes");
  const paths = [...snippets.files];
  for (const folder of themes.folders) {
    const name = folder.slice("themes/".length);
    if (name.includes("/") || !isPortableName(name)) continue;
    paths.push(...(await files.list(folder)).files);
  }
  return paths.filter(isAppearancePath);
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
