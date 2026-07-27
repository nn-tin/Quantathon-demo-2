# Google Colab notebooks

The repository contains exactly two Colab notebooks with separate responsibilities.

## 1. Live demo backend

Use `PiL-HQUC_Colab_GPU_Demo_API.ipynb` to:

- upload and extract the project ZIP;
- install the pinned Qamomile/CUDA-Q environment;
- verify the NVIDIA CUDA-Q target;
- start FastAPI on the Colab GPU;
- create a public Cloudflare HTTPS tunnel;
- connect the local Vite frontend to the public `/api` URL.

This notebook does not run tests or benchmarks. Keep its runtime active during the frontend demonstration.

## 2. Backend tests and full benchmark suite

Use `PiL-HQUC_Colab_GPU_Backend_Tests_and_3_Benchmarks.ipynb` to:

- install backend, pytest and benchmark dependencies;
- verify the NVIDIA CUDA-Q target;
- run `backend/tests` and `benchmark/tests`;
- execute Benchmark 1, Benchmark 2 and Benchmark 3 with `--experiments all`;
- apply one discarded warm-up per unique quantum configuration;
- generate the HTML report, summary CSV files, raw results and figures;
- download a bundle containing benchmark outputs and test logs.

The notebook defaults to `RUN_FULL_BENCHMARK = True`. Set it to `False` only for a quick protocol check, not for final reported results. It does not start FastAPI or expose a frontend tunnel.
