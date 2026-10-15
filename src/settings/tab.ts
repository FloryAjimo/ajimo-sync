import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { formatDiagnosticReport } from "../diagnostics/report";
import { DiagnosticReportModal } from "../diagnostics/modal";
import type PrivateSyncPlugin from "../main";
import { generateVaultKeyBase64 } from "../crypto/crypto";

export class PrivateSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: PrivateSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", { cls: "private-sync-version", text: `Версия плагина: ${this.plugin.manifest.version}` });
    containerEl.createEl("p", {
      text: "Сервер хранит только зашифрованный манифест и зашифрованные файлы. Ключ Vault остаётся только на ваших устройствах."
    });

    new Setting(containerEl)
      .setName("URL сервера")
      .setDesc("HTTPS-адрес вашего Ajimo Sync сервера.")
      .addText((text) => text
        .setPlaceholder("https://sync.example.com")
        .setValue(this.plugin.data.settings.serverUrl)
        .onChange(async (value) => {
          this.plugin.data.settings.serverUrl = value.trim();
          await this.plugin.savePluginData();
          this.plugin.reconfigureAutoSync();
        }));

    new Setting(containerEl)
      .setName("API-токен")
      .setDesc("Токен авторизации на сервере. Это не ключ шифрования.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.data.settings.apiToken).onChange(async (value) => {
          this.plugin.data.settings.apiToken = value;
          await this.plugin.savePluginData();
          this.plugin.reconfigureAutoSync();
        });
      });

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("Одинаковый идентификатор должен использоваться на всех устройствах этого хранилища.")
      .addText((text) => text
        .setValue(this.plugin.data.settings.vaultId)
        .onChange(async (value) => {
          this.plugin.data.settings.vaultId = value.trim();
          await this.plugin.savePluginData();
          this.plugin.reconfigureAutoSync();
        }))
      .addButton((button) => button.setButtonText("Сгенерировать").onClick(async () => {
        this.plugin.data.settings.vaultId = crypto.randomUUID();
        await this.plugin.savePluginData();
        this.plugin.reconfigureAutoSync();
        this.display();
      }));

    new Setting(containerEl)
      .setName("Device ID")
      .setDesc("Уникальный ID этого устройства. Не используйте один Device ID на двух устройствах.")
      .addText((text) => text
        .setValue(this.plugin.data.settings.deviceId)
        .onChange(async (value) => {
          this.plugin.data.settings.deviceId = value.trim();
          await this.plugin.savePluginData();
        }))
      .addButton((button) => button.setButtonText("Пересоздать").onClick(async () => {
        this.plugin.data.settings.deviceId = crypto.randomUUID();
        await this.plugin.savePluginData();
        this.display();
      }));

    new Setting(containerEl)
      .setName("Имя устройства")
      .setDesc("Используется в именах конфликтных копий и диагностике.")
      .addText((text) => text
        .setPlaceholder("home-pc")
        .setValue(this.plugin.data.settings.deviceName)
        .onChange(async (value) => {
          this.plugin.data.settings.deviceName = value.trim();
          await this.plugin.savePluginData();
        }));

    const keySetting = new Setting(containerEl)
      .setName("Ключ шифрования Vault")
      .setDesc("32-байтовый ключ в Base64. Его нужно безопасно перенести на остальные устройства. На сервер он не отправляется.");

    keySetting.settingEl.addClass("private-sync-secret");
    keySetting.addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("Сгенерируйте ключ")
        .setValue(this.plugin.data.settings.vaultKeyBase64)
        .onChange(async (value) => {
          this.plugin.data.settings.vaultKeyBase64 = value.trim();
          await this.plugin.savePluginData();
          this.plugin.reconfigureAutoSync();
        });

      keySetting.addButton((button) => {
        button.setButtonText("Показать")
          .setTooltip("Показать или скрыть ключ шифрования")
          .onClick(() => {
            const visible = text.inputEl.type === "password";
            text.inputEl.type = visible ? "text" : "password";
            button.setButtonText(visible ? "Скрыть" : "Показать");
            button.buttonEl.setAttribute("aria-pressed", String(visible));
          });
        button.buttonEl.setAttribute("aria-pressed", "false");
      });

      keySetting.addButton((button) => button
        .setButtonText("Копировать")
        .setTooltip("Скопировать ключ шифрования в буфер обмена")
        .onClick(async () => {
          const key = this.plugin.data.settings.vaultKeyBase64;
          if (!key) {
            new Notice("Сначала сгенерируйте или вставьте ключ шифрования.");
            return;
          }

          button.setDisabled(true);
          try {
            const clipboard = text.inputEl.ownerDocument.defaultView?.navigator.clipboard;
            if (!clipboard) {
              new Notice("Буфер обмена недоступен. Нажмите «Показать» и скопируйте ключ вручную.");
              return;
            }
            await clipboard.writeText(key);
            new Notice("Ключ шифрования скопирован.");
          } catch {
            new Notice("Не удалось скопировать ключ. Нажмите «Показать» и скопируйте его вручную.");
          } finally {
            button.setDisabled(false);
          }
        }));
    }).addButton((button) => button.setButtonText("Сгенерировать").setWarning().onClick(async () => {
      if (this.plugin.data.settings.vaultKeyBase64) {
        new Notice("Ключ уже существует. Для его замены сначала очистите поле вручную.");
        return;
      }

      this.plugin.data.settings.vaultKeyBase64 = generateVaultKeyBase64();
      await this.plugin.savePluginData();
      this.plugin.reconfigureAutoSync();
      new Notice("Ключ создан. Обязательно сохраните его отдельно перед подключением второго устройства.");
      this.display();
    }));

    containerEl.createDiv({
      cls: "private-sync-warning",
      text: "Не меняйте ключ после загрузки данных на сервер. В v0.2 ротация ключей ещё не реализована."
    });

    new Setting(containerEl).setName("Автоматическая синхронизация").setHeading();

    new Setting(containerEl)
      .setName("Включить автосинхронизацию")
      .setDesc("По умолчанию после обновления выключена. Сначала рекомендуется выполнить одну ручную синхронизацию.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.settings.autoSyncEnabled)
        .onChange(async (value) => {
          this.plugin.data.settings.autoSyncEnabled = value;
          await this.plugin.savePluginData();
          this.plugin.reconfigureAutoSync();
        }));

    new Setting(containerEl)
      .setName("Синхронизировать при запуске")
      .setDesc("После открытия Obsidian выполнить автоматическую проверку изменений.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.settings.syncOnStartup)
        .onChange(async (value) => {
          this.plugin.data.settings.syncOnStartup = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Синхронизировать при возврате")
      .setDesc("Проверять изменения после возвращения в Obsidian из другого приложения или после разблокировки телефона.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.settings.syncOnResume)
        .onChange(async (value) => {
          this.plugin.data.settings.syncOnResume = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("После изменения файлов")
      .setDesc("Автоматически запускать синхронизацию после создания, изменения, переименования или удаления файла.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.settings.syncOnFileChange)
        .onChange(async (value) => {
          this.plugin.data.settings.syncOnFileChange = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Задержка после изменения, секунд")
      .setDesc("Позволяет объединить серию быстрых изменений в одну синхронизацию. Допустимо от 1 до 120 секунд.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.max = "120";
        text.setValue(String(this.plugin.data.settings.debounceSeconds))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
              this.plugin.data.settings.debounceSeconds = Math.max(1, Math.min(120, Math.round(parsed)));
              await this.plugin.savePluginData();
            }
          });
      });

    new Setting(containerEl)
      .setName("Периодическая проверка, минут")
      .setDesc("Резервная проверка удалённых изменений. 0 отключает периодическую синхронизацию.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.max = "1440";
        text.setValue(String(this.plugin.data.settings.periodicSyncMinutes))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
              this.plugin.data.settings.periodicSyncMinutes = Math.max(0, Math.min(1440, Math.round(parsed)));
              await this.plugin.savePluginData();
              this.plugin.reconfigureAutoSync();
            }
          });
      });

    new Setting(containerEl)
      .setName("Пауза")
      .setDesc("Временно остановить только автоматические запуски. Ручная синхронизация остаётся доступной.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.settings.paused)
        .onChange(async (value) => {
          await this.plugin.setPaused(value);
          this.display();
        }));

    new Setting(containerEl).setName("Проверка").setHeading();

    new Setting(containerEl)
      .setName("Проверить соединение")
      .setDesc("Проверяет URL и API-токен без синхронизации файлов.")
      .addButton((button) => button.setButtonText("Проверить").onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.testConnection();
          new Notice("Ajimo Sync: сервер доступен.");
        } catch (error) {
          new Notice(`Ajimo Sync: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          button.setDisabled(false);
        }
      }));

    new Setting(containerEl)
      .setName("Синхронизировать сейчас")
      .setDesc("Ручной запуск работает даже при паузе автосинхронизации.")
      .addButton((button) => button.setCta().setButtonText("Запустить").onClick(async () => {
        await this.plugin.syncNow({ reason: "настройки" });
        this.display();
      }));

    new Setting(containerEl)
      .setName("Диагностический отчёт")
      .setDesc("Версия и состояние синхронизации без URL сервера, токена, ключа и имён файлов. Можно просмотреть и скопировать.")
      .addButton(button => button.setButtonText("Открыть").onClick(() => {
        const report = formatDiagnosticReport(this.plugin.data, this.plugin.manifest.version);
        new DiagnosticReportModal(this.app, report).open();
      }));

    const state = this.plugin.data.state;
    const statusLines: string[] = [];
    if (state.lastSuccessfulSyncAt) {
      statusLines.push(`Последняя успешная синхронизация: ${new Date(state.lastSuccessfulSyncAt).toLocaleString("ru-RU")}`);
    } else {
      statusLines.push("Успешных синхронизаций пока не было.");
    }

    if (state.lastResult) {
      statusLines.push(
        `Последний результат: ↑${state.lastResult.uploaded} ↓${state.lastResult.downloaded}, конфликтов: ${state.lastResult.conflicts}.`
      );
    }

    if (state.lastError) {
      statusLines.push(`Последняя ошибка: ${state.lastError}`);
    }

    containerEl.createDiv({
      cls: "private-sync-status",
      text: statusLines.join("\n")
    });
  }
}
