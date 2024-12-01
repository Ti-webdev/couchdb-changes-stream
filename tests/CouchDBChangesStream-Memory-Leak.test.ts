import {
  CouchDBChangesStream,
  CouchDBChange,
} from "../src/CouchDBChangesStream";

if (typeof global.gc !== "function") {
  console.warn(
    "Skipping tests: Run Node.js with --expose-gc to enable garbage collection.",
  );
  test.skip("Garbage collection is not enabled.", () => {});
} else {
  describe("CouchDBChangesStream Memory Leak Test", () => {
    it("should not cause memory leaks after being stopped", async () => {
      // Mock fetch response
      const changes: CouchDBChange<any>[] = Array.from(
        { length: 1000 },
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
            changes.forEach((change) => {
              const changeString = JSON.stringify(change) + "\n";
              controller.enqueue(new TextEncoder().encode(changeString));
            });
            controller.close();
          },
        }),
      };

      const mockFetch = jest.fn(async () => mockResponse as Response);

      // Measure memory before creating the stream
      if (global.gc) global.gc(); // Force garbage collection
      const memoryBefore = process.memoryUsage().heapUsed;

      // Create and consume the stream
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

      // Stop the stream and allow garbage collection
      stream.stop();
      if (global.gc) global.gc();

      // Measure memory after the stream is stopped
      const memoryAfter = process.memoryUsage().heapUsed;

      // Log memory usage for analysis
      console.log(`Memory Before: ${memoryBefore}`);
      console.log(`Memory After: ${memoryAfter}`);
      console.log(`Memory Difference: ${memoryAfter - memoryBefore}`);

      // Allow for slightly larger tolerances in memory usage differences
      const memoryLeakThreshold = 1024 * 100; // 100 KB

      expect(memoryAfter - memoryBefore).toBeLessThan(memoryLeakThreshold);
    });
  });
}
