"""Moroccan calendar features: public holidays and Ramadan.

Islamic dates follow the moon-sighting announcements of the Ministry of
Habous and can shift by ±1 day from the dates below; extend the tables when
new years are announced.
"""
from datetime import date, timedelta

import numpy as np
import pandas as pd

# Fixed civil holidays (month, day).
FIXED_HOLIDAYS = [
    (1, 1),    # New Year
    (1, 11),   # Proclamation of Independence
    (1, 14),   # Amazigh New Year (Yennayer, since 2024)
    (5, 1),    # Labour Day
    (7, 30),   # Throne Day
    (8, 14),   # Oued Ed-Dahab Day
    (8, 20),   # Revolution of the King and the People
    (8, 21),   # Youth Day
    (10, 31),  # Unity Day (since 2025)
    (11, 6),   # Green March
    (11, 18),  # Independence Day
]

# Islamic holidays as observed in Morocco (first day; Eids span 2 days).
ISLAMIC_HOLIDAYS = {
    2021: ["2021-05-13", "2021-05-14", "2021-07-21", "2021-07-22", "2021-08-10", "2021-10-19"],
    2022: ["2022-05-03", "2022-05-04", "2022-07-10", "2022-07-11", "2022-07-30", "2022-10-09"],
    2023: ["2023-04-22", "2023-04-23", "2023-06-29", "2023-06-30", "2023-07-19", "2023-09-28"],
    2024: ["2024-04-10", "2024-04-11", "2024-06-17", "2024-06-18", "2024-07-08", "2024-09-16"],
    2025: ["2025-03-31", "2025-04-01", "2025-06-07", "2025-06-08", "2025-06-27", "2025-09-05"],
    2026: ["2026-03-20", "2026-03-21", "2026-05-27", "2026-05-28", "2026-06-16", "2026-08-26"],
    2027: ["2027-03-10", "2027-03-11", "2027-05-16", "2027-05-17", "2027-06-06", "2027-08-15"],
}

# Ramadan (first day, last day).
RAMADAN = [
    ("2021-04-14", "2021-05-12"),
    ("2022-04-03", "2022-05-02"),
    ("2023-03-23", "2023-04-21"),
    ("2024-03-12", "2024-04-09"),
    ("2025-03-02", "2025-03-30"),
    ("2026-02-19", "2026-03-19"),
    ("2027-02-08", "2027-03-09"),
]


def holidays(years) -> set[date]:
    out = set()
    for y in years:
        out.update(date(y, m, d) for m, d in FIXED_HOLIDAYS)
        out.update(date.fromisoformat(s) for s in ISLAMIC_HOLIDAYS.get(y, []))
    return out


def ramadan_days(years) -> set[date]:
    out = set()
    for start, end in RAMADAN:
        s, e = date.fromisoformat(start), date.fromisoformat(end)
        if s.year in years or e.year in years:
            d = s
            while d <= e:
                out.add(d)
                d += timedelta(days=1)
    return out


def calendar_frame(index_utc: pd.DatetimeIndex, tz: str) -> pd.DataFrame:
    """Calendar features in local time for a UTC hourly index."""
    local = index_utc.tz_convert(tz)
    years = set(local.year)
    hol, ram = holidays(years), ramadan_days(years)
    days = pd.Series(local.date, index=index_utc)
    doy = local.dayofyear.to_numpy()
    return pd.DataFrame({
        "hour": local.hour,
        "dow": local.dayofweek,
        "month": local.month,
        "doy_sin": np.sin(2 * np.pi * doy / 365.25),
        "doy_cos": np.cos(2 * np.pi * doy / 365.25),
        "is_holiday": days.map(lambda d: d in hol).astype(int).to_numpy(),
        "is_ramadan": days.map(lambda d: d in ram).astype(int).to_numpy(),
    }, index=index_utc)
