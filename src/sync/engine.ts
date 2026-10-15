import { App, normalizePath, TFile, type EventRef } from "obsidian";
import { SyncApiClient } from "../api/client";
import { decryptEnvelope, decryptJson, encryptEnvelope, encryptJson, sha256Hex } from "../crypto/crypto";
import type {
  LocalEntryState,
  PrivateSyncLocalState,
  PrivateSyncSettings,
  RemoteManifest,
  SyncResult
} from "../types/model";

interface LocalFileSnapshot {
  file: TFile;
  hash: string;
  mtime: number;
  size: number;
  version: number;
}

export class SyncEngine {
  private readonly localVersions = new Map<string, number>();

  constructor(
    private readonly app: App,
    private readonly settings: PrivateSyncSettings,
    private readonly state: PrivateSyncLocalState,
    private readonly persistState: () => Promise<void>
  ) {}

  async sync(): Promise<SyncResult> {
    const stateBeforeSync = structuredClone(this.state);
    this.localVersions.clear();
    const events = this.trackLocalChanges();
    try {
      this.validateSettings();
      const api = new SyncApiClient(this.settings.serverUrl, this.settings.apiToken, this.settings.vaultId);
      await api.health();

      const remoteResponse = await api.getManifest();
      let manifest: RemoteManifest;
      if (remoteResponse.exists) {
        if (!remoteResponse.payload) throw new Error("Remote manifest payload is empty.");
        manifest = await decryptJson<RemoteManifest>(remoteResponse.payload, this.settings.vaultKeyBase64);
        this.validateManifest(manifest);
      } else {
        if (this.state.manifestEtag || Object.keys(this.state.entries).length > 0) {
          throw new Error("Удалённый манифест ранее синхронизированного Vault отсутствует. Синхронизация остановлена; восстановите данные сервера из резервной копии.");
        }
        manifest = {
          schemaVersion: 1,
          vaultId: this.settings.vaultId,
          generation: 0,
          entries: {}
        };
      }

      const local = await this.scanLocalFiles();
      const result: SyncResult = {
        uploaded: 0,
        downloaded: 0,
        deletedLocal: 0,
        deletedRemote: 0,
        conflicts: 0,
        unchanged: 0
      };
      let manifestDirty = !remoteResponse.exists;

      const paths = new Set<string>([
        ...Object.keys(local),
        ...Object.keys(manifest.entries),
        ...Object.keys(this.state.entries)
      ]);

      for (const path of Array.from(paths).sort()) {
        if (this.isExcludedPath(path)) continue;
        const localFile = local[path];
        const remote = manifest.entries[path];
        const previous = this.state.entries[path];

        if (!previous) {
          if (localFile && remote && !remote.deleted) {
            if (remote.contentHash === localFile.hash) {
              this.recordState(path, localFile, remote.revision, false);
              result.unchanged += 1;
            } else {
              await this.resolveContentConflict(path, localFile, remote, api);
              this.recordRemoteState(path, remote);
              result.conflicts += 1;
            }
          } else if (localFile && remote?.deleted) {
            await this.preserveConflictCopy(path, localFile);
            await this.deletePathIfExists(path, localFile);
            this.state.entries[path] = { remoteRevision: remote.revision, remoteDeleted: true };
            result.conflicts += 1;
            result.deletedLocal += 1;
          } else if (localFile && !remote) {
            await this.uploadLocal(path, localFile, 0, manifest, api);
            manifestDirty = true;
            result.uploaded += 1;
          } else if (!localFile && remote && !remote.deleted) {
            await this.applyRemoteFile(path, remote, api, localFile);
            this.recordRemoteState(path, remote);
            result.downloaded += 1;
          } else if (remote?.deleted) {
            this.state.entries[path] = {
              remoteRevision: remote.revision,
              remoteDeleted: true
            };
            result.unchanged += 1;
          }
          continue;
        }

        const localChanged = this.hasLocalChanged(localFile, previous);
        const remoteChanged = this.hasRemoteChanged(remote, previous);

        if (!localChanged && !remoteChanged) {
          if (localFile && remote) this.recordState(path, localFile, remote.revision, remote.deleted);
          result.unchanged += 1;
          continue;
        }

        if (localChanged && remoteChanged) {
          if (localFile && remote && !remote.deleted && localFile.hash === remote.contentHash) {
            this.recordState(path, localFile, remote.revision, false);
            result.unchanged += 1;
            continue;
          }

          if (remote?.deleted) {
            if (localFile) {
              await this.preserveConflictCopy(path, localFile);
              await this.deletePathIfExists(path, localFile);
            }
            this.state.entries[path] = { remoteRevision: remote.revision, remoteDeleted: true };
            result.conflicts += 1;
            result.deletedLocal += 1;
            continue;
          }

          if (remote && !remote.deleted) {
            if (localFile) await this.preserveConflictCopy(path, localFile);
            await this.applyRemoteFile(path, remote, api, localFile);
            this.recordRemoteState(path, remote);
            result.conflicts += 1;
            result.downloaded += 1;
            continue;
          }
        }

        if (localChanged) {
          if (localFile) {
            await this.uploadLocal(path, localFile, remote?.revision ?? previous.remoteRevision ?? 0, manifest, api);
            manifestDirty = true;
            result.uploaded += 1;
          } else {
            this.assertSnapshotCurrent(path, undefined);
            const nextRevision = (remote?.revision ?? previous.remoteRevision ?? 0) + 1;
            manifest.entries[path] = {
              path,
              revision: nextRevision,
              deleted: true,
              updatedBy: this.settings.deviceId,
              updatedAt: Date.now()
            };
            this.state.entries[path] = { remoteRevision: nextRevision, remoteDeleted: true };
            manifestDirty = true;
            result.deletedRemote += 1;
          }
          continue;
        }

        if (remoteChanged && remote) {
          if (remote.deleted) {
            await this.deletePathIfExists(path, localFile);
            this.state.entries[path] = { remoteRevision: remote.revision, remoteDeleted: true };
            result.deletedLocal += 1;
          } else {
            await this.applyRemoteFile(path, remote, api, localFile);
            this.recordRemoteState(path, remote);
            result.downloaded += 1;
          }
        }
      }

      if (manifestDirty) {
        manifest.generation += 1;
        const encrypted = await encryptJson(manifest, this.settings.vaultKeyBase64);
        const etag = await api.putManifest(encrypted, remoteResponse.etag);
        this.state.manifestEtag = etag;
      } else {
        this.state.manifestEtag = remoteResponse.etag;
      }

      await this.persistState();
      return result;
    } catch (error) {
      if (stateBeforeSync.manifestEtag === undefined) {
        delete this.state.manifestEtag;
      } else {
        this.state.manifestEtag = stateBeforeSync.manifestEtag;
      }
      this.state.entries = stateBeforeSync.entries;
      for (const path of this.localVersions.keys()) this.invalidateCachedStat(path);
      throw error;
    } finally {
      for (const event of events) this.app.vault.offref(event);
    }
  }

