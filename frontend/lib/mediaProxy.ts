export function getMediaProxyUrl(url: string | undefined, mediaType: string): string | undefined {
  if (!url) return undefined;
  
  const isAudioVideo = mediaType.includes('audio') || mediaType.includes('video') ||
    url.match(/\.(mp3|ogg|wav|m4a|mp4|webm|mov)$/i);
  
  if (!isAudioVideo) return url;
  
  const keyMatch = url.match(/(chat|media)\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\.[a-zA-Z0-9]+$/);
  if (!keyMatch) {
    return url;
  }
  
  const key = keyMatch[0];
  return `/api/media/proxy?key=${encodeURIComponent(key)}`;
}
