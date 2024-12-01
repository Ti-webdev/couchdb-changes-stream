export type CouchDBChange<T> = {
  seq: string | number;
  id: string;
  changes: { rev: string }[];
  deleted?: boolean;
  doc?: T;
};

export interface CouchDBChangesOptions {
  since?: string | number;
  filter?: string;
  doc_ids?: string[] | readonly string[];
  selector?: Record<string, unknown>;
  conflicts?: boolean;
  descending?: boolean;
  heartbeat?: boolean | number;
  include_docs?: boolean;
  attachments?: boolean;
  att_encoding_info?: boolean;
  limit?: number;
  style?: "main_only" | "all_docs";
  timeout?: number;
  seq_interval?: number;
  feed?: "normal" | "longpoll" | "continuous" | "eventsource"; // Добавлено поле feed
  live?: boolean;
  abortController?: AbortController;
  fetch?: typeof globalThis.fetch;
}

export class CouchDBChangesStream<T> {
  private readonly options:
    | CouchDBChangesOptions
    | Readonly<CouchDBChangesOptions>;
  private readonly abortController: AbortController;
  private readonly fetch: typeof globalThis.fetch;
  private activeSeq?: string | number;

  constructor(
    private readonly dbUrl: string,
    {
      abortController,
      fetch,
      ...options
    }: CouchDBChangesOptions | Readonly<CouchDBChangesOptions> = {},
  ) {
    this.options = options;
    this.abortController = abortController || new AbortController();
    this.fetch = fetch || globalThis.fetch;
  }

