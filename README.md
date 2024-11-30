# trading212-ynab

### Why request an export rather than use individual API methods?

The Trading 212 API is super buggy/broken as of writing this 2024-11-30, with the majority of the endpoints returning errors like `InternalError` or empty responses entirely. Until they can improve their API, exports are the most reliable way to get your data.
