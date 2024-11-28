import {
  CouchDBChangesStream,
  CouchDBChange,
} from "../src/CouchDBChangesStream";

describe("CouchDBChangesStream Performance and Scalability", () => {
  it("processes a large number of changes correctly and completely", async () => {
    const changeCount = 1000;
    const changes: CouchDBChange<any>[] = Array.from(
      { length: changeCount },
      (_, i) => ({
        seq: i + 1,
        id: `doc${i + 1}`,
        changes: [{ rev: `${i + 1}-abc` }],
        deleted: false,
      }),
    );

    const mockResponse: Partial<Response> = {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          const changeStream = changes
            .map((change) => JSON.stringify(change) + "\n")
            .join("");

          controller.enqueue(new TextEncoder().encode(changeStream));
          controller.close();
        },
      }),
    };

    const mockFetch = jest.fn(async () => {
      return mockResponse as Response;
    });

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      feed: "continuous",
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];

    for await (const change of stream) {
      result.push(change);
      if (result.length === changeCount) {
        stream.stop();
      }
    }

    expect(result).toHaveLength(changeCount);
    expect(result.map((r) => r.seq)).toEqual(changes.map((c) => c.seq));
  });

  it("maintains stability with increasing data volume", async () => {
    const largeVolumes = [100, 1000, 5000];
    const performanceResults: Record<number, number> = {};

    for (const volume of largeVolumes) {
      const changes: CouchDBChange<any>[] = Array.from(
        { length: volume },
        (_, i) => ({
          seq: i + 1,
          id: `doc${i + 1}`,
          changes: [{ rev: `${i + 1}-abc` }],
          deleted: false,
        }),
      );

      const mockResponse: Partial<Response> = {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            const changeStream = changes
              .map((change) => JSON.stringify(change) + "\n")
              .join("");

            controller.enqueue(new TextEncoder().encode(changeStream));
            controller.close();
          },
        }),
      };

      const mockFetch = jest.fn(async () => {
        return mockResponse as Response;
      });

      const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
        feed: "continuous",
        fetch: mockFetch,
      });

      const result: CouchDBChange<any>[] = [];
      const startTime = performance.now();

      for await (const change of stream) {
        result.push(change);
        if (result.length === volume) {
          stream.stop();
        }
      }

      const endTime = performance.now();
      const elapsedTime = endTime - startTime;
      performanceResults[volume] = elapsedTime;

      expect(result).toHaveLength(volume);
      expect(result.map((r) => r.seq)).toEqual(changes.map((c) => c.seq));
    }

    console.log("Performance Results (ms):", performanceResults);
  });

  it("handles high throughput with multiple chunks of data", async () => {
    const chunkSize = 500;
    const chunkCount = 5;
    const changes: CouchDBChange<any>[] = Array.from(
      { length: chunkSize * chunkCount },
      (_, i) => ({
        seq: i + 1,
        id: `doc${i + 1}`,
        changes: [{ rev: `${i + 1}-abc` }],
        deleted: false,
      }),
    );

    const mockResponse: Partial<Response> = {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          changes.forEach((change, i) => {
            const changeString = JSON.stringify(change) + "\n";
            controller.enqueue(new TextEncoder().encode(changeString));
            if ((i + 1) % chunkSize === 0) {
              // Simulate chunked data
              controller.enqueue(new TextEncoder().encode("\n"));
            }
          });
          controller.close();
        },
      }),
    };

    const mockFetch = jest.fn(async () => {
      return mockResponse as Response;
    });

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      feed: "continuous",
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];

    for await (const change of stream) {
      result.push(change);
      if (result.length === changes.length) {
        stream.stop();
      }
    }

    expect(result).toHaveLength(changes.length);
    expect(result.map((r) => r.seq)).toEqual(changes.map((c) => c.seq));
  });
});
