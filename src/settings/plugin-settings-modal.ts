import { App, Modal, Setting } from "obsidian";
import type PrivateSyncPlugin from "../main";
import { selectedPluginIds } from "../sync/plugin-settings";
import type { CommunityPluginInfo } from "../types/model";

export class PluginSettingsModal extends Modal {
  constructor(app: App, private readonly plugin: PrivateSyncPlugin, private readonly installed: CommunityPluginInfo[]) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Перенос настроек плагинов");
    this.contentEl.createEl("p", {
      text: "Настройки плагинов могут содержать токены и локальные пути. Включайте перенос только для тех плагинов, настройки которых хотите использовать на других устройствах."
    });

    const installedIds = new Set(this.installed.map(plugin => plugin.id));
    const selected = selectedPluginIds(this.plugin.data.settings.pluginSettingsIds);
    const unavailable = selected.filter(id => !installedIds.has(id));
    if (this.installed.length === 0 && unavailable.length === 0) {
      this.contentEl.createEl("p", { text: "На этом устройстве нет подходящих сторонних плагинов." });
    }

    for (const plugin of this.installed) {
      new Setting(this.contentEl).setName(plugin.name).setDesc(plugin.id).addToggle(toggle => toggle
        .setValue(selected.includes(plugin.id))
        .onChange(value => this.setSelected(plugin.id, value)));
    }
    for (const id of unavailable) {
      new Setting(this.contentEl).setName(id).setDesc("Недоступен на этом устройстве").addButton(button => button
        .setButtonText("Исключить")
        .onClick(async () => {
          await this.setSelected(id, false);
          this.contentEl.empty();
          this.onOpen();
        }));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async setSelected(id: string, value: boolean): Promise<void> {
    const next = new Set(selectedPluginIds(this.plugin.data.settings.pluginSettingsIds));
    if (value) next.add(id);
    else next.delete(id);
    this.plugin.data.settings.pluginSettingsIds = [...next].sort();
    await this.plugin.savePluginData();
  }
}
