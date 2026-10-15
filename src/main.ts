import { Notice, Plugin } from "obsidian";
import { SyncApiClient } from "./api/client";
import { PrivateSyncSettingTab } from "./settings/tab";
import { SyncEngine } from "./sync/engine";
import type { PrivateSyncData, SyncResult } from "./types/model";

type SyncStatus = "not-configured" | "paused" | "idle" | "syncing" | "synced" | "conflict" | "error";

interface SyncOptions {
  silent?: boolean;
  automatic?: boolean;
  reason?: string;
}

const DEFAULT_DATA: PrivateSyncData = {
  settings: {
    serverUrl: "",
    apiToken: "",
    vaultId: "",
    deviceId: "",
    deviceName: "",
    vaultKeyBase64: "",
    autoSyncEnabled: false,
    syncOnStartup: true,
    syncOnResume: true,
    syncOnFileChange: true,
    debounceSeconds: 5,
    periodicSyncMinutes: 10,
    paused: false
  },
  state: {
    entries: {}
  }
};

export default class PrivateSyncPlugin extends Plugin {
  data: PrivateSyncData = structuredClone(DEFAULT_DATA);

  private syncing = false;
  private pendingAutoSync = false;
  private debounceTimer: number | null = null;
  private periodicTimer: number | null = null;
  private statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    if (!this.data.settings.deviceId) {
      this.data.settings.deviceId = crypto.randomUUID();
      await this.savePluginData();
    }

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("private-sync-statusbar");
    this.statusBarEl.addEventListener("click", () => void this.syncNow({ reason: "статус-бар" }));

