import { Client } from "minio";

/**
 * Object storage (MinIO/S3) для immutable raw-снапшотів: HTML, скріншоти, PDF.
 * Ключі — детерміновані: `<sourceId>/<sha>/<name>`, тому один і той самий контент
 * не дублюється, а будь-який етап обробки можна переграти зі снапшота (replay).
 */
export class ObjectStore {
  private client: Client;
  constructor(
    private bucket = process.env.S3_BUCKET_SNAPSHOTS ?? "snapshots",
    endpoint = process.env.S3_ENDPOINT ?? "http://localhost:9000",
  ) {
    const url = new URL(endpoint);
    this.client = new Client({
      endPoint: url.hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      useSSL: url.protocol === "https:",
      accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
      secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
    });
  }

  async ensureBucket(): Promise<void> {
    if (!(await this.client.bucketExists(this.bucket).catch(() => false))) {
      await this.client.makeBucket(this.bucket);
    }
  }

  async putText(key: string, body: string, contentType = "text/html"): Promise<string> {
    await this.client.putObject(this.bucket, key, body, Buffer.byteLength(body), {
      "Content-Type": contentType,
    });
    return key;
  }

  async putBytes(key: string, bytes: Uint8Array, contentType = "application/octet-stream"): Promise<string> {
    const buf = Buffer.from(bytes);
    await this.client.putObject(this.bucket, key, buf, buf.length, { "Content-Type": contentType });
    return key;
  }

  async getText(key: string): Promise<string> {
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
}
