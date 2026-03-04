from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from Printers.FDM_Printer import router as fdm_router

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount FDM printer backend
app.include_router(fdm_router, prefix="/fdm")