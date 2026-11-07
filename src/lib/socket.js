import { io } from 'socket.io-client';

export function connectSocket() {
  return io({
    withCredentials: true,
    transports: ['websocket', 'polling'],
  });
}
