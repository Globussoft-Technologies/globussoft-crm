// Unit tests for backend/lib/videoUrl.js — pure helper, no I/O.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const { normalizeVideoEmbedUrl, isLocalUpload, isDirectVideoFile, LOCAL_UPLOAD_PREFIX } =
  requireCJS('../../lib/videoUrl');

describe('normalizeVideoEmbedUrl — YouTube', () => {
  test('youtube.com/watch?v=ID → embed', () => {
    expect(normalizeVideoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
      .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });
  test('youtube.com/shorts/ID → embed (the bug surfaced 2026-06-22)', () => {
    expect(normalizeVideoEmbedUrl('https://www.youtube.com/shorts/vYbKn1uE3zoS'))
      .toBe('https://www.youtube.com/embed/vYbKn1uE3zoS');
  });
  test('youtu.be short URL → embed', () => {
    expect(normalizeVideoEmbedUrl('https://youtu.be/dQw4w9WgXcQ'))
      .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });
  test('m.youtube.com/watch?v=ID → embed', () => {
    expect(normalizeVideoEmbedUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ'))
      .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });
  test('youtube.com/watch with extra params (& list= etc.) still extracts ID', () => {
    expect(normalizeVideoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=ABC&t=10s'))
      .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });
  test('already-embed URL passes through', () => {
    expect(normalizeVideoEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ'))
      .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });
  test('http (not https) youtube URL still normalised', () => {
    expect(normalizeVideoEmbedUrl('http://youtube.com/watch?v=ABCDEFGHIJK'))
      .toBe('https://www.youtube.com/embed/ABCDEFGHIJK');
  });
});

describe('normalizeVideoEmbedUrl — Vimeo', () => {
  test('vimeo.com/<id> → player.vimeo.com/video/<id>', () => {
    expect(normalizeVideoEmbedUrl('https://vimeo.com/76979871'))
      .toBe('https://player.vimeo.com/video/76979871');
  });
  test('vimeo.com/<id>/<hash> → player.vimeo.com/video/<id>?h=<hash>', () => {
    expect(normalizeVideoEmbedUrl('https://vimeo.com/76979871/abc123def'))
      .toBe('https://player.vimeo.com/video/76979871?h=abc123def');
  });
  test('player.vimeo.com/video/<id> passes through', () => {
    expect(normalizeVideoEmbedUrl('https://player.vimeo.com/video/76979871'))
      .toBe('https://player.vimeo.com/video/76979871');
  });
});

describe('normalizeVideoEmbedUrl — pass-through cases', () => {
  test('Wistia embed URL passes through unchanged', () => {
    expect(normalizeVideoEmbedUrl('https://fast.wistia.net/embed/iframe/abc123'))
      .toBe('https://fast.wistia.net/embed/iframe/abc123');
  });
  test('unknown provider passes through unchanged', () => {
    expect(normalizeVideoEmbedUrl('https://example.com/some-private-embed.html'))
      .toBe('https://example.com/some-private-embed.html');
  });
  test('local upload URL passes through unchanged', () => {
    expect(normalizeVideoEmbedUrl('/uploads/landing-page-videos/tenant-1/abc.mp4'))
      .toBe('/uploads/landing-page-videos/tenant-1/abc.mp4');
  });
});

describe('normalizeVideoEmbedUrl — empty / invalid input', () => {
  test('null → empty string', () => {
    expect(normalizeVideoEmbedUrl(null)).toBe('');
  });
  test('undefined → empty string', () => {
    expect(normalizeVideoEmbedUrl(undefined)).toBe('');
  });
  test('empty string → empty string', () => {
    expect(normalizeVideoEmbedUrl('')).toBe('');
  });
  test('whitespace-only → empty string', () => {
    expect(normalizeVideoEmbedUrl('   ')).toBe('');
  });
  test('non-string input → empty string', () => {
    expect(normalizeVideoEmbedUrl(123)).toBe('');
    expect(normalizeVideoEmbedUrl({})).toBe('');
  });
  test('leading whitespace is trimmed before pattern match', () => {
    expect(normalizeVideoEmbedUrl('  https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
      .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });
});

describe('isLocalUpload', () => {
  test('detects canonical /api/uploads/landing-page-videos prefix', () => {
    expect(isLocalUpload('/api/uploads/landing-page-videos/tenant-1/foo.mp4')).toBe(true);
  });
  test('detects legacy bare /uploads/landing-page-videos prefix (pre-fix saved pages)', () => {
    expect(isLocalUpload('/uploads/landing-page-videos/tenant-1/foo.mp4')).toBe(true);
  });
  test('false for YouTube URL', () => {
    expect(isLocalUpload('https://youtube.com/embed/abc')).toBe(false);
  });
  test('false for /uploads/landing-page-images prefix (sibling but image, not video)', () => {
    expect(isLocalUpload('/uploads/landing-page-images/tenant-1/foo.png')).toBe(false);
  });
  test('false for null / empty input', () => {
    expect(isLocalUpload(null)).toBe(false);
    expect(isLocalUpload('')).toBe(false);
    expect(isLocalUpload(undefined)).toBe(false);
  });
  test('tolerates leading whitespace', () => {
    expect(isLocalUpload('  /uploads/landing-page-videos/tenant-1/foo.mp4')).toBe(true);
    expect(isLocalUpload('  /api/uploads/landing-page-videos/tenant-1/foo.mp4')).toBe(true);
  });
});

describe('isDirectVideoFile', () => {
  test('Pexels CDN .mp4 URL is recognised (the Singapore landing-page bug)', () => {
    expect(isDirectVideoFile(
      'https://videos.pexels.com/video-files/35061521/14852247_1920_1080_30fps.mp4'
    )).toBe(true);
  });
  test('common direct video extensions are recognised', () => {
    expect(isDirectVideoFile('https://cdn.example.com/clip.mp4')).toBe(true);
    expect(isDirectVideoFile('https://cdn.example.com/clip.webm')).toBe(true);
    expect(isDirectVideoFile('https://cdn.example.com/clip.mov')).toBe(true);
    expect(isDirectVideoFile('https://cdn.example.com/clip.ogv')).toBe(true);
    expect(isDirectVideoFile('https://cdn.example.com/clip.ogg')).toBe(true);
    expect(isDirectVideoFile('https://cdn.example.com/clip.m4v')).toBe(true);
  });
  test('extension is allowed before a query string or fragment', () => {
    expect(isDirectVideoFile('https://cdn.example.com/clip.mp4?token=abc')).toBe(true);
    expect(isDirectVideoFile('https://cdn.example.com/clip.mp4#t=10')).toBe(true);
  });
  test('local upload prefix is treated as a direct video file', () => {
    expect(isDirectVideoFile('/uploads/landing-page-videos/tenant-1/foo.mp4')).toBe(true);
    expect(isDirectVideoFile('/uploads/landing-page-videos/tenant-1/clip')).toBe(true);
  });
  test('YouTube / Vimeo / Wistia embed URLs are NOT direct video files', () => {
    expect(isDirectVideoFile('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(false);
    expect(isDirectVideoFile('https://player.vimeo.com/video/76979871')).toBe(false);
    expect(isDirectVideoFile('https://fast.wistia.net/embed/iframe/abc123')).toBe(false);
  });
  test('false for null / empty / non-string input', () => {
    expect(isDirectVideoFile(null)).toBe(false);
    expect(isDirectVideoFile(undefined)).toBe(false);
    expect(isDirectVideoFile('')).toBe(false);
    expect(isDirectVideoFile('   ')).toBe(false);
    expect(isDirectVideoFile(123)).toBe(false);
    expect(isDirectVideoFile({})).toBe(false);
  });
});

describe('exported constant', () => {
  test('LOCAL_UPLOAD_PREFIX matches the upload route + renderer expectations', () => {
    expect(LOCAL_UPLOAD_PREFIX).toBe('/api/uploads/landing-page-videos/');
  });
});
