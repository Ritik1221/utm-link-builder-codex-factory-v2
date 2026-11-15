# Product goals

This is the only file you maintain. Agents read it and never edit it.

## Product

A tiny service used to smoke-test the factory.

## G1: Health endpoint

A Node.js HTTP server (no framework, no dependencies) answers `GET /health` with status 200 and the JSON body `{"status":"ok"}`. Any other path answers 404. `npm test` proves both using Node's built-in test runner.

## Constraints

No web framework and no runtime dependencies. This is not a Next.js app.
