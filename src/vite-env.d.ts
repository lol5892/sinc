/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEV_USER_ID?: string;
  readonly VITE_DEV_USER_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
