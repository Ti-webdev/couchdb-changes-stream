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
  private dbUrl: string;
  private options: CouchDBChangesOptions | Readonly<CouchDBChangesOptions>;
  private abortController: AbortController;
  private activeSeq?: string | number;
  private fetch: typeof globalThis.fetch;

  constructor(
    dbUrl: string,
    {
      abortController,
      fetch,
      ...options
    }: CouchDBChangesOptions | Readonly<CouchDBChangesOptions> = {},
  ) {
    this.dbUrl = dbUrl;
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
    const isEventsource = this.options.feed === "eventsource";

    let retryCount = 0;

    while (!signal.aborted) {
      try {
        const url = this.buildUrl(); // Динамически обновляем URL с новым `since`

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

        const response = await this.fetch(
          `${url.origin}${url.pathname}${url.search}`,
          {
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
            signal,
          },
        );

        if (!response.ok) {
          // console.error(`[fetchChanges] HTTP error: ${response.status}`);
          throw new Error(
            `HTTP error: ${response.status}\n${await response.text()}`,
          );
        }

        if (isNormal || isLongpoll) {
          const data = await response.json();
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
          const { value, done } = await reader.read();

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

          // console.error(
          //   `[fetchChanges] Error fetching changes: ${
          //     error instanceof Error ? error.message : error
          //   }. Retrying in ${(delay / 1000).toFixed(2)} seconds...`,
          // );

          await new Promise((resolve) => setTimeout(resolve, delay));
          // console.debug("[fetchChanges] Retrying...");
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
