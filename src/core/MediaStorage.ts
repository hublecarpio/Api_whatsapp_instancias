import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import logger from "../utils/logger";
import { Readable } from "stream";

let s3Client: S3Client | null = null;
let bucketName: string | null = null;
let publicBaseUrl: string | null = null;

export class MediaStorage {
  static initialize(): boolean {
    const endpoint = process.env.MINIO_ENDPOINT;
    const accessKey = process.env.MINIO_ACCESS_KEY;
    const secretKey = process.env.MINIO_SECRET_KEY;
    const bucket = process.env.MINIO_BUCKET;

    if (!endpoint || !accessKey || !secretKey || !bucket) {
      logger.warn("MinIO not configured - media storage disabled. Set MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET");
      return false;
    }

    try {
      s3Client = new S3Client({
        endpoint: endpoint,
        region: "us-east-1",
        credentials: {
          accessKeyId: accessKey,
          secretAccessKey: secretKey,
        },
        forcePathStyle: true,
      });

      bucketName = bucket;
      
      publicBaseUrl = process.env.MINIO_PUBLIC_URL || endpoint;

      logger.info({ endpoint, bucket }, "MediaStorage initialized with MinIO");
      return true;
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to initialize MediaStorage");
      return false;
    }
  }

  static isEnabled(): boolean {
    return s3Client !== null && bucketName !== null;
  }

  static async storeMedia(
    buffer: Buffer,
    mimetype: string,
    instanceId: string
  ): Promise<{ url: string; path: string } | null> {
    if (!s3Client || !bucketName) {
      return null;
    }

    try {
      const extension = this.getExtension(mimetype);
      const fileName = `${randomUUID()}${extension}`;
      const objectPath = `whatsapp/${instanceId}/${fileName}`;

      await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: objectPath,
        Body: buffer,
        ContentType: mimetype,
        ACL: "public-read",
      }));

      const publicUrl = `${publicBaseUrl}/${bucketName}/${objectPath}`;

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
    if (!s3Client || !bucketName) {
      return null;
    }

    try {
      const objectPath = `whatsapp/${instanceId}/${fileName}`;

      const headResponse = await s3Client.send(new HeadObjectCommand({
        Bucket: bucketName,
        Key: objectPath,
      }));

      const response = await s3Client.send(new GetObjectCommand({
        Bucket: bucketName,
        Key: objectPath,
      }));

      if (!response.Body) {
        return null;
      }

      const stream = response.Body as Readable;
      const chunks: Buffer[] = [];
      
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }

      return {
        buffer: Buffer.concat(chunks),
        mimetype: headResponse.ContentType || "application/octet-stream",
      };
    } catch (error: any) {
      if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) {
        return null;
      }
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
