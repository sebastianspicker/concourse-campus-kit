import { createAbortError } from "@/platform/http/errors";

type CoordinatedLoad = {
  controller: AbortController;
  consumers: Set<symbol>;
  promise: Promise<unknown>;
};

const inFlight = new Map<string, CoordinatedLoad>();
const DEFAULT_LOADER_TIMEOUT_MS = 15_000;

function runCoordinatedLoader<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
): CoordinatedLoad {
  const controller = new AbortController();
  const coordinated: CoordinatedLoad = {
    controller,
    consumers: new Set(),
    promise: Promise.resolve(),
  };
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Cache loader timeout"));
    }, DEFAULT_LOADER_TIMEOUT_MS);
  });

  let loaded: Promise<T>;
  try {
    loaded = Promise.resolve(loader(controller.signal));
  } catch (error: unknown) {
    loaded = Promise.reject(error);
  }
  coordinated.promise = Promise.race([loaded, deadline])
    .then((value) => {
      if (controller.signal.aborted) throw createAbortError();
      return value;
    })
    .finally(() => {
      clearTimeout(timeout);
      if (inFlight.get(key) === coordinated) inFlight.delete(key);
    });
  void coordinated.promise.catch(() => undefined);
  inFlight.set(key, coordinated);
  return coordinated;
}

function attachConsumer<T>(load: CoordinatedLoad, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(createAbortError());

  const consumer = Symbol("cache-consumer");
  load.consumers.add(consumer);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const detach = (cancelled: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      load.consumers.delete(consumer);
      if (cancelled && load.consumers.size === 0) load.controller.abort();
    };
    const onAbort = () => {
      detach(true);
      reject(createAbortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    load.promise.then(
      (value) => {
        if (settled) return;
        detach(false);
        resolve(value as T);
      },
      (error: unknown) => {
        if (settled) return;
        detach(false);
        reject(error);
      },
    );
  });
}

/** Joins the one coordinated loader for the key, starting it if none is in flight. */
export async function shareLoad<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw createAbortError();

  let coordinated = inFlight.get(key);
  if (coordinated?.controller.signal.aborted) {
    if (inFlight.get(key) === coordinated) inFlight.delete(key);
    coordinated = undefined;
  }
  coordinated ??= runCoordinatedLoader(key, loader);
  return attachConsumer<T>(coordinated, signal);
}

/** Aborts the shared transport for every affected key. */
export function clearCache(key?: string): void {
  if (key) {
    inFlight.get(key)?.controller.abort();
    inFlight.delete(key);
    return;
  }

  for (const load of inFlight.values()) load.controller.abort();
  inFlight.clear();
}
