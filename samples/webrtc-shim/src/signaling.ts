// Signaling Channel
// WebSocket-based signaling for SDP offer/answer and ICE candidate exchange.

export interface SignalingMessage {
  type: string;
  sdp?: string;
  candidate?: unknown;
  target?: string;
  from?: string;
  peerId?: string;
  peers?: string[];
  room?: string;
  message?: string;
}

export class SignalingChannel {
  url: string;
  ws: WebSocket | null = null;
  peerId: string | null = null;
  remotePeerId: string | null = null;

  // Event callbacks
  onOffer: ((sdp: string, from: string) => void) | null = null;
  onAnswer: ((sdp: string, from: string) => void) | null = null;
  onIceCandidate: ((candidate: unknown, from: string) => void) | null = null;
  onPeerJoined: ((peerId: string) => void) | null = null;
  onPeerLeft: ((peerId: string) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onConnected: ((peerId: string, peers: string[]) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  connect(room: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.ws!.send(JSON.stringify({ type: 'join', room }));
      };

      this.ws.onmessage = (event: MessageEvent) => {
        const msg: SignalingMessage = JSON.parse(event.data as string);
        this._handleMessage(msg, resolve);
      };

      this.ws.onerror = (err) => {
        if (this.onError) this.onError(err as unknown as Error);
        reject(err);
      };

      this.ws.onclose = () => {
        if (this.onError) this.onError(new Error('WebSocket closed'));
      };
    });
  }

  sendOffer(sdp: string): void {
    this._send({ type: 'offer', sdp, target: this.remotePeerId ?? undefined });
  }

  sendAnswer(sdp: string): void {
    this._send({ type: 'answer', sdp, target: this.remotePeerId ?? undefined });
  }

  sendIceCandidate(candidate: unknown): void {
    this._send({ type: 'ice-candidate', candidate, target: this.remotePeerId ?? undefined } as SignalingMessage);
  }

  disconnect(): void {
    if (this.ws) {
      this._send({ type: 'leave' });
      this.ws.close();
      this.ws = null;
    }
  }

  private _send(msg: Partial<SignalingMessage>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private _handleMessage(msg: SignalingMessage, joinResolve?: (value: string) => void): void {
    switch (msg.type) {
      case 'joined':
        this.peerId = msg.peerId!;
        if (msg.peers && msg.peers.length > 0) {
          this.remotePeerId = msg.peers[0];
        }
        if (this.onConnected) this.onConnected(msg.peerId!, msg.peers || []);
        if (joinResolve) joinResolve(msg.peerId!);
        break;

      case 'peer-joined':
        this.remotePeerId = msg.peerId!;
        if (this.onPeerJoined) this.onPeerJoined(msg.peerId!);
        break;

      case 'peer-left':
        if (this.onPeerLeft) this.onPeerLeft(msg.peerId!);
        this.remotePeerId = null;
        break;

      case 'offer':
        this.remotePeerId = msg.from!;
        if (this.onOffer) this.onOffer(msg.sdp!, msg.from!);
        break;

      case 'answer':
        if (this.onAnswer) this.onAnswer(msg.sdp!, msg.from!);
        break;

      case 'ice-candidate':
        if (this.onIceCandidate) this.onIceCandidate(msg.candidate, msg.from!);
        break;

      case 'error':
        if (this.onError) this.onError(new Error(msg.message));
        break;
    }
  }
}
