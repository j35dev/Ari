export const LOCAL_MEDIA_PREFIX = '#ari-media='

// Keep the list to audio and video files that can open through a player association.
const MEDIA_EXTENSION =
  /\.(?:aac|aiff?|avi|flac|m4a|m4v|mkv|mov|mp3|mp4|oga|ogg|opus|wav|webm|wmv)$/i

export function isLocalMediaPath(path: string, windows = /^[a-z]:/i.test(path)): boolean {
  if (path.includes('\0') || path.trimEnd() !== path || !MEDIA_EXTENSION.test(path)) return false
  // Require an absolute path and exclude UNC/device paths and Windows alternate data streams.
  return windows ? /^[a-z]:[\\/][^:]*$/i.test(path) : /^\/(?![\\/])/.test(path)
}