  private validateSettings(): void {
    if (!this.settings.serverUrl || !this.settings.apiToken || !this.settings.vaultId || !this.settings.deviceId || !this.settings.vaultKeyBase64) {
      throw new Error("Ajimo Sync is not configured. Open plugin settings first.");
    }
  }

  private validateManifest(manifest: RemoteManifest): void {
    if (manifest.schemaVersion !== 1) throw new Error("Unsupported remote manifest schema.");
    if (manifest.vaultId !== this.settings.vaultId) throw new Error("Vault ID does not match the encrypted manifest.");
  }

  private isExcludedPath(path: string): boolean {
    const configDir = normalizePath(this.app.vault.configDir);
    return path === configDir || path.startsWith(configDir + "/") || path.startsWith(".trash/") || path === ".trash";
  }

  private async scanLocalFiles(): Promise<Record<string, LocalFileSnapshot>> {
    const result: Record<string, LocalFileSnapshot> = {};
    for (const file of this.app.vault.getFiles()) {
      if (this.isExcludedPath(file.path)) continue;
      const previous = this.state.entries[file.path];
      if (previous?.localHash && previous.localMtime === file.stat.mtime && previous.localSize === file.stat.size) {
        result[file.path] = {
          file,
          hash: previous.localHash,
          mtime: file.stat.mtime,
          size: file.stat.size,
          version: this.localVersion(file.path)
        };
      } else {
        const { snapshot } = await this.readLocalFile(file.path);
        result[file.path] = snapshot;
      }
    }
    return result;
  }

