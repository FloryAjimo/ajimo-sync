import type { PrivateSyncData, SyncResult } from "../types/model";

function timestamp(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 8.64e15) return null;
  return new Date(value).toISOString();
}
function count(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
function resultCounts(result: SyncResult | undefined): object | null {
  if (!result) return null;
  return {
    uploaded: count(result.uploaded),
    downloaded: count(result.downloaded),
    deletedLocal: count(result.deletedLocal),
    deletedRemote: count(result.deletedRemote),
    conflicts: count(result.conflicts),
    unchanged: count(result.unchanged)
  };
}
function interval(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}

// Build an explicit allowlist. Never serialize settings/state wholesale:
// even error messages and entry names can contain tokens or private paths.
export function formatDiagnosticReport(data: PrivateSyncData, version: string): string {
  const { settings, state } = data;
  const required = ["serverUrl", "apiToken", "vaultId", "deviceId", "vaultKeyBase64"] as const;
  const missingSettings = required.filter(name => !settings[name]);
  return JSON.stringify({
    plugin: { id: "floryajimo-private-sync", version },
    configured: missingSettings.length === 0,
    missingSettings,
    autoSync: {
      enabled: Boolean(settings.autoSyncEnabled),
      paused: Boolean(settings.paused),
      onStartup: Boolean(settings.syncOnStartup),
      onResume: Boolean(settings.syncOnResume),
      onFileChange: Boolean(settings.syncOnFileChange),
      changeDelaySeconds: interval(settings.debounceSeconds, 5, 1, 120),
      periodicCheckMinutes: interval(settings.periodicSyncMinutes, 10, 0, 1440)
    },
    lastSync: {
      successfulAt: timestamp(state.lastSuccessfulSyncAt),
      hasError: Boolean(state.lastError),
      errorAt: timestamp(state.lastErrorAt),
      result: resultCounts(state.lastResult)
    }
  }, null, 2);
}
