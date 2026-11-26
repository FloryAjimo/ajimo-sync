export const HOTKEYS_PATH = "hotkeys.json";

function isHotkey(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { key, modifiers } = value as { key?: unknown; modifiers?: unknown };
  return typeof key === "string" && key.length > 0 && Array.isArray(modifiers) &&
    modifiers.every(modifier => typeof modifier === "string");
}

export function checkHotkeys(value: unknown, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Object.values(value).every(hotkeys => Array.isArray(hotkeys) && hotkeys.every(isHotkey))) {
    throw new Error(`Файл ${path} не соответствует формату горячих клавиш Obsidian.`);
  }
}
