import {
  CouchDBChangesStream,
  CouchDBChange,
  CouchDBChangesOptions,
} from "../src/CouchDBChangesStream";

import * as fc from "fast-check";

type NestedDocument = {
  _id: string;
  _rev: string;
  type: string;
  data: {
    nested: {
      field: string;
      value: number;
    };
  };
};

type SimpleDocument = {
  _id: string;
  _rev: string;
  type: string;
};

function createMockFetch<T>(
  changes: CouchDBChange<T>[],
): jest.Mock<Promise<Response>> {
  return jest.fn(async () => {
    const responseStream = changes
      .map((change) => JSON.stringify(change) + "\n")
      .join("");

    const mockResponse: Partial<Response> = {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(responseStream));
          controller.close();
        },
      }),
    };

    return mockResponse as Response;
  });
}

describe("CouchDBChangesStream", () => {
  it("returns changes in the correct order and type", async () => {
    const changes: CouchDBChange<any>[] = [
      { seq: 1, id: "doc1", changes: [{ rev: "1-abc" }], deleted: false },
      { seq: 2, id: "doc2", changes: [{ rev: "1-def" }], deleted: false },
    ];

    const mockFetch = createMockFetch(changes);

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      feed: "continuous",
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];
    for await (const change of stream) {
      result.push(change);
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(changes.length);
    expect(result.map((r) => r.seq)).toEqual(changes.map((c) => c.seq));
  });

  it("ensures pause between processing changes", async () => {
    const changes: CouchDBChange<any>[] = [
      { seq: 1, id: "doc1", changes: [{ rev: "1-abc" }], deleted: false },
      { seq: 2, id: "doc2", changes: [{ rev: "1-def" }], deleted: false },
    ];

    const mockFetch = createMockFetch(changes);

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      feed: "continuous",
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];
    let processing = false;

    for await (const change of stream) {
      expect(processing).toBe(false);
      processing = true;

      // Simulate long processing time
      await new Promise((resolve) => setTimeout(resolve, 100));

      result.push(change);
      processing = false;

      if (result.length === changes.length) {
        stream.stop();
      }
    }

    expect(result).toHaveLength(changes.length);
  });

  it("correctly stops when stop() or AbortController is called", async () => {
    const changes: CouchDBChange<any>[] = [
      { seq: 1, id: "doc1", changes: [{ rev: "1-abc" }], deleted: false },
      { seq: 2, id: "doc2", changes: [{ rev: "1-def" }], deleted: false },
    ];

    const mockFetch = createMockFetch(changes);

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      feed: "continuous",
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];
    const iterator = stream[Symbol.asyncIterator]();

    // Read first change
    const next1 = await iterator.next();
    expect(next1.done).toBe(false);
    result.push(next1.value);

    // Call stop()
    stream.stop();

    // Attempt to read the next change
    const next2 = await iterator.next();
    expect(next2.done).toBe(true);

    expect(result).toHaveLength(1);
  });

  it("stops the stream when AbortController is aborted", async () => {
    const changes: CouchDBChange<any>[] = [
      { seq: 1, id: "doc1", changes: [{ rev: "1-abc" }], deleted: false },
      { seq: 2, id: "doc2", changes: [{ rev: "1-def" }], deleted: false },
    ];

    const abortController = new AbortController();
    const mockFetch = createMockFetch(changes);

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      feed: "continuous",
      fetch: mockFetch,
      abortController,
    });

    const result: CouchDBChange<any>[] = [];
    const iterator = stream[Symbol.asyncIterator]();

    // Read first change
    const next1 = await iterator.next();
    expect(next1.done).toBe(false);
    result.push(next1.value);

    // Abort the signal
    abortController.abort();

    // Attempt to read the next change
    const next2 = await iterator.next();
    expect(next2.done).toBe(true);

    expect(result).toHaveLength(1);
  });

  it("isolated test for filter parameter", async () => {
    const mockFetch = createMockFetch([]);
    const options = {
      filter: "",
      doc_ids: [],
      feed: "continuous",
      fetch: mockFetch,
    } as const;

    const stream = new CouchDBChangesStream<any>(
      "http://mock-couchdb",
      options,
    );

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const fetchCallArgs = mockFetch.mock.calls[0];
    const fetchUrl = fetchCallArgs[0] as string;
    const url = new URL(fetchUrl);
    const params = url.searchParams;

    expect(params.has("filter")).toBe(false);
  });

  it("correctly reflects passed parameters in the HTTP request", async () => {
    const mockFetch = createMockFetch([]);

    const options = {
      since: "now",
      filter: "test_filter",
      doc_ids: ["doc1", "doc2"],
      feed: "continuous",
      conflicts: true,
      descending: false,
      include_docs: true,
      limit: 5,
      fetch: mockFetch,
    } as const;

    const stream = new CouchDBChangesStream<any>(
      "http://mock-couchdb",
      options,
    );

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const fetchCallArgs = mockFetch.mock.calls[0];
    const fetchUrl = fetchCallArgs[0] as string;
    const fetchOptions = fetchCallArgs[1] as RequestInit;

    if (!fetchOptions) {
      throw new Error("fetchOptions is undefined");
    }

    const url = new URL(fetchUrl);
    const params = url.searchParams;

    expect(params.get("since")).toBe("now");
    expect(params.get("filter")).toBe("test_filter");
    expect(params.get("include_docs")).toBe("true");
    expect(params.get("limit")).toBe("5");

    expect(fetchOptions.method).toBe("POST");
    expect(fetchOptions.body).toEqual(
      JSON.stringify({ doc_ids: ["doc1", "doc2"] }),
    );
  });

  it("correctly maps changes to the specified document type", async () => {
    const nestedChanges: CouchDBChange<NestedDocument>[] = [
      {
        seq: 1,
        id: "nested_doc1",
        changes: [{ rev: "1-nested" }],
        doc: {
          _id: "nested_doc1",
          _rev: "1-nested",
          type: "nested",
          data: { nested: { field: "example", value: 42 } },
        },
      },
    ];

    const simpleChanges: CouchDBChange<SimpleDocument>[] = [
      {
        seq: 2,
        id: "simple_doc1",
        changes: [{ rev: "1-simple" }],
        doc: {
          _id: "simple_doc1",
          _rev: "1-simple",
          type: "simple",
        },
      },
    ];

    const mockFetchNested = createMockFetch(nestedChanges);
    const mockFetchSimple = createMockFetch(simpleChanges);

    const nestedStream = new CouchDBChangesStream<NestedDocument>(
      "http://mock-couchdb",
      { include_docs: true, feed: "continuous", fetch: mockFetchNested },
    );

    const simpleStream = new CouchDBChangesStream<SimpleDocument>(
      "http://mock-couchdb",
      { include_docs: true, feed: "continuous", fetch: mockFetchSimple },
    );

    const nestedResult: CouchDBChange<NestedDocument>[] = [];
    for await (const change of nestedStream) {
      nestedResult.push(change);
    }

    const simpleResult: CouchDBChange<SimpleDocument>[] = [];
    for await (const change of simpleStream) {
      simpleResult.push(change);
    }

    // Validate nested document results
    expect(nestedResult).toHaveLength(nestedChanges.length);
    expect(nestedResult[0].doc).toEqual(nestedChanges[0].doc);

    // Validate simple document results
    expect(simpleResult).toHaveLength(simpleChanges.length);
    expect(simpleResult[0].doc).toEqual(simpleChanges[0].doc);
  });

  it("excludes 'live' from URL parameters but affects behavior", async () => {
    const mockFetch = createMockFetch([]);
    const options: CouchDBChangesOptions = {
      since: "now",
      feed: "continuous",
      filter: "test_filter",
      live: true, // This is the key parameter we're testing
      include_docs: true,
      fetch: mockFetch,
    };

    const stream = new CouchDBChangesStream<any>(
      "http://mock-couchdb",
      options,
    );

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const fetchCallArgs = mockFetch.mock.calls[0];
    const fetchUrl = fetchCallArgs[0] as string;
    const fetchOptions = fetchCallArgs[1] as RequestInit;

    if (!fetchOptions) {
      throw new Error("fetchOptions is undefined");
    }

    const url = new URL(fetchUrl);
    const params = url.searchParams;

    // Ensure 'live' does not appear as a query parameter
    expect(params.get("live")).toBeNull();

    // Check that other parameters are still included
    expect(params.get("since")).toBe("now");
    expect(params.get("filter")).toBe("test_filter");
    expect(params.get("include_docs")).toBe("true");

    // Validate the fetch method and body
    expect(fetchOptions.method).toBe("GET");
    expect(fetchOptions.body).toBeUndefined();

    // Further behavior checks can be added for live mode if necessary
  });

  it("adds Basic Auth header when credentials are included in URL", async () => {
    const mockFetch = jest.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        return new Response(JSON.stringify({ results: [], last_seq: "0" }));
      },
    ) as jest.MockedFunction<typeof fetch>;
    const options = {
      since: "now",
      include_docs: true,
      fetch: mockFetch,
    };

    const stream = new CouchDBChangesStream<any>(
      "https://admin:password@mock-couchdb",
      options,
    );

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const fetchCallArgs = mockFetch.mock.calls[0];
    const fetchOptions = fetchCallArgs[1] as RequestInit;

    expect(fetchOptions?.headers).toBeDefined();
    expect(
      "Authorization" in fetchOptions?.headers! &&
        fetchOptions?.headers!["Authorization"],
    ).toBe("Basic " + btoa("admin:password"));
  });

  it("processes all changes and stops in 'normal' mode", async () => {
    // Mock fetch to return a finite response
    const changesResponse = {
      results: [
        { seq: 1, id: "doc1", changes: [{ rev: "1-abc" }], deleted: false },
        { seq: 2, id: "doc2", changes: [{ rev: "1-def" }], deleted: false },
      ],
      last_seq: "2",
    };

    const mockFetch = jest.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        return new Response(JSON.stringify(changesResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      feed: "normal",
      include_docs: true,
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];

    for await (const change of stream) {
      result.push(change);
    }

    // Check results
    expect(result).toHaveLength(2);
    expect(result[0].seq).toBe(1);
    expect(result[1].seq).toBe(2);

    // Check fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("_changes");
  });

  it("processes changes in 'longpoll' mode and continues waiting for updates", async () => {
    // Mock fetch to return different responses on each call
    const firstResponse = {
      results: [
        { seq: 1, id: "doc1", changes: [{ rev: "1-abc" }], deleted: false },
      ],
      last_seq: "1",
    };

    const secondResponse = {
      results: [
        { seq: 2, id: "doc2", changes: [{ rev: "1-def" }], deleted: false },
      ],
      last_seq: "2",
    };

    const mockFetch = jest
      .fn()
      .mockImplementationOnce(async () => {
        return new Response(JSON.stringify(firstResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
      .mockImplementationOnce(async () => {
        return new Response(JSON.stringify(secondResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as jest.MockedFunction<typeof fetch>;

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      feed: "longpoll",
      include_docs: true,
      live: true,
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];
    const iterator = stream[Symbol.asyncIterator]();

    // Read first set of changes
    result.push((await iterator.next()).value);

    // Read second set of changes
    result.push((await iterator.next()).value);

    // Stop the stream
    stream.stop();

    // Check results
    expect(result).toHaveLength(2);
    expect(result[0].seq).toBe(1);
    expect(result[1].seq).toBe(2);

    // Check fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
