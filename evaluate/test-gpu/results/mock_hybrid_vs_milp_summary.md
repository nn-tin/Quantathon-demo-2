# Mock Hybrid vs MILP Comparison

| Requested Qubits | Supported | Active Qubits | Instances | MILP Cost | Hybrid Cost | Gap % | MILP Feas. | Hybrid Feas. | MILP Curtail | Hybrid Curtail | MILP Runtime ms | Hybrid Runtime ms | Source |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 8 | yes | 8 | 3 | 78993.881667 | 79642.527667 | 0.821448 | 1.0 | 1.0 | 0.0 | 0.0 | 1854.122333 | 1831.011 | numpy_statevector_qaoa_fallback |
| 12 | yes | - | 0 | - | - | - | - | - | - | - | - | - | failed |
| 16 | yes | - | 0 | - | - | - | - | - | - | - | - | - | failed |
| 20 | yes | - | 0 | - | - | - | - | - | - | - | - | - | failed |
| 24 | yes | - | 0 | - | - | - | - | - | - | - | - | - | failed |
