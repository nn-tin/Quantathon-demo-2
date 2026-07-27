# Start Here

## Live frontend demo

1. Open `PiL-HQUC_Colab_GPU_Demo_API.ipynb` in Google Colab.
2. Select a GPU runtime.
3. Upload the delivered project ZIP.
4. Run all cells through public API verification.
5. Copy the displayed API URL into `frontend/.env.local`.
6. Run the frontend locally with `npm install` and `npm run dev`.
7. Keep the Colab runtime and tunnel active throughout the demo.

## Backend tests and all three benchmarks

1. Open `PiL-HQUC_Colab_GPU_Backend_Tests_and_3_Benchmarks.ipynb` in a separate Google Colab runtime.
2. Select a GPU runtime and upload the same project ZIP.
3. Run the complete backend and benchmark test cell.
4. Keep `RUN_FULL_BENCHMARK = True`.
5. Run all three IEEE30 benchmarks.
6. Preview or download `benchmark_report.html` and the complete result bundle.

## What appears where?

- `localhost:5173`: recommended Hybrid operating schedule, costs, feasibility and QAOA evidence.
- `benchmark/report/benchmark_report.html`: IEEE30 Hybrid-vs-MILP comparison, qubit scaling and generator scaling.

The demo and benchmark notebooks are intentionally separate. Do not run the benchmark suite in the Colab runtime serving the live frontend. CUDA-Q target `nvidia` is mandatory; CPU fallback is disabled.
