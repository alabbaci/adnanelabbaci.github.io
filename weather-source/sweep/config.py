"""Settings shared by the sweep: domain, forecast steps and data sources."""

# Africa plus the seas that shape its weather: the tropical Atlantic, the Mediterranean,
# the Red Sea and Arabian Sea, and the south-west Indian Ocean (Madagascar, Mascarenes)
# where its cyclones form.
WEST, EAST, SOUTH, NORTH = -26.0, 64.0, -42.0, 40.0
RES = 0.25

# HRES frames every 6 h out to day 6. Gusts and maximum temperature are 3-hourly maxima,
# so those are fetched every 3 h and folded into the 6-hourly frames.
STEPS = list(range(0, 145, 6))
FINE_STEPS = list(range(3, 145, 3))

SOURCES = [
    "https://data.ecmwf.int/forecasts",
    "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com",
]

MAX_ITEMS = 15
ATTRIBUTION = "Data: © ECMWF, CC BY 4.0. Cropped and unit-converted."
