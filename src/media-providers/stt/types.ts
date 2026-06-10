// ---------------------------------------------------------------------------
// STT (Speech-to-Text) provider types
// ---------------------------------------------------------------------------

import type { MediaProvider } from '../types.js';

export interface STTInput {
  /** Path to the local audio file. */
  audioPath: string;
  /** ISO 639-1 language code or 'auto'. Each provider maps this to its own format. */
  language?: string;
}

export interface STTResult {
  text: string;
  language?: string;
  /** Duration of the processed audio in milliseconds. */
  durationMs: number;
  providerId: string;
}

export interface STTProvider extends MediaProvider {
  transcribe(input: STTInput): Promise<STTResult>;
}
