'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  clearPersistedRun,
  readPersistedRun,
  writePersistedRun,
} from '@/app/lib/persistence';

import { AppSkeleton, ChatRuntime } from './chat-runtime';
import type { ChatBootstrap, RunSummary } from './types';
import { failureFromRun, isPendingStatus } from './utils';

export function ResilientChat() {
  const isClient = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [bootstrap, setBootstrap] = useState<ChatBootstrap | null>(null);

  useEffect(() => {
    if (!isClient) return;
    const controller = new AbortController();
    const initialRun = readPersistedRun();

    const bootstrapRequest: Promise<ChatBootstrap> = initialRun
      ? fetch(`/api/agent/runs/${encodeURIComponent(initialRun.runId)}`, {
          signal: controller.signal,
        }).then(async (response) => {
          if (response.status === 404) {
            clearPersistedRun();
            return {
              initialRun: { ...initialRun, pending: false },
              initialFailure: null,
            } satisfies ChatBootstrap;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const run = (await response.json()) as RunSummary;
          const reconciled = {
            ...initialRun,
            pending: isPendingStatus(run.status),
          };
          writePersistedRun(reconciled);
          return {
            initialRun: reconciled,
            initialFailure: failureFromRun(run),
          } satisfies ChatBootstrap;
        })
      : Promise.resolve({ initialRun: null, initialFailure: null });

    void bootstrapRequest
      .then(setBootstrap)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setBootstrap({ initialRun, initialFailure: null });
      });

    return () => controller.abort();
  }, [isClient]);

  if (!isClient || !bootstrap) {
    return <AppSkeleton />;
  }

  return (
    <ChatRuntime
      initialFailure={bootstrap.initialFailure}
      initialRun={bootstrap.initialRun}
    />
  );
}
