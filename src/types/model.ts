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
}

export interface LocalEntryState {
  localHash?: string;
  localMtime?: number;
  localSize?: number;
  remoteRevision?: number;
  remoteDeleted?: boolean;
}

export interface PrivateSyncLocalState {
  manifestEtag?: string;
  entries: Record<string, LocalEntryState>;
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
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  unchanged: number;
}
