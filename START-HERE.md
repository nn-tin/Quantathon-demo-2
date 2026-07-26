# Start Here

## Fastest route

1. Open `Run_PiL_HQUC_GPU_Demo_and_Benchmarks.ipynb` in Google Colab.
2. Select a GPU runtime.
3. Upload the delivered project ZIP in the first code cell.
4. Run the installation and GPU verification cells.
5. Open the displayed Vite proxy link for the Hybrid-only demo.
6. Run the quick benchmark, then the full benchmark when ready.
7. Open or download `benchmark_report.html`.

## What appears where?

- `localhost:5173`: recommended Hybrid operating schedule, costs, feasibility and QAOA evidence.
- `benchmark/report/benchmark_report.html`: SimBench Hybrid-vs-MILP comparison, qubit scaling and generator scaling.

The demo always requires CUDA-Q target `nvidia`; it does not silently fall back to CPU.
