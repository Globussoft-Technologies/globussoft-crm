/** Detect a generated downloadable artifact (e.g. a brochure) in a deliverable. */
export interface Artifact {
  url: string;
  type: 'pdf' | 'html';
  filename: string;
}

const ARTIFACT_RE = /\/generated\/[\w.-]+\.(pdf|html)/i;

export function extractArtifact(text?: string): Artifact | null {
  if (!text) return null;
  const m = text.match(ARTIFACT_RE);
  if (!m) return null;
  const url = m[0];
  const type = url.toLowerCase().endsWith('.pdf') ? 'pdf' : 'html';
  return { url, type, filename: url.split('/').pop() ?? `brochure.${type}` };
}
