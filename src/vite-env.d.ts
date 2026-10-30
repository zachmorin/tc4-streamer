/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STREAM_PROVIDER?: string;
  readonly VITE_SITE_TITLE?: string;
  readonly VITE_WHEP_URL?: string;
  readonly VITE_WHIP_URL?: string;
  readonly VITE_WHIP_SEALED?: string;
  readonly VITE_LIVEKIT_WHIP_URL?: string;
  readonly VITE_LIVEKIT_STREAM_KEY_SEALED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
