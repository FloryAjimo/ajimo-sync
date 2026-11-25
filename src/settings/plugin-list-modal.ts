import { App, Modal } from "obsidian";
import { isCommunityPluginId } from "../sync/plugin-list";
import type { PluginComparison } from "../types/model";

export class PluginListModal extends Modal {
  constructor(app: App, private readonly comparison: PluginComparison | undefined) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Недостающие плагины");
    if (!this.comparison) {
      this.contentEl.createEl("p", { text: "Запустите синхронизацию, чтобы получить списки устройств." });
      return;
    }
    if (this.comparison.otherDevices === 0) {
      this.contentEl.createEl("p", { text: "Включите обмен списком хотя бы на одном другом устройстве и синхронизируйте оба устройства." });
      return;
    }
    if (this.comparison.missing.length === 0) {
      this.contentEl.createEl("p", { text: "По последней синхронизации все подходящие плагины уже есть на этом устройстве." });
      return;
    }

    this.contentEl.createEl("p", { text: "Эти плагины найдены на других устройствах. Откройте нужный плагин в каталоге, чтобы проверить совместимость и установить его вручную." });
    const list = this.contentEl.createEl("ul");
    for (const plugin of this.comparison.missing) {
      if (!isCommunityPluginId(plugin.id)) continue;
      list.createEl("li").createEl("a", {
        text: `${plugin.name} (${plugin.id})`,
        href: `https://community.obsidian.md/plugins/${encodeURIComponent(plugin.id)}`,
        cls: "external-link",
        attr: { target: "_blank", rel: "noopener noreferrer" }
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
