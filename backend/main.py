from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import time
from fastapi import Request
from services import perf
from Printers.FDM_Printer import router as fdm_router
from Printers.Pocket_NC import router as cnc_router
from Printers.resin_Printer import router as resin_router
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Performance logging: time every dashboard request, per printer ──────────
@app.middleware("http")
async def perf_middleware(request: Request, call_next):
    t0 = time.perf_counter()
    status, err = 500, ""
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    except Exception as e:
        err = repr(e)
        raise
    finally:
        secs = time.perf_counter() - t0
        perf.record(perf.printer_for_path(request.url.path), "api",
                    request.method, request.url.path, status, secs, err)


@app.get("/perf/stats")
def perf_stats():
    """Aggregated latency (count / avg / p50 / p95 / max) per printer and route."""
    return {"csv": perf.CSV_PATH, "stats": perf.stats()}


app.include_router(fdm_router)
app.include_router(cnc_router)
app.include_router(resin_router)

@app.get("/")
def home():
    return {"status": "Backend Running"}