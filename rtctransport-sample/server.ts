// RtcTransport WebRTC Sample - Signaling Server
// Simple WebSocket relay for SDP offer/answer and ICE candidates.

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Serve static files from project root (parent of dist/)
const STATIC_ROOT = existsSync(join(__dirname, 'index.html')) ? __dirname : dirname(__dirname);

const PORT = parseInt(process.env.PORT || '8080', 10);

interface SignalingMessage {
  type: string;
  room?: string;
  peerId?: string;
  target?: string;
  sdp?: string;
  candidate?: unknown;
  from?: string;
  [key: string]: unknown;
}

// Simple HTTP server for static files
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  let filePath = join(STATIC_ROOT, req.url === '/' ? 'index.html' : req.url!);

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.ts': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
  };

  const ext = extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': contentType });
  res.end(readFileSync(filePath));
});

// WebSocket signaling server
const wss = new WebSocketServer({ server: httpServer });

// Room management: roomId -> Map<peerId, WebSocket>
const rooms = new Map<string, Map<string, WebSocket>>();

wss.on('connection', (ws: WebSocket) => {
  let currentRoom: string | null = null;
  let peerId: string | null = null;

  ws.on('message', (data: Buffer | string) => {
    let msg: SignalingMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        currentRoom = msg.room!;
        peerId = msg.peerId || crypto.randomUUID();

        if (!rooms.has(currentRoom)) {
          rooms.set(currentRoom, new Map());
        }
        const room = rooms.get(currentRoom)!;

        if (room.size >= 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
          return;
        }

        room.set(peerId, ws);
        ws.send(JSON.stringify({
          type: 'joined',
          peerId,
          peers: [...room.keys()].filter(id => id !== peerId),
        }));

        // Notify other peers
        for (const [id, peer] of room) {
          if (id !== peerId) {
            peer.send(JSON.stringify({ type: 'peer-joined', peerId }));
          }
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        if (!currentRoom || !rooms.has(currentRoom)) return;
        const room = rooms.get(currentRoom)!;

        const target = msg.target;
        if (target && room.has(target)) {
          room.get(target)!.send(JSON.stringify({ ...msg, from: peerId }));
        } else {
          for (const [id, peer] of room) {
            if (id !== peerId) {
              peer.send(JSON.stringify({ ...msg, from: peerId }));
            }
          }
        }
        break;
      }

      case 'leave': {
        leaveRoom();
        break;
      }
    }
  });

  function leaveRoom(): void {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom)!;
      room.delete(peerId!);

      for (const [, peer] of room) {
        peer.send(JSON.stringify({ type: 'peer-left', peerId }));
      }

      if (room.size === 0) {
        rooms.delete(currentRoom);
      }
    }
    currentRoom = null;
  }

  ws.on('close', leaveRoom);
  ws.on('error', leaveRoom);
});

httpServer.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
});
