from supabase import create_client
import pandas as pd
from prophet import Prophet
import json
import sys
import os

SUPABASE_URL = "https://gznemevovvcfjnuwsixl.supabase.co"

SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_SERVICE_ROLE_KEY:
    print("ERROR: SUPABASE_SERVICE_ROLE_KEY environment variable is not set.", file=sys.stderr)
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

def run_forecast(generated_by=None):
    response = supabase.rpc("get_monthly_completed_reservation_counts").execute()
    data = response.data

    if not data:
        print("No completed reservations yet — skipping forecast run.")
        return

    df = pd.DataFrame(data).rename(columns={"month": "ds", "reservation_count": "y"})
    df['ds'] = pd.to_datetime(df['ds'])

    if len(df) < 2:
        print(f"Only {len(df)} month(s) of completed-reservation data — not enough to fit Prophet. Skipping.")
        return

    # 2. Train Prophet
    model = Prophet(yearly_seasonality=True, uncertainty_samples=0)
    model.fit(df)

    # 3. Forecast FULL YEAR (12 months ahead)
    future = model.make_future_dataframe(periods=36, freq='MS')
    forecast = model.predict(future)

    # CLEAN VALUES
    #  FIX 1: Remove negatives
    forecast['yhat'] = forecast['yhat'].clip(lower=0)

    #  FIX 2: ROUND VALUES (NO DECIMALS)
    forecast['yhat'] = forecast['yhat'].round()

    #  FIX 2: Limit forecast spikes (OPTIONAL)
    forecast['yhat'] = forecast['yhat'].clip(upper=20)

    # 4. Format for DB (ONLY FORECAST)
    forecast_data = forecast[['ds', 'yhat']].copy()
    forecast_data['ds'] = forecast_data['ds'].dt.strftime('%Y-%m-%d')

    output = forecast_data.to_dict(orient='records')

    # 5. Store in JSONB
    try:
        insert_res = supabase.table("reservation_forecast").insert({
            "forecast_data": output,
            "generated_by": generated_by   # None if run by scheduler/cron
        }).execute()
    except Exception as e:
        print(f"ERROR: failed to store forecast: {e}", file=sys.stderr)
        raise

    try:
        new_id = insert_res.data[0]["forecast_id"]
        deleted = supabase.table("reservation_forecast") \
            .delete() \
            .neq("forecast_id", new_id) \
            .execute()
        if deleted.data:
            print(f"Cleaned up {len(deleted.data)} old forecast row(s).")
    except Exception as e:
        print(f"WARNING: cleanup of old forecast rows failed: {e}", file=sys.stderr)

    print("Forecast updated!")

if __name__ == "__main__":
    _generated_by = sys.argv[1] if len(sys.argv) > 1 else None
    run_forecast(_generated_by)