    this.addSettingTab(new PrivateSyncSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Ajimo Sync: синхронизировать сейчас", () => {
      void this.syncNow({ reason: "кнопка" });
    });

    this.addCommand({
      id: "sync-now",
      name: "Синхронизировать сейчас",
      callback: () => void this.syncNow({ reason: "команда" })
    });

    this.addCommand({
      id: "toggle-auto-sync-pause",
      name: "Приостановить/возобновить автосинхронизацию",
      callback: () => void this.setPaused(!this.data.settings.paused)
    });

    this.addCommand({
      id: "test-connection",
      name: "Проверить соединение с сервером",
      callback: () => void this.testConnection().then(
        () => new Notice("Ajimo Sync: сервер доступен."),
        (error: unknown) => new Notice(`Ajimo Sync: ${this.errorMessage(error)}`)
      )
    });

    this.registerEvent(this.app.vault.on("create", () => this.onVaultChanged()));
    this.registerEvent(this.app.vault.on("modify", () => this.onVaultChanged()));
    this.registerEvent(this.app.vault.on("delete", () => this.onVaultChanged()));
    this.registerEvent(this.app.vault.on("rename", () => this.onVaultChanged()));

    this.registerDomEvent(document, "visibilitychange", () => {
      if (
        document.visibilityState === "visible" &&
        this.data.settings.syncOnResume
      ) {
        this.scheduleAutoSync("возврат в приложение", 750);
      }
    });

    this.app.workspace.onLayoutReady(() => {
      this.reconfigureAutoSync();
      this.refreshStatusFromState();

      if (this.data.settings.syncOnStartup) {
        this.scheduleAutoSync("запуск Obsidian", 1200);
      }
    });
  }

  onunload(): void {
    this.clearDebounceTimer();
    this.clearPeriodicTimer();
  }

  async loadPluginData(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<PrivateSyncData> | null;
    this.data = {
      settings: {
        ...DEFAULT_DATA.settings,
        ...(loaded?.settings ?? {})
      },
      state: {
        ...DEFAULT_DATA.state,
        ...(loaded?.state ?? {}),
        entries: loaded?.state?.entries ?? {}
      }
    };
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }

  isConfigured(): boolean {
    const { serverUrl, apiToken, vaultId, deviceId, vaultKeyBase64 } = this.data.settings;
    return Boolean(serverUrl && apiToken && vaultId && deviceId && vaultKeyBase64);
  }

  async testConnection(): Promise<void> {
    const { serverUrl, apiToken, vaultId } = this.data.settings;
    if (!serverUrl || !apiToken || !vaultId) {
      throw new Error("нужно заполнить URL сервера, API-токен и Vault ID");
    }
    const client = new SyncApiClient(serverUrl, apiToken, vaultId);
    await client.health();
  }

  async setPaused(paused: boolean): Promise<void> {
    this.data.settings.paused = paused;
    await this.savePluginData();

    if (paused) {
      this.clearDebounceTimer();
      this.clearPeriodicTimer();
      this.setStatus("paused");
      new Notice("Ajimo Sync: автосинхронизация приостановлена.");
      return;
    }

    this.reconfigureAutoSync();
    this.refreshStatusFromState();
    new Notice("Ajimo Sync: автосинхронизация возобновлена.");
    this.scheduleAutoSync("возобновление", 500);
  }

  reconfigureAutoSync(): void {
    this.clearPeriodicTimer();

    if (!this.canAutoSync()) {
      this.refreshStatusFromState();
      return;
    }

    const minutes = this.normalizedPeriodicMinutes();
    if (minutes > 0) {
      this.periodicTimer = window.setInterval(() => {
        this.scheduleAutoSync("периодическая проверка", 0);
      }, minutes * 60_000);
      this.registerInterval(this.periodicTimer);
    }

    this.refreshStatusFromState();
  }

  async syncNow(options: SyncOptions = {}): Promise<void> {
    if (options.automatic && !this.canAutoSync()) {
      return;
    }

    if (!this.isConfigured()) {
      this.setStatus("not-configured");
      if (!options.silent) {
        new Notice("Ajimo Sync: сначала заполните настройки подключения и шифрования.");
      }
      return;
    }

    if (this.syncing) {
      if (options.automatic) {
        this.pendingAutoSync = true;
      } else if (!options.silent) {
        new Notice("Ajimo Sync: синхронизация уже выполняется.");
      }
      return;
    }

    this.clearDebounceTimer();
    this.syncing = true;
    this.setStatus("syncing", options.reason);

    if (!options.silent) {
      new Notice("Ajimo Sync: синхронизация запущена.");
    }

    try {
      const engine = new SyncEngine(
        this.app,
        this.data.settings,
        this.data.state,
        () => this.savePluginData()
      );

      const result = await engine.sync();
      await this.recordSuccessfulSync(result);

      if (result.conflicts > 0) {
        this.setStatus("conflict", `конфликтов: ${result.conflicts}`);
      } else {
        this.setStatus("synced");
      }

      if (!options.silent || result.conflicts > 0) {
        new Notice(
          `Ajimo Sync: готово. ↑${result.uploaded} ↓${result.downloaded}, конфликтов: ${result.conflicts}, удалений: ${result.deletedLocal + result.deletedRemote}.`,
          result.conflicts > 0 ? 10_000 : 6_000
        );
      }
    } catch (error) {
      console.error("Ajimo Sync failed", error);
      const message = this.errorMessage(error);
      this.data.state.lastError = message;
      this.data.state.lastErrorAt = Date.now();
      await this.savePluginData();
      this.setStatus("error", message);

      if (!options.silent) {
        new Notice(`Ajimo Sync: ошибка — ${message}`, 10_000);
      }
    } finally {
      this.syncing = false;

      if (this.pendingAutoSync) {
        this.pendingAutoSync = false;
        if (this.canAutoSync()) {
          this.scheduleAutoSync("изменения во время синхронизации", 1000);
        }
      }
    }
  }

  private onVaultChanged(): void {
    if (!this.data.settings.syncOnFileChange) return;

    if (this.syncing) {
      this.pendingAutoSync = true;
      return;
    }

    this.scheduleAutoSync("изменение файлов");
  }

  private scheduleAutoSync(reason: string, delayMs?: number): void {
    if (!this.canAutoSync()) return;

    if (this.syncing) {
      this.pendingAutoSync = true;
      return;
    }

    this.clearDebounceTimer();

    const delay = delayMs ?? this.normalizedDebounceSeconds() * 1000;
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow({
        silent: true,
        automatic: true,
        reason
      });
    }, Math.max(0, delay));
  }

  private canAutoSync(): boolean {
    return this.data.settings.autoSyncEnabled && !this.data.settings.paused && this.isConfigured();
  }

  private normalizedDebounceSeconds(): number {
    const value = Number(this.data.settings.debounceSeconds);
    if (!Number.isFinite(value)) return 5;
    return Math.max(1, Math.min(120, Math.round(value)));
  }

  private normalizedPeriodicMinutes(): number {
    const value = Number(this.data.settings.periodicSyncMinutes);
    if (!Number.isFinite(value)) return 10;
    return Math.max(0, Math.min(1440, Math.round(value)));
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearPeriodicTimer(): void {
    if (this.periodicTimer !== null) {
      window.clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  private async recordSuccessfulSync(result: SyncResult): Promise<void> {
    this.data.state.lastSuccessfulSyncAt = Date.now();
    this.data.state.lastResult = result;
    this.data.state.lastError = undefined;
    this.data.state.lastErrorAt = undefined;
    await this.savePluginData();
  }

  private refreshStatusFromState(): void {
    if (!this.isConfigured()) {
      this.setStatus("not-configured");
      return;
    }

    if (this.data.settings.paused) {
      this.setStatus("paused");
      return;
    }

    if (this.data.state.lastResult?.conflicts) {
      this.setStatus("conflict", `конфликтов: ${this.data.state.lastResult.conflicts}`);
      return;
    }

    if (this.data.state.lastError && this.data.state.lastErrorAt) {
      const lastSuccess = this.data.state.lastSuccessfulSyncAt ?? 0;
      if (this.data.state.lastErrorAt > lastSuccess) {
        this.setStatus("error", this.data.state.lastError);
        return;
      }
    }

    if (this.data.state.lastSuccessfulSyncAt) {
      this.setStatus("synced");
      return;
    }

    this.setStatus("idle");
  }

  private setStatus(status: SyncStatus, detail?: string): void {
    if (!this.statusBarEl) return;

    const labels: Record<SyncStatus, string> = {
      "not-configured": "Ajimo Sync: не настроен",
      paused: "Ajimo Sync: пауза",
      idle: "Ajimo Sync: готов",
      syncing: "Ajimo Sync: синхронизация…",
      synced: "Ajimo Sync: синхронизировано",
      conflict: "Ajimo Sync: конфликт",
      error: "Ajimo Sync: ошибка"
    };

    this.statusBarEl.setText(labels[status]);
    this.statusBarEl.dataset.state = status;

    const details: string[] = [];
    if (detail) details.push(detail);
    if (this.data.state.lastSuccessfulSyncAt) {
      details.push(`Последняя успешная синхронизация: ${new Date(this.data.state.lastSuccessfulSyncAt).toLocaleString("ru-RU")}`);
    }
    if (status === "error" && this.data.state.lastError) {
      details.push(`Ошибка: ${this.data.state.lastError}`);
    }
    details.push("Нажмите для ручной синхронизации.");
    this.statusBarEl.setAttr("aria-label", details.join("\n"));
    this.statusBarEl.setAttr("title", details.join("\n"));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
