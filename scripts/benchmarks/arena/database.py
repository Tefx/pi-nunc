# purpose: Refuse scorer-only material as the live Arena database before loading tools.
# usage: validate_live_database(task_root), called by travel_tools.py
# effects: Read metadata and tool definitions only.
# requires: Pinned full official source tree and unmodified six official tools.
import json
def validate_live_database(root):
    source=root/'runtime/MemoryArena/env/env_systems/travel_planner_env'
    flights=list(source.glob('database/**/clean_Flights_2022.csv'))
    if len(flights)!=1 or flights[0].stat().st_size!=304807007:
        raise ValueError('Full official304807007B flight CSV required; scorer subset is not liveDB')
    tools=json.loads((root/'runtime/tools.json').read_text())
    expected={'FlightSearch','RestaurantSearch','AccommodationSearch','AttractionSearch','DistanceMatrix','CitySearch'}
    names=[t['function']['name'] for t in tools]
    if len(names)!=6 or set(names)!=expected:
        raise ValueError('Exactly six official tool definitions required')
    return flights[0].stat().st_size
