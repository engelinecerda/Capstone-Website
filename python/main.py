from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI
from supabase import create_client
from datetime import datetime
from fastapi import HTTPException
from pydantic import BaseModel
import pandas as pd
import subprocess
import os

SUPABASE_URL = "https://gznemevovvcfjnuwsixl.supabase.co"

# This backend runs server-side and needs to read across all reservations
# for analytics (package distribution, forecasting), regardless of which
# staff member is logged in on the dashboard. That's a trusted, cross-cutting
# read the anon/publishable key was never meant to satisfy — RLS correctly
# blocks it from reading `reservations` (it holds customer PII), which is
# what was causing the 500s on /forecast and /analytics/package-distribution.
# The service role key bypasses RLS the same way the Supabase Edge Functions
# in this project already do (see supabase/functions/*). It must be set as
# an env var on Render — never hardcode it, it grants full DB access.
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
# FORECAST (manual trigger — kept for the "Update Forecast" button in the dashboard)
# =========================
class GenerateForecastRequest(BaseModel):
    user_id: str | None = None

@app.post("/forecast/generate")
async def generate_forecast(body: GenerateForecastRequest):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor

    def run():
        args = ["python", "python/forecast.py"]
        if body.user_id:
            args.append(body.user_id)
        result = subprocess.run(args, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(result.stderr)

    loop = asyncio.get_event_loop()
    try:
        with ThreadPoolExecutor() as pool:
            await loop.run_in_executor(pool, run)
        return {"success": True, "message": "Forecast generated successfully."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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