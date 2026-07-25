# Verification

Completed in the delivery environment:

```text
Backend test suite: 10 passed
Python compile check: passed
Frontend App.jsx TypeScript/JSX check: passed
Default comparison request: Classical feasible, Hybrid feasible, 10 active qubits
Runtime input contract: same frontend dataset applied to both methods
```

The production frontend bundle should be generated after a clean platform-local install:

```bash
cd frontend
npm install
npm run build
```

The archive intentionally excludes `node_modules` because native Rollup/esbuild packages are platform-specific.
