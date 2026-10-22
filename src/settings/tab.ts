import { App, Notice, PluginSettingTab, Setting, requireApiVersion, type SettingDefinitionBase } from "obsidian";
import { formatDiagnosticReport } from "../diagnostics/report";
import { DiagnosticReportModal } from "../diagnostics/modal";
import type PrivateSyncPlugin from "../main";
import { generateVaultKeyBase64 } from "../crypto/crypto";

interface SyncSettingRow extends SettingDefinitionBase {
  render(setting: Setting): void;
}

interface SyncSettingGroup {
  type: "group";
  heading: string;
  items: SyncSettingRow[];
}

export class PrivateSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: PrivateSyncPlugin
  ) {
    super(app, plugin);
  }

  getSettingDefinitions(): (SyncSettingRow | SyncSettingGroup)[] {
    return [
      {
        name: "Версия плагина",
        desc: this.plugin.manifest.version,
        searchable: false,
        render: (setting) => {
          setting.settingEl.addClass("private-sync-version");
        }
      },
      {
        name: "Шифрование",
        desc: "Сервер хранит только зашифрованный манифест и зашифрованные файлы. Ключ Vault остаётся только на ваших устройствах.",
        searchable: false,
        render: () => {}
      },
      {
        name: "URL сервера",
        desc: "HTTPS-адрес вашего Ajimo Sync сервера.",
        render: (setting) => {
          setting.addText((text) =>
            text
              .setPlaceholder("https://sync.example.com")
              .setValue(this.plugin.data.settings.serverUrl)
              .onChange(async (value) => {
                this.plugin.data.settings.serverUrl = value.trim();
                await this.plugin.savePluginData();
                this.plugin.reconfigureAutoSync();
              })
          );
        }
      },
      {
        name: "API-токен",
        desc: "Токен авторизации на сервере. Это не ключ шифрования.",
        render: (setting) => {
          setting.addText((text) => {
            text.inputEl.type = "password";
            text.setValue(this.plugin.data.settings.apiToken).onChange(async (value) => {
              this.plugin.data.settings.apiToken = value;
              await this.plugin.savePluginData();
              this.plugin.reconfigureAutoSync();
            });
          });
        }
      },
      {
        name: "Vault ID",
        desc: "Одинаковый идентификатор должен использоваться на всех устройствах этого хранилища.",
        render: (setting) => {
          setting
            .addText((text) =>
              text.setValue(this.plugin.data.settings.vaultId).onChange(async (value) => {
                this.plugin.data.settings.vaultId = value.trim();
                await this.plugin.savePluginData();
                this.plugin.reconfigureAutoSync();
              })
            )
            .addButton((button) =>
              button.setButtonText("Сгенерировать").onClick(async () => {
                this.plugin.data.settings.vaultId = crypto.randomUUID();
                await this.plugin.savePluginData();
                this.plugin.reconfigureAutoSync();
                this.refreshSettings();
              })
            );
        }
      },
      {
        name: "Device ID",
        desc: "Уникальный ID этого устройства. Не используйте один Device ID на двух устройствах.",
        render: (setting) => {
          setting
            .addText((text) =>
              text.setValue(this.plugin.data.settings.deviceId).onChange(async (value) => {
                this.plugin.data.settings.deviceId = value.trim();
                await this.plugin.savePluginData();
              })
            )
            .addButton((button) =>
              button.setButtonText("Пересоздать").onClick(async () => {
                this.plugin.data.settings.deviceId = crypto.randomUUID();
                await this.plugin.savePluginData();
                this.refreshSettings();
              })
            );
        }
      },
      {
        name: "Имя устройства",
        desc: "Используется в именах конфликтных копий и диагностике.",
        render: (setting) => {
          setting.addText((text) =>
            text
              .setPlaceholder("home-pc")
              .setValue(this.plugin.data.settings.deviceName)
              .onChange(async (value) => {
                this.plugin.data.settings.deviceName = value.trim();
                await this.plugin.savePluginData();
              })
          );
        }
      },
      {
        name: "Ключ шифрования Vault",
        desc: "32-байтовый ключ в Base64. Его нужно безопасно перенести на остальные устройства. На сервер он не отправляется.",
        render: (setting) => {
          setting.settingEl.addClass("private-sync-secret");
          setting
            .addText((text) => {
              text.inputEl.type = "password";
              text
                .setPlaceholder("Сгенерируйте ключ")
                .setValue(this.plugin.data.settings.vaultKeyBase64)
                .onChange(async (value) => {
                  this.plugin.data.settings.vaultKeyBase64 = value.trim();
                  await this.plugin.savePluginData();
                  this.plugin.reconfigureAutoSync();
                });

              setting.addButton((button) => {
                button
                  .setButtonText("Показать")
                  .setTooltip("Показать или скрыть ключ шифрования")
                  .onClick(() => {
                    const visible = text.inputEl.type === "password";
                    text.inputEl.type = visible ? "text" : "password";
                    button.setButtonText(visible ? "Скрыть" : "Показать");
                    button.buttonEl.setAttribute("aria-pressed", String(visible));
                  });
                button.buttonEl.setAttribute("aria-pressed", "false");
              });

              setting.addButton((button) =>
                button
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
                  })
              );
            })
            .addButton((button) =>
              button.setButtonText("Сгенерировать").onClick(async () => {
                if (this.plugin.data.settings.vaultKeyBase64) {
                  new Notice("Ключ уже существует. Для его замены сначала очистите поле вручную.");
                  return;
                }

                this.plugin.data.settings.vaultKeyBase64 = generateVaultKeyBase64();
                await this.plugin.savePluginData();
                this.plugin.reconfigureAutoSync();
                new Notice("Ключ создан. Обязательно сохраните его отдельно перед подключением второго устройства.");
                this.refreshSettings();
              })
            );
        }
      },
      {
        name: "Смена ключа",
        desc: "Не меняйте ключ после загрузки данных на сервер. В v0.2 ротация ключей ещё не реализована.",
        searchable: false,
        render: (setting) => {
          setting.settingEl.addClass("private-sync-warning");
        }
      },
      {
        type: "group",
        heading: "Автоматическая синхронизация",
        items: [
          {
            name: "Включить автосинхронизацию",
            desc: "По умолчанию после обновления выключена. Сначала рекомендуется выполнить одну ручную синхронизацию.",
            render: (setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.plugin.data.settings.autoSyncEnabled).onChange(async (value) => {
                  this.plugin.data.settings.autoSyncEnabled = value;
                  await this.plugin.savePluginData();
                  this.plugin.reconfigureAutoSync();
                })
              );
            }
          },
          {
            name: "Синхронизировать при запуске",
            desc: "После открытия Obsidian выполнить автоматическую проверку изменений.",
            render: (setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.plugin.data.settings.syncOnStartup).onChange(async (value) => {
                  this.plugin.data.settings.syncOnStartup = value;
                  await this.plugin.savePluginData();
                })
              );
            }
          },
          {
            name: "Синхронизировать при возврате",
            desc: "Проверять изменения после возвращения в Obsidian из другого приложения или после разблокировки телефона.",
            render: (setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.plugin.data.settings.syncOnResume).onChange(async (value) => {
                  this.plugin.data.settings.syncOnResume = value;
                  await this.plugin.savePluginData();
                })
              );
            }
          },
          {
            name: "После изменения файлов",
            desc: "Автоматически запускать синхронизацию после создания, изменения, переименования или удаления файла.",
            render: (setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.plugin.data.settings.syncOnFileChange).onChange(async (value) => {
                  this.plugin.data.settings.syncOnFileChange = value;
                  await this.plugin.savePluginData();
                })
              );
            }
          },
          {
            name: "Задержка после изменения, секунд",
            desc: "Позволяет объединить серию быстрых изменений в одну синхронизацию. Допустимо от 1 до 120 секунд.",
            render: (setting) => {
              setting.addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "1";
                text.inputEl.max = "120";
                text.setValue(String(this.plugin.data.settings.debounceSeconds)).onChange(async (value) => {
                  const parsed = Number(value);
                  if (Number.isFinite(parsed)) {
                    this.plugin.data.settings.debounceSeconds = Math.max(1, Math.min(120, Math.round(parsed)));
                    await this.plugin.savePluginData();
                  }
                });
              });
            }
          },
          {
            name: "Периодическая проверка, минут",
            desc: "Резервная проверка удалённых изменений. 0 отключает периодическую синхронизацию.",
            render: (setting) => {
              setting.addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.inputEl.max = "1440";
                text.setValue(String(this.plugin.data.settings.periodicSyncMinutes)).onChange(async (value) => {
                  const parsed = Number(value);
                  if (Number.isFinite(parsed)) {
                    this.plugin.data.settings.periodicSyncMinutes = Math.max(0, Math.min(1440, Math.round(parsed)));
                    await this.plugin.savePluginData();
                    this.plugin.reconfigureAutoSync();
                  }
                });
              });
            }
          },
          {
            name: "Пауза",
            desc: "Временно остановить только автоматические запуски. Ручная синхронизация остаётся доступной.",
            render: (setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.plugin.data.settings.paused).onChange(async (value) => {
                  await this.plugin.setPaused(value);
                  this.refreshSettings();
                })
              );
            }
          }
        ]
      },
      {
        type: "group",
        heading: "Проверка",
        items: [
          {
            name: "Проверить соединение",
            desc: "Проверяет URL и API-токен без синхронизации файлов.",
            render: (setting) => {
              setting.addButton((button) =>
                button.setButtonText("Проверить").onClick(async () => {
                  button.setDisabled(true);
                  try {
                    await this.plugin.testConnection();
                    new Notice("Ajimo Sync: сервер доступен.");
                  } catch (error) {
                    new Notice(`Ajimo Sync: ${error instanceof Error ? error.message : String(error)}`);
                  } finally {
                    button.setDisabled(false);
                  }
                })
              );
            }
          },
          {
            name: "Синхронизировать сейчас",
            desc: "Ручной запуск работает даже при паузе автосинхронизации.",
            render: (setting) => {
              setting.addButton((button) =>
                button
                  .setCta()
                  .setButtonText("Запустить")
                  .onClick(async () => {
                    await this.plugin.syncNow({ reason: "настройки" });
                    this.refreshSettings();
                  })
              );
            }
          },
          {
            name: "Диагностический отчёт",
            desc: "Версия и состояние синхронизации без URL сервера, токена, ключа и имён файлов. Можно просмотреть и скопировать.",
            render: (setting) => {
              setting.addButton((button) =>
                button.setButtonText("Открыть").onClick(() => {
                  const report = formatDiagnosticReport(this.plugin.data, this.plugin.manifest.version);
                  new DiagnosticReportModal(this.app, report).open();
                })
              );
            }
          },
          {
            name: "Состояние синхронизации",
            searchable: false,
            render: (setting) => {
              setting.settingEl.addClass("private-sync-status");
              setting.setDesc(this.syncStatusDescription());
            }
          }
        ]
      }
    ];
  }

  // Obsidian < 1.13 calls display(); newer versions render the same definitions.
  display(): void {
    this.renderLegacySettings();
  }

  private refreshSettings(): void {
    if (requireApiVersion("1.13.0")) {
      this.update();
    } else {
      this.renderLegacySettings();
    }
  }

  private renderLegacySettings(): void {
    this.containerEl.empty();
    for (const item of this.getSettingDefinitions()) {
      if ("type" in item) {
        new Setting(this.containerEl).setName(item.heading).setHeading();
        for (const definition of item.items) this.renderLegacyRow(definition);
      } else {
        this.renderLegacyRow(item);
      }
    }
  }

  private renderLegacyRow(definition: SyncSettingRow): void {
    const setting = new Setting(this.containerEl).setName(definition.name);
    if (definition.desc) setting.setDesc(definition.desc);
    // Our row renderers use only Setting, so both API paths share handlers.
    definition.render(setting);
  }

  private syncStatusDescription(): string {
    const state = this.plugin.data.state;
    const statusLines: string[] = [];
    if (state.lastSuccessfulSyncAt) {
      statusLines.push(
        `Последняя успешная синхронизация: ${new Date(state.lastSuccessfulSyncAt).toLocaleString("ru-RU")}`
      );
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

    return statusLines.join("\n");
  }
}
