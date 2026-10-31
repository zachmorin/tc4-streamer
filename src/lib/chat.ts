/**
 * Terminal chat: name gate + BroadcastChannel fan-out (same origin / tabs).
 * Optional VITE_CHAT_WS upgrades to a real multi-device relay when set.
 */

export type ChatKind = "text" | "emoji" | "gif" | "system";

export interface ChatMessage {
  id: string;
  name: string;
  kind: ChatKind;
  text: string;
  at: number;
}

export type ChatHandler = (msg: ChatMessage) => void;

const NAME_KEY = "dj-stream:chat-name";
const CHANNEL = "dj-stream:chat";

export function loadChatName(): string | null {
  const n = localStorage.getItem(NAME_KEY)?.trim();
  return n || null;
}

export function saveChatName(name: string): void {
  localStorage.setItem(NAME_KEY, name.trim().slice(0, 24));
}

export function clearChatName(): void {
  localStorage.removeItem(NAME_KEY);
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class ChatClient {
  private bc: BroadcastChannel | null = null;
  private ws: WebSocket | null = null;
  private onMessage: ChatHandler | null = null;
  private name: string | null = null;

  constructor(private readonly wsUrl: string | null) {}

  start(name: string, onMessage: ChatHandler): void {
    this.stop();
    this.name = name;
    this.onMessage = onMessage;
    this.bc = new BroadcastChannel(CHANNEL);
    this.bc.onmessage = (ev) => {
      const msg = ev.data as ChatMessage;
      if (msg?.id && msg.name) this.onMessage?.(msg);
    };

    if (this.wsUrl) {
      try {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data)) as ChatMessage;
            if (msg?.id) this.onMessage?.(msg);
          } catch {
            /* ignore */
          }
        };
      } catch {
        this.pushLocal({
          id: uid(),
          name: "system",
          kind: "system",
          text: "chat relay unreachable; falling back to local channel",
          at: Date.now(),
        });
      }
    }

    this.pushLocal({
      id: uid(),
      name: "system",
      kind: "system",
      text: this.wsUrl
        ? `${name} joined`
        : `${name} joined // local channel (same browser / tabs). set VITE_CHAT_WS for multi-device.`,
      at: Date.now(),
    });
  }

  stop(): void {
    this.bc?.close();
    this.bc = null;
    this.ws?.close();
    this.ws = null;
    this.onMessage = null;
    this.name = null;
  }

  send(kind: ChatKind, text: string): void {
    if (!this.name || !text.trim()) return;
    const msg: ChatMessage = {
      id: uid(),
      name: this.name,
      kind,
      text: text.trim().slice(0, kind === "gif" ? 500 : 280),
      at: Date.now(),
    };
    this.bc?.postMessage(msg);
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify(msg));
    this.onMessage?.(msg);
  }

  private pushLocal(msg: ChatMessage): void {
    this.onMessage?.(msg);
  }
}

/** Compact emoji set for the picker (no external deps). */
export const EMOJI = [
  "🔥", "😎", "🎧", "🕺", "💃", "🙌", "👏", "❤️", "💚", "🖤",
  "✨", "⚡", "🌀", "🌊", "🚀", "👽", "🦐", "🎯", "💀", "😂",
  "😭", "🫡", "👀", "💯", "🎶", "🔊", "🛑", "🟢", "🟣", "📀",
];
