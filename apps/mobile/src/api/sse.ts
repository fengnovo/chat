import { fetch as streamingFetch } from 'expo/fetch';
import { createRunStream, type RunStreamCallbacks } from './run-stream';
export type { RunStreamHandle } from './run-stream';

export function subscribeRunStream(
  baseUrl: string,
  token: string,
  runId: string,
  callbacks: RunStreamCallbacks,
) {
  return createRunStream(
    streamingFetch as typeof fetch,
    baseUrl,
    token,
    runId,
    callbacks,
  );
}
