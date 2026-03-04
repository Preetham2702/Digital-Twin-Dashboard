from fastapi import FastAPI
from Printers.FDM_Printer import router as fdm_router

app = FastAPI()

app.include_router(fdm_router)
