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
import { AppearanceFiles, checkAppearanceNames, isAppearancePath } from "./appearance";

interface LocalFileSnapshot {
  file?: TFile;
  hash: string;
  mtime: number;
  size: number;
  version: number;
}

export class SyncEngine {
  private readonly localVersions = new Map<string, number>();
  private readonly appearance?: AppearanceFiles;

  constructor(
    private readonly app: App,
    private readonly settings: PrivateSyncSettings,
    private readonly state: PrivateSyncLocalState,
    private readonly persistState: () => Promise<void>
  ) {
    if (settings.syncAppearance === true) this.appearance = new AppearanceFiles(app.vault);
  }

  async sync(): Promise<SyncResult> {
    const stateBeforeSync = structuredClone(this.state);
    this.state.entries = Object.assign(Object.create(null), this.state.entries);
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
        await this.acceptManifest(manifest, remoteResponse.payload);
        manifest.entries = Object.assign(Object.create(null), manifest.entries);
      } else {
        if (this.state.manifestCheckpoint || this.state.manifestEtag || Object.keys(this.state.entries).length > 0) {
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

      if (await this.reconcileEntries(manifest.entries, this.state.entries, local, api, result)) {
        manifestDirty = true;
      }
      if (this.appearance && await this.syncAppearance(manifest, api, result, this.appearance)) {
        manifestDirty = true;
      }

      if (manifestDirty) {
        if (manifest.generation >= Number.MAX_SAFE_INTEGER - 1) throw new Error("Manifest generation limit reached.");
        manifest.generation += 1;
        const encrypted = await encryptJson(manifest, this.settings.vaultKeyBase64);
        const digest = await sha256Hex(encrypted);
        const etag = await api.putManifest(encrypted, remoteResponse.etag);
        this.state.manifestEtag = etag;
        this.state.manifestCheckpoint = { generation: manifest.generation, digest };
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
      if (stateBeforeSync.appearance) this.state.appearance = stateBeforeSync.appearance;
      else delete this.state.appearance;
      for (const path of this.localVersions.keys()) this.invalidateCachedStat(path);
      throw error;
    } finally {
      for (const event of events) this.app.vault.offref(event);
    }
  }

  private async syncAppearance(manifest: RemoteManifest, api: SyncApiClient, result: SyncResult, appearance: AppearanceFiles): Promise<boolean> {
    const entries: RemoteManifest["entries"] = Object.assign(Object.create(null), manifest.appearanceEntries);
    const paths = await appearance.listPaths();
    checkAppearanceNames([...paths, ...Object.keys(entries).filter(isAppearancePath)]);

    const previousEntries: Record<string, LocalEntryState> = Object.assign(Object.create(null), this.appearanceHistory());
    this.state.appearance = { configDir: appearance.configDir, entries: previousEntries };
    const local: Record<string, LocalFileSnapshot> = Object.create(null);
    for (const path of paths) {
      // Hidden files do not have reliable Vault change events. Rehash on every run.
      local[path] = (await this.readAppearanceFile(appearance, appearance.fullPath(path))).snapshot;
    }

    if (!await this.reconcileEntries(entries, previousEntries, local, api, result, appearance)) return false;
    manifest.appearanceEntries = entries;
    return true;
  }

  private appearanceHistory(): Record<string, LocalEntryState> | undefined {
    if (this.appearance && this.state.appearance?.configDir === this.appearance.configDir) {
      return this.state.appearance.entries;
    }
    return undefined;
  }

  private async reconcileEntries(
    entries: RemoteManifest["entries"],
    previousEntries: Record<string, LocalEntryState>,
    local: Record<string, LocalFileSnapshot>,
    api: SyncApiClient,
    result: SyncResult,
    appearance?: AppearanceFiles
  ): Promise<boolean> {
    let manifestDirty = false;
    const paths = new Set<string>([
      ...Object.keys(local),
      ...Object.keys(entries),
      ...Object.keys(previousEntries)
    ]);

    for (const path of Array.from(paths).sort()) {
      if (appearance ? !isAppearancePath(path) : this.isExcludedPath(path)) continue;
      const filePath = appearance ? appearance.fullPath(path) : path;
      const localFile = local[path];
      const remote = entries[path];
      const previous = previousEntries[path];

      if (!previous) {
        if (localFile && remote && !remote.deleted) {
          if (remote.contentHash === localFile.hash) {
            this.recordState(previousEntries, path, localFile, remote.revision, false);
            result.unchanged += 1;
          } else {
            await this.resolveContentConflict(filePath, localFile, remote, api);
            this.recordRemoteState(previousEntries, path, remote);
            result.conflicts += 1;
          }
        } else if (localFile && remote?.deleted) {
          await this.preserveConflictCopy(filePath, localFile);
          await this.deletePathIfExists(filePath, localFile);
          previousEntries[path] = { remoteRevision: remote.revision, remoteDeleted: true };
          result.conflicts += 1;
          result.deletedLocal += 1;
        } else if (localFile && !remote) {
          await this.uploadLocal(path, filePath, localFile, 0, entries, previousEntries, api);
          manifestDirty = true;
          result.uploaded += 1;
        } else if (!localFile && remote && !remote.deleted) {
          await this.applyRemoteFile(filePath, remote, api, localFile);
          this.recordRemoteState(previousEntries, path, remote);
          result.downloaded += 1;
        } else if (remote?.deleted) {
          previousEntries[path] = {
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
        if (localFile && remote) this.recordState(previousEntries, path, localFile, remote.revision, remote.deleted);
        result.unchanged += 1;
        continue;
      }

      if (localChanged && remoteChanged) {
        if (localFile && remote && !remote.deleted && localFile.hash === remote.contentHash) {
          this.recordState(previousEntries, path, localFile, remote.revision, false);
          result.unchanged += 1;
          continue;
        }

        if (remote?.deleted) {
          if (localFile) {
            await this.preserveConflictCopy(filePath, localFile);
            await this.deletePathIfExists(filePath, localFile);
          }
          previousEntries[path] = { remoteRevision: remote.revision, remoteDeleted: true };
          result.conflicts += 1;
          result.deletedLocal += 1;
          continue;
        }

        if (remote && !remote.deleted) {
          if (localFile) await this.preserveConflictCopy(filePath, localFile);
          await this.applyRemoteFile(filePath, remote, api, localFile);
          this.recordRemoteState(previousEntries, path, remote);
          result.conflicts += 1;
          result.downloaded += 1;
          continue;
        }
      }

      if (localChanged) {
        if (localFile) {
          await this.uploadLocal(path, filePath, localFile, remote?.revision ?? previous.remoteRevision ?? 0, entries, previousEntries, api);
          manifestDirty = true;
          result.uploaded += 1;
        } else {
          await this.readExpectedLocal(filePath, undefined);
          const nextRevision = (remote?.revision ?? previous.remoteRevision ?? 0) + 1;
          entries[path] = {
            path,
            revision: nextRevision,
            deleted: true,
            updatedBy: this.settings.deviceId,
            updatedAt: Date.now()
          };
          previousEntries[path] = { remoteRevision: nextRevision, remoteDeleted: true };
          manifestDirty = true;
          result.deletedRemote += 1;
        }
        continue;
      }

      if (remoteChanged && remote) {
        if (remote.deleted) {
          await this.deletePathIfExists(filePath, localFile);
          previousEntries[path] = { remoteRevision: remote.revision, remoteDeleted: true };
          result.deletedLocal += 1;
        } else {
          await this.applyRemoteFile(filePath, remote, api, localFile);
          this.recordRemoteState(previousEntries, path, remote);
          result.downloaded += 1;
        }
      }
    }
    return manifestDirty;
  }

  private validateSettings(): void {
    if (!this.settings.serverUrl || !this.settings.apiToken || !this.settings.vaultId || !this.settings.deviceId || !this.settings.vaultKeyBase64) {
      throw new Error("Ajimo Sync is not configured. Open plugin settings first.");
    }
  }

  private validateManifest(manifest: RemoteManifest): void {
    if (manifest?.schemaVersion !== 1) throw new Error("Unsupported remote manifest schema.");
    if (manifest.vaultId !== this.settings.vaultId) throw new Error("Vault ID does not match the encrypted manifest.");
    if (!Number.isSafeInteger(manifest.generation) || manifest.generation < 1 || manifest.generation >= Number.MAX_SAFE_INTEGER ||
        !manifest.entries || typeof manifest.entries !== "object" || Array.isArray(manifest.entries)) {
      throw new Error("Invalid remote manifest.");
    }
    this.validateEntries(manifest.entries, manifest.generation);
    if (this.appearance && manifest.appearanceEntries !== undefined) {
      const entries = manifest.appearanceEntries;
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("Invalid appearance index.");
      this.validateEntries(entries, manifest.generation, true);
    }
  }

  private validateEntries(entries: RemoteManifest["entries"], generation: number, appearance = false): void {
    const hash = /^[a-f0-9]{64}$/;
    for (const [path, entry] of Object.entries(entries)) {
      if (appearance && !isAppearancePath(path)) continue;
      if (!this.isRelativeVaultPath(path) || !entry || path !== entry.path ||
          !Number.isSafeInteger(entry.revision) || entry.revision < 1 || entry.revision > generation ||
          typeof entry.deleted !== "boolean" ||
          (!entry.deleted && (!hash.test(entry.objectId ?? "") || !hash.test(entry.contentHash ?? "") ||
            !Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0))) {
        throw new Error("Invalid file entry in the remote manifest.");
      }
    }
  }

  private async acceptManifest(manifest: RemoteManifest, payload: ArrayBuffer): Promise<void> {
    const digest = await sha256Hex(payload);
    const checkpoint = this.state.manifestCheckpoint;
    if (checkpoint && (manifest.generation < checkpoint.generation ||
        (manifest.generation === checkpoint.generation && digest !== checkpoint.digest))) {
      throw new Error("Сервер вернул более старый или несовместимый манифест. Проверьте сервер и резервную копию. Файлы не изменены.");
    }
    // Upgrades from versions without a checkpoint can still compare known file revisions.
    this.checkEntryHistory(this.state.entries, manifest.entries, path => !this.isExcludedPath(path));
    const appearanceHistory = this.appearanceHistory();
    if (appearanceHistory) this.checkEntryHistory(appearanceHistory, manifest.appearanceEntries ?? {}, isAppearancePath);
    if (checkpoint?.digest === digest) return;

    // Save the authenticated version before applying it. A later error can leave some files changed.
    this.state.manifestCheckpoint = { generation: manifest.generation, digest };
    try {
      await this.persistState();
    } catch (error) {
      if (checkpoint) this.state.manifestCheckpoint = checkpoint;
      else delete this.state.manifestCheckpoint;
      throw error;
    }
  }

  private checkEntryHistory(
    history: Record<string, LocalEntryState>,
    entries: RemoteManifest["entries"],
    includes: (path: string) => boolean
  ): void {
    for (const [path, previous] of Object.entries(history)) {
      if (!includes(path) || previous.remoteRevision === undefined) continue;
      const remote = Object.hasOwn(entries, path) ? entries[path] : undefined;
      if (!remote || remote.revision < previous.remoteRevision ||
          (remote.revision === previous.remoteRevision && previous.remoteDeleted !== undefined && remote.deleted !== previous.remoteDeleted)) {
        throw new Error("Сервер вернул более старую историю файлов. Проверьте сервер и резервную копию. Файлы не изменены.");
      }
    }
  }

  private isRelativeVaultPath(path: string): boolean {
    return path.length > 0 && !/[\\:\u0000-\u001f]/.test(path) &&
      path.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
  }

  private isExcludedPath(path: string): boolean {
    const configDir = normalizePath(this.app.vault.configDir).normalize("NFC").toLowerCase();
    path = path.normalize("NFC").toLowerCase();
    return path === configDir || path.startsWith(configDir + "/") || path.startsWith(".trash/") || path === ".trash";
  }

  private async scanLocalFiles(): Promise<Record<string, LocalFileSnapshot>> {
    const result: Record<string, LocalFileSnapshot> = Object.create(null);
    for (const file of this.app.vault.getFiles()) {
      if (this.isExcludedPath(file.path)) continue;
      if (!this.isRelativeVaultPath(file.path)) throw new Error(`Unsupported vault path: ${file.path}`);
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
    filePath: string,
    local: LocalFileSnapshot,
    baseRevision: number,
    entries: RemoteManifest["entries"],
    previousEntries: Record<string, LocalEntryState>,
    api: SyncApiClient
  ): Promise<void> {
    const appearance = this.appearance;
    let content;
    if (appearance?.contains(filePath)) {
      content = await this.readAppearanceFile(appearance, filePath);
      if (content.snapshot.hash !== local.hash) throw this.localChangedError(filePath);
    } else {
      this.assertSnapshotCurrent(filePath, local);
      content = await this.readLocalFile(filePath);
    }
    const { bytes, snapshot } = content;
    const encrypted = await encryptEnvelope(bytes, this.settings.vaultKeyBase64, "object");
    const objectId = await sha256Hex(encrypted);
    await api.putObject(objectId, encrypted);
    const revision = baseRevision + 1;
    entries[path] = {
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
    this.recordState(previousEntries, path, snapshot, revision, false);
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
    const appearance = this.appearance;
    if (appearance?.contains(path)) {
      await appearance.ensureParentFolders(path);
      const current = await this.readExpectedLocal(path, local);
      const remoteText = this.decodeText(plain);
      const localText = current && this.decodeText(current.bytes);
      if (remoteText !== undefined && localText !== undefined) {
        await appearance.adapter.process(path, (content) => {
          if (content !== localText) throw this.localChangedError(path);
          return remoteText;
        });
      } else {
        await appearance.adapter.writeBinary(path, plain);
      }
      return;
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
    const appearance = this.appearance;
    if (appearance?.contains(path)) {
      const conflictPath = this.makeConflictPath(appearance.conflictPath(path));
      await appearance.ensureParentFolders(conflictPath);
      if (await appearance.adapter.exists(conflictPath)) throw new Error(`Conflict copy already exists: ${conflictPath}`);
      const current = await this.readExpectedLocal(path, local);
      if (!current) throw this.localChangedError(path);
      await appearance.adapter.writeBinary(conflictPath, current.bytes);
      return;
    }
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
    const appearance = this.appearance;
    if (appearance?.contains(path)) {
      if (local) await appearance.adapter.trashLocal(path);
      return;
    }
    this.assertSnapshotCurrent(path, local);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.fileManager.trashFile(existing);
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

  private recordState(entries: Record<string, LocalEntryState>, path: string, local: LocalFileSnapshot, remoteRevision: number, remoteDeleted: boolean): void {
    const cacheStat = local.file && local.version === this.localVersion(path);
    entries[path] = {
      localHash: local.hash,
      localMtime: cacheStat ? local.mtime : undefined,
      localSize: cacheStat ? local.size : undefined,
      remoteRevision,
      remoteDeleted
    };
  }

  private recordRemoteState(entries: Record<string, LocalEntryState>, path: string, remote: RemoteManifest["entries"][string]): void {
    // Record the bytes we applied, not a later local edit that may arrive after the write.
    entries[path] = {
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
    if (!snapshot.file || current !== snapshot.file || snapshot.file.path !== path ||
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

  private async readAppearanceFile(appearance: AppearanceFiles, path: string): Promise<{ bytes: ArrayBuffer; snapshot: LocalFileSnapshot }> {
    const stat = await appearance.adapter.stat(path);
    if (stat?.type !== "file") throw this.localChangedError(path);
    const bytes = await appearance.adapter.readBinary(path);
    const hash = await sha256Hex(bytes);
    const after = await appearance.adapter.stat(path);
    if (after?.type !== "file" || after.mtime !== stat.mtime || after.size !== stat.size || bytes.byteLength !== stat.size) {
      throw this.localChangedError(path);
    }
    return { bytes, snapshot: { hash, mtime: stat.mtime, size: stat.size, version: 0 } };
  }

  private async readExpectedLocal(
    path: string,
    expected: LocalFileSnapshot | undefined
  ): Promise<{ bytes: ArrayBuffer; snapshot: LocalFileSnapshot } | undefined> {
    const appearance = this.appearance;
    if (appearance?.contains(path)) {
      if (!expected) {
        if (await appearance.adapter.stat(path)) throw this.localChangedError(path);
        return undefined;
      }
      const current = await this.readAppearanceFile(appearance, path);
      if (current.snapshot.hash !== expected.hash) throw this.localChangedError(path);
      return current;
    }
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
