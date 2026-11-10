import type { OverapiBridge } from '../preload/index';

declare global {
  interface Window {
    overapi: OverapiBridge;
  }
}

export {};
