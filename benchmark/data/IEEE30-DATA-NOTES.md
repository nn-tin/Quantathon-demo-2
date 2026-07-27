# IEEE 30-bus benchmark adaptation

Source case: MATPOWER `data/case30.m` (30 buses, 6 generators), based on the Alsac–Stott 30-bus system.

- Source generator buses: 1, 2, 22, 27, 23 and 13.
- Source `Pmax`: 80, 80, 50, 55, 30 and 40 MW (335 MW total).
- Static real-power demand aggregated across the 30 buses: 189.2 MW.
- Source quadratic generation-cost coefficients are retained and converted to one linear marginal-cost proxy at half loading because the current UC implementation uses linear variable costs.
- The six source generators are split deterministically into ten virtual units while preserving each source generator's total capacity and cost ordering. The split creates enough binary decisions for active-block experiments.
- Minimum output, ramp, no-load, startup and multi-period timing values are deterministic UC adaptation parameters; MATPOWER `case30.m` is an OPF case and does not provide a complete 24-hour UC data set.
- The project solves a copper-plate/single-bus UC adaptation. IEEE30 branch-flow constraints are not included and no network-constrained claim should be made.
- Benchmark 3 creates 20–50 generator instances by replicating the same ten-unit IEEE30-derived fleet and scaling demand, renewable production and reserve with installed capacity.

Official source: https://github.com/MATPOWER/matpower/blob/master/data/case30.m
