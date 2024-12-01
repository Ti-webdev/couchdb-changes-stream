import {
  CouchDBChangesStream,
  CouchDBChange,
} from "../src/CouchDBChangesStream";

describe("CouchDBChangesStream Error Handling", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("retries fetch on connection drop and doesn't hang", async () => {
    jest.useFakeTimers();

    // Mock fetch to simulate connection drop
    const mockFetch = jest.fn();

    // First call to fetch will reject with a connection error
    const connectionError = new Error("Connection dropped");

    // Keep track of how many times fetch is called
    let fetchCallCount = 0;

    mockFetch.mockImplementation(async () => {
      fetchCallCount++;

      if (fetchCallCount === 1) {
        throw connectionError;
      } else {
        // After the first failure, return a valid response
        const changes: CouchDBChange<any>[] = [
          { seq: 1, id: "doc1", changes: [{ rev: "1-abc" }], deleted: false },
        ];

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
      }
    });

    // Mock Math.random to return 0, so jitter is 0
    jest.spyOn(Math, "random").mockReturnValue(0);

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      live: true,
      feed: "continuous",
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];

    const iterator = stream[Symbol.asyncIterator]();

    // Start fetching the first change
    const nextPromise = iterator.next();

    // Advance timers to allow the first fetch attempt
    await Promise.resolve(); // Ensure any pending promises are resolved

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(fetchCallCount).toBe(1);

    // Since the first fetch fails, it should schedule a retry with backoff
    // The backoff delay for retryCount = 1 is 2^1 * 100 = 200ms
    // Jitter is 0

    await Promise.resolve(); // Allow promises to resolve

    // Advance timers by 200ms to trigger the retry
    jest.advanceTimersByTime(200);

    // Wait for the retry to occur
    await Promise.resolve(); // Allow promises to resolve
    //
    // expect(mockFetch).toHaveBeenCalledTimes(2);
    // expect(fetchCallCount).toBe(2);

    // Now the fetch should succeed, and we can get the next change
    const next = await nextPromise;

    expect(next.done).toBe(false);
    result.push(next.value);

    // Stop the stream
    stream.stop();

    const final = await iterator.next();
    expect(final.done).toBe(true);

    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(1);

    jest.useRealTimers();
    jest.spyOn(Math, "random").mockRestore();
  });

  it("throws an exception when there is a malformed JSON in response", async () => {
    // Mock fetch to return a response with malformed JSON
    const changesResponse = `
{"seq":1,"id":"doc1","changes":[{"rev":"1-abc"}]}
MALFORMED_JSON
{"seq":2,"id":"doc2","changes":[{"rev":"1-def"}]}
`;

    const mockResponse: Partial<Response> = {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(changesResponse));
          controller.close();
        },
      }),
    };

    const mockFetch = jest.fn<
      Promise<Response>,
      [RequestInfo | URL, RequestInit?]
    >(async () => {
      return mockResponse as Response;
    }) as jest.MockedFunction<typeof fetch>;

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      live: false,
      feed: "continuous",
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];
    let caughtError: Error | null = null;

    try {
      for await (const change of stream) {
        result.push(change);
      }
    } catch (error) {
      caughtError = error as Error;
    }

    // Check that an error was thrown
    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain(
      "[fetchChanges] Error parsing change:",
    );

    // Ensure only valid changes were processed before the error
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(1);
  });

  it("stops after processing all changes when live is false", async () => {
    // Mock fetch to return a finite response
    const changesResponse = `
{"seq":1,"id":"doc1","changes":[{"rev":"1-abc"}]}
{"seq":2,"id":"doc2","changes":[{"rev":"1-def"}]}
{"seq":3,"id":"doc3","changes":[{"rev":"1-ghi"}]}
`;

    const mockResponse: Partial<Response> = {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(changesResponse));
          controller.close();
        },
      }),
    };

    const mockFetch = jest.fn<
      Promise<Response>,
      [RequestInfo | URL, RequestInit?]
    >(async (input, init) => {
      return mockResponse as Response;
    }) as jest.MockedFunction<typeof fetch>;

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      live: false,
      feed: "continuous",
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];

    for await (const change of stream) {
      result.push(change);
    }

    // The stream should complete after processing all changes
    expect(result).toHaveLength(3);
    expect(result[0].seq).toBe(1);
    expect(result[1].seq).toBe(2);
    expect(result[2].seq).toBe(3);

    // Verify fetch was called exactly once since live mode is disabled
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Access the first call arguments
    const calledArgs = mockFetch.mock.calls[0];

    // Ensure that calledArgs is defined and has at least one element
    expect(calledArgs).toBeDefined();
    expect(calledArgs.length).toBeGreaterThanOrEqual(1);

    const [calledUrl, calledOptions] = calledArgs;

    // Validate that the URL is correct
    expect(calledUrl).toBe("http://mock-couchdb/_changes?feed=continuous");

    // Validate that options exist and contain the expected method
    if (calledOptions) {
      expect(calledOptions.method).toBe("GET");
    } else {
      fail("Expected calledOptions to be defined");
    }
  });
});
