/** Pluggable storage backend for binary assets (images, video, audio, PDF, etc.). */
export interface StorageProvider {
  /** One-time setup (create directories, verify credentials, etc.). */
  init(): Promise<void>;

  /** Store data under the given key. Returns the key for retrieval. */
  put(key: string, data: Uint8Array, mime: string): Promise<string>;

  /** Retrieve stored data by key. Returns null if not found. */
  get(key: string): Promise<{ data: Uint8Array; mime: string } | null>;

  /** Delete stored data by key. Returns true if deleted. */
  delete(key: string): Promise<boolean>;

  /** Resolve a key to a URL path suitable for HTTP serving. */
  resolve(key: string): string;
}
