import {
  CouchDBChangesStream,
  CouchDBChange,
} from "../src/CouchDBChangesStream";

describe("CouchDBChangesStream - Automatic Reconnection", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("should automatically reconnect and continue from the last seq without duplicates", async () => {
    jest.useFakeTimers();

    // Simulate changes before and after connection drop
    const initialChanges: CouchDBChange<any>[] = [
      { seq: 1, id: "doc1", changes: [{ rev: "1-abc" }] },
      { seq: 2, id: "doc2", changes: [{ rev: "1-def" }] },
      // Connection will drop after this change
    ];

    const subsequentChanges: CouchDBChange<any>[] = [
      { seq: 3, id: "doc3", changes: [{ rev: "1-ghi" }] },
      { seq: 4, id: "doc4", changes: [{ rev: "1-jkl" }] },
    ];

    const mockFetch = jest.fn();
    let fetchCallCount = 0;

    mockFetch.mockImplementation(async () => {
      fetchCallCount++;

      if (fetchCallCount === 1) {
        // First fetch returns initial changes and simulates a connection drop
        const responseStream = initialChanges
          .map((change) => JSON.stringify(change) + "\n")
          .join("");

        const body = new ReadableStream({
          start(controller) {
            // Enqueue initial changes
            controller.enqueue(new TextEncoder().encode(responseStream));

            // Simulate connection drop after a short delay
            setTimeout(() => {
              controller.error(new Error("Connection dropped"));
            }, 100); // 100ms задержка перед разрывом соединения
          },
        });

        const mockResponse: Partial<Response> = {
          ok: true,
          status: 200,
          body,
        };

        return mockResponse as Response;
      } else {
        // Subsequent fetch returns remaining changes
        const responseStream = subsequentChanges
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

    // Suppress console errors for clean test output
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      live: true,
      feed: "continuous",
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];
    const iterator = stream[Symbol.asyncIterator]();

    // Process changes asynchronously
    const processChanges = async () => {
      try {
        for await (const change of iterator) {
          result.push(change);
          // Simulate processing time
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (result.length === 4) {
            stream.stop();
          }
        }
      } catch (error) {
        // Should not reach here
        fail("Unexpected error during processing: " + error);
      }
    };

    const processingPromise = processChanges();

    // Advance timers to simulate passage of time
    await jest.advanceTimersByTimeAsync(650);

    // At this point, connection should have dropped and reconnection should occur
    expect(fetchCallCount).toBeGreaterThanOrEqual(2);

    // Finish processing
    await processingPromise;

    // Verify that no duplicates are present
    const seqs = result.map((change) => change.seq);
    const uniqueSeqs = Array.from(new Set(seqs));
    expect(seqs).toEqual(uniqueSeqs);

    // Verify that all changes are received
    const expectedChanges = [...initialChanges, ...subsequentChanges];
    expect(result).toEqual(expectedChanges);

    consoleErrorSpy.mockRestore();
    jest.useRealTimers();
  });
});
