from supabase import create_client
import pandas as pd
from prophet import Prophet
import json
import sys
import os

SUPABASE_URL = "https://gznemevovvcfjnuwsixl.supabase.co"

# Same reasoning as python/main.py: this needs to bypass RLS to read
# `reservations` across all customers, so it must use the service role key,
# loaded from the environment (set on Render), never hardcoded.
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPABASE_SERVICE_ROLE_KEY:
    print("ERROR: SUPABASE_SERVICE_ROLE_KEY environment variable is not set.", file=sys.stderr)
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# 1. Fetch reservation data (ACTUAL)
response = supabase.table("reservations").select("event_date").eq("status", "completed").execute()
data = response.data

if not data:
    print("No completed reservations yet — skipping forecast run.")
    sys.exit(0)

df = pd.DataFrame(data)

df['ds'] = pd.to_datetime(df['event_date'])
df = df.groupby(df['ds'].dt.to_period('M')).size().reset_index(name='y')
df['ds'] = df['ds'].dt.to_timestamp()

# Prophet needs at least 2 data points to fit a model
if len(df) < 2:
    print(f"Only {len(df)} month(s) of completed-reservation data — not enough to fit Prophet. Skipping.")
    sys.exit(0)

# 2. Train Prophet
model = Prophet(yearly_seasonality=True)
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
generated_by = sys.argv[1] if len(sys.argv) > 1 else None

try:
    insert_res = supabase.table("reservation_forecast").insert({
        "forecast_data": output,
        "generated_by": generated_by   # None if run by scheduler/cron
    }).execute()
except Exception as e:
    print(f"ERROR: failed to store forecast: {e}", file=sys.stderr)
    sys.exit(1)

# Only clean up old rows AFTER the new one is safely stored,
# so a failed run never leaves the table empty.
try:
    new_id = insert_res.data[0]["forecast_id"]
    old_rows = supabase.table("reservation_forecast") \
        .select("forecast_id") \
        .neq("forecast_id", new_id) \
        .execute()
    for row in old_rows.data:
        supabase.table("reservation_forecast").delete().eq("forecast_id", row["forecast_id"]).execute()
    if old_rows.data:
        print(f"Cleaned up {len(old_rows.data)} old forecast row(s).")
except Exception as e:
    # Non-fatal: the new forecast is already saved, cleanup failing isn't critical
    print(f"WARNING: cleanup of old forecast rows failed: {e}", file=sys.stderr)

print("Forecast updated!")