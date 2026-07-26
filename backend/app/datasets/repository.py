from __future__ import annotations

from app.datasets.default_dataset import load_default_dataset


class DatasetRepository:
    def __init__(self) -> None:
        dataset = load_default_dataset()
        self._datasets = {dataset.id: dataset}

    def list_datasets(self):
        return list(self._datasets.values())

    def get_dataset(self, dataset_id: str):
        return self._datasets[dataset_id]

