from fastapi.testclient import TestClient

from app.main import app


def test_health_exposes_only_two_methods():
    response = TestClient(app).get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["methods"] == ["classical_highs", "hybrid_qaoa"]


def test_backends_exposes_only_classical_and_hybrid():
    response = TestClient(app).get("/api/backends")
    assert response.status_code == 200
    ids = [row["id"] for row in response.json()]
    assert ids == ["classical_highs", "hybrid_qaoa"]
