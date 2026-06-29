from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI
from supabase import create_client
from apscheduler.schedulers.background import BackgroundScheduler
from datetime import datetime
import pandas as pd
import subprocess
import threading

SUPABASE_URL = "https://gznemevovvcfjnuwsixl.supabase.co"
SUPABASE_KEY = "sb_publishable_CeGNCGlslM9tB2WD7Vrlvw_Da--_DIM" 

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Run Prophet
def run_forecast():
    subprocess.run(["python", "python/forecast.py"])

scheduler = BackgroundScheduler()
scheduler.add_job(run_forecast, "interval", hours=24)

@app.on_event("startup")
def start_scheduler():
    if not scheduler.running:
        scheduler.start()

    # Run forecast in background (non-blocking)
    threading.Thread(target=run_forecast).start()

# =========================
# FORECAST
# =========================
@app.get("/forecast")
def get_forecast():

    # 🔹 Forecast data
    forecast_res = (
        supabase.table("reservation_forecast")
        .select("forecast_data")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )

    if not forecast_res.data:
        return []

    forecast_data = forecast_res.data[0]["forecast_data"]

    forecast_map = {
        f["ds"][:7]: f["yhat"] for f in forecast_data
    }

    # Actual data
    res = supabase.table("reservations").select("event_date").execute()

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
# MONTHLY RESERVATIONS (LAST 6 MONTHS)
# =========================
@app.get("/analytics/monthly-reservations")
def monthly_reservations():

    res = supabase.table("reservations").select("event_date").execute()

    df = pd.DataFrame(res.data)

    if df.empty:
        return []

    df['event_date'] = pd.to_datetime(df['event_date'])

    today = datetime.today()
    six_months_ago = today - pd.DateOffset(months=5)

    df = df[df['event_date'] >= six_months_ago]

    df['month_num'] = df['event_date'].dt.month
    df['month'] = df['event_date'].dt.strftime('%b')

    grouped = (
        df.groupby(['month_num','month'])
        .size()
        .reset_index(name='count')
        .sort_values('month_num')
    )

    return grouped[['month','count']].to_dict(orient='records')

# =========================
# PACKAGE DISTRIBUTION
# =========================
@app.get("/analytics/package-distribution")
def package_distribution():

    res = supabase.table("reservations") \
        .select("package!reservations_package_id_fkey(package_type)") \
        .execute()

    counts = {}

    for r in res.data:
        pkg = r.get("package")

        if pkg and pkg.get("package_type"):
            name = pkg["package_type"]
        else:
            name = "Unknown"

        counts[name] = counts.get(name, 0) + 1

    return [{"package": k, "count": v} for k, v in counts.items()]