export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export const WS_BASE = API_URL.replace(/^http/, 'ws');
