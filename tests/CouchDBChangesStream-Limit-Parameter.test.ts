import {
  CouchDBChangesStream,
  CouchDBChange,
} from "../src/CouchDBChangesStream";

describe("CouchDBChangesStream - Limit Parameter", () => {
  it("should return only the specified number of changes when limit is set", async () => {
    const changes: CouchDBChange<any>[] = Array.from(
      { length: 10 },
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

    const mockFetch = jest.fn(async (url) => {
      const urlObj = new URL(url);
      const limitParam = urlObj.searchParams.get("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : changes.length;

      const responseStream = changes
        .slice(0, limit) // Применяем limit
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

    for (const limit of [1, 5, 10]) {
      const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
        limit,
        feed: "continuous",
        fetch: mockFetch,
      });

      const result: CouchDBChange<any>[] = [];
      for await (const change of stream) {
        result.push(change);
      }

      // Проверяем, что количество возвращенных изменений соответствует лимиту
      expect(result).toHaveLength(limit);

      // Проверяем, что полученные изменения соответствуют первым `limit` изменениям
      expect(result.map((r) => r.seq)).toEqual(
        changes.slice(0, limit).map((c) => c.seq),
      );
    }

    expect(mockFetch).toHaveBeenCalledTimes(3); // Проверяем, что fetch вызывался для каждого limit
  });

  it("should return all changes if limit is not set", async () => {
    const changes: CouchDBChange<any>[] = Array.from(
      { length: 10 },
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

    const mockFetch = jest.fn(async () => mockResponse as Response);

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      feed: "continuous",
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];
    for await (const change of stream) {
      result.push(change);
    }

    // Проверяем, что возвращены все изменения
    expect(result).toHaveLength(changes.length);

    // Проверяем, что полученные изменения соответствуют всем изменениям
    expect(result.map((r) => r.seq)).toEqual(changes.map((c) => c.seq));

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
