export interface PrivateSyncSettings {
  serverUrl: string;
  apiToken: string;
  vaultId: string;
  deviceId: string;
  deviceName: string;
  vaultKeyBase64: string;
  autoSyncEnabled: boolean;
  syncOnStartup: boolean;
  syncOnResume: boolean;
  syncOnFileChange: boolean;
  debounceSeconds: number;
  periodicSyncMinutes: number;
  paused: boolean;
  syncAppearance: boolean;
  syncAppearanceSelection: boolean;
  syncHotkeys: boolean;
  syncPluginList: boolean;
  pluginSettingsIds: string[];
}

export interface CommunityPluginInfo {
  id: string;
  name: string;
  isDesktopOnly: boolean;
}

export interface PluginComparison {
  otherDevices: number;
  missing: CommunityPluginInfo[];
}

export interface LocalEntryState {
  localHash?: string;
  localMtime?: number;
  localSize?: number;
  remoteRevision?: number;
  remoteDeleted?: boolean;
}

export interface ConfigEntryState {
  configDir: string;
  entries: Record<string, LocalEntryState>;
}

export interface PrivateSyncLocalState {
  manifestEtag?: string;
  manifestCheckpoint?: { generation: number; digest: string };
  entries: Record<string, LocalEntryState>;
  appearance?: ConfigEntryState;
  appearanceSelection?: ConfigEntryState;
  hotkeys?: ConfigEntryState;
  pluginSettings?: ConfigEntryState;
  pluginComparison?: PluginComparison;
  lastSuccessfulSyncAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  lastResult?: SyncResult;
}

export interface PrivateSyncData {
  settings: PrivateSyncSettings;
  state: PrivateSyncLocalState;
}

export interface ManifestEntry {
  path: string;
  revision: number;
  objectId?: string;
  contentHash?: string;
  size?: number;
  modifiedAt?: number;
  deleted: boolean;
  updatedBy: string;
  updatedAt: number;
}

export interface RemoteManifest {
  schemaVersion: 1;
  vaultId: string;
  generation: number;
  entries: Record<string, ManifestEntry>;
  appearanceEntries?: Record<string, ManifestEntry>;
  appearanceSelectionEntries?: Record<string, ManifestEntry>;
  hotkeyEntries?: Record<string, ManifestEntry>;
  pluginLists?: Record<string, CommunityPluginInfo[]>;
  pluginSettingsEntries?: Record<string, ManifestEntry>;
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  unchanged: number;
}