  private hasLocalChanged(local: LocalFileSnapshot | undefined, previous: LocalEntryState): boolean {
    if (!local) return previous.localHash !== undefined;
    return local.hash !== previous.localHash;
  }

  private hasRemoteChanged(remote: RemoteManifest["entries"][string] | undefined, previous: LocalEntryState): boolean {
    if (!remote) return false;
    return remote.revision !== previous.remoteRevision || remote.deleted !== previous.remoteDeleted;
  }

  private async uploadLocal(
    path: string,
    local: LocalFileSnapshot,
    baseRevision: number,
    manifest: RemoteManifest,
    api: SyncApiClient
  ): Promise<void> {
    this.assertSnapshotCurrent(path, local);
    const { bytes, snapshot } = await this.readLocalFile(path);
    const encrypted = await encryptEnvelope(bytes, this.settings.vaultKeyBase64, "object");
    const objectId = await sha256Hex(encrypted);
    await api.putObject(objectId, encrypted);
    const revision = baseRevision + 1;
    manifest.entries[path] = {
      path,
      revision,
      objectId,
      contentHash: snapshot.hash,
      size: bytes.byteLength,
      modifiedAt: snapshot.mtime,
      deleted: false,
      updatedBy: this.settings.deviceId,
      updatedAt: Date.now()
    };
    this.recordState(path, snapshot, revision, false);
  }

