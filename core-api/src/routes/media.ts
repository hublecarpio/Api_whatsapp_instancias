import { Router, Response, Request } from 'express';
import multer from 'multer';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID, createHmac } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import prisma from '../services/prisma.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { Readable } from 'stream';

const MEDIA_TOKEN_SECRET = process.env.SESSION_SECRET || 'fallback-media-token-secret';
const TOKEN_VALIDITY_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateMediaToken(key: string, businessId: string, expiresAt: number): string {
  const data = `${key}:${businessId}:${expiresAt}`;
  const signature = createHmac('sha256', MEDIA_TOKEN_SECRET).update(data).digest('hex').slice(0, 16);
  return Buffer.from(`${data}:${signature}`).toString('base64url');
}

function validateMediaToken(token: string, key: string): { valid: boolean; businessId?: string } {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts.length !== 4) return { valid: false };
    
    const [tokenKey, businessId, expiresAtStr, signature] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);
    
    // Check expiration
    if (Date.now() > expiresAt) {
      return { valid: false };
    }
    
    // Verify key matches
    if (tokenKey !== key) {
      return { valid: false };
    }
    
    // Verify signature
    const data = `${tokenKey}:${businessId}:${expiresAtStr}`;
    const expectedSig = createHmac('sha256', MEDIA_TOKEN_SECRET).update(data).digest('hex').slice(0, 16);
    if (signature !== expectedSig) {
      return { valid: false };
    }
    
    return { valid: true, businessId };
  } catch {
    return { valid: false };
  }
}

export { generateMediaToken };

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

