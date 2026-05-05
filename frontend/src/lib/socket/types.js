export const isTranscript = (m) => 'type' in m && m.type === 'transcript';

export const isAudio = (m) => 'type' in m && m.type === 'audio';

export const isError = (m) => 'error' in m;
