from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from Printers.FDM_Printer import router as fdm_router
# from Printers.Pocket_NC import router as cnc_router
from Printers.resin_Printer import router as resin_router
from Printers.resin_Printer import run_print
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(fdm_router)
#app.include_router(cnc_router)
app.include_router(resin_router)

@app.on_event("startup")
async def startup():
    import asyncio
    asyncio.create_task(run_print())