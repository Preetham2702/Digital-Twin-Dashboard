from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import asyncio
from Printers.FDM_Printer import router as fdm_router
from Printers.Pocket_NC import router as cnc_router
# from Printers.resin_Printer import router as resin_router
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(fdm_router)
app.include_router(cnc_router)
# app.include_router(resin_router)

@app.get("/")
def home():
    return {"status": "Backend Running"}