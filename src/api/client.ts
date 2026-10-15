import { requestUrl } from "obsidian";

export interface ManifestResponse {
  exists: boolean;
  etag?: string;
  payload?: ArrayBuffer;
}

export class SyncApiClient {
  constructor(
    private readonly serverUrl: string,
    private readonly apiToken: string,
    private readonly vaultId: string
  ) {}

  private baseUrl(): string {
    const url = new URL(this.serverUrl);
    const isLocalHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !isLocalHttp) {
      throw new Error("Ajimo Sync требует HTTPS. HTTP разрешён только для localhost.");
    }
    return this.serverUrl.replace(/\/+$/, "");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      ...extra
    };
  }

  async health(): Promise<void> {
    const response = await requestUrl({
      url: `${this.baseUrl()}/health`,
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status !== 200) {
      throw new Error(`Server health check failed with HTTP ${response.status}.`);
    }
  }

  async getManifest(): Promise<ManifestResponse> {
    const response = await requestUrl({
      url: `${this.baseUrl()}/v1/vaults/${encodeURIComponent(this.vaultId)}/manifest`,
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status === 404) {
      return { exists: false };
    }
    if (response.status !== 200) {
      throw new Error(`Cannot read remote manifest: HTTP ${response.status}.`);
    }
    return {
      exists: true,
      etag: response.headers.etag ?? response.headers.ETag,
      payload: response.arrayBuffer
    };
  }

  async putManifest(payload: ArrayBuffer, baseEtag?: string): Promise<string> {
    const response = await requestUrl({
      url: `${this.baseUrl()}/v1/vaults/${encodeURIComponent(this.vaultId)}/manifest`,
      method: "PUT",
      headers: this.headers({
        "Content-Type": "application/octet-stream",
        "X-Private-Sync-Base-Etag": baseEtag ?? "none"
      }),
      body: payload,
      throw: false
    });
    if (response.status === 409) {
      throw new Error("Remote manifest changed during synchronization. Run Sync again.");
    }
    if (response.status !== 200) {
      throw new Error(`Cannot update remote manifest: HTTP ${response.status}.`);
    }
    const body = response.json as { etag?: string };
    if (!body.etag) {
      throw new Error("Server returned no manifest ETag.");
    }
    return body.etag;
  }

  async putObject(objectId: string, payload: ArrayBuffer): Promise<void> {
    const response = await requestUrl({
      url: `${this.baseUrl()}/v1/vaults/${encodeURIComponent(this.vaultId)}/objects/${objectId}`,
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/octet-stream" }),
      body: payload,
      throw: false
    });
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`Cannot upload object ${objectId}: HTTP ${response.status}.`);
    }
  }

  async getObject(objectId: string): Promise<ArrayBuffer> {
    const response = await requestUrl({
      url: `${this.baseUrl()}/v1/vaults/${encodeURIComponent(this.vaultId)}/objects/${objectId}`,
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status !== 200) {
      throw new Error(`Cannot download object ${objectId}: HTTP ${response.status}.`);
    }
    return response.arrayBuffer;
  }
}