// ============================================================================
// AUTHENTICATED MEDIA PROXY: Range request support for audio/video streaming
// 
// Security Model:
// - Requires a signed token (generated when messages are fetched) that contains:
//   * The media key
//   * The businessId that owns the media
//   * Expiration timestamp
//   * HMAC signature using SESSION_SECRET
// - Token is validated before serving media, preventing IDOR attacks
// - Tokens expire after 24 hours, limiting exposure window
// - If no token is provided, falls back to DB existence check (for backwards compat)
//
// Must be defined BEFORE authMiddleware to allow audio/video players without Bearer token
// ============================================================================
router.get('/proxy', async (req: Request, res: Response) => {
  try {
    const { key, token } = req.query;
    
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'Missing key parameter' });
    }
    
    if (!initializeS3()) {
      return res.status(500).json({ error: 'Media storage not configured' });
    }
    
    // Security: validate key format (should be like chat/businessId/file.ext or media/businessId/file.ext)
    if (!key.match(/^(chat|media)\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\.[a-zA-Z0-9]+$/)) {
      console.log('[MEDIA PROXY] Invalid key format:', key);
      return res.status(400).json({ error: 'Invalid key format' });
    }
    
    // Extract businessId from key for validation
    const keyParts = key.split('/');
    const keyBusinessId = keyParts[1]; // chat/BUSINESSID/file.ext
    
    // Security: Validate signed token if provided (preferred method)
    if (token && typeof token === 'string') {
      const validation = validateMediaToken(token, key);
      if (!validation.valid) {
        console.log('[MEDIA PROXY] Invalid or expired token for key:', key);
        return res.status(403).json({ error: 'Invalid or expired token' });
      }
      // Verify token's businessId matches the key's businessId (cross-tenant protection)
      if (validation.businessId !== keyBusinessId) {
        console.log('[MEDIA PROXY] Token businessId mismatch:', validation.businessId, '!=', keyBusinessId);
        return res.status(403).json({ error: 'Access denied' });
      }
      // Token is valid and businessId matches
    } else {
      // Fallback: Verify this media key exists in our database (backwards compat)
      // This is less secure but maintains compatibility during transition
      const [messageWithMedia, productWithMedia] = await Promise.all([
        prisma.messageLog.findFirst({
          where: { 
            mediaUrl: { contains: key },
            businessId: keyBusinessId // Verify business ownership
          },
          select: { id: true }
        }),
        prisma.product.findFirst({
          where: { 
            imageUrl: { contains: key },
            businessId: keyBusinessId // Verify business ownership
          },
          select: { id: true }
        })
      ]);
      
      if (!messageWithMedia && !productWithMedia) {
        console.log('[MEDIA PROXY] Access denied - key not found for business:', key, keyBusinessId);
        return res.status(403).json({ error: 'Access denied' });
      }
    }
    
    // Get object metadata first to know the size
    let contentLength: number;
    let contentType: string;
    
    try {
      const headResult = await s3Client!.send(new HeadObjectCommand({
        Bucket: bucketName!,
        Key: key,
      }));
      contentLength = headResult.ContentLength || 0;
      contentType = headResult.ContentType || 'application/octet-stream';
    } catch (headErr: any) {
      if (headErr.name === 'NotFound' || headErr.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: 'File not found' });
      }
      throw headErr;
    }
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    
    // Handle OPTIONS preflight
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    
    // Parse Range header for partial content requests (critical for audio/video seeking)
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = contentLength - 1;
    
    if (rangeHeader) {
      const matches = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (matches) {
        start = parseInt(matches[1], 10);
        end = matches[2] ? parseInt(matches[2], 10) : contentLength - 1;
        
        // Validate range
        if (start >= contentLength || end >= contentLength || start > end) {
          res.setHeader('Content-Range', `bytes */${contentLength}`);
          return res.status(416).json({ error: 'Range not satisfiable' });
        }
      }
    }
    
    const chunkSize = end - start + 1;
    
    // Get the object with range
    const getResult = await s3Client!.send(new GetObjectCommand({
      Bucket: bucketName!,
      Key: key,
      Range: `bytes=${start}-${end}`,
    }));
    
    if (!getResult.Body) {
      return res.status(500).json({ error: 'Failed to retrieve file' });
    }
    
    // Set appropriate headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    
    if (rangeHeader) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${contentLength}`);
      res.status(206); // Partial Content
    } else {
      res.status(200);
    }
    
    // Stream the response
    const stream = getResult.Body as Readable;
    stream.pipe(res);
    
    stream.on('error', (err) => {
      console.error('[MEDIA PROXY] Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error' });
      }
    });
    
  } catch (error: any) {
    console.error('[MEDIA PROXY] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to proxy media' });
    }
  }
});

async function convertAudioForWhatsApp(inputBuffer: Buffer, inputMimetype: string): Promise<{ buffer: Buffer; extension: string; mimetype: string }> {
  const inputExt = inputMimetype.includes('webm') ? 'webm' : 
                   inputMimetype.includes('mp3') ? 'mp3' :
                   inputMimetype.includes('m4a') ? 'm4a' :
                   inputMimetype.includes('ogg') ? 'ogg' :
                   inputMimetype.includes('wav') ? 'wav' : 'webm';
  
  const inputPath = join(tmpdir(), `audio_input_${randomUUID()}.${inputExt}`);
  const outputPath = join(tmpdir(), `audio_output_${randomUUID()}.mp3`);
  
  try {
    await writeFile(inputPath, inputBuffer);
    
    await execAsync(
      `ffmpeg -y -i "${inputPath}" -c:a libmp3lame -b:a 128k -ar 44100 -ac 1 "${outputPath}"`
    );
    
    const outputBuffer = await readFile(outputPath);
    console.log(`Audio converted: ${inputBuffer.length} bytes -> ${outputBuffer.length} bytes (MP3)`);
    
    return { buffer: outputBuffer, extension: '.mp3', mimetype: 'audio/mpeg' };
  } finally {
    try { await unlink(inputPath); } catch {}
    try { await unlink(outputPath); } catch {}
  }
}

router.use(authMiddleware);

router.post('/upload', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const { businessId } = req.body;
    
    console.log('[MEDIA] Upload request:', { businessId, userId: req.userId, filename: req.file?.originalname, mimetype: req.file?.mimetype, size: req.file?.size });
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    if (!businessId) {
      return res.status(400).json({ error: 'businessId is required' });
    }
    
    // Check for business access - support advisors (who don't own the business)
    const user = await prisma.user.findUnique({ 
      where: { id: req.userId! },
      select: { role: true, parentUserId: true }
    });
    
    let business;
    if (user?.role === 'ASESOR' && user.parentUserId) {
      // Advisors can access their parent's businesses
      business = await prisma.business.findFirst({
        where: { id: businessId, userId: user.parentUserId }
      });
    } else {
      business = await prisma.business.findFirst({
        where: { id: businessId, userId: req.userId! }
      });
    }
    
    if (!business) {
      console.log('[MEDIA] Business not found for user:', req.userId, 'businessId:', businessId, 'role:', user?.role);
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
        console.log('[MEDIA] Converting audio for WhatsApp from', req.file.mimetype, '(', req.file.buffer.length, 'bytes)');
        const converted = await convertAudioForWhatsApp(req.file.buffer, req.file.mimetype);
        fileBuffer = converted.buffer;
        fileMimetype = converted.mimetype;
        extension = converted.extension;
        console.log('[MEDIA] Audio converted successfully:', converted.mimetype, '(', converted.buffer.length, 'bytes)');
      } catch (convErr: any) {
        console.error('[MEDIA] Audio conversion failed:', convErr.message);
        console.error('[MEDIA] Fallback: using original audio (may not work with Meta Cloud API)');
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
