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

// Verbose mode: log every relayed signaling message (offer/answer/candidate)
// and connection lifecycle. Enable with `--verbose`/`-v` or VERBOSE=1.
const VERBOSE =
  process.argv.includes('--verbose') ||
  process.argv.includes('-v') ||
  process.env.VERBOSE === '1' ||
  process.env.VERBOSE === 'true';

function ts(): string {
  return new Date().toISOString();
}
function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`);
}
function vlog(msg: string): void {
  if (VERBOSE) console.log(`[${ts()}] [verbose] ${msg}`);
}

/** One-line human summary of a signaling message for verbose logging. */
function describeMessage(msg: SignalingMessage): string {
  const to = msg.target ? `→ ${msg.target}` : '→ (broadcast)';
  switch (msg.type) {
    case 'offer':
    case 'answer':
      return `${msg.type} ${to} (sdp: ${(msg.sdp ?? '').length} bytes)`;
    case 'ice-candidate': {
      const c = msg.candidate as { candidate?: string } | string | undefined;
      const cand = typeof c === 'string' ? c : c?.candidate ?? JSON.stringify(c);
      return `ice-candidate ${to} ${cand}`;
    }
    case 'join':
      return `join room "${msg.room}" as ${msg.peerId ?? '(auto)'}`;
    case 'leave':
      return 'leave';
    default:
      return `${msg.type} ${JSON.stringify(msg)}`;
  }
}

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
  // Strip query string / fragment before resolving the static file path.
  const rawUrl = (req.url ?? '/').split(/[?#]/)[0];
  let filePath = join(STATIC_ROOT, rawUrl === '/' ? 'index.html' : rawUrl);

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

  vlog('WebSocket connection opened');

  ws.on('message', (data: Buffer | string) => {
    let msg: SignalingMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      vlog('Dropped non-JSON message');
      return;
    }

    vlog(`recv ${describeMessage(msg)}` + (peerId ? ` [from ${peerId}]` : ''));

    switch (msg.type) {
      case 'join': {
        currentRoom = msg.room!;
        peerId = msg.peerId || crypto.randomUUID();

        if (!rooms.has(currentRoom)) {
          rooms.set(currentRoom, new Map());
          vlog(`Room "${currentRoom}" created`);
        }
        const room = rooms.get(currentRoom)!;

        if (room.size >= 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
          log(`Join rejected: room "${currentRoom}" is full (peer ${peerId})`);
          return;
        }

        room.set(peerId, ws);
        log(`User joined: ${peerId} → room "${currentRoom}" (${room.size}/2)`);
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
          vlog(`relay ${describeMessage(msg)} [from ${peerId}]`);
        } else {
          let relayed = 0;
          for (const [id, peer] of room) {
            if (id !== peerId) {
              peer.send(JSON.stringify({ ...msg, from: peerId }));
              relayed++;
            }
          }
          vlog(`relay ${describeMessage(msg)} [from ${peerId}, ${relayed} recipient(s)]`);
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

      log(`User gone: ${peerId} ← room "${currentRoom}" (${room.size}/2 remaining)`);

      if (room.size === 0) {
        rooms.delete(currentRoom);
        vlog(`Room "${currentRoom}" deleted (empty)`);
      }
    }
    currentRoom = null;
  }

  ws.on('close', () => { vlog('WebSocket connection closed'); leaveRoom(); });
  ws.on('error', leaveRoom);
});

httpServer.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
  console.log(`Verbose logging: ${VERBOSE ? 'ON' : 'OFF (enable with --verbose)'}`);
});
