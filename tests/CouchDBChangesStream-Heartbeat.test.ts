import {
  CouchDBChangesStream,
  CouchDBChange,
} from "../src/CouchDBChangesStream";

describe("CouchDBChangesStream - Heartbeat", () => {
  let mockFetch: jest.Mock;
  const dbUrl = "http://localhost:5984/mydb";

  beforeEach(() => {
    mockFetch = jest.fn();
    jest.useFakeTimers(); // Подключаем fake timers
  });

  afterEach(() => {
    jest.useRealTimers(); // Отключаем fake timers после каждого теста
    jest.restoreAllMocks();
  });

  it("should reset heartbeat timer on receiving data", async () => {
    const mockResponseData = {
      seq: "1",
      id: "doc1",
      changes: [{ rev: "1-abc" }],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(mockResponseData) + "\n"),
          );
          controller.close();
        },
      }),
    });

    const stream = new CouchDBChangesStream(dbUrl, {
      feed: "continuous",
      heartbeat: 30_000, // 30 секунд
      live: true,
      fetch: mockFetch,
    });

    const iterator = stream[Symbol.asyncIterator]();

    const heartbeatSpy = jest.spyOn(global, "setTimeout");

    const firstChange = await iterator.next();
    expect(firstChange.done).toBe(false);
    expect(firstChange.value.seq).toBe("1");
    // Таймер heartbeat должен был быть установлен
    expect(heartbeatSpy).toHaveBeenCalledWith(expect.any(Function), 33_000); // 5000 + 10% буфер,
  });

  it("should throw an error if no data is received within heartbeat + buffer", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          // do not send any data to test heartbeat timeout
        },
      }),
    });

    const stream = new CouchDBChangesStream(dbUrl, {
      feed: "continuous",
      heartbeat: 20_000,
      fetch: mockFetch,
    });

    const iterator = stream[Symbol.asyncIterator]();

    const fetchPromise = iterator.next();

    // Прокручиваем время до истечения heartbeat таймера (20_000 + 10%)
    jest.advanceTimersByTime(22_000);

    await expect(fetchPromise).rejects.toThrow(
      "Heartbeat timeout: no data received from server after 22000 ms",
    );
  });

  it("should continue working if data is received before heartbeat timeout", async () => {
    const mockResponseData = {
      seq: "1",
      id: "doc1",
      changes: [{ rev: "1-abc" }],
    };

    mockFetch.mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          // Отправляем данные перед истечением таймера
          setTimeout(() => {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(mockResponseData) + "\n"),
            );
            controller.close();
          }, 2000); // Data arrives before heartbeat timeout (3000)
        },
      }),
    });

    const stream = new CouchDBChangesStream(dbUrl, {
      feed: "continuous",
      heartbeat: 3_000,
      fetch: mockFetch,
      live: true,
    });

    const iterator = stream[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    await Promise.resolve();
    jest.advanceTimersByTime(2_999);
    await Promise.resolve();

    const firstChange = await nextPromise;
    expect(firstChange.done).toBe(false);
    expect(firstChange.value.seq).toBe("1");

    // Let's make sure that a timeout error does not occur
    await Promise.resolve();
    jest.advanceTimersByTime(2_999);
    await Promise.resolve();

    const secondFetch = iterator.next();
    await expect(secondFetch).resolves.not.toThrow();
  });
});
