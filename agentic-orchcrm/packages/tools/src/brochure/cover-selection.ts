/** Vary search-sourced covers without overriding operator-supplied photography. */
export function selectCoverPhoto(uploaded: string[], destinationPhotos: string[], random = Math.random): string {
  if (uploaded.length) return uploaded[0]!;
  const candidates = [...new Set(destinationPhotos.filter(Boolean))];
  if (!candidates.length) return '';
  const index = Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)));
  return candidates[index]!;
}

export function partitionEditorialPhotos(gallery: string[], hero: string, dayUrls: string[]) {
  const reserved = new Set([hero, ...dayUrls]);
  const available = [...new Set(gallery)].filter(url => url && !reserved.has(url));
  return { overviewPhotos: available.slice(0, 3), extraPhotos: available.slice(3, 11) };
}

/** Keep a photo only once even when the model repeats its token or an alias. */
export function deduplicatePhotoTags(html: string, tokenMap: Record<string, string>): string {
  const seen = new Set<string>();
  return html.replace(/<img\b[^>]*\bsrc=(["'])((?:HERO|OVERVIEW|EXTRA|DAY_\d+)_PHOTO(?:_\d+)?)\1[^>]*>/gi,
    (tag, _quote, token) => {
      const url = tokenMap[token];
      if (!url) return tag;
      if (seen.has(url)) return '';
      seen.add(url);
      return tag;
    });
}
