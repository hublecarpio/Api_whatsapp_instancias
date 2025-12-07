import { Router, Response } from 'express';
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const execAsync = promisify(exec);
const router = Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 16 * 1024 * 1024 }
});

let s3Client: S3Client | null = null;
let bucketName: string | null = null;
let publicBaseUrl: string | null = null;

function initializeS3() {
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

async function convertAudioToOgg(inputBuffer: Buffer): Promise<Buffer> {
  const inputPath = join(tmpdir(), `audio_input_${randomUUID()}.webm`);
  const outputPath = join(tmpdir(), `audio_output_${randomUUID()}.ogg`);
  
  try {
    await writeFile(inputPath, inputBuffer);
    
    await execAsync(`ffmpeg -y -i "${inputPath}" -c:a libopus -b:a 64k -vbr on -compression_level 10 "${outputPath}"`);
    
    const outputBuffer = await readFile(outputPath);
    
    return outputBuffer;
  } finally {
    try { await unlink(inputPath); } catch {}
    try { await unlink(outputPath); } catch {}
  }
}

router.use(authMiddleware);

router.post('/upload', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    const business = await prisma.business.findFirst({
      where: { id: businessId, userId: req.userId! }
    });
    
    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    if (!initializeS3()) {
      return res.status(500).json({ error: 'Media storage not configured' });
    }
    
    let fileBuffer = req.file.buffer;
    let fileMimetype = req.file.mimetype;
    let extension = getExtension(req.file.mimetype);
    
    if (req.file.mimetype === 'audio/webm' || req.file.mimetype.startsWith('audio/')) {
      try {
        console.log('Converting audio to OGG format...');
        fileBuffer = await convertAudioToOgg(req.file.buffer);
        fileMimetype = 'audio/ogg';
        extension = '.ogg';
        console.log('Audio converted successfully');
      } catch (convErr: any) {
        console.error('Audio conversion failed, using original:', convErr.message);
      }
    }
    
    if (!extension) {
      extension = req.file.originalname ? `.${req.file.originalname.split('.').pop()}` : '';
    }
    
    const fileName = `${randomUUID()}${extension}`;
    const objectPath = `chat/${businessId}/${fileName}`;
    
    await s3Client!.send(new PutObjectCommand({
      Bucket: bucketName!,
      Key: objectPath,
      Body: fileBuffer,
      ContentType: fileMimetype,
      ACL: 'public-read',
    }));
    
    const publicUrl = `${publicBaseUrl}/${bucketName}/${objectPath}`;
    const mediaType = getMediaType(fileMimetype);
    
    res.json({
      url: publicUrl,
      path: objectPath,
      type: mediaType,
      mimetype: fileMimetype,
      size: fileBuffer.length,
      originalName: req.file.originalname
    });
  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

export default router;
