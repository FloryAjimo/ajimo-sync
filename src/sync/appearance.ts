import type { ConfigFiles } from "./config-files";

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
