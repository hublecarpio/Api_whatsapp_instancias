import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

let s3Client: S3Client | null = null;
let bucketName: string | null = null;
let publicBaseUrl: string | null = null;

function initializeS3(): boolean {
  if (s3Client) return true;
  
  const endpoint = process.env.MINIO_ENDPOINT;
  const accessKey = process.env.MINIO_ACCESS_KEY;
  const secretKey = process.env.MINIO_SECRET_KEY;
  const bucket = process.env.MINIO_BUCKET;

  if (!endpoint || !accessKey || !secretKey || !bucket) {
    return false;
  }

  s3Client = new S3Client({
    endpoint: endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    forcePathStyle: true,
  });

  bucketName = bucket;
  publicBaseUrl = process.env.MINIO_PUBLIC_URL || endpoint;
  return true;
}

function getExtension(mimetype: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/webm': '.ogg',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/zip': '.zip',
    'application/x-rar-compressed': '.rar',
  };
  return map[mimetype] || '';
}

function getMediaType(mimetype: string): 'image' | 'video' | 'audio' | 'file' {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'file';
}

export interface UploadResult {
  url: string;
  type: 'image' | 'video' | 'audio' | 'file';
  key: string;
}

export async function uploadBuffer(
  buffer: Buffer, 
  mimetype: string, 
  businessId: string,
  filename?: string
): Promise<UploadResult | null> {
  if (!initializeS3()) {
    console.error('S3 not configured');
    return null;
  }

  const ext = getExtension(mimetype);
  const type = getMediaType(mimetype);
  const key = `media/${businessId}/${randomUUID()}${ext}`;

  try {
    await s3Client!.send(new PutObjectCommand({
      Bucket: bucketName!,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    }));

    const url = `${publicBaseUrl}/${bucketName}/${key}`;
    
    console.log('[STORAGE] Uploaded media:', { key, type, url });
    
    return { url, type, key };
  } catch (error) {
    console.error('[STORAGE] Upload failed:', error);
    return null;
  }
}

export function isS3Configured(): boolean {
  return initializeS3();
}
