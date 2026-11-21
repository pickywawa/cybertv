import * as Comlink from 'comlink';
import type { DataApi } from '@/workers/data.worker';
import type { SearchApi } from '@/workers/search.worker';
import { getProxyBase } from './net/http';

let data: Comlink.Remote<DataApi> | null = null;
let search: Comlink.Remote<SearchApi> | null = null;

export function dataWorker() {
  if (!data) {
    data = Comlink.wrap<DataApi>(new Worker(new URL('../workers/data.worker.ts', import.meta.url), { type: 'module' }));
    void data.init(getProxyBase());
  }
  return data;
}

export function searchWorker() {
  if (!search) search = Comlink.wrap<SearchApi>(new Worker(new URL('../workers/search.worker.ts', import.meta.url), { type: 'module' }));
  return search;
}

/** must be called after the native proxy port is known */
export function reinitWorkers() {
  if (data) void data.init(getProxyBase());
}

export const proxyCb = Comlink.proxy;