  private async applyRemoteFile(
    path: string,
    remote: RemoteManifest["entries"][string],
    api: SyncApiClient,
    local: LocalFileSnapshot | undefined
  ): Promise<void> {
    if (!remote.objectId || !remote.contentHash) throw new Error(`Remote entry ${path} has no object metadata.`);
    const encrypted = await api.getObject(remote.objectId);
    if (await sha256Hex(encrypted) !== remote.objectId) {
      throw new Error(`Object integrity check failed for ${path}.`);
    }
    const plain = await decryptEnvelope(encrypted, this.settings.vaultKeyBase64, "object");
    if (await sha256Hex(plain) !== remote.contentHash) {
      throw new Error(`Decrypted content hash mismatch for ${path}.`);
    }
    const current = await this.readExpectedLocal(path, local);
    await this.ensureParentFolders(path);
    this.assertSnapshotCurrent(path, local);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile && current) {
      const remoteText = path.toLowerCase().endsWith(".md") ? this.decodeText(plain) : undefined;
      const localText = remoteText !== undefined ? this.decodeText(current.bytes) : undefined;
      if (remoteText !== undefined && localText !== undefined) {
        await this.app.vault.process(existing, (content) => {
          this.assertSnapshotCurrent(path, local);
          if (content !== localText) throw this.localChangedError(path);
          return remoteText;
        });
      } else {
        // Obsidian has no atomic binary process API; check again after all asynchronous work.
        await this.app.vault.modifyBinary(existing, plain);
      }
    } else if (!existing) {
      await this.app.vault.createBinary(path, plain);
    } else {
      throw new Error(`Cannot write ${path}: a folder exists at this path.`);
    }
  }

  private async resolveContentConflict(
    path: string,
    local: LocalFileSnapshot,
    remote: RemoteManifest["entries"][string],
    api: SyncApiClient
  ): Promise<void> {
    await this.preserveConflictCopy(path, local);
    await this.applyRemoteFile(path, remote, api, local);
  }

  private async preserveConflictCopy(path: string, local: LocalFileSnapshot): Promise<void> {
    const current = await this.readExpectedLocal(path, local);
    if (!current) throw this.localChangedError(path);
    const conflictPath = this.makeConflictPath(path);
    await this.ensureParentFolders(conflictPath);
    this.assertSnapshotCurrent(path, local);
    await this.app.vault.createBinary(conflictPath, current.bytes);
  }

  private makeConflictPath(path: string): string {
    const dot = path.lastIndexOf(".");
    const deviceLabel = (this.settings.deviceName || this.settings.deviceId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
    const suffix = `${deviceLabel}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    if (dot > path.lastIndexOf("/")) {
      return normalizePath(`${path.slice(0, dot)}.sync-conflict-${suffix}${path.slice(dot)}`);
    }
    return normalizePath(`${path}.sync-conflict-${suffix}`);
  }

  private async deletePathIfExists(path: string, local: LocalFileSnapshot | undefined): Promise<void> {
    await this.readExpectedLocal(path, local);
    this.assertSnapshotCurrent(path, local);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.trash(existing, false);
    }
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const parent = normalizePath(path.substring(0, path.lastIndexOf("/")));
    if (!parent || parent === "/") return;
    const parts = parent.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private recordState(path: string, local: LocalFileSnapshot, remoteRevision: number, remoteDeleted: boolean): void {
    this.state.entries[path] = {
      localHash: local.hash,
      localMtime: local.version === this.localVersion(path) ? local.mtime : undefined,
      localSize: local.version === this.localVersion(path) ? local.size : undefined,
      remoteRevision,
      remoteDeleted
    };
  }

  private recordRemoteState(path: string, remote: RemoteManifest["entries"][string]): void {
    // Record the bytes we applied, not a later local edit that may arrive after the write.
    this.state.entries[path] = {
      localHash: remote.contentHash,
      remoteRevision: remote.revision,
      remoteDeleted: false
    };
  }

  private trackLocalChanges(): EventRef[] {
    const vault = this.app.vault;
    return [
      vault.on("create", (file) => this.markLocalChanged(file.path)),
      vault.on("modify", (file) => this.markLocalChanged(file.path)),
      vault.on("delete", (file) => this.markLocalChanged(file.path)),
      vault.on("rename", (file, oldPath) => {
        this.markLocalChanged(oldPath);
        this.markLocalChanged(file.path);
      })
    ];
  }

  private localVersion(path: string): number {
    return this.localVersions.get(path) ?? 0;
  }

  private markLocalChanged(path: string): void {
    this.localVersions.set(path, this.localVersion(path) + 1);
    this.invalidateCachedStat(path);
  }

  private invalidateCachedStat(path: string): void {
    const entry = this.state.entries[path];
    if (entry) {
      delete entry.localMtime;
      delete entry.localSize;
    }
  }

  private localChangedError(path: string): Error {
    return new Error(`Файл ${path} изменился во время синхронизации. Локальные изменения сохранены; повторите синхронизацию.`);
  }

  private assertSnapshotCurrent(path: string, snapshot: LocalFileSnapshot | undefined): void {
    const current = this.app.vault.getAbstractFileByPath(path);
    if (!snapshot) {
      if (current) throw this.localChangedError(path);
      return;
    }
    if (current !== snapshot.file || snapshot.file.path !== path ||
      snapshot.version !== this.localVersion(path) ||
      snapshot.mtime !== snapshot.file.stat.mtime || snapshot.size !== snapshot.file.stat.size) {
      throw this.localChangedError(path);
    }
  }

  private async readLocalFile(path: string): Promise<{ bytes: ArrayBuffer; snapshot: LocalFileSnapshot }> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw this.localChangedError(path);
    const snapshot: LocalFileSnapshot = {
      file,
      hash: "",
      mtime: file.stat.mtime,
      size: file.stat.size,
      version: this.localVersion(path)
    };
    const bytes = await this.app.vault.readBinary(file);
    snapshot.hash = await sha256Hex(bytes);
    this.assertSnapshotCurrent(path, snapshot);
    if (bytes.byteLength !== snapshot.size) throw this.localChangedError(path);
    return { bytes, snapshot };
  }

  private async readExpectedLocal(
    path: string,
    expected: LocalFileSnapshot | undefined
  ): Promise<{ bytes: ArrayBuffer; snapshot: LocalFileSnapshot } | undefined> {
    this.assertSnapshotCurrent(path, expected);
    if (!expected) return undefined;
    const current = await this.readLocalFile(path);
    if (current.snapshot.hash !== expected.hash) throw this.localChangedError(path);
    this.assertSnapshotCurrent(path, expected);
    return current;
  }

  private decodeText(bytes: ArrayBuffer): string | undefined {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }
}
