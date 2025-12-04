import { Storage } from "@google-cloud/storage";
import { randomUUID } from "crypto";
import logger from "../utils/logger";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const storageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class MediaStorage {
  private static bucketName: string | null = null;
  private static baseUrl: string | null = null;

  static initialize(): boolean {
    const mediaDir = process.env.MEDIA_STORAGE_DIR || "";
    if (!mediaDir) {
      logger.warn("MEDIA_STORAGE_DIR not set - media storage disabled");
      return false;
    }

    const parts = mediaDir.replace(/^\//, "").split("/");
    this.bucketName = parts[0];
    this.baseUrl = process.env.REPLIT_DEV_DOMAIN 
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.BASE_URL || "http://localhost:5000";

    logger.info({ bucketName: this.bucketName }, "MediaStorage initialized");
    return true;
  }

  static isEnabled(): boolean {
    return this.bucketName !== null;
  }

  static async storeMedia(
    buffer: Buffer,
    mimetype: string,
    instanceId: string
  ): Promise<{ url: string; path: string } | null> {
    if (!this.bucketName) {
      return null;
    }

    try {
      const extension = this.getExtension(mimetype);
      const fileName = `${randomUUID()}${extension}`;
      const objectPath = `whatsapp-media/${instanceId}/${fileName}`;

      const bucket = storageClient.bucket(this.bucketName);
      const file = bucket.file(objectPath);

      await file.save(buffer, {
        contentType: mimetype,
        metadata: {
          cacheControl: "public, max-age=31536000",
        },
      });

      const publicUrl = `${this.baseUrl}/media/${instanceId}/${fileName}`;

      logger.info({ path: objectPath, url: publicUrl }, "Media stored successfully");

      return {
        url: publicUrl,
        path: objectPath,
      };
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to store media");
      return null;
    }
  }

  static async getMedia(instanceId: string, fileName: string): Promise<{ buffer: Buffer; mimetype: string } | null> {
    if (!this.bucketName) {
      return null;
    }

    try {
      const objectPath = `whatsapp-media/${instanceId}/${fileName}`;
      const bucket = storageClient.bucket(this.bucketName);
      const file = bucket.file(objectPath);

      const [exists] = await file.exists();
      if (!exists) {
        return null;
      }

      const [buffer] = await file.download();
      const [metadata] = await file.getMetadata();

      return {
        buffer,
        mimetype: (metadata.contentType as string) || "application/octet-stream",
      };
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to get media");
      return null;
    }
  }

  private static getExtension(mimetype: string): string {
    const map: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "video/mp4": ".mp4",
      "video/3gpp": ".3gp",
      "audio/ogg": ".ogg",
      "audio/mpeg": ".mp3",
      "audio/mp4": ".m4a",
      "application/pdf": ".pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    };
    return map[mimetype] || "";
  }
}
