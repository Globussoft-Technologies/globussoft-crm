import { io } from 'socket.io-client';
import { getAuthToken } from './authToken';

export function createAuthenticatedSocket(uri = '/', options = {}) {
  return io(uri, {
    ...options,
    auth: {
      ...(options.auth || {}),
      token: getAuthToken(),
    },
  });
}
