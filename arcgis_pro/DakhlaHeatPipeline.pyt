"""
DakhlaHeatPipeline.pyt

An ArcGIS Pro Python Toolbox that exposes the three pipeline steps as
geoprocessing tools in the Geoprocessing pane. Add it from Catalog ->
Toolboxes -> Add Toolbox, then run the tools in order:

    1. Import Overture Geometry
    2. Generate Heat Grid
    3. Integrate Demographics

Each tool just drives the matching arcgis_pro/0*.py script, so the toolbox
and the command-line route stay in sync.
"""

import importlib.util
import os

import arcpy

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(filename):
    """Import a step module whose filename starts with a digit."""
    path = os.path.join(HERE, filename)
    spec = importlib.util.spec_from_file_location(filename[:-3], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Toolbox(object):
    def __init__(self):
        self.label = "Dakhla Heat Pipeline"
        self.alias = "dakhlaHeat"
        self.tools = [ImportOvertureGeometry, GenerateHeatGrid,
                      IntegrateDemographics]


class ImportOvertureGeometry(object):
    def __init__(self):
        self.label = "1 - Import Overture Geometry"
        self.description = (
            "Create the File Geodatabase and load buildings_3d + "
            "pedestrian_network, from the committed GeoJSONs or live Overture."
        )
        self.canRunInBackground = False

    def getParameterInfo(self):
        source = arcpy.Parameter(
            displayName="Source",
            name="source",
            datatype="GPString",
            parameterType="Required",
            direction="Input",
        )
        source.filter.type = "ValueList"
        source.filter.list = ["geojson", "overture"]
        source.value = "geojson"
        return [source]

    def execute(self, parameters, messages):
        module = _load("01_import_overture_geometry.py")
        module.main(parameters[0].valueAsText)


class GenerateHeatGrid(object):
    def __init__(self):
        self.label = "2 - Generate Heat Grid"
        self.description = (
            "Build the 200m fishnet, compute urban_density and "
            "temperature_proxy, keep built-up cells."
        )
        self.canRunInBackground = False

    def getParameterInfo(self):
        return []

    def execute(self, parameters, messages):
        _load("02_generate_heat_grid.py").main()


class IntegrateDemographics(object):
    def __init__(self):
        self.label = "3 - Integrate Demographics"
        self.description = (
            "Attach population_estimate to the heat grid (census mode if "
            "data/raw/census_sections.geojson exists, else dasymetric proxy)."
        )
        self.canRunInBackground = False

    def getParameterInfo(self):
        return []

    def execute(self, parameters, messages):
        _load("03_integrate_demographics.py").main()
