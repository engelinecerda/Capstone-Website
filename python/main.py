from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI, BackgroundTasks
from supabase import create_client
from datetime import datetime
from fastapi import HTTPException
from pydantic import BaseModel
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import pandas as pd
import logging
import asyncio
import sys
import os

sys.path.insert(0, str(Path(__file__).resolve().parent))

import forecast as forecast_module

logger = logging.getLogger("uvicorn.error")

_forecast_executor = ThreadPoolExecutor(max_workers=1)

_forecast_status = {
    "state": "idle",       # "idle" | "running" | "done" | "error"
    "started_at": None,    # ISO timestamp, set when a run begins
    "finished_at": None,   # ISO timestamp, set when a run ends (done or error)
    "error": None,         # error message, only set when state == "error"
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
# Lightweight endpoint with zero heavy imports (no pandas/Prophet work),
# so external uptime pingers can hit this to prevent Render free-tier
# cold starts without triggering any real work.
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
        return supabase.table("reservations").select("event_date").eq("status", "completed").execute()  

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
        key = r["event_date"][:7]
        year = r["event_date"][:4]

        years.add(year)
        actual_map[key] = actual_map.get(key, 0) + 1

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
        # run_forecast() is a blocking, CPU-bound call (Prophet fit) — run
        # it on the dedicated worker thread so it doesn't block the event
        # loop (and therefore /health and every other request) for the
        # duration of the fit.
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
    # Guard against overlapping runs (e.g. the cron job firing while
    # someone's mid-click on "Update Forecast") — the ThreadPoolExecutor
    # above is single-worker anyway, so a second run would just queue up
    # invisibly; better to say so explicitly.
    if _forecast_status["state"] == "running":
        logger.info("forecast/generate: request received, but a run is already in progress")
        return {"success": True, "message": "Forecast generation already in progress.", "already_running": True}

    logger.info("forecast/generate: request received")
    background_tasks.add_task(_run_forecast_generation, body.user_id)
    return {"success": True, "message": "Forecast generation started.", "already_running": False}

# =========================
# FORECAST GENERATION STATUS
# =========================
# Lets the frontend poll for actual completion instead of guessing on a
# fixed timer. "idle" also covers server-restart cases (in-memory status
# resets), which is fine — the caller just treats it the same as "done".
@app.get("/forecast/status")
async def get_forecast_status():
    return _forecast_status

# =========================
# MONTHLY RESERVATIONS
# =========================
@app.get("/analytics/monthly-reservations")
def monthly_reservations():
    res = supabase.table("reservations") \
        .select("event_date") \
        .in_("status", ["approved", "confirmed", "completed"]) \
        .execute()

    df = pd.DataFrame(res.data)

    if df.empty:
        return []

    df['event_date'] = pd.to_datetime(df['event_date'])
    df['year'] = df['event_date'].dt.year.astype(str)
    df['month_num'] = df['event_date'].dt.month
    df['month'] = df['event_date'].dt.strftime('%b')

    grouped = (
        df.groupby(['year', 'month_num', 'month'])
        .size()
        .reset_index(name='count')
        .sort_values(['year', 'month_num'])
    )

    return grouped[['year', 'month_num', 'month', 'count']].to_dict(orient='records')
# =========================
# PACKAGE DISTRIBUTION
# =========================
@app.get("/analytics/package-distribution")
def package_distribution():

    try:
        res = (
            supabase.table("reservations")
            .select("""
                reservation_id,
                package:package_id (
                    package_category:package_category_id (
                        category_name
                    )
                )
            """)
            .execute()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load package distribution: {e}")

    counts = {}

    for r in res.data:
        pkg = r.get("package") or {}
        category = pkg.get("package_category") or {}

        name = category.get("category_name", "Unknown")

        counts[name] = counts.get(name, 0) + 1

    return [{"package": k, "count": v} for k, v in counts.items()]