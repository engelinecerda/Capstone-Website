from supabase import create_client
import pandas as pd
from prophet import Prophet
import json

SUPABASE_URL = "https://gznemevovvcfjnuwsixl.supabase.co"
SUPABASE_KEY = "sb_publishable_CeGNCGlslM9tB2WD7Vrlvw_Da--_DIM"

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# 1. Fetch reservation data (ACTUAL)
response = supabase.table("reservations").select("event_date").eq("status", "approved").execute()
data = response.data

df = pd.DataFrame(data)

df['ds'] = pd.to_datetime(df['event_date'])
df = df.groupby(df['ds'].dt.to_period('M')).size().reset_index(name='y')
df['ds'] = df['ds'].dt.to_timestamp()

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

#  FIX 2: Limit forecast spikes
forecast['yhat'] = forecast['yhat'].clip(upper=20)


# 4. Format for DB (ONLY FORECAST)
forecast_data = forecast[['ds', 'yhat']].copy()
forecast_data['ds'] = forecast_data['ds'].dt.strftime('%Y-%m-%d')

output = forecast_data.to_dict(orient='records')

# 5. Store in JSONB
supabase.table("reservation_forecast").insert({
    "forecast_data": output
}).execute()

print("Forecast updated!") # CHECKING PURPOSES