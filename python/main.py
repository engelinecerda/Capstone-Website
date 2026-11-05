from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, BackgroundTasks
from supabase import create_client
from datetime import datetime
from fastapi import HTTPException
from pydantic import BaseModel
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import logging
import asyncio
import sys
import os

sys.path.insert(0, str(Path(__file__).resolve().parent))

import forecast as forecast_module

logger = logging.getLogger("uvicorn.error")

_forecast_executor = ThreadPoolExecutor(max_workers=1)

_forecast_status = {
    "state": "idle",      
    "started_at": None,   
    "finished_at": None,   
    "error": None,         
}

SUPABASE_URL = "https://gznemevovvcfjnuwsixl.supabase.co"

SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError(
        "SUPABASE_SERVICE_ROLE_KEY environment variable is not set. "
        "Add it in the Render dashboard (Environment tab) — get the value "
        "from Supabase → Project Settings → API → service_role key."
    )

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# HEALTH / KEEP-ALIVE
# =========================
@app.get("/health")
async def health():
    return {"status": "ok"}

# =========================
# FORECAST (read-only; generation now runs as a separate Render Cron Job)
# =========================
@app.get("/forecast")
async def get_forecast():
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    def fetch_forecast():
        return (
            supabase.table("reservation_forecast")
            .select("forecast_data")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )

    def fetch_actuals():
        return supabase.rpc("get_monthly_completed_reservation_counts").execute()

    loop = asyncio.get_event_loop()
    try:
        with ThreadPoolExecutor() as pool:
            forecast_res, res = await asyncio.gather(
                loop.run_in_executor(pool, fetch_forecast),
                loop.run_in_executor(pool, fetch_actuals)
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load forecast data: {e}")

    if not forecast_res.data:
        return []

    forecast_data = forecast_res.data[0]["forecast_data"]
    forecast_map = {
        f["ds"][:7]: f["yhat"] for f in forecast_data
    }

    actual_map = {}
    years = set()

    for r in res.data:
        key = r["month"][:7]
        year = r["month"][:4]

        years.add(year)
        actual_map[key] = r["reservation_count"]

    # ADD FUTURE YEARS (next 2 years)
    current_year = datetime.now().year
    years.update([str(current_year + 1), str(current_year + 2)])

    # SORT YEARS
    years = sorted(years)

    result = []

    for year in years:
        for m in range(1, 13):
            key = f"{year}-{m:02d}"

            result.append({
                "month_name": datetime(int(year), m, 1).strftime("%b"),
                "year": year,
                "y": actual_map.get(key, 0),
                "yhat": forecast_map.get(key, None)
            })

    return result

# =========================
# FORECAST (manual trigger — kept for the "Update Forecast" button in the
# dashboard, and also hit daily by the cron-job.org "daily forecast" job)
# =========================
class GenerateForecastRequest(BaseModel):
    user_id: str | None = None

async def _run_forecast_generation(user_id: str | None):
    logger.info("forecast/generate: starting background run (user_id=%s)", user_id)
    _forecast_status["state"] = "running"
    _forecast_status["started_at"] = datetime.utcnow().isoformat() + "Z"
    _forecast_status["finished_at"] = None
    _forecast_status["error"] = None

    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(_forecast_executor, forecast_module.run_forecast, user_id)
        _forecast_status["state"] = "done"
        logger.info("forecast/generate: completed successfully")
    except Exception as e:
        _forecast_status["state"] = "error"
        _forecast_status["error"] = str(e)
        logger.exception("forecast/generate: failed")
    finally:
        _forecast_status["finished_at"] = datetime.utcnow().isoformat() + "Z"

@app.post("/forecast/generate")
async def generate_forecast(
    background_tasks: BackgroundTasks,
    body: GenerateForecastRequest = GenerateForecastRequest(),
):
    if _forecast_status["state"] == "running":
        logger.info("forecast/generate: request received, but a run is already in progress")
        return {"success": True, "message": "Forecast generation already in progress.", "already_running": True}

    logger.info("forecast/generate: request received")
    background_tasks.add_task(_run_forecast_generation, body.user_id)
    return {"success": True, "message": "Forecast generation started.", "already_running": False}

# =========================
# FORECAST GENERATION STATUS
# =========================
@app.get("/forecast/status")
async def get_forecast_status():
    return _forecast_status

# =========================
# MONTHLY RESERVATIONS
# =========================
@app.get("/analytics/monthly-reservations")
def monthly_reservations():
    res = supabase.rpc(
        "get_monthly_reservation_counts",
        {"p_statuses": ["approved", "confirmed", "completed"]},
    ).execute()

    if not res.data:
        return []

    result = [
        {
            "year": row["month"][:4],
            "month_num": int(row["month"][5:7]),
            "month": datetime.strptime(row["month"][:7], "%Y-%m").strftime("%b"),
            "count": row["reservation_count"],
        }
        for row in res.data
    ]

    result.sort(key=lambda r: (r["year"], r["month_num"]))
    return result
# =========================
# PACKAGE DISTRIBUTION
# =========================
@app.get("/analytics/package-distribution")
def package_distribution():
    try:
        res = (
            supabase.table("package_category_distribution_cache")
            .select("category_name, reservation_count")
            .order("reservation_count", desc=True)
            .execute()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load package distribution: {e}")

    return [{"package": row["category_name"], "count": row["reservation_count"]} for row in res.data]