from __future__ import annotations

import pytest

from benchmark.data.block_mapping import benchmark_top_k, generator_scaling_block, qubit_scaling_block
from benchmark.data.ieee30_factory import (
    IEEE30_BASE_LOAD_MW,
    IEEE30_SOURCE_TOTAL_CAPACITY_MW,
    build_ieee30_dataset,
    build_ieee30_generator_fleet,
)


def test_ieee30_base_fleet_preserves_source_capacity():
    fleet = build_ieee30_generator_fleet(10)
    assert len(fleet) == 10
    assert sum(unit.p_max for unit in fleet) == pytest.approx(IEEE30_SOURCE_TOTAL_CAPACITY_MW)
    assert len({unit.id for unit in fleet}) == 10


def test_ieee30_scaled_fleet_and_profiles():
    dataset = build_ieee30_dataset("double-peak", generator_count=50)
    assert len(dataset.generators) == 50
    assert len(dataset.hours) == 24
    assert len(dataset.demand) == 24
    assert len(dataset.renewable) == 24
    assert len(dataset.reserve) == 24
    assert sum(unit.p_max for unit in dataset.generators) == pytest.approx(5 * IEEE30_SOURCE_TOTAL_CAPACITY_MW)
    assert max(dataset.demand) > IEEE30_BASE_LOAD_MW


def test_top_k_and_block_axes_are_controlled():
    assert [benchmark_top_k(g) for g in [10, 20, 30, 40, 50]] == [10, 20, 30, 40, 50]
    assert qubit_scaling_block(26).total_positions == 26
    assert generator_scaling_block(50, 10).total_positions == 10
    assert generator_scaling_block(50, 20).total_positions == 20
