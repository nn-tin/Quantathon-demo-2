from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router

app = FastAPI(title="Hybrid Quantum-Classical Unit Commitment Demo")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {
        "name": "Hybrid Quantum-Classical Unit Commitment Demo",
        "status": "ok",
        "docs": "/docs",
        "health": "/api/health",
    }


app.include_router(router)
