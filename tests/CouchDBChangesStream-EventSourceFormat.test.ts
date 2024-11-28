import {
  CouchDBChangesStream,
  CouchDBChange,
} from "../src/CouchDBChangesStream";

describe("CouchDBChangesStream - EventSource Format", () => {
  it("should parse changes from text/event-stream format correctly", async () => {
    const eventSourceData = `
event: change
data: {"seq":1,"id":"doc1","changes":[{"rev":"1-abc"}]}

event: change
data: {"seq":2,"id":"doc2","changes":[{"rev":"2-def"}]}

event: change
data: {"seq":3,"id":"doc3","changes":[{"rev":"3-ghi"}]}
`;

    const mockResponse: Partial<Response> = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(eventSourceData));
          controller.close();
        },
      }),
    };

    const mockFetch = jest.fn(async () => mockResponse as Response);

    const stream = new CouchDBChangesStream<any>("http://mock-couchdb", {
      feed: "eventsource",
      fetch: mockFetch,
    });

    const result: CouchDBChange<any>[] = [];
    for await (const change of stream) {
      result.push(change);
    }

    // Ожидаемый результат
    const expectedChanges: CouchDBChange<any>[] = [
      { seq: 1, id: "doc1", changes: [{ rev: "1-abc" }] },
      { seq: 2, id: "doc2", changes: [{ rev: "2-def" }] },
      { seq: 3, id: "doc3", changes: [{ rev: "3-ghi" }] },
    ];

    // Проверяем, что результат соответствует ожидаемым изменениям
    expect(result).toEqual(expectedChanges);

    // Проверяем, что fetch был вызван
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
