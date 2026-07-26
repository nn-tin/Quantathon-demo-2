from fastapi.testclient import TestClient

from app.main import app


def test_health_exposes_hybrid_gpu_demo():
    response = TestClient(app).get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["run_mode"] == "hybrid_demo"
    assert payload["method"] == "hybrid_qaoa"
    assert payload["fixed_profile"]["qaoa_depth"] == 1
    assert payload["fixed_profile"]["shots"] == 256


def test_backends_exposes_only_hybrid():
    response = TestClient(app).get("/api/backends")
    assert response.status_code == 200
    ids = [row["id"] for row in response.json()]
    assert ids == ["hybrid_qaoa"]