  private buildUrl(): URL {
    const url = new URL(`${this.dbUrl}/_changes`);
    Object.entries(this.options).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        if (key !== "doc_ids" && key !== "selector" && key !== "live") {
          url.searchParams.append(key, value.toString());
        }
      }
    });

    // Add `since` parameter if `activeSeq` is set
    if (this.activeSeq !== undefined) {
      url.searchParams.set("since", this.activeSeq.toString());
    }

    return url;
  }

  private async *fetchChanges(): AsyncGenerator<
    CouchDBChange<T>,
    void,
    unknown
  > {
    const headers = { Accept: "application/json" };

    const signal = this.abortController.signal;

    const isNormal = this.options.feed === "normal" || !this.options.feed;
    const isLongpoll = this.options.feed === "longpoll";
    const isContinuous = this.options.feed === "continuous";
    const isEventsource = this.options.feed === "eventsource";

    // Heartbeat configuration
    const usesHeartbeat =
      (isContinuous || isEventsource) && this.options.heartbeat !== 0;
    let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
    let heartbeatPromise: Promise<never> = new Promise<never>(() => {});

    let abortControllerWithHeartbeat: AbortController = new AbortController();

    signal.addEventListener("abort", () => {
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = null;
      }
      abortControllerWithHeartbeat.abort(signal.reason);
    });
    if (signal.aborted) {
      abortControllerWithHeartbeat.abort(signal.reason);
    }

    const resetHeartbeat = () => {
      if (!usesHeartbeat) return;

      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
      }

      if (abortControllerWithHeartbeat.signal.aborted) {
        abortControllerWithHeartbeat = new AbortController();
        if (signal.aborted) {
          abortControllerWithHeartbeat.abort(signal.reason);
        }
      }

      const heartbeatInterval =
        typeof this.options.heartbeat === "number"
          ? this.options.heartbeat
          : 60000; // Default 60 seconds
      const timeoutBuffer = Math.max(heartbeatInterval * 0.1, 1000); // 10% buffer or at least 1s
      const adjustedTimeout = heartbeatInterval + timeoutBuffer;
      heartbeatPromise = new Promise<never>((resolve, reject) => {
        heartbeatTimeout = setTimeout(() => {
          const reason = `Heartbeat timeout: no data received from server after ${adjustedTimeout} ms`;
          abortControllerWithHeartbeat.abort(reason);
          reject(new Error(reason));
        }, adjustedTimeout);

        if (typeof heartbeatTimeout === "object" && heartbeatTimeout.unref) {
          heartbeatTimeout.unref();
        }
      });
    };

    let retryCount = 0;

    while (!signal.aborted) {
      try {
        resetHeartbeat();

        const url = this.buildUrl(); // Dynamic URL update with new `since`

        const hasDocIds =
          Array.isArray(this.options.doc_ids) &&
          this.options.doc_ids.length > 0;

        const hasSelector =
          this.options.selector && typeof this.options.selector === "object";

        const requestBody = hasDocIds
          ? { doc_ids: this.options.doc_ids }
          : hasSelector
            ? { selector: this.options.selector }
            : undefined;

        const body = requestBody ? JSON.stringify(requestBody) : undefined;

        const method = body ? "POST" : "GET";

        const response = await Promise.race([
          this.fetch(`${url.origin}${url.pathname}${url.search}`, {
            method,
            headers: {
              ...headers,
              ...(method === "POST"
                ? { "Content-Type": "application/json" }
                : {}),
              ...(url.username && url.password
                ? {
                    Authorization: `Basic ${btoa(`${url.username}:${url.password}`)}`,
                  }
                : {}),
            },
            body,
            signal: abortControllerWithHeartbeat.signal,
          }),
          heartbeatPromise,
        ]);

        if (!response.ok) {
          // console.error(`[fetchChanges] HTTP error: ${response.status}`);
          const textError = await Promise.race([
            response.text(),
            heartbeatPromise,
          ]);
          throw new Error(`HTTP error: ${response.status}\n${textError}`);
        }

        if (isNormal || isLongpoll) {
          const data = await Promise.race([response.json(), heartbeatPromise]);
          for (const change of data.results) {
            this.activeSeq = change.seq;
            yield change;
          }
          if (data.last_seq) {
            this.activeSeq = data.last_seq;
          }

          // If `longpoll`, restart the loop after processing changes
          if (isLongpoll && !signal.aborted) {
            continue;
          }

          return; // Exit for `normal` after processing all changes
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("Unable to read response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (!signal.aborted) {
          const { value, done } = await Promise.race([
            reader.read(),
            heartbeatPromise,
          ]);
          resetHeartbeat();

          buffer += decoder.decode(value, { stream: true });

          let newlineIndex;
          while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
            if (signal.aborted) {
              return;
            }
            let line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);

            if (isEventsource) {
              if (line.startsWith("event:")) {
                continue; // Игнорируем строки event:
              }
              if (line.startsWith("data:")) {
                line = line.slice(5);
              }
            }

            if (line.trim() === "") {
              if (done) {
                return;
              }
              continue;
            }

            try {
              const change: CouchDBChange<T> = JSON.parse(line);
              this.activeSeq = change.seq;
              yield change;
            } catch (error) {
              if (!signal.aborted && buffer.indexOf("\n", newlineIndex)) {
                throw new Error(
                  `[fetchChanges] Error parsing change: ${line} ${error}`,
                );
              }
            }
          }

          if (done || signal.aborted) {
            return; // No more data to read
          }
        }
      } catch (error) {
        if (signal.aborted) break;

        if (this.options.live) {
          retryCount++;
          const backoff = Math.min(2 ** retryCount * 100, 30000); // Exponential backoff with max 30 seconds
          const jitter = Math.random() * 100; // Add jitter
          const delay = backoff + jitter;

          console.debug(
            `[fetchChanges] Error fetching changes: ${
              error instanceof Error ? error.message : error
            }. Retrying in ${(delay / 1000).toFixed(2)} seconds...`,
          );

          if (heartbeatTimeout) {
            clearTimeout(heartbeatTimeout);
            heartbeatTimeout = null;
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }
  }

  public async *[Symbol.asyncIterator](): AsyncIterableIterator<
    CouchDBChange<T>
  > {
    try {
      yield* this.fetchChanges();
    } finally {
      this.abortController.abort(); // Ensure we abort if the iterator is closed
    }
  }

  public stop() {
    this.abortController.abort();
  }
}
