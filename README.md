
# CouchDBChangesStream Documentation

---

## Description

`CouchDBChangesStream` is a TypeScript class for handling real-time changes in a CouchDB database through the `_changes` API. It supports `normal`, `longpoll`, `continuous`, and `eventsource` modes, with filtering via `selector` and automatic reconnection in `live` mode.

---

## Installation

Install the package via npm:

```bash
npm install couchdb-changes-stream
```

---

## Usage

### Example

```typescript
import { CouchDBChangesStream } from "couchdb-changes-stream";

const changesStream = new CouchDBChangesStream(
  "http://localhost:5984/mydb",
  {
    feed: "continuous",
    include_docs: true,
    since: "now",
    heartbeat: 10000,
    selector: {
      type: "message",
    },
  },
);

(async () => {
  try {
    for await (const change of changesStream) {
      console.log("Change:", change);

      // Process data
      if (change.doc) {
        console.log("Document:", change.doc);
      }
    }
  } catch (error) {
    console.error("Error in changes stream:", error);
  }
})();
```

---

## Parameters

### Constructor

```typescript
new CouchDBChangesStream<T>(
  dbUrl: string,
  options: CouchDBChangesOptions | Readonly<CouchDBChangesOptions>,
)
```

### Constructor Parameters

| Parameter          | Type                                         | Description                                                                 |
|--------------------|----------------------------------------------|-----------------------------------------------------------------------------|
| `dbUrl`            | `string`                                    | The CouchDB database URL (e.g., `http://localhost:5984/mydb`).              |
| `options`          | `CouchDBChangesOptions`                     | The query options. Supports the same parameters as CouchDB `_changes` API. |

### Fields in `CouchDBChangesOptions`

| Field              | Type                                         | Description                                                                 |
|--------------------|----------------------------------------------|-----------------------------------------------------------------------------|
| `since`            | `string \| number`                          | The sequence to start from (`now` or a number).                            |
| `filter`           | `string`                                    | Name of the filter (e.g., `_selector`).                                     |
| `doc_ids`          | `string[] \| readonly string[]`             | List of document IDs to filter.                                            |
| `selector`         | `Record<string, unknown>`                   | A JSON object for selecting documents (works only with `POST`).            |
| `feed`             | `"normal" \| "longpoll" \| "continuous" \| "eventsource"` | Feed mode.                                                                 |
| `include_docs`     | `boolean`                                   | Include document body in changes.                                          |
| `heartbeat`        | `boolean \| number`                         | Frequency of keep-alive messages in milliseconds.                          |
| `live`             | `boolean`                                   | Enable live mode with automatic reconnection.                              |
| `timeout`          | `number`                                    | Timeout for waiting for changes in milliseconds.                           |

---

## Features

- **Support for all modes:** `normal`, `longpoll`, `continuous`, `eventsource`.
- **Filtering via `selector`:** Uses the `POST` method when `selector` is present.
- **Automatic reconnection:** Enabled in `live` mode.
- **Heartbeat support:** Keeps connections alive.
- **Scalable:** Asynchronous stream for handling large data volumes.

---

## Methods

### `stop`

```typescript
public stop(): void
```

Stops the current changes stream.

**Example:**
```typescript
changesStream.stop();
```

---

## Errors

- `HTTP error: 400`: Invalid request parameters (e.g., incorrect `selector`).
- `HTTP error: 401`: Authentication error.
- `Error parsing change`: Failed to parse data from the stream.

---

## Usage Tips

1. **Use `heartbeat`** to keep connections alive.
2. **Add exception handling** to properly manage network errors.
3. **Prefer `selector` over `filter`** for more flexible document selection.
4. **Call `stop`** when done to terminate the stream gracefully.

---

## License

This project is distributed under the [MIT License](LICENSE).

---

For questions or issues, feel free to reach out! 🚀
