export interface WhatsAppEvent {
  type: 'text' | 'image' | 'document' | 'video' | 'audio';
  text?: string;
  url?: string;
  caption?: string;
  filename?: string;
  mimetype?: string;
}

interface ParseOptions {
  maxCaptionChars?: number;
  maxTextChars?: number;
  maxTextSentences?: number;
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const DOCUMENT_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'xml', 'json', 'zip', 'rar'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', '3gp'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac'];

function getExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('.');
    if (parts.length > 1) {
      return parts[parts.length - 1].toLowerCase().split('?')[0];
    }
  } catch {
    const match = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

function getFilenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/');
    return parts[parts.length - 1] || 'file';
  } catch {
    return 'file';
  }
}

function getMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    xml: 'application/xml',
    json: 'application/json',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    '3gp': 'video/3gpp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    m4a: 'audio/mp4',
    aac: 'audio/aac'
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function getMediaType(ext: string): 'image' | 'document' | 'video' | 'audio' | null {
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (DOCUMENT_EXTENSIONS.includes(ext)) return 'document';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  return null;
}

function splitIntoSentences(text: string): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];

  const abbreviations = new Set(['sr.', 'sra.', 'dr.', 'dra.', 'ing.', 'etc.', 'ej.', 'pág.', 'tel.', 'no.']);
  const out: string[] = [];
  let buf = '';

  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    buf += ch;

    const isEndPunct = ch === '.' || ch === '?' || ch === '!' || ch === '…';
    if (!isEndPunct) continue;

    const words = buf.trim().toLowerCase().split(' ');
    const lastToken = words[words.length - 1];
    if (abbreviations.has(lastToken)) continue;

    const next = t[i + 1];
    if (i === t.length - 1 || next === ' ') {
      out.push(buf.trim());
      buf = '';
      while (t[i + 1] === ' ') i++;
    }
  }

  if (buf.trim()) out.push(buf.trim());
  return out;
}

function splitByWords(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';

  const pushCur = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };

  for (const w of words) {
    if (w.length > maxChars) {
      pushCur();
      for (let i = 0; i < w.length; i += maxChars) {
        chunks.push(w.slice(i, i + maxChars));
      }
      continue;
    }

    const candidate = cur ? (cur + ' ' + w) : w;
    if (candidate.length > maxChars) {
      pushCur();
      cur = w;
    } else {
      cur = candidate;
    }
  }

  pushCur();
  return chunks;
}

function chunkWhatsAppMessage(text: string, options: { maxChars?: number; maxSentences?: number; preserveBullets?: boolean } = {}): string[] {
  const { maxChars = 320, maxSentences = 2, preserveBullets = true } = options;

  if (!text || typeof text !== 'string') return [];

  let t = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!t) return [];

  const paragraphs = t.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const isBulletLine = (line: string) => /^(\-|\•|\*|\d+\.)\s+/.test(line.trim());

  interface Unit { type: 'line' | 'sentence'; value: string }
  const units: Unit[] = [];

  for (const p of paragraphs) {
    const lines = p.split('\n').map(x => x.trim()).filter(Boolean);
    const hasBullets = preserveBullets && lines.some(isBulletLine);

    if (hasBullets) {
      for (const line of lines) units.push({ type: 'line', value: line });
    } else {
      const sentenceParts = splitIntoSentences(p);
      for (const s of sentenceParts) units.push({ type: 'sentence', value: s });
    }
  }

  const messages: string[] = [];
  let current = '';
  let sentenceCount = 0;

  const flush = () => {
    const out = current.trim();
    if (out) messages.push(out);
    current = '';
    sentenceCount = 0;
  };

  for (const u of units) {
    let piece = u.value.trim();
    if (!piece) continue;

    const pieces = (piece.length > maxChars) ? splitByWords(piece, maxChars) : [piece];

    for (const part of pieces) {
      const partIsSentence = u.type === 'sentence';

      if (current && partIsSentence && sentenceCount >= maxSentences) flush();

      const sep = current ? '\n' : '';
      const candidate = current + sep + part;

      if (candidate.length > maxChars) {
        flush();
        if (part.length > maxChars) {
          const more = splitByWords(part, maxChars);
          for (const m of more) messages.push(m);
          continue;
        }
        current = part;
        sentenceCount = partIsSentence ? 1 : 0;
      } else {
        current = candidate;
        if (partIsSentence) sentenceCount += 1;
      }
    }
  }

  flush();
  return messages.map(m => m.trim()).filter(Boolean);
}

export function parseAgentOutputToWhatsAppEvents(raw: string, options: ParseOptions = {}): WhatsAppEvent[] {
  const { maxCaptionChars = 800, maxTextChars = 320, maxTextSentences = 2 } = options;

  if (!raw || typeof raw !== 'string') return [];

  const text = raw.replace(/\r\n/g, '\n').trim();
  const urlRegex = /(https?:\/\/[^\s)]+)(?=\s|$)/g;

  interface Token { type: 'text' | 'url'; value: string }
  const tokens: Token[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[1];
    const start = match.index;
    const end = start + url.length;

    const before = text.slice(lastIdx, start);
    if (before.trim()) tokens.push({ type: 'text', value: before.trim() });

    tokens.push({ type: 'url', value: url });
    lastIdx = end;
  }

  const after = text.slice(lastIdx);
  if (after.trim()) tokens.push({ type: 'text', value: after.trim() });

  const events: WhatsAppEvent[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];

    if (tk.type === 'url') {
      const ext = getExtension(tk.value);
      const mediaType = getMediaType(ext);

      if (mediaType) {
        let caption: string | undefined;

        const next = tokens[i + 1];
        if (next && next.type === 'text') {
          const candidate = next.value.trim();
          if (candidate.length <= maxCaptionChars) {
            caption = candidate;
            i++;
          }
        }

        events.push({
          type: mediaType,
          url: tk.value,
          caption,
          filename: getFilenameFromUrl(tk.value),
          mimetype: getMimeType(ext)
        });
        continue;
      }

      events.push({ type: 'text', text: tk.value });
      continue;
    }

    const chunks = chunkWhatsAppMessage(tk.value, {
      maxChars: maxTextChars,
      maxSentences: maxTextSentences,
      preserveBullets: true
    });

    for (const c of chunks) {
      events.push({ type: 'text', text: c });
    }
  }

  return events;
}

export function calculateTypingDelay(text: string): number {
  const words = text.split(/\s+/).length;
  const baseDelay = 300;
  const perWordDelay = 50;
  const maxDelay = 3000;
  return Math.min(baseDelay + (words * perWordDelay), maxDelay);
}
