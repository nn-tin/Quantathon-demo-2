# IEEE30 benchmark correction

- Removed SimBench and the standalone synthetic benchmark factory.
- Restored one MATPOWER `case30.m`-derived copper-plate data family across all three benchmarks.
- Benchmark 1: eight 24-hour IEEE30-derived scenarios, Hybrid q=10 versus HiGHS.
- Benchmark 2: fixed IEEE30-derived 10-generator `double-peak` case, q=8,10,14,18,20,24,26 versus one reused HiGHS result.
- Benchmark 3: IEEE30-derived replicated fleets G=10,20,30,40,50 at q=10 and q=20, each compared with HiGHS.
- Top-K is 10 for Benchmarks 1–2 and 10,20,30,40,50 for Benchmark 3.
- Preserved the one-discarded-warm-up-per-quantum-configuration timing protocol.
- Removed the SimBench package dependency and updated the Colab notebook/report.
- HiGHS reference target: 0.5% relative MIP gap, 60-second limit per dataset.
- Split the mixed Colab workflows into exactly two notebooks: one GPU API notebook for the frontend demo and one notebook for all backend tests plus the full three-benchmark suite.